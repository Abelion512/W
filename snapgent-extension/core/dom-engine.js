// SPDX-License-Identifier: GPL-3.0-or-later
// core/dom-engine.js - DOM waiting, hidden-tab parking, submission, and streaming response engine.
// Extracted from core/main.js so DOM observation and response lifecycle stay modular.
const ZSDomEngine = (() => {
  "use strict";

  function createDomEngine(deps) {
    const P = deps.provider;
    const T = deps.timings || P.timings;
    const A = deps.state;
    const a2a = deps.a2a;
    const sleep = deps.sleep;
    const diag = deps.diag;
    const log = deps.log;
    const getUi = deps.getUi;
    const jitterBeforeSend = deps.jitterBeforeSend;
    const backgroundSessionsReady = deps.backgroundSessionsReady;
    const scrollSuppressed = deps.scrollSuppressed;
    const bareToolName = deps.bareToolName;
    const knownTool = deps.knownTool;
    const preHideWholeItems = deps.preHideWholeItems;
    const scheduleSweep = deps.scheduleSweep;

    async function waitFor(pred, timeout) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) {
        if (pred()) return true;
        await sleep(120);
      }
      return false;
    }

    // Park until the AI tab is the FOREGROUND tab of its window again (or the user
    // halts). Deliberately has NO time cap: a tab minimized/backgrounded for an
    // hour must resume cleanly, not silently time out into a "could not send /
    // not run" failure. (A plain waitFor with a finite timeout returned false on a
    // long minimize, which broke the send loop and ended the agent loop.) Returns
    // false ONLY if the user stopped while we were parked, so callers can break.
    // EVENT-DRIVEN, not polled. A chained setTimeout loop is subject to Chrome's
    // "intensive throttling": once a tab has been hidden >5 min, chained timers are
    // clamped to ONE tick per minute, so a sleep(300) poll could take up to a full
    // minute to notice the tab came back - the user sees the bar sit on "Paused"
    // long after they returned. visibilitychange fires immediately on unhide, so we
    // race it against a slow stop-poll (the stop path is not latency-critical).
    async function waitVisible() {
      if (!document.hidden || A.stop) return !A.stop;
      // A bridge-driven A2A task must never park: the caller is waiting on this
      // exact tab, and fan-out pins one task per provider tab. Parking here was
      // what made a deep task in a background tab stall until the caller timed
      // out, and what dropped the result of a tab that lost focus mid-task. The
      // manual-session opt-in below stays off by default for user-driven work.
      if (a2a.getCurrentId()) {
        diag("park.skipped.a2a", { promptId: a2a.getCurrentId() });
        return !A.stop;
      }
      // Multi-tab opt-in: a hidden tab may keep working. Read the flag through the
      // awaitable so a session started immediately after load cannot race it.
      if (await backgroundSessionsReady()) {
        // Mark the state for the diagnostics only; never place a cover over a tab
        // the user cannot see anyway.
        diag("park.skipped.background", { configured: true });
        return !A.stop;
      }
      A.parked = true;
      try { getUi().setStarting(); } catch {}
      try {
        await new Promise((resolve) => {
          let unsubStop = null;
          const done = () => {
            document.removeEventListener("visibilitychange", onVis);
            window.removeEventListener("focus", onVis);
            if (unsubStop) { unsubStop(); unsubStop = null; }
            resolve();
          };
          const onVis = () => { if (A.stop || !document.hidden) done(); };
          document.addEventListener("visibilitychange", onVis);
          window.addEventListener("focus", onVis);
          if (typeof deps.onStop === "function") unsubStop = deps.onStop(done);
          if (A.stop || !document.hidden) done();
        });
      } finally {
        A.parked = false;
        try { getUi().setStarting(); } catch {}
      }
      return !A.stop;
    }

    // Park while the tab is hidden and report how long we were parked, so callers
    // can slide their timers forward by that amount. Without this, every deadline
    // inside waitForResponse (inactivity timeout, warm-up, text-stability) keeps
    // ticking while nothing can be read - which is what turned "user switched to
    // Studio for 5 minutes" into "No response from <site>, the loop has stopped"
    // and left the pending command showing a grey "not run".
    async function parkHidden() {
      if (!document.hidden || A.stop) return 0;
      if (a2a.getCurrentId()) return 0;
      const t0 = Date.now();
      await waitVisible();
      const parked = Date.now() - t0;
      diag("park.resumed", { parkedMs: parked });
      // Give the site a beat to repaint: a tab that was hidden has no layout, so
      // the first reads after unhide can come back stale/blank.
      if (!A.stop) await sleep(400);
      return parked;
    }

    // Submit `text` as a new turn, masking the input while we type. Returns the
    // assistant-item count BEFORE the reply (waitForResponse waits beyond it).
    // Snapshot the identity of the assistant turn present BEFORE we send. Paired
    // with waitForResponse, this lets "a new reply turn exists" be tested by node
    // identity rather than a raw count - the latter is unreliable on providers that
    // virtualize the message list, where the count stays flat as a new
    // turn appears and old ones detach. Captured at every send site (tool feedback,
    // user message, bootstrap). Providers without lastAssistantId fall back to count.
    function captureSendToken() {
      A.sendToken = P.lastAssistantId ? P.lastAssistantId() : undefined;
    }

    async function submitAndGetBase(text, images) {
      captureSendToken();
      if (A.stop) return P.assistantCount();
      diag("send", { chars: String(text).length, busy: P.isBusyNow() });
      A.injecting = true;
      getUi().inputCover(true);
      try {
        // Quick 2-point settle: sample the previous response's stream length before
        // and after a 200ms yield. A one-shot React batch flush (the common case)
        // shows no second growth and costs only 200ms. A genuinely still-generating
        // stream shows growth → fall back to the full idle wait.
        const _settleItem = P.lastAssistant();
        const _settleLen0 = _settleItem ? P.streamLen(_settleItem) : 0;
        await sleep(200);
        if (A.stop) return P.assistantCount();
        if (_settleItem && _settleItem === P.lastAssistant() &&
            P.streamLen(_settleItem) > _settleLen0) {
          await waitFor(() => A.stop || !P.isGenerating(), 4000);
        }
        const base = P.assistantCount();
        const preUser = P.userCount();
        // Arm the optimistic pre-hide for the result turn we're about to inject:
        // the very next NEW user turn is ours, so preHideWholeItems can mask it on
        // creation instead of waiting for its "Output of '…'" caption to render
        // (which lands a tick after the node - especially with an attached image -
        // and would otherwise flash the raw output for the 200/700ms until a sweep
        // nudge catches it). See preHideWholeItems.
        A.injectPreUser = preUser;
        A.injectHideUntil = Date.now() + 2500;
        // "Landed" = a new turn appeared in the DOM. In long chats, list
        // virtualisation can keep counts flat even when our message landed - the
        // textarea-cleared signal below is the primary fast gate.
        const landed = () => P.userCount() > preUser || P.assistantCount() > base;
        // CRITICAL: never type/send while the tab is HIDDEN. Background tabs throttle
        // rendering, which made the landed-check unreliable and caused the SAME
        // feedback to be sent several times. Send ONLY while visible.
        let tries = 0;
        let messageSent = false;
        const maxTries = Number.isInteger(P.sendRetryLimit) && P.sendRetryLimit > 0
          ? P.sendRetryLimit
          : 4;
        while (!messageSent && !landed() && tries < maxTries && !A.stop) {
          if (document.hidden) {
            diag("send.waitVisible", { tries });
            if (!(await waitVisible()) || A.stop) break; // park (no cap) until foreground; break only on user stop
          }
          await jitterBeforeSend();
          if (A.stop) break;
          diag("submit.typeAndSend", { hasImages: !!(images && images.length) });
          await P.typeAndSend(text, images);
          // Re-arm the pre-hide window NOW that typeAndSend has returned (the send
          // was just clicked, so our result turn is about to render). The initial
          // arm above can EXPIRE during an image upload - typeAndSend blocks ~3-6s
          // uploading the capture before the turn appears, past the 2.5s window - so
          // without this re-arm the raw "Output of…" + a still-loading (0-byte)
          // thumbnail flash for image feedbacks until a sweep chip lands. Safe: the
          // input is covered and the loop owns this send, so no user turn can slip
          // into the window, and the pre-hide is one-shot (consumes the first turn).
          A.injectHideUntil = Date.now() + 2500;
          // The site clears the textarea as soon as the send is accepted - faster
          // and more reliable than waiting for a DOM turn count change.
          await waitFor(() => {
            if (P.editorText().trim() === "") messageSent = true;
            return A.stop || messageSent || landed();
          }, 3500);
          tries++;
        }
        if (messageSent) diag("send.cleared", { tries });
        // All retries exhausted with NO evidence the message landed (textarea never
        // cleared, no new turn). Silently returning here left the loop waiting for
        // a reply that will never come (~60s "empty" timeout) with zero explanation
        // - the reported "the tool result just never gets injected" symptom. Tell
        // the user what actually happened so they can nudge the conversation
        // themselves instead of watching a stuck bar.
        if (!messageSent && !landed() && !A.stop) {
          diag("send.failed", { tries });
          getUi().banner("warn", "Message could not be sent",
            `Send "continue" to resume.`);
        }
        return base;
      } finally {
        // During Starting Up / the agent loop, the bootstrap or loop owns the cover
        // for the whole phase, so don't lift it here between an injection and the
        // next waitForResponse - it stays up until the loop / bootstrap ends.
        if (!A.starting && !A.running) getUi().inputCover(false);
        if (A.stop) A.injecting = false;
        else setTimeout(() => (A.injecting = false), 400);
        // Camouflage the turn we just injected without waiting on the rAF observer
        // (paused in a background tab). A couple of nudges cover the render.
        setTimeout(scheduleSweep, 200);
        setTimeout(scheduleSweep, 700);
      }
    }

    // ════════════════════════════════════════════════════════════════════════
    //  RESPONSE WATCHER  (generating-flag driven - robust to DOM churn)
    // ════════════════════════════════════════════════════════════════════════
    // Shared wording for the 2026-11 placeholder turn, used by both the Start flow
    // and agentLoop so the user sees one explanation, not two dialects.
    const FALLBACK_TURN_TEXT =
      "ChatGPT returned an empty placeholder reply for this conversation - open a new chat and Start again.";

    async function waitForResponse(base) {
      const t0 = Date.now();
      // INACTIVITY timeout (not total-elapsed): the loop only gives up after this
      // long with NO streaming AND no text change. lastActiveAt is refreshed every
      // tick the model is generating or the reply text grows, so an arbitrarily
      // LONG but still-active response never trips it (the old total-elapsed cap
      // wrongly fired "No response" while the model was still writing past 300s).
      const TIMEOUT = T.RESPONSE_TIMEOUT_MS;
      let lastActiveAt = Date.now();
      const STABLE_MS = T.STABLE_MS; // generating-flag stuck ON but text frozen → done
      let started = false, doneSince = 0, lastLimitScan = 0;
      let lastText = null, lastChangeAt = Date.now(), genFalseSince = 0;
      // ── DIAG: finalisation-latency instrumentation (multi_edit "slow" probe) ──
      // genOffFirstAt: the FIRST moment gen went false after streaming began (does
      // NOT reset on flicker, unlike genFalseSince). genFlickers: how many times gen
      // flipped back true after having been false - a high count means post-stop DOM
      // churn (or a wedged stop button) is what keeps the watcher alive. waitedBlock/
      // waitedFlicker: iterations spent waiting because effectiveBlock held vs because
      // gen was (re)true. These pinpoint which gate causes any tail latency.
      let genOffFirstAt = 0, genFlickers = 0, prevGen = null;
      let waitedBlock = 0, waitedFlicker = 0;
      const finalizeDiag = (kind) => {
        const now = Date.now();
        diag("stopGoneToResp", {
          kind,
          stopGoneToRespMs: genOffFirstAt ? now - genOffFirstAt : null,
          genStableForMs: genFalseSince ? now - genFalseSince : null,
          lastChangeAgoMs: now - lastChangeAt,
          genFlickers, waitedBlock, waitedFlicker,
          totalMs: now - t0,
        });
      };
      let preStartSilent = 0; // nothing produced AND not generating
      let curItem = null, sawContent = false, warmSince = 0; // per-turn "warming up"
      // Last NON-EMPTY reply read for the CURRENT turn. Sites re-render a turn's
      // subtree (React/Monaco churn) and a read can come back "" for a frame at
      // the exact moment the watcher finalizes - the turn then ended as
      // kind:"empty" even though a (possibly cut-off) command was sitting there a
      // tick earlier, leaving a DEAD turn: no parse_error feedback, and the
      // autoResume dedupe (zResume) blocks any later retry (validated live on a
      // Qwen post-stop regenerate, 2026-07). Classify on this fallback instead of
      // declaring empty. Reset whenever the turn NODE changes so a new turn can
      // never inherit the previous turn's text.
      let lastGoodReply = "";
      let reasonSince = 0; // reasoning written but no answer yet (loading phase)
      let noTurnSince = 0; // finalize attempted before this send's reply turn exists
      let unsettledSince = 0; // command-shaped reply whose read is not yet stable
      const WARMUP_MS = T.WARMUP_MS;
      const REASON_NOREPLY_MS = T.REASON_NOREPLY_MS;
      const NO_TURN_GRACE_MS = T.NO_TURN_GRACE_MS || 30000;
      // Upper bound on holding off a parse verdict while a provider reports its
      // read is unsettled (Qwen A/B dual turn still landing). A genuinely stuck
      // read still resolves after this and is parsed as-is.
      const UNSETTLED_GRACE_MS = 8000;
      // Once the generating flag has been OFF this long, the model has clearly
      // stopped streaming - so an "open tool block" reading is a DOM-churn/parse
      // artifact, not live output, and must not keep the watcher waiting. Provider
      // -neutral: while a model is genuinely streaming, gen stays true and this is
      // never reached.
      const GEN_STOP_GRACE_MS = 2500;

      while (Date.now() - lastActiveAt < TIMEOUT) {
        if (A.stop) return { kind: "stopped" };
        // SCROLL-AWAY RULE: while the user scrolls up, NOTHING is read or run.
        // Hold here (and keep the inactivity clock alive, since this is the user
        // browsing, not a stalled model) so no scroll-rendered history can be
        // interpreted as a fresh command. Resumes as soon as the gesture window
        // lapses; a genuine run that was already in flight is untouched.
        if (scrollSuppressed() && !a2a.getCurrentId()) {
          lastActiveAt = Date.now();
          await sleep(250);
          continue;
        }
        // NEVER let a deadline expire while the tab is in the background. A hidden
        // tab has no layout (innerText reads come back "", getBoundingClientRect is
        // 0x0) and Chrome throttles its timers, so every read here is unreliable -
        // and the site may legitimately keep streaming for as long as the user is
        // away in Studio. Park until the tab is foreground again, then slide EVERY
        // deadline forward by the time we were parked so nothing that was mid-flight
        // when the user switched away expires the moment they come back. This is the
        // fix for "I switched to Studio, came back and the command says 'not run'":
        // the loop used to burn its 5-minute inactivity budget off-screen, end with
        // "No response from <site>", and orphan the pending command.
        // Upstream a4b831b: with Background sessions on, parkHidden() returns at
        // once and the loop re-parks forever without ever reading the reply.
        if (document.hidden && !A.stop && !a2a.getCurrentId() && !(await backgroundSessionsReady())) {
          const parked = await parkHidden();
          if (A.stop) return { kind: "stopped" };
          if (parked) {
            lastActiveAt += parked; lastChangeAt += parked;
            if (doneSince) doneSince += parked;
            if (genFalseSince) genFalseSince += parked;
            if (preStartSilent) preStartSilent += parked;
            if (warmSince) warmSince += parked;
            if (reasonSince) reasonSince += parked;
            if (noTurnSince) noTurnSince += parked;
            if (unsettledSince) unsettledSince += parked;
            if (genOffFirstAt) genOffFirstAt += parked;
          }
          continue; // re-read everything now that the tab has layout again
        }
        const gen = P.isGenerating();
        if (gen) lastActiveAt = Date.now(); // actively generating ⇒ never time out
        const d = P.readAssistant();
        // Sites virtualize their lists, so the absolute assistant count can DROP
        // even as a new reply is added. A count increase still proves a new turn
        // appeared; the generating flag is the reliable "reply has begun" signal.
        // A new reply turn exists. Prefer node IDENTITY (virtualization-proof) when
        // the provider exposes it: the last assistant turn's id differs from the one
        // captured at send time. Fall back to the count test otherwise. Without this,
        // a provider's list virtualisation can keep assistantCount() <= base for a
        // fresh reply, so the reliableCounts gate below waits out the full NO_TURN_GRACE
        // (~30s) before finalising a multi_edit - the "input box stuck until I scroll
        // up" symptom (scrolling re-attached old turns and bumped the count).
        const curTok = P.lastAssistantId ? P.lastAssistantId() : undefined;
        // A NULL token means the provider could not read an identity for the
        // CURRENT last turn (not that the provider lacks ids - that's undefined).
        // Treating null as "no new reply" wedged the watcher on Qwen: a
        // REGENERATED turn is rebuilt WITHOUT the id attribute the normal turns
        // carry, so curTok stayed null, `started` never latched, and the loop
        // sat in the pre-start branch for the full 60s before ending "empty" -
        // the regenerated command (complete in the net tap) was never run and
        // zResume then blocked any retry (validated live via empty.why, 2026-07).
        // Fall back to the count test instead, exactly as for a provider with no
        // lastAssistantId at all.
        const newReply = (curTok !== undefined && curTok !== null)
          ? (curTok !== A.sendToken)
          : P.assistantCount() > base;

        // Track whether the CURRENT turn has produced anything. Reset when the
        // turn node changes (the PREVIOUS turn's content never counts).
        if (d.item !== curItem) { curItem = d.item; sawContent = false; warmSince = 0; lastGoodReply = ""; a2a.resetChunk(); }
        if ((d.reply && d.reply.length) || (d.thinking && d.thinking.length)) sawContent = true;
        if (d.reply && d.reply.length && (!P.reliableCounts || newReply)) {
          lastGoodReply = d.reply;
          a2a.emitChunkIfDue(d.reply, Date.now());
        }

        if (!started) {
          // CRITICAL: a bare count increase is NOT enough - the empty turn
          // CONTAINER can appear seconds before the first token. Require actual
          // CONTENT (or the generating flag).
          const hasText = !!((d.reply && d.reply.length) || (d.thinking && d.thinking.length));
          if (gen || (newReply && hasText)) { started = true; }
          else {
            // The site can be slow to even CREATE the reply turn. Keep waiting -
            // only give up after a long fully-silent window.
            if (!preStartSilent) preStartSilent = Date.now();
            // diag: WHICH empty-branch fired matters - a dead post-regenerate turn
            // on Qwen kept ending "empty" with a complete command in the net tap,
            // and without the branch name the cause was unfindable from the log.
            if (Date.now() - preStartSilent > 60000) { diag("empty.why", { branch: "preStart", rep: (d.reply||"").length }); return { kind: "empty" }; }
            await sleep(200);
            continue;
          }
        }

        // Track text stability (independent of the generating flag). Compare the
        // NORMALISED reply (collapsed whitespace) so cosmetic re-renders of a large
        // reply - React re-creating the hidden tool <pre>, syntax-highlight passes,
        // copy-bar text churn - don't count as real "changes" and keep resetting
        // lastChangeAt. A churn-poisoned lastChangeAt was stalling finalisation of
        // big multi_edit blocks ~30s (stuckDone never fired); this can only ever
        // reduce false changes, so short replies / other providers are unaffected.
        const replyNorm = (d.reply || "").replace(/\s+/g, " ").trim();
        if (replyNorm !== lastText) { lastText = replyNorm; lastChangeAt = Date.now(); lastActiveAt = Date.now(); }
        // How long the generating flag has been OFF. A mid-stream flicker resets
        // this the instant growth resumes and gen flips back on.
        if (gen) genFalseSince = 0; else if (!genFalseSince) genFalseSince = Date.now();
        // DIAG: first gen-off, and count flickers back to true after a gen-off.
        if (started && !gen && !genOffFirstAt) genOffFirstAt = Date.now();
        if (prevGen === false && gen && genOffFirstAt) genFlickers++;
        prevGen = gen;

        if (Date.now() - lastLimitScan > 1000) {
          lastLimitScan = Date.now();
          const ctx = P.scanError();
          if (ctx) return { kind: "context_limit", detail: ctx };
        }

        // Keep waiting while a tool command is still being streamed (opener written
        // but no end marker yet) so we never parse/finalize half a command.
        const blockActive = ZSParse.hasOpenToolBlock(d.reply) && Date.now() - lastChangeAt < 6000;
        // ...but once generation has clearly stopped (stop indicator gone past the
        // grace window), stop honoring an "open block" - it is DOM churn, not live
        // streaming. Lets a finished big block finalise in seconds instead of
        // waiting out ~30s of re-render churn. Safe: real streaming keeps gen true.
        const genStopped = !gen && genFalseSince && Date.now() - genFalseSince > GEN_STOP_GRACE_MS;
        const effectiveBlock = blockActive && !genStopped;

        // Fallback: generating flag stuck ON (e.g. a wedged stop button - seen
        // live on Gemini after a mid-write halt) but the text has been frozen for
        // a while → stop waiting and finalize. This must BYPASS the gen branch
        // below entirely: falling through while gen stays true used to reset
        // doneSince every iteration, so the watcher never finalized at all.
        // ...but NEVER treat a still-OPEN command block as "done" while the site is
        // genuinely still generating. A model writing a big command (a 3799-char
        // execute_luau seen live on GLM) can pause >STABLE_MS between tokens - that
        // is a mid-write gap, NOT a wedged stop button on a COMPLETE reply. Firing
        // here parsed the half-written JSON and stamped a false "bad JSON" error
        // while GLM was still typing. RESPONSE_TIMEOUT still bounds a truly stuck one.
        const stuckDone = started && d.reply && (!P.reliableCounts || newReply) && Date.now() - lastChangeAt > STABLE_MS &&
          !(gen && ZSParse.hasOpenToolBlock(d.reply));
        if ((gen || effectiveBlock) && !stuckDone) {
          // DIAG: attribute this wait. genOffFirstAt set ⇒ we are PAST first stop,
          // so any wait here is tail latency: either gen flickered back on, or an
          // (effective) open-block reading is holding us.
          if (genOffFirstAt) { if (gen) waitedFlicker++; else if (effectiveBlock) waitedBlock++; }
          doneSince = 0;
          await sleep(160);
          continue;
        }
        if (stuckDone && gen) log("generating flag stuck - falling back to text stability");

        // On providers whose turn counts are RELIABLE (semantic elements, no
        // list virtualisation - Gemini), never finalize before the reply turn
        // for THIS send exists. The generating flag can flicker off in the gap
        // between the send and the new <model-response> node spawning, and the
        // watcher used to finalize on the PREVIOUS turn's stable text - a
        // premature loop.end rescued only by autoResume 30-45s later (diag
        // showed `response kind:text` ~2.4s after loop.start with rp unchanged).
        // Bounded so a genuinely dead send still ends the turn.
        if (P.reliableCounts && !newReply) {
          if (!noTurnSince) noTurnSince = Date.now();
          // [TRACE] This is the 30s NO_TURN_GRACE gate. If a Qwen tool turn sits here
          // ~30s EVERY turn, newReply is wrongly stuck false: log the identity values
          // that decide it so we can see whether curTok is null (id missing on the new
          // turn -> count fallback) or equal to sendToken (last turn not advancing).
          const _waited = Date.now() - noTurnSince;
          if (_waited > 800 && (!A._noTurnLoggedAt || Date.now() - A._noTurnLoggedAt > 3000)) {
            A._noTurnLoggedAt = Date.now();
            diag("noTurnGrace.wait", {
              waitedMs: _waited,
              curTok: (P.lastAssistantId ? P.lastAssistantId() : undefined),
              sendToken: A.sendToken,
              assistantCount: P.assistantCount ? P.assistantCount() : undefined,
              base, gen, started, replyLen: (d.reply || "").length });
          }
          if (Date.now() - noTurnSince < NO_TURN_GRACE_MS) { await sleep(200); continue; }
          diag("empty.why", { branch: "noTurnGrace", base, assistantCount: P.assistantCount ? P.assistantCount() : undefined });
          return { kind: "empty" };
        } else {
          noTurnSince = 0;
          A._noTurnLoggedAt = 0;
        }

        if (!doneSince) doneSince = Date.now();
        if (Date.now() - doneSince < 500) {  // 500ms settle – DOM is stable
          await sleep(120);
          continue;
        }

        // A turn that has produced NOTHING yet is still warming up - never
        // finalize it as empty/truncated/text (a premature retry interrupts it).
        if (!sawContent) {
          // 2026-11 ChatGPT: a saturated conversation answers with a PLACEHOLDER
          // turn that never gains content. Its only marker is the search-unit key
          //   data-content-search-unit-key="fallback-turn-0:2:assistant"
          // and the bubble holds nothing but "ChatGPT said:". Measured live: the
          // reply text was present in the page's own text but never rendered into
          // the turn, so the loop waited the full WARMUP_MS (45 s) and then blamed
          // the DOM ("empty"). Detect the placeholder immediately and say what it
          // actually is, so the user is told to open a new chat instead of losing
          // an hour to a stuck chip.
          try {
            const it = d && d.item;
            const marker = it && it.querySelector
              ? it.querySelector('[data-content-search-unit-key^="fallback-turn"]')
              : null;
            if (marker && !(d.reply || "").length) {
              if (!warmSince) warmSince = Date.now();
              if (Date.now() - warmSince > 2500) {
                diag("empty.why", { branch: "fallbackTurn", rep: 0 });
                return { kind: "fallback_turn" };
              }
              await sleep(200);
              continue;
            }
          } catch (error) {
            // The fallback marker could not be read; keep the warmup path but
            // make the failure visible instead of swallowing it.
            diag("empty.why", { branch: "fallbackTurnError", message: String(error) });
          }
          if (!warmSince) warmSince = Date.now();
          if (Date.now() - warmSince < WARMUP_MS) { await sleep(200); continue; }
          diag("empty.why", { branch: "warmup", rep: (d.reply||"").length, lastGood: lastGoodReply.length });
          return { kind: "empty" };
        }

        // Still REASONING / loading: thinking written but no answer yet. Don't
        // finalize - wait for the reply, bounded. A manually-stopped turn is
        // exempt so a real stop still ends.
        if (d.thinking && d.thinking.length && !(d.reply && d.reply.length) && !P.turnHalted(d.item)) {
          if (!reasonSince) reasonSince = Date.now();
          if (Date.now() - reasonSince < REASON_NOREPLY_MS) { await sleep(200); continue; }
        } else {
          reasonSince = 0;
        }

        // Blank-read guard: if THIS read came back empty but the same turn had
        // real text a tick ago, classify that text - see lastGoodReply above.
        let r = d.reply;
        if (!r && lastGoodReply) { r = lastGoodReply; diag("reply.blankReadFallback", { len: r.length }); }
        // "Conversation too long" / "server busy" notices are always SHORT system
        // messages; gating on a short reply stops the model's own long output
        // (which may quote those phrases) from tripping them.
        if (r.length < 400 && P.isTooLongMsg(r)) return { kind: "too_long" };
        // Hold off on any "unparseable command" verdict while the provider reports
        // this turn's text is not yet a settled read. Qwen's A/B "dual" turn is the
        // case: its network tap flips `done` the instant the SSE ends, but the
        // candidate-1 DOM we parse can still be mid-render, so a real command looks
        // half-written for a beat. Firing parse_error there sends an ERROR
        // mid-generation and nags a model that did nothing wrong. Only guard when
        // the reply already LOOKS like a command (so a plain-text answer is never
        // delayed) and bound it with UNSETTLED_GRACE_MS. No-op on providers that
        // don't implement replyUnsettled (DeepSeek/Gemini/GLM/Kimi/Arena).
        const cmdShaped = P.replyUnsettled && (
          ZSParse.hasToolSignature(r) ||
          (ZSParse.LUA_END_RE.test(r) && !ZSParse.LUA_START_RE.test(r)) ||
          (/"(?:datamodel_type|edits|old_string|new_string|file_path|target_file)"\s*:/.test(r) &&
            !/"command"\s*:/.test(r))
        );
        if (cmdShaped && P.replyUnsettled(d.item)) {
          if (!unsettledSince) unsettledSince = Date.now();
          if (Date.now() - unsettledSince < UNSETTLED_GRACE_MS) { await sleep(250); continue; }
        } else {
          unsettledSince = 0;
        }
        // A/B "carousel" turn (Qwen): while it is unresolved the site REMOVES the
        // composer from the DOM (validated live: getEditor() is null), so we can't
        // send the tool result until a candidate is picked - and the read reply is a
        // partial candidate, so a command there looks "cut off". Per the product rule
        // we use the FIRST candidate: wait for BOTH candidates to finish generating
        // (you can't select mid-stream), then auto-select Response 1. That collapses
        // the carousel to a normal turn - composer returns - and the normal parse/run
        // path below handles it. Never a parse_error here (the model didn't truncate).
        // No-op for every provider except Qwen. RESPONSE_TIMEOUT still bounds a truly
        // stuck carousel, so this cannot hang.
        if (P.isComparisonTurn && P.isComparisonTurn(d.item)) {
          if (P.isGenerating()) { await sleep(250); continue; }   // both still writing
          if (P.resolveComparison && P.resolveComparison()) {
            diag("carousel.resolved");
            await sleep(400); continue;                            // let it collapse, re-read
          }
          await sleep(250); continue;                              // button not ready yet
        }
        if (ZSParse.hasToolSignature(r)) {
          const calls = ZSParse.parseToolCalls(r);
          if (calls.length) { finalizeDiag("tool"); return { kind: "tool", calls, item: d.item }; }
          // A half-written command + the site's "Continue" button means the command
          // was truncated mid-stream → resume it rather than reporting bad JSON.
          if (P.findContinueBtn()) return { kind: "truncated", text: r, item: d.item };
          // Only fire parse_error if explicit markers were present.
          if (r.includes(ZSParse.START_M) || ZSParse.LUA_START_RE.test(r)) return { kind: "parse_error", reason: "malformed", raw: r, item: d.item };
          // A command opener with no closer (a JSON object that never closed -
          // the model was halted mid-write and there is no Continue affordance):
          // ask the model to rewrite it instead of silently ending the turn.
          // ...unless ONLY the trailing closers were lost (the model hit its
          // output limit with the payload complete - seen live on Qwen: a big
          // multi_edit missing exactly one final "}"). salvageCutOff auto-closes
          // and runs it instead of burning a whole retry turn; it refuses any
          // cut that amputated real content (mid-string / deep deficit), which
          // still falls through to the parse_error feedback. Safe to run here:
          // generation has ended (the open-block branch above kept waiting
          // while it streamed).
          if (ZSParse.hasOpenToolBlock(r)) {
            const saved = ZSParse.salvageCutOff(r);
            if (saved) {
              diag("tool.salvaged", { name: saved.tool });
              finalizeDiag("tool");
              return { kind: "tool", calls: [saved], item: d.item };
            }
            return { kind: "parse_error", reason: "unclosed", raw: r, item: d.item };
          }
          // A closed-looking JSON command envelope that NAMES A REAL TOOL but failed
          // to parse - typically an unescaped " inside a code/string param broke the
          // JSON (seen live on Kimi's execute_blender_code: `name = "Camera_System"`
          // mid-code). Unlike execute_luau there is NO ###LUA### fallback, so the
          // command silently dropped and the loop finalized the turn as a plain-text
          // answer with no result and no error - a dead turn. Fire a parse_error so
          // the model can fix its JSON. GATED on a known command name so prose that
          // merely quotes {"command":"..."} (a DeepSeek-style explanation, or a
          // placeholder like "command_name") is NOT misread as a broken command and
          // looped on - only a real tool name means a genuine failed call.
          const nm = ZSParse.toolNameFromText(r);
          if (nm && nm !== "command" && (A.toolNames.has(nm) || A.toolNames.has(bareToolName(nm)))) {
            return { kind: "parse_error", reason: "malformed", raw: r, item: d.item };
          }
        }
        // The model answered in its OWN native tool-call markup instead of a
        // snapgentV3 command - DeepSeek's DSML invoke/parameter tags (reported by
        // users, 2026-08; DeepSeek is the only provider seen doing it). It carries
        // no "command"/"tool" key and no ###...### markers, so hasToolSignature is
        // false and every guard below misses it too: the turn finalized as a
        // plain-text answer, the tool never ran, and the loop ended on a dead agent.
        // Checked FIRST among the fallthrough guards because the marker is
        // unambiguous - unlike the guards below it needs no known-tool gate, which
        // matters because the degenerate form seen in the wild carries no tool name
        // at all (a bare tool_calls opener followed by prose).
        if (ZSParse.DSML_RE.test(r)) {
          diag("cmd.dsml", { len: r.length });
          return { kind: "parse_error", reason: "dsml", raw: r, item: d.item };
        }
        // Malformed execute_luau: the model wrote the ###END_LUA### closer but
        // FORGOT the ###LUA### opener, so hasToolSignature missed it and the block
        // never ran (seen on Gemini). Don't silently treat it as a final answer -
        // nudge a rewrite instead of leaving the user stuck on a dead turn.
        if (ZSParse.LUA_END_RE.test(r) && !ZSParse.LUA_START_RE.test(r) && !r.includes(ZSParse.START_M)) {
          return { kind: "parse_error", reason: "luaOpener", raw: r, item: d.item };
        }
        // Malformed command: the model emitted a tool's RAW ARGUMENTS as a bare JSON
        // object (e.g. {"datamodel_type":...,"edits":[...],"file_path":...}) instead of
        // the required {"command":...,"params":...} envelope - it treated the tool as a
        // real callable function (seen on Gemini). Those argument keys never appear in a
        // normal prose answer, so nudge a rewrite rather than ending the turn silently.
        if (/"(?:datamodel_type|edits|old_string|new_string|file_path|target_file)"\s*:/.test(r) &&
            !/"command"\s*:/.test(r)) {
          return { kind: "parse_error", reason: "envelope", raw: r, item: d.item };
        }
        // Malformed command, function-calling flavour: the model named a REAL tool
        // but under the WRONG KEY - {"toolName": "get_studio_state", "studio_id": …}
        // instead of {"command": …, "params": {…}}. It reads as a deliberate call,
        // yet hasToolSignature never fires (no "command" key, no markers) and the
        // argument keys are the tool's own, so neither guard above catches it: the
        // turn finalized as a plain-text answer and the loop ENDED with the user
        // watching a dead agent (seen live on ChatGPT, long session, 2026-08).
        // GATED on the value being a tool we actually have - same reasoning as the
        // toolNameFromText gate above, so prose that merely mentions a tool name in
        // some JSON example is never looped on.
        const wrongKey = /"(?:toolName|tool_name|tool|name|function|action)"\s*:\s*"([A-Za-z0-9_.\/-]+)"/.exec(r);
        if (wrongKey && !/"command"\s*:/.test(r)) {
          const wk = wrongKey[1];
          const hit = knownTool(wk);
          // Log the miss too: the gate depends on how the bridge ADVERTISES names
          // (they can be prefixed per server on a collision), so a silent no-match
          // is exactly the case that is impossible to diagnose after the fact.
          diag("cmd.wrongKey", { name: wk, known: hit, catalogue: A.toolNames.size });
          if (hit) return { kind: "parse_error", reason: "toolKey", raw: r, item: d.item };
        }
        // NOTE: a site "server busy / something went wrong" notice is deliberately
        // NOT special-cased. It falls through to kind:"text" below and simply ENDS
        // the loop as a final answer - no auto-retry. Retrying risked an infinite
        // re-answer loop when the model's OWN prose said "try again", and treating
        // busy as a normal terminal turn is cleaner: the user just re-sends if the
        // site actually hiccuped. (P.isBusyMsg stays on the provider interface,
        // unused by the core, in case a future flow wants it.)
        // The site caps output length and shows a native "Continue" button when it
        // truncates. We try clicking it directly (same turn) in the loop.
        if (P.findContinueBtn()) return { kind: "truncated", text: r, item: d.item };
        if (r === "") {
          // A provider can cut generation short (Rudder's ~10s cap) and show its
          // OWN limit notice while the assistant turn stays blank. Reporting a
          // bare "empty reply" threw that reason away. Carry the site's text so
          // the caller learns the real cause instead of retrying blindly.
          const siteError = P.scanError ? (P.scanError() || "") : "";
          if (siteError) {
            diag("empty.why", { branch: "finalBlank", detail: siteError.slice(0, 160) });
            return { kind: "context_limit", detail: siteError };
          }
          diag("empty.why", { branch: "finalBlank" });
          return { kind: "empty" };
        }
        if (r.length < 600 && P.scanError) {
          const siteError = P.scanError() || "";
          if (siteError) {
            diag("text.siteError", { detail: siteError.slice(0, 160) });
            return { kind: "context_limit", detail: siteError };
          }
        }
        return { kind: "text", text: r };
      }
      return { kind: "timeout" };
    }

    return {
      waitFor,
      waitVisible,
      parkHidden,
      captureSendToken,
      submitAndGetBase,
      waitForResponse,
    };
  }

  return { createDomEngine };
})();
