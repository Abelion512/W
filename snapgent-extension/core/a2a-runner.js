// SPDX-License-Identifier: GPL-3.0-or-later
// core/a2a-runner.js - A2A prompt runner, cancellation, fresh-chat opening, and chunk emission.
// Extracted from core/main.js so A2A lifecycle logic stays isolated and testable.
const ZSA2ARunner = (() => {
  "use strict";

  const NEW_CHAT_LABEL = /^(new chat|new conversation|new thread|chat baru|nouveau chat|nuevo chat)$/i;
  // Some sites put their reasoning UI INSIDE the answer turn, and the readable
  // text then starts with its status line (measured live: Kimi -> "Thinking
  // process      PONG"). Strip those leading status lines and nothing else.
  const REASONING_HEAD = /^(thinking (process|complete)|thought for \d+(?:\.\d+)?\s*s(?:ec(?:onds?)?)?)\s*[:.\-]?\s*/i;
  const A2A_HARD_CAP_MS = 30 * 60 * 1000;

  function findNewChatControl(doc) {
    const rootDoc = doc || (typeof document !== "undefined" ? document : null);
    if (!rootDoc || typeof rootDoc.querySelectorAll !== "function") return null;
    const candidates = [...rootDoc.querySelectorAll('button, a, [role="button"], [tabindex="0"]')];
    const matches = candidates.filter((el) => {
      if (el.closest && el.closest("#zs-root")) return false;
      if (el.hidden || (el.getAttribute && el.getAttribute("aria-hidden") === "true")) return false;
      const label = (el.innerText || (el.getAttribute && el.getAttribute("aria-label")) || el.textContent || "")
        .trim().replace(/\s+/g, " ");
      return NEW_CHAT_LABEL.test(label);
    });
    if (!matches.length) return null;
    // Prefer rendered controls first, falling back when sidebar drawers collapse rects to 0 (e.g. DeepSeek).
    return matches.find((el) => el.getClientRects && el.getClientRects().length > 0) || matches[0];
  }

  function cleanA2AText(raw) {
    let text = String(raw || "").trim();
    let previous;
    do {
      previous = text;
      text = text.replace(REASONING_HEAD, "").trim();
    } while (text !== previous);
    return text;
  }

  function defaultSendRuntimeMessage(payload) {
    try {
      if (typeof chrome !== "undefined" && chrome && chrome.runtime && chrome.runtime.sendMessage) {
        const promise = chrome.runtime.sendMessage(payload);
        if (promise && typeof promise.catch === "function") promise.catch(() => {});
      }
    } catch {}
  }

  function createRunner(deps) {
    const P = deps.provider;
    const A = deps.state;
    const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const diag = deps.diag || (() => {});
    const startSession = deps.startSession;
    const submitAndGetBase = deps.submitAndGetBase;
    const agentLoop = deps.agentLoop;
    const syncSessionState = deps.syncSessionState;
    const sendRuntimeMessage = deps.sendRuntimeMessage || defaultSendRuntimeMessage;
    const doc = deps.doc;
    const hardCapMs = deps.hardCapMs == null ? A2A_HARD_CAP_MS : deps.hardCapMs;
    const chunkIntervalMs = deps.chunkIntervalMs == null ? 600 : deps.chunkIntervalMs;

    let a2aAborted = false;
    let a2aAbortReason = "";
    let a2aCurrentId = null;
    let a2aChunkId = null;
    let a2aChunkLen = 0;
    let a2aChunkAt = 0;

    function getCurrentId() {
      return a2aCurrentId;
    }

    function resetChunk() {
      a2aChunkLen = 0;
    }

    function emitChunkIfDue(reply, nowMs) {
      if (!a2aCurrentId || !reply) return false;
      if (a2aChunkId !== a2aCurrentId) {
        a2aChunkId = a2aCurrentId;
        a2aChunkLen = 0;
        a2aChunkAt = 0;
      }
      const ts = nowMs == null ? Date.now() : nowMs;
      if (reply.length > a2aChunkLen && ts - a2aChunkAt >= chunkIntervalMs) {
        const delta = reply.slice(a2aChunkLen);
        a2aChunkLen = reply.length;
        a2aChunkAt = ts;
        sendRuntimeMessage({ type: "a2a_chunk", promptId: a2aCurrentId, text: delta });
        return true;
      }
      return false;
    }

    function freshChatReady() {
      if (typeof P.isFreshChat === "function") return !!P.isFreshChat();
      if (!P.chatIsEmpty()) return false;
      return typeof P.getEditor === "function" ? !!P.getEditor() : true;
    }

    async function openFreshChat() {
      if (freshChatReady()) return true;
      const controlDeadline = Date.now() + 10000;
      let control = null;
      while (!(control = findNewChatControl(doc))) {
        if (a2aAborted || Date.now() >= controlDeadline) return false;
        await sleep(400);
      }
      if (a2aAborted) return false;
      control.click();
      const started = Date.now();
      while (Date.now() - started < 12000) {
        if (a2aAborted) return false;
        await sleep(250);
        if (freshChatReady()) return true;
      }
      return freshChatReady();
    }

    function abort(reason) {
      if (!a2aCurrentId) return;
      a2aAborted = true;
      a2aAbortReason = String(reason || "cancelled");
      A.stop = true;
      try { P.stopGeneration(); } catch {}
      diag("a2a.abort", { reason, promptId: a2aCurrentId });
    }

    function abortIfMatches(promptId, reason) {
      if (!promptId || promptId === a2aCurrentId) abort(reason || "bridge-cancel");
    }

    async function runPrompt(prompt, promptId, opts) {
      const reply = (payload) => {
        sendRuntimeMessage({ type: "a2a_result", promptId, ...payload });
      };
      const modeOpts = opts && typeof opts === "object" ? opts.mode : null;
      try {
        const unwindDeadline = Date.now() + 3000;
        while ((a2aCurrentId && a2aAborted) || ((A.running || A.starting || A.injecting) && (a2aAborted || A.stop))) {
          if (Date.now() >= unwindDeadline) break;
          await sleep(50);
        }
        if (A.running || A.starting || A.injecting || a2aCurrentId) {
          throw new Error("The web AI is already working on another task.");
        }
        if (typeof syncSessionState === "function") {
          try { syncSessionState(); } catch {}
        }
        a2aAborted = false;
        a2aAbortReason = "";
        a2aCurrentId = promptId;
        A.lastLoopError = "";
        const cap = setTimeout(() => abort("hard-cap"), hardCapMs);
        let loopText = "";
        try {
          if (!A.started && !a2aAborted) {
            const composerDeadline = Date.now() + 30000;
            while (!a2aAborted && !(P.getEditor && P.getEditor())) {
              if (Date.now() >= composerDeadline) {
                throw new Error("The provider composer never appeared (waited 30s). Reload the tab and retry.");
              }
              await sleep(500);
            }
            if (!a2aAborted && !(await openFreshChat())) {
              throw new Error(
                "Could not start a Snapgent session: this chat already has messages " +
                "and no new-chat button was found. Open a new chat and retry."
              );
            }
            if (!a2aAborted && A.starting && !A.started) { A.starting = false; A.startGen++; }
            if (!a2aAborted) await startSession(modeOpts);
            const fatalStartRe = /limit|quota|allowance|unavailable|tls connect|rate limited|sign in|log in|context limit|too long|ai request failed/i;
            if (!a2aAborted && !A.started && !fatalStartRe.test(A.lastStartFailure || "")) {
              await sleep(2000);
              if (!a2aAborted && ((P.chatIsEmpty && P.chatIsEmpty()) || await openFreshChat())) {
                if (!a2aAborted) await startSession(modeOpts);
              }
            }
            if (!a2aAborted && !A.started) {
              throw new Error("Could not start a Snapgent session in this chat." +
                (A.lastStartFailure ? ` ${A.lastStartFailure}` : ""));
            }
          } else if (!a2aAborted && modeOpts && (modeOpts.model || modeOpts.thinking) &&
                     typeof P.ensureComposerReady === "function") {
            await P.ensureComposerReady("mode", modeOpts);
          }
          if (!a2aAborted && !A.stop) {
            const base = await submitAndGetBase(prompt);
            if (!a2aAborted && !A.stop) {
              const result = await agentLoop(base);
              if (typeof result === "string") loopText = result;
            } else if (a2aAborted) {
              try { P.stopGeneration(); } catch {}
            }
          }
        } finally {
          clearTimeout(cap);
        }
        if (a2aAborted) {
          const msg = a2aAbortReason === "hard-cap"
            ? "The task hit the extension hard cap without completing."
            : "The task was cancelled: the caller stopped waiting.";
          reply({ ok: false, error: msg });
          return;
        }
        if (A.lastLoopError) {
          const err = String(A.lastLoopError);
          A.lastLoopError = "";
          reply({ ok: false, error: err });
          return;
        }
        const item = P.lastAssistant();
        const domText = item ? P.itemText(item) : "";
        const readText = (!domText && P.readAssistant) ? ((P.readAssistant() || {}).reply || "") : "";
        const text = cleanA2AText(domText || readText || loopText);
        if (!text) {
          reply({ ok: false, error: "The web AI returned an empty reply." });
          return;
        }
        reply({ ok: true, text, tokens: Math.max(1, Math.round(text.length / 4)) });
      } catch (error) {
        reply({ ok: false, error: String((error && error.message) || error) });
      } finally {
        if (a2aCurrentId === promptId) {
          a2aCurrentId = null;
          a2aAborted = false;
          a2aAbortReason = "";
          if (!A.running && !A.starting) A.stop = false;
        }
      }
    }

    return {
      getCurrentId,
      resetChunk,
      emitChunkIfDue,
      openFreshChat,
      abort,
      abortIfMatches,
      runPrompt,
    };
  }

  return {
    NEW_CHAT_LABEL,
    REASONING_HEAD,
    A2A_HARD_CAP_MS,
    findNewChatControl,
    cleanA2AText,
    createRunner,
  };
})();
