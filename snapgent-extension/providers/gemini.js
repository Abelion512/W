// SPDX-License-Identifier: GPL-3.0-or-later
// providers/gemini.js - the Google Gemini (gemini.google.com) provider.
// Exports the same ZSProvider interface as providers/deepseek.js; the core
// (core/main.js) is provider-agnostic. To DISABLE Gemini support, simply remove
// this file from manifest.json (and its URL from background.js PROVIDER_URLS).
//
// Gemini DOM notes (validated live, 2026-06):
//  - Angular app with SEMANTIC custom elements - far more stable than hashed
//    CSS classes: one exchange = <div.conversation-container> holding a
//    <user-query> AND a <model-response>. We treat each of those two elements
//    as one "turn item" (alternating, in DOM order), which maps 1:1 onto the
//    core's expectations.
//  - The reply markdown lives in <message-content>; thinking-model reasoning
//    lives in <model-thoughts> (absent on non-thinking models).
//  - The composer is a Quill contenteditable (.ql-editor) guarded by Trusted
//    Types CSP: innerHTML assignment THROWS. Inject text via select-all +
//    document.execCommand("insertText") - validated to update Angular state.
//  - The primary action button (in <input-area-v2>) is identified by its
//    <mat-icon fonticon>: "arrow_upward" = send (text present), "stop" =
//    generating (whole stream, start to end - no indicatorless reasoning
//    phase like DeepSeek), "mic" = idle empty. aria-labels are localized,
//    fonticon names are NOT - we anchor on fonticon.
//  - No truncation "Continue" button; no per-turn "stopped" marker we can
//    rely on → findContinueBtn/turnHalted return null/false.
// eslint-disable-next-line no-unused-vars
const ZSProvider = (() => {
  "use strict";
  const B = ZSProviderBase;
  const sleep = B.sleep;
  let diag = () => {}; // injected by core via init()

  const S = {
    userItem: "user-query",
    assistantItem: "model-response",
    anyItem: "user-query, model-response",
    reply: "message-content",
    thinking: "model-thoughts",
    editor: ".ql-editor[contenteditable='true']",
    inputArea: "input-area-v2",
    codeWrap: "code-block",
    errorSurfaces: 'mat-snack-bar-container,[role="alert"],[class*="error-message"]',
  };

  const RE = {
    contextLimit: new RegExp(
      [
        "conversation.{0,20}(too long|trop long)",
        "context.{0,20}(limit|exceeded|d\\u00e9pass\\u00e9)",
        "limite.{0,20}(de contexte|atteinte)",
        "please.{0,30}start.{0,20}new.{0,20}(chat|conversation)",
        "(token|context).{0,10}limit",
        "maximum.{0,20}context",
      ].join("|"),
      "i"
    ),
    tooLong: /conversation .{0,20}(too long|getting too long|trop longue)/i,
    busy: /something went wrong|une erreur s.est produite|try again later|réessayer plus tard|temporarily unavailable/i,
  };

  // Gemini streams continuously with a hard stop-icon signal for the WHOLE
  // generation (including thinking), so idle windows can be much tighter than
  // DeepSeek's. Thinking models still get generous reasoning windows.
  const timings = {
    GEN_IDLE_MS: 1500,
    REASON_IDLE_MS: 12000,
    WARMUP_MS: 45000,
    REASON_NOREPLY_MS: 90000,
    STABLE_MS: 9000,
    RESPONSE_TIMEOUT_MS: 300000,
  };

  // ── Turn classification ───────────────────────────────────────────────────
  const isUserItem = (item) => !!item && item.tagName === "USER-QUERY";
  const isAssistantItem = (item) => !!item && item.tagName === "MODEL-RESPONSE";

  // Gemini prefixes every turn's textContent with a screen-reader label
  // ("Vous avez dit" / "Gemini a dit", inside .cdk-visually-hidden). That
  // prefix broke the core's anchored matching (e.g. /^Output of '/), so ALL
  // text extraction walks the tree and skips those (and any excluded) subtrees.
  const SR_HIDDEN = ".cdk-visually-hidden, [class*='screen-reader']";
  function textWithout(root, excludeSel) {
    if (!root) return "";
    const skip = SR_HIDDEN + (excludeSel ? ", " + excludeSel : "");
    let t = "";
    const walk = (n) => {
      if (n.nodeType === 3) { t += n.nodeValue; return; }
      if (n.nodeType !== 1) return;
      if (n.matches && n.matches(skip)) return;
      for (const c of n.childNodes) walk(c);
    };
    walk(root);
    return t;
  }

  // Non-thinking reply text only (tool blocks drafted inside the model's
  // reasoning must never be detected or executed).
  function itemText(item) {
    if (!item) return "";
    if (isAssistantItem(item)) {
      const md = item.querySelector(S.reply);
      return md && !md.closest(S.thinking) ? textWithout(md) : "";
    }
    return textWithout(item);
  }

  function classifyText(item, excludeSel) {
    if (isAssistantItem(item)) {
      const md = item.querySelector(S.reply);
      if (!md || (excludeSel && md.closest(excludeSel))) return "";
      return textWithout(md, excludeSel);
    }
    return textWithout(item, excludeSel);
  }

  // ── DOM primitives ────────────────────────────────────────────────────────
  const allItems = () => [...document.querySelectorAll(S.anyItem)];
  const assistantItems = () => [...document.querySelectorAll(S.assistantItem)];
  const assistantCount = () => assistantItems().length;
  const userCount = () => document.querySelectorAll(S.userItem).length;
  // Scope to the SITE's composer only: skip snapgentV3's own injected UI (the
  // settings textarea #zs-set-text in #zs-root). On login/OAuth pages with no
  // site editor this returns null, keeping the "not on a chat page" guard in
  // the send hooks intact (otherwise our own textarea would defeat it and the
  // hooks could swallow the site's login button).
  const getEditor = () => {
    for (const sel of [S.editor, ".ql-editor"]) {
      for (const e of document.querySelectorAll(sel)) {
        if (!e.closest("#zs-root")) return e;
      }
    }
    return null;
  };
  const editorText = () => {
    const e = getEditor();
    return e ? e.textContent || "" : "";
  };

  const lastAssistant = () => {
    const it = assistantItems();
    return it.length ? it[it.length - 1] : null;
  };

  const chatIsEmpty = () => allItems().length === 0;
  // A genuinely fresh chat: no turns rendered yet, with the composer mounted.
  // NOTE: we intentionally do NOT also require the bare "/app" route anymore -
  // Gemini's own "New chat" button clears the turn list WITHOUT resetting the
  // address bar (it keeps the PREVIOUS conversation's /app/<id> until the first
  // message is actually sent, validated live 2026-07). Gating on the URL left
  // isFreshChat() - and, transitively, conversationKey() below - still seeing
  // the OLD conversation id on a chat that was visually empty, so the
  // snapgentV3 bar stuck on "Agent active" with no way to start a new session.
  const isFreshChat = () => chatIsEmpty() && !!getEditor();

  // The composer box the Start gate hides as one unit.
  const composerFrame = () => document.querySelector(S.inputArea);

  // Where the core mounts its in-flow status bar. The <input-area-v2> composer
  // sits inside a flex-COLUMN <fieldset.input-area-container>, so inserting the
  // bar right before the composer makes it span the full input width and push
  // the composer down (validated live). Returns {parent, before}.
  function barMount() {
    const ia = composerFrame();
    if (!ia) return null;
    const col = ia.parentElement; // fieldset.input-area-container (flex column)
    if (!col) return null;
    return { parent: col, before: ia };
  }

  // ── Input lock ────────────────────────────────────────────────────────────
  // Quill is a contenteditable: flipping contenteditable=false would also block
  // our own execCommand injection, so typeAndSend temporarily re-enables it.
  let _locked = false;
  function setInputLock(on) {
    _locked = on;
    const ed = getEditor();
    if (!ed) return;
    ed.setAttribute("contenteditable", on ? "false" : "true");
    const ph = ed.closest("rich-textarea") || ed;
    if (on) ph.setAttribute("data-zs-locked", "1");
    else ph.removeAttribute("data-zs-locked");
  }

  // ── Action button (send / stop / mic) ─────────────────────────────────────
  const iconName = (el) => {
    const i = el && el.querySelector("mat-icon");
    return i ? (i.getAttribute("fonticon") || i.getAttribute("data-mat-icon-name") || (i.textContent || "").trim()) : "";
  };
  function actionButtons() {
    const box = document.querySelector(S.inputArea);
    return box ? [...box.querySelectorAll("button")].filter((b) => b.offsetParent !== null) : [];
  }
  const findButtonByIcon = (name) => actionButtons().find((b) => iconName(b) === name) || null;
  const sendButton = () => findButtonByIcon("arrow_upward");
  const stopButton = () => findButtonByIcon("stop");

  // ── Generation detection ──────────────────────────────────────────────────
  // The stop icon is present for the ENTIRE generation (validated live), which
  // makes detection far simpler than DeepSeek. Growth tracking remains as a
  // belt-and-braces fallback for the instants around start/end.
  function streamText(item) {
    if (!item) return "";
    const think = item.querySelector(S.thinking);
    const md = item.querySelector(S.reply);
    return (think ? think.textContent || "" : "") + "\n" + (md ? textWithout(md, ".zs-chip") : "");
  }
  const _stream = B.createStreamTracker(streamText, lastAssistant, { minGrow: 1 });
  const streamLen = _stream.streamLen;
  let _streamAt = 0;
  function sampleStream() {
    const snap = _stream.sampleStream();
    _streamAt = snap.at;
  }
  const grewWithin = _stream.grewWithin;

  // CRITICAL Gemini quirk (validated live): the stop button can WEDGE in the ON
  // state after a generation finishes - the icon stays "stop" with the text
  // frozen, forever. Trusting it blindly pinned isGenerating() permanently true,
  // which froze the loop (no send, no auto-resume, Stop button stuck on). So the
  // stop button is treated as "live" only while the stream is actually advancing
  // (or Task Mode is visibly working, or it only just appeared - generation
  // spinning up). Frozen past WEDGE_MS ⇒ wedged ⇒ not generating.
  const WEDGE_MS = 30000;
  const TASK_PROGRESS_SEL = '[role="progressbar"], mat-progress-bar, mat-progress-spinner, mat-spinner, progress';
  const TASK_BUSY_SEL = '[aria-busy="true"]';
  const TASK_STATUS_SEL = '[role="status"], [aria-live]';
  const TASK_THINKING_RE = /thinking it through/i;
  const DIALOG_SEL = '[role="dialog"], [role="alertdialog"], mat-dialog-container';
  const CANCEL_DIALOG_RE = /cancel response generation|stop generating|cancel generation/i;

  function isVisible(el) {
    if (!el) return false;
    if (el.closest && el.closest("#zs-root")) return false;
    if (el.getAttribute && el.getAttribute("aria-hidden") === "true") return false;
    try {
      if (typeof getComputedStyle === "function") {
        const st = getComputedStyle(el);
        if (st && (st.display === "none" || st.visibility === "hidden" || st.opacity === "0")) return false;
      }
    } catch {}
    if (el.offsetParent !== null && el.offsetParent !== undefined) return true;
    // position:fixed overlays (e.g. Angular CDK dialogs) have offsetParent === null.
    // Collapsed Angular submenus also have offsetParent === null but a 0x0 box.
    if (typeof el.getClientRects === "function" && el.getClientRects().length > 0) {
      if (typeof el.getBoundingClientRect === "function") {
        const r = el.getBoundingClientRect();
        return !!r && r.width > 0 && r.height > 0;
      }
      return true;
    }
    return false;
  }

  // In Gemini Task Mode ("Thinking it through..." or Remote computer panel),
  // <message-content> can stay quiet for >10s while the agent is actively
  // working. Detect active Task Mode indicators so genActive() stays true and
  // unwedgeStop() never clicks Stop mid-task.
  function isTaskModeWorking() {
    try {
      for (const el of document.querySelectorAll(TASK_PROGRESS_SEL)) {
        if (isVisible(el)) return true;
      }
      for (const el of document.querySelectorAll(TASK_BUSY_SEL)) {
        if (!isVisible(el)) continue;
        if (el.closest && (el.closest(S.userItem) || el.closest(S.reply))) continue;
        return true;
      }
      const last = lastAssistant();
      if (last && TASK_THINKING_RE.test(textWithout(last, S.reply))) {
        return true;
      }
      for (const el of document.querySelectorAll(TASK_STATUS_SEL)) {
        if (!isVisible(el)) continue;
        if (el.closest && (el.closest(S.userItem) || el.closest(S.reply))) continue;
        if (TASK_THINKING_RE.test(el.textContent || "")) return true;
      }
    } catch {}
    return false;
  }

  // Never click Stop while Gemini's "Cancel response generation?" confirmation
  // dialog is already open.
  function isCancelDialogOpen() {
    try {
      for (const el of document.querySelectorAll(DIALOG_SEL)) {
        if (!isVisible(el)) continue;
        if (CANCEL_DIALOG_RE.test(el.textContent || "")) return true;
      }
    } catch {}
    return false;
  }

  let _stopSince = 0;
  function genActive() {
    sampleStream();
    const stop = !!stopButton();
    const now = Date.now();
    if (stop) {
      if (!_stopSince) _stopSince = now;
      if (isTaskModeWorking()) {
        _streamAt = now;
        return true;
      }
      return (now - _streamAt < WEDGE_MS) || (now - _stopSince < 2000);
    }
    _stopSince = 0;
    return grewWithin(timings.GEN_IDLE_MS);
  }
  const isGenerating = genActive;
  const isBusyNow = genActive;
  const isHardGenerating = genActive;

  // Reset a WEDGED stop button. Gemini's action button can stay frozen on the
  // "stop" icon forever after a generation ENDS (the same quirk genActive guards
  // against for detection). When it does, the send (arrow_upward) button never
  // appears, so typeAndSend can't send and the injected tool result is stranded
  // in the composer (seen live: send.click found:false x4 → "Message could not
  // be sent"). Clicking the frozen stop resets the composer to its idle state and
  // arrow_upward reappears (validated live). Guarded by genActive, Task Mode
  // detection, and cancel-dialog detection so a genuinely live generation is
  // NEVER aborted. Returns true if it clicked.
  function unwedgeStop() {
    const stop = stopButton();
    if (!stop) return false;
    if (isCancelDialogOpen()) {
      diag("send.unwedgeSkip", { reason: "cancel_dialog" });
      return false;
    }
    if (isTaskModeWorking()) {
      diag("send.unwedgeSkip", { reason: "task_mode" });
      return false;
    }
    if (!genActive()) {
      diag("send.unwedge", {});
      try { stop.click(); } catch {}
      return true;
    }
    return false;
  }

  // Keep trying to unwedge for a bounded window, then confirm the send button
  // came back. One single attempt was not enough, and that is what made the
  // system prompt occasionally never leave the composer on Start:
  // genActive() latches true for 2s from the FIRST moment it sees a stop button
  // (`_stopSince`), so the very first unwedge attempt on a freshly-loaded page -
  // exactly the bootstrap case - is refused by its own guard. By the time the
  // latch expires, typeAndSend had already fallen through to the Enter fallback,
  // which does nothing on a wedged composer. Retrying across the latch window
  // fixes it without ever touching a genuinely live generation (genActive stays
  // true for the whole of a real stream, so every attempt is refused then).
  async function unwedgeStopPersistently(totalMs = 4000) {
    const t0 = Date.now();
    while (Date.now() - t0 < totalMs) {
      if (sendButton()) return true;
      if (unwedgeStop() && await waitFor(() => !!sendButton(), 1500)) return true;
      await sleep(250);
    }
    return !!sendButton();
  }

  // Gemini exposes no reliable per-turn "stopped" marker → never halted.
  const turnHalted = () => false;
  // No truncation Continue button on Gemini.
  const findContinueBtn = () => null;
  const clickContinueBtn = () => false;

  function snapshot() {
    try {
      const it = lastAssistant();
      if (!it) return { th: 0, rp: 0 };
      const think = it.querySelector(S.thinking);
      const md = it.querySelector(S.reply);
      return {
        th: think ? (think.textContent || "").trim().length : 0,
        rp: md ? (md.textContent || "").length : 0,
      };
    } catch { return {}; }
  }

  function readAssistant() {
    const item = lastAssistant();
    if (!item) return { present: false, reply: "", thinking: "", item: null };
    const think = item.querySelector(S.thinking);
    const md = item.querySelector(S.reply);
    return {
      present: true,
      reply: md ? textWithout(md, ".zs-chip").trim() : "",
      thinking: think ? (think.textContent || "").trim() : "",
      item,
    };
  }

  async function waitFor(pred, timeout) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (pred()) return true;
      await sleep(120);
    }
    return false;
  }

  // ── Sending ───────────────────────────────────────────────────────────────
  // Gemini's composer is a Quill editor wrapped by an Angular ControlValueAccessor.
  // We run in the extension's ISOLATED world, so the page's `window.Quill`
  // (and its instance API) is NOT reachable - we can only touch the shared DOM.
  // document.execCommand("insertText") drives the browser's native editing
  // pipeline, which fires the beforeinput/input events Quill's editor listens
  // to → its model updates, .ql-blank clears, the Angular CVA syncs and the send
  // button appears. This works reliably WHEN the composer is actually visible
  // (the Start gate is removed before the loop sends), which it always is during
  // the agentic loop. A selectAll first guarantees we replace any stale content.
  // PERF + FIDELITY (measured live, 2026): a single execCommand("insertText") of a
  // MULTI-LINE string is catastrophically slow in Gemini's Quill editor - every
  // "\n" makes Quill split the content into a new <p> block and re-normalise the
  // whole document, ~80ms PER LINE (linear). A ~90-line system prompt froze the
  // composer for ~7s under the "Working…" cover (big tool outputs stalled too).
  // We instead insert each line with insertText and join them with insertLineBreak
  // (a SOFT break, like Shift+Enter): the content stays in ONE block (~3ms/line,
  // ~430ms for 150 lines) yet Gemini STILL transmits the message as real, separate
  // lines (validated: the sent turn renders one query-text-line per line). Keeping
  // real line structure matters - an earlier attempt that flattened newlines to
  // U+2028 made the image-capable "Flash" model misfire into GENERATING AN IMAGE
  // at boot, because the prompt arrived as one mangled line. The first op runs over
  // the select-all so any stale content is replaced; empty lines skip insertText
  // (an empty insertText collapses the selection and breaks the following inserts).
  // Gemini has no server-side composer cap worth hitting, but its EDITOR does:
  // the insert cost below is paid per LINE, synchronously, on the page's main
  // thread, and it degrades as the document grows. A big tool result (validated
  // live: a 2599-line http_get) froze the whole page for ~a minute - nothing
  // clickable, the "Agent is working…" cover stuck, then it resumed on its own
  // once the insert finished. So the cap here is about the DOM cost, not the
  // model's context: keep head+tail, drop the middle, and tell the model that
  // content was dropped so it does not re-run the command.
  const SEND_MAX_CHARS = 120000;
  const SEND_MAX_LINES = 1200;   // the line count is what actually hurts
  function truncateForSend(text) {
    if (!text) return text;
    const lines = String(text).split("\n");
    if (text.length <= SEND_MAX_CHARS && lines.length <= SEND_MAX_LINES) return text;
    const marker = (what) =>
      `\n\n[…snapgentV3: result truncated (${what}) so it can be pasted into ` +
      `Gemini's composer without freezing the page. Do NOT re-run the command; ` +
      `work with the head and tail shown here…]\n\n`;
    let out, note;
    if (lines.length > SEND_MAX_LINES) {
      const head = Math.floor(SEND_MAX_LINES * 0.85);
      const tail = SEND_MAX_LINES - head;
      note = `${lines.length - SEND_MAX_LINES} of ${lines.length} lines omitted`;
      out = lines.slice(0, head).join("\n") + marker(note) + lines.slice(lines.length - tail).join("\n");
    } else {
      out = text;
    }
    if (out.length > SEND_MAX_CHARS) {
      const budget = SEND_MAX_CHARS - 300;
      const head = Math.floor(budget * 0.85);
      note = `${out.length - budget} of ${out.length} characters omitted`;
      out = out.slice(0, head) + marker(note) + out.slice(out.length - (budget - head));
    }
    diag("send.truncated", { from: text.length, to: out.length, lines: lines.length });
    return out;
  }

  // Yield to the event loop between chunks. Without this the whole insert is one
  // uninterruptible synchronous burst: the page cannot repaint or respond to a
  // click for its entire duration (the "I can't click anything anymore" report).
  // Yielding does not make the insert faster, it makes the page stay alive while
  // it happens - and lets the Stop button remain usable.
  const INSERT_CHUNK_LINES = 120;
  async function setEditorText(ed, text) {
    ed.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(ed);
    sel.removeAllRanges();
    sel.addRange(range);
    const lines = String(text).split("\n");
    const t0 = Date.now();
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]) document.execCommand("insertText", false, lines[i]);
      if (i < lines.length - 1) document.execCommand("insertLineBreak");
      if (i && i % INSERT_CHUNK_LINES === 0) await sleep(0);
    }
    if (lines.length > INSERT_CHUNK_LINES) diag("send.insertDone", { lines: lines.length, ms: Date.now() - t0 });
  }

  function requestTabWake() {
    try {
      if (typeof chrome !== "undefined" && chrome.runtime && typeof chrome.runtime.sendMessage === "function") {
        diag("send.wakeTab", {});
        chrome.runtime.sendMessage({ type: "zs-wake-tab" }, () => void (chrome.runtime && chrome.runtime.lastError));
        return true;
      }
    } catch {}
    return false;
  }

  async function typeAndSend(text, images) {
    const ed = getEditor();
    if (!ed) throw new Error("Gemini input box not found");
    // Cap BEFORE any comparison below, so the retry path's `editorText() !== text`
    // test compares against what we actually typed.
    text = truncateForSend(text);
    const relock = _locked;
    if (relock) ed.setAttribute("contenteditable", "true"); // injection needs it editable
    try {
      // submitAndGetBase RETRIES this whole function (up to 4x) when the send
      // doesn't land within its window. Naively redoing both steps every retry
      // is destructive: (1) setEditorText's select-all + insertText wipes the
      // editor's internal reference to whatever is already pending, and (2)
      // pasting again attaches ANOTHER duplicate file on top of the first
      // (validated live: 3 retries produced 3 separate attach.dispatchPaste
      // calls with 3 different files, and the model's replies stayed generic
      // - it never got one coherent image). So: only retype if the text isn't
      // already there, and only attach if nothing is pending yet.
      if (editorText() !== text) await setEditorText(ed, text);
      const hasPendingAttachment = () => {
        const box = document.querySelector(S.inputArea);
        return !!(box && box.querySelector("[class*='preview'], [class*='thumbnail']"));
      };
      if (images && images.length && !hasPendingAttachment()) {
        diag("attach.beforeCall", { count: images.length });
        try { const ok = await attachImages(images); diag("attach.afterCall", { ok }); }
        catch (e) { diag("attach.threw", { msg: String((e && e.message) || e) }); }
      }
      if (!sendButton() && typeof document !== "undefined" && document.hidden) {
        requestTabWake();
        await waitFor(() => !!sendButton(), 1500);
      }
      // A generation that just ended can leave the action button WEDGED on the
      // stop icon (see unwedgeStop), so arrow_upward never appears and the send
      // fails. If the stream is frozen yet a stop button shows, reset it first.
      if (!sendButton()) await unwedgeStopPersistently();
      // Wait for Angular to render the send (arrow_upward) button - proof that
      // it registered the text. The Quill-API injection (see setEditorText)
      // fires text-change so this resolves; if it doesn't, the send won't work.
      await waitFor(() => !!sendButton(), 3000);
      // Last resort before the Enter fallback: re-type. A composer that was
      // wedged when setEditorText ran can swallow the insert entirely, leaving
      // an empty editor and therefore no send button - the "Start did nothing,
      // the system prompt was never sent" report. Retyping now that the stop is
      // cleared is safe: the editor is either empty or holds our own text.
      if (!sendButton() && editorText() !== text) {
        diag("send.retype", {});
        await setEditorText(ed, text);
        await waitFor(() => !!sendButton(), 2000);
      }
      const btn = sendButton();
      diag("send.click", { found: !!btn, pending: hasPendingAttachment() });
      if (btn) { btn.click(); return; }
      // Fallback: Enter sends in Gemini's composer.
      const o = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
      ed.dispatchEvent(new KeyboardEvent("keydown", o));
      ed.dispatchEvent(new KeyboardEvent("keyup", o));
    } finally {
      if (relock) { const e2 = getEditor(); if (e2) e2.setAttribute("contenteditable", "false"); }
    }
  }

  function stopGeneration() {
    const b = stopButton();
    if (b) try { b.click(); } catch {}
  }

  function findModePickerButton() {
    const btns = [...document.querySelectorAll("button")].filter(isVisible);
    return (
      btns.find((b) => b.getAttribute("data-test-id") === "bard-mode-menu-button") ||
      btns.find((b) => /mode picker/i.test(b.getAttribute("aria-label") || "")) ||
      btns.find((b) => /hydrogen|neon/i.test(b.textContent || "")) ||
      null
    );
  }

  function parseModeLabel(btn) {
    if (!btn) return { raw: "", model: "unknown", thinking: "" };
    const rawText = (btn.innerText || btn.textContent || "").trim();
    const ariaRaw = (btn.getAttribute("aria-label") || "").trim();
    const ariaCur = ariaRaw.replace(/^open mode picker,?\s*(?:currently)?\s*/i, "").trim();
    const combined = [ariaCur, rawText]
      .filter(Boolean)
      .join(" ")
      .replace(/([a-z])([A-Z])/g, "$1 $2");
    let model = ariaCur || rawText || "unknown";
    if (/hydrogen/i.test(combined)) model = "4 Hydrogen";
    else if (/neon/i.test(combined)) model = "4 Neon";
    else if (/\bauto\b/i.test(combined)) model = "Auto";
    let thinking = "";
    if (/\bhigh\b/i.test(combined)) thinking = "High";
    else if (/\bmedium\b/i.test(combined)) thinking = "Medium";
    else if (/\blow\b/i.test(combined)) thinking = "Low";
    // Live Gemini omits "Low" from the label ("Hydrogen" / "Neon") while it
    // always prints "Medium" / "High", so a bare model name means Low.
    if (!thinking && (model === "4 Hydrogen" || model === "4 Neon")) thinking = "Low";
    return { raw: ariaCur || rawText, model, thinking };
  }

  function normalizeModeTarget(target) {
    if (target && target.preserveMode) return { preserveMode: true, model: "", thinking: "" };
    const hasExplicit = !!(target && (target.model || target.thinking));
    const rawModel = String((target && target.model) || "").trim();
    const rawThinking = String((target && target.thinking) || "").trim();
    let model = "";
    if (/hydrogen/i.test(rawModel)) model = "4 Hydrogen";
    else if (/neon/i.test(rawModel)) model = "4 Neon";
    else if (/auto/i.test(rawModel)) model = "Auto";
    else if (!hasExplicit) model = "4 Hydrogen";
    let thinking = "";
    if (model !== "Auto") {
      if (/high/i.test(rawThinking)) thinking = "High";
      else if (/medium/i.test(rawThinking)) thinking = "Medium";
      else if (/low/i.test(rawThinking)) thinking = "Low";
      else if (!hasExplicit) thinking = "High";
    }
    return { preserveMode: false, model, thinking };
  }

  const visibleMenuItems = () => [...document.querySelectorAll("gem-menu-item")].filter(isVisible);
  const isItemSelected = (m) =>
    !!m && (/\bselected\b/.test(String(m.className || "")) || m.getAttribute("aria-checked") === "true");
  const isUpsellItem = (m) =>
    !!m && /upsell/i.test(String(m.getAttribute("data-mode-id") || m.getAttribute("data-test-id") || ""));

  function findMenuItem(re, role) {
    return visibleMenuItems().find(
      (m) => (!role || m.getAttribute("role") === role) && re.test((m.textContent || "").trim())
    ) || null;
  }

  async function openModeMenu(btn) {
    if (visibleMenuItems().length > 0) return true;
    const b = findModePickerButton() || btn;
    if (!b) return false;
    try { b.click(); } catch {}
    const opened = await waitFor(() => visibleMenuItems().length > 0, 1500);
    if (opened) await sleep(120); // let Angular finish wiring item handlers
    return opened;
  }

  // Live Angular <gem-menu> ignores Escape dispatched on `document` (validated
  // 2026-11 via CDP: 7 items stayed open) but closes on Escape dispatched on a
  // menu item. No .cdk-overlay-backdrop exists; .popover-click-shield is the
  // click-outside surface, kept as a fallback.
  async function closeModeMenu() {
    if (visibleMenuItems().length === 0) return;
    const esc = () => new KeyboardEvent("keydown", {
      key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true,
    });
    const first = visibleMenuItems()[0];
    try { if (first && typeof first.dispatchEvent === "function") first.dispatchEvent(esc()); } catch {}
    try { if (visibleMenuItems().length > 0) document.dispatchEvent(esc()); } catch {}
    if (await waitFor(() => visibleMenuItems().length === 0, 600)) return;
    const shield = document.querySelector(".popover-click-shield") ||
      document.querySelector(".cdk-overlay-backdrop") || findModePickerButton();
    try { if (shield) shield.click(); } catch {}
    await waitFor(() => visibleMenuItems().length === 0, 500);
  }

  async function selectModelItem(btn, wantModel) {
    const re = wantModel === "Auto" ? /^auto\b/i : new RegExp(wantModel.replace(/\s+/g, "\\s+"), "i");
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!(await openModeMenu(findModePickerButton() || btn))) continue;
      const item = findMenuItem(re, "menuitemradio");
      if (!item || isUpsellItem(item)) { await closeModeMenu(); return false; }
      if (!isItemSelected(item)) {
        try { item.click(); } catch {}
        await waitFor(() => parseModeLabel(findModePickerButton()).model === wantModel, 4000);
        await waitFor(() => visibleMenuItems().length === 0, 600);
      }
      if (parseModeLabel(findModePickerButton()).model === wantModel) return true;
      diag("mode_switch.retry", { step: "model", wantModel, attempt });
      await closeModeMenu();
      await sleep(250);
    }
    return parseModeLabel(findModePickerButton()).model === wantModel;
  }

  async function selectThinkingItem(btn, wantThinking) {
    const optRe = new RegExp(`^${wantThinking}\\b`, "i");
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!(await openModeMenu(findModePickerButton() || btn))) continue;
      if (!findMenuItem(optRe, "menuitemradio")) {
        const trigger = findMenuItem(/thinking level/i) ||
          visibleMenuItems().find((m) => m.getAttribute("value") === "thinking_level");
        if (!trigger) { await closeModeMenu(); return false; }
        try { trigger.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true })); } catch {}
        try { trigger.click(); } catch {}
        if (await waitFor(() => !!findMenuItem(optRe, "menuitemradio"), 1500)) await sleep(120);
      }
      const opt = findMenuItem(optRe, "menuitemradio");
      if (opt && !isItemSelected(opt)) {
        try { opt.click(); } catch {}
        await waitFor(() => parseModeLabel(findModePickerButton()).thinking === wantThinking, 4000);
      }
      await closeModeMenu();
      if (parseModeLabel(findModePickerButton()).thinking === wantThinking) return true;
      diag("mode_switch.retry", { step: "thinking", wantThinking, attempt });
      await sleep(250);
    }
    return parseModeLabel(findModePickerButton()).thinking === wantThinking;
  }

  // Restore or switch Gemini's model/thinking mode at session startup (or on explicit
  // mode metadata). Manual UI starts pass { preserveMode: true } so user selection holds.
  async function ensureFocusMode(target) {
    let btn = findModePickerButton();
    if (!btn) {
      // Narrow/mobile Gemini layout lazy-mounts the top-bar mode picker only
      // after the composer receives focus/click.
      const ed = getEditor();
      if (ed) {
        try {
          if (typeof ed.focus === "function") ed.focus();
          if (typeof ed.click === "function") ed.click();
        } catch {}
        await waitFor(() => !!findModePickerButton(), 1500);
        btn = findModePickerButton();
      }
    }
    const observed = parseModeLabel(btn);
    if (!btn) return { applied: false, model: observed.model, thinking: observed.thinking };
    const want = normalizeModeTarget(target);
    if (want.preserveMode) {
      return { applied: true, model: observed.model, thinking: observed.thinking };
    }
    const modelOk = !want.model || observed.model === want.model;
    const thinkOk = !want.thinking || want.model === "Auto" || observed.thinking === want.thinking;
    if (modelOk && thinkOk) {
      return { applied: true, model: observed.model, thinking: observed.thinking };
    }
    let applied = true;
    if (want.model && observed.model !== want.model) {
      applied = await selectModelItem(btn, want.model);
    }
    const mid = parseModeLabel(findModePickerButton());
    if (applied && want.thinking && mid.model !== "Auto" && mid.thinking !== want.thinking) {
      applied = await selectThinkingItem(findModePickerButton() || btn, want.thinking);
    }
    await closeModeMenu();
    const after = parseModeLabel(findModePickerButton());
    const finalModelOk = !want.model || after.model === want.model;
    const finalThinkOk = !want.thinking || after.model === "Auto" || after.thinking === want.thinking;
    const ok = applied && finalModelOk && finalThinkOk;
    diag("mode_switch", { observed, want, after, applied: ok });
    return { applied: ok, model: after.model, thinking: after.thinking };
  }

  // No other site modes to enforce on Gemini.
  function enforceComposer() { return { ready: true }; }
  async function ensureComposerReady(reason, opts) {
    let mode;
    if (reason === "startup" || reason === "mode") {
      mode = await ensureFocusMode(opts);
    } else {
      const cur = parseModeLabel(findModePickerButton());
      mode = {
        applied: cur.model === "4 Hydrogen" && cur.thinking === "High",
        model: cur.model,
        thinking: cur.thinking,
      };
    }
    const state = { ready: !!getEditor(), model: mode.model, thinking: mode.thinking, modeApplied: mode.applied };
    diag("mode_ready", { reason, provider: "gemini", ...state });
    return state;
  }

  // ── Error / limit detection (site chrome only) ────────────────────────────
  function scanError() {
    try {
      for (const el of document.querySelectorAll(S.errorSurfaces)) {
        if (el.offsetParent === null) continue;
        if (el.closest(S.anyItem)) continue; // model content, not UI chrome
        const t = (el.innerText || "").trim();
        if (t.length > 8 && t.length < 600 && RE.contextLimit.test(t)) return t.slice(0, 240);
      }
    } catch {}
    if (!getEditor()) return "The input box disappeared (session ended?).";
    return null;
  }
  const isTooLongMsg = (text) => RE.tooLong.test(text);
  const isBusyMsg = (text) => RE.busy.test(text);

  // ── Image attachment (best effort: paste onto the composer) ──────────────
  function fileFromImage(img, i) {
    const mime = img.mimeType || "image/jpeg";
    const bin = atob(img.data);
    const arr = new Uint8Array(bin.length);
    for (let j = 0; j < bin.length; j++) arr[j] = bin.charCodeAt(j);
    const ext = mime.includes("png") ? "png" : "jpg";
    return new File([arr], `snapgentV3_${Date.now()}_${i}.${ext}`, { type: mime });
  }
  async function attachImages(images) {
    const ed = getEditor();
    if (!ed) { diag("attach.noEditor"); return false; }
    if (!images || !images.length) return false;
    const dt = new DataTransfer();
    images.forEach((img, i) => { try { dt.items.add(fileFromImage(img, i)); } catch {} });
    if (!dt.items.length) { diag("attach.noDtItems"); return false; }
    diag("attach.dispatchPaste", { items: dt.items.length });
    ed.focus();
    ed.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    // An upload preview appearing in the input area is the FAST accepted-signal,
    // but it renders instantly from a local blob: URL - well before Gemini
    // finishes uploading the file to its backend. Sending while the upload's
    // own progress spinner is still up silently drops the attachment (validated
    // live: the message went out text-only and the file sat in the composer,
    // unsent, indefinitely - even though the preview had long since appeared).
    const previewOk = await waitFor(() => {
      const box = document.querySelector(S.inputArea);
      return !!(box && box.querySelector("img, [class*='preview'], [class*='thumbnail']"));
    }, 15000);
    diag("attach.previewOk", { previewOk });
    if (!previewOk) return false;
    // Gemini's uploader renders a <mat-spinner> (Angular Material) inside the
    // file-preview container while the paste is still uploading to its backend
    // - NOT mat-progress-spinner. Missing it here made the wait resolve instantly,
    // so the send fired mid-upload and the file was dropped (text went out alone,
    // the attachment stuck loading in the composer). Verified live: the mat-spinner
    // is present ~2-4s (grows with file size), then removed on completion.
    const spinnerSel = 'mat-spinner, mat-progress-spinner, progress, [role="progressbar"]';
    const hasSpinner = () => {
      const box = document.querySelector(S.inputArea);
      return !!(box && box.querySelector(spinnerSel));
    };
    // The preview wrapper and the spinner mount in the SAME Angular render, so a
    // "no spinner ⇒ done" check can win a frame before the spinner appears and
    // resolve prematurely. First give the spinner a short window to show up; if it
    // never does (tiny file, instant upload) that's fine - proceed either way.
    await waitFor(hasSpinner, 1500);
    const spinnerCleared = await waitFor(() => !hasSpinner(), 20000);
    diag("attach.spinnerCleared", { spinnerCleared });
    return true;
  }
  function clearAttachments() {
    try {
      const box = document.querySelector(S.inputArea);
      if (!box) return;
      box.querySelectorAll("[aria-label*='upprimer'], [aria-label*='emove'], [class*='delete'], [class*='remove']")
        .forEach((d) => { try { d.click(); } catch {} });
    } catch {}
  }


  // A conversation with NO turns rendered yet is treated as transient ("") so
  // the core never persists it - and never stays sticky on it - as "started".
  // This covers both the bare "/app" route AND Gemini's "New chat" button,
  // which clears the turn list but keeps the PREVIOUS conversation's /app/<id>
  // in the address bar until the first message is actually sent (see
  // isFreshChat() above for the full story).
  const conversationKey = () =>
    (chatIsEmpty() || /\/app\/?$/.test(location.pathname)) ? "" : location.pathname;

  // ── User-send interception ────────────────────────────────────────────────
  function installSendHooks(handlers) {
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
        const ed = getEditor();
        if (!ed || !ed.contains(e.target)) return;
        if (editorText().trim() === "") return;
        if (handlers.isBlocked()) return;
        if (!handlers.isStarted()) {
          if (!chatIsEmpty()) return; // existing conversation → not ours to gate
          handlers.onBlockedAttempt(); // nudge only; never block plain chat
          return;
        }
        handlers.onUserMessage(assistantCount());
      },
      true
    );

    document.addEventListener(
      "click",
      (e) => {
        if (!getEditor()) return;
        const btn = e.target && e.target.closest && e.target.closest(`${S.inputArea} button`);
        if (!btn) return;
        const ic = iconName(btn);
        if (ic === "stop") {
          // Only a REAL user click is a native stop. unwedgeStop() clicks this
          // same button programmatically to reset a frozen stop icon before a
          // send - that synthetic click (isTrusted=false) must NOT be mistaken
          // for the user halting the agent, or the next legit command gets
          // marked "stopped" and the loop wrongly winds down (seen live).
          if (!e.isTrusted) return;
          handlers.onNativeStop();
          return;
        }
        if (ic !== "arrow_upward") return;
        if (handlers.isBlocked()) return;
        if (!handlers.isStarted()) {
          if (!chatIsEmpty()) return;
          handlers.onBlockedAttempt(); // nudge only; never block plain chat
          return;
        }
        handlers.onUserMessage(assistantCount());
      },
      true
    );
  }

  // ── Tool-block location for camouflage ────────────────────────────────────
  // Gemini wraps each fenced code block in a <code-block> element (markers and
  // JSON survive intact in textContent), and a whole ###LUA###…###END_LUA### or
  // ###MCP_TOOL### block is ONE atomic code-block. So hiding is simple and
  // robust: hide every <code-block> in the reply whose text carries a command
  // shape, plus any bare top-level paragraph that holds an inline command (the
  // model is told to use code blocks, but this catches a stray inline one).
  // The host-walk the DeepSeek provider uses is WRONG here - it descends inside
  // a code-block, so hiding the wrapper then fails. The core anchors the chip at
  // the turn level (chipAtItemLevel), so the returned position is unused; this
  // function's real job is applying the .zs-tool-hide classes correctly.
  const CMD_SHAPE = /"(?:command|tool)"\s*:\s*"|###\s*lua|###mcp_tool###/i;
  function findToolBlockSpot(item /*, chip */) {
    const replies = [...item.querySelectorAll(S.reply)].filter((m) => !m.closest(S.thinking));
    let hidAny = null;
    for (const mc of replies) {
      // 1. Fenced code blocks carrying a command.
      mc.querySelectorAll(S.codeWrap).forEach((cb) => {
        if (cb.closest(".zs-chip")) return;
        if (CMD_SHAPE.test(cb.textContent || "")) {
          cb.classList.add("zs-tool-hide");
          // Angular recreates <code-block> nodes (markdown settle at end of
          // stream + again when the next turn is sent), stripping the class
          // above and flashing the raw command until the next sweep. The
          // <message-content> element KEEPS its identity through those
          // re-renders (validated live), so also mark it: the overlay.css
          // rule `message-content.zs-cmd-mask code-block` keeps every
          // recreated block hidden with zero flash.
          mc.classList.add("zs-cmd-mask");
          hidAny = hidAny || { parent: cb.parentElement, ref: cb };
        }
      });
      // 2. Bare top-level blocks with an inline command (no code-block inside).
      [...mc.children].forEach((el) => {
        if (el.classList.contains("zs-chip") || el.querySelector(S.codeWrap)) return;
        const t = el.textContent || "";
        if (t.length < 600 && CMD_SHAPE.test(t)) {
          el.classList.add("zs-tool-hide");
          hidAny = hidAny || { parent: el.parentElement, ref: el };
        }
      });
    }
    return hidAny;
  }

  return B.createProvider({
    id: "gemini",
    displayName: "Gemini",
    // Gemini's web model is natively multimodal (image understanding), so
    // screen_capture is safe to expose here. Other providers default this
    // to false until confirmed live (see main.js BLOCKED_TOOLS gate).
    supportsVision: true,
    timings,
    // Reasoning-area selector, exported so the CORE's raw-command-visible probes
    // exclude it (same fix as DeepSeek): Gemini's thinking models (2.5 Pro/Flash)
    // render their reasoning in <model-thoughts> and often QUOTE the command
    // JSON/###LUA### there. The camouflage never hides that quote (by design), so
    // without this exclusion the core reads it as "raw block still visible"
    // forever - the chip then FLAPS done→run→done and rebuilds on every sweep.
    thinkingSel: S.thinking,
    // Gemini (Angular) re-renders a turn's content subtree on every update,
    // wiping any chip placed inside it. Tell the core to anchor chips at the
    // turn-element level instead, where they survive those re-renders.
    chipAtItemLevel: true,
    // The "Working…" input cover overshoots the editor box by this many px on
    // each side. Gemini's Quill keeps typed text near the rounded corners, so a
    // few px of bleed hides the slivers that would otherwise peek (see placeBar /
    // inputCover). Providers with a native <textarea> omit this (default 0).
    coverPad: 8,
    // Gemini's .ql-editor rect sits a few px below the visual input-box centre,
    // so nudge the "Agent is working…" cover up to read as vertically centred.
    coverOffsetY: -6,
    // Gemini's turn elements are semantic and never virtualized away, so
    // assistantCount() reliably increases for every new reply. The core's
    // watcher uses this to refuse finalizing before this send's reply turn
    // exists (fixes premature loop.end on the previous turn's stable text).
    reliableCounts: true,
    // Shown as a permanent, non-intrusive notice in the snapgentV3 panel.
    // Gemini drifts away from emitting tool blocks after a while in long
    // sessions - observed live, model behavior, not something the prompt fixes.
    unstableWarning:
      "Gemini may stop using tools in long sessions. Remind it to use the commands, or start a new chat",
    init({ diag: d } = {}) { if (d) diag = d; },
    // turns
    allItems, isUserItem, isAssistantItem, itemText, classifyText,
    assistantCount, userCount, lastAssistant, readAssistant,
    streamLen, snapshot,
    // composer / state
    getEditor, editorText, chatIsEmpty, isFreshChat, composerFrame, barMount,
    setInputLock, typeAndSend, stopGeneration,
    isGenerating, isBusyNow, isHardGenerating,
    enforceComposer, ensureComposerReady,
    turnHalted, findContinueBtn, clickContinueBtn,
    scanError, isTooLongMsg, isBusyMsg,
    // actions
    attachImages, clearAttachments, conversationKey,
    installSendHooks, findToolBlockSpot,
    __test: {
      WEDGE_MS,
      isTaskModeWorking,
      isCancelDialogOpen,
      unwedgeStop,
      genActive,
      resetStreamState: () => { _stream.reset(); _streamAt = 0; _stopSince = 0; },
    },
  });
})();
