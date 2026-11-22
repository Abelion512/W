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
  const A2A_HARD_CAP_MS = 15 * 60 * 1000;

  function findNewChatControl(doc) {
    const rootDoc = doc || (typeof document !== "undefined" ? document : null);
    if (!rootDoc || typeof rootDoc.querySelectorAll !== "function") return null;
    const candidates = [...rootDoc.querySelectorAll('button, a, [role="button"]')];
    return candidates.find((el) => {
      if (el.closest && el.closest("#zs-root")) return false;
      if (el.hidden || (el.getAttribute && el.getAttribute("aria-hidden") === "true")) return false;
      if (!rootDoc.hidden && (!el.getClientRects || !el.getClientRects().length)) return false;
      const label = (el.innerText || (el.getAttribute && el.getAttribute("aria-label")) || el.textContent || "")
        .trim().replace(/\s+/g, " ");
      return NEW_CHAT_LABEL.test(label);
    }) || null;
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
    const sendRuntimeMessage = deps.sendRuntimeMessage || defaultSendRuntimeMessage;
    const doc = deps.doc;
    const hardCapMs = deps.hardCapMs == null ? A2A_HARD_CAP_MS : deps.hardCapMs;
    const chunkIntervalMs = deps.chunkIntervalMs == null ? 600 : deps.chunkIntervalMs;

    let a2aAborted = false;
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

    async function openFreshChat() {
      if (P.chatIsEmpty()) return true;
      const controlDeadline = Date.now() + 10000;
      let control = null;
      while (!(control = findNewChatControl(doc))) {
        if (Date.now() >= controlDeadline) return false;
        await sleep(400);
      }
      control.click();
      const started = Date.now();
      while (Date.now() - started < 12000) {
        await sleep(250);
        if (P.chatIsEmpty() && (!P.getEditor || P.getEditor())) return true;
      }
      return P.chatIsEmpty();
    }

    function abort(reason) {
      if (!a2aCurrentId) return;
      a2aAborted = true;
      A.stop = true;
      try { P.stopGeneration(); } catch {}
      diag("a2a.abort", { reason, promptId: a2aCurrentId });
    }

    function abortIfMatches(promptId, reason) {
      if (!promptId || promptId === a2aCurrentId) abort(reason || "bridge-cancel");
    }

    async function runPrompt(prompt, promptId) {
      const reply = (payload) => {
        sendRuntimeMessage({ type: "a2a_result", promptId, ...payload });
      };
      try {
        if (A.running || A.starting || A.injecting) {
          throw new Error("The web AI is already working on another task.");
        }
        a2aAborted = false;
        a2aCurrentId = promptId;
        const cap = setTimeout(() => abort("hard-cap"), hardCapMs);
        let loopText = "";
        try {
          if (!A.started) {
            const composerDeadline = Date.now() + 30000;
            while (!(P.getEditor && P.getEditor())) {
              if (Date.now() >= composerDeadline) {
                throw new Error("The provider composer never appeared (waited 30s). Reload the tab and retry.");
              }
              await sleep(500);
            }
            if (!(await openFreshChat())) {
              throw new Error(
                "Could not start a Snapgent session: this chat already has messages " +
                "and no new-chat button was found. Open a new chat and retry."
              );
            }
            if (A.starting && !A.started) { A.starting = false; A.startGen++; }
            await startSession();
            if (!A.started) {
              await sleep(2000);
              await startSession();
            }
            if (!A.started) {
              throw new Error("Could not start a Snapgent session in this chat." +
                (A.lastStartFailure ? ` ${A.lastStartFailure}` : ""));
            }
          }
          const base = await submitAndGetBase(prompt);
          const result = await agentLoop(base);
          if (typeof result === "string") loopText = result;
        } finally {
          clearTimeout(cap);
        }
        if (a2aAborted) {
          reply({ ok: false, error: "The task was cancelled: the caller stopped waiting." });
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
        if (a2aCurrentId === promptId) a2aCurrentId = null;
        a2aAborted = false;
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
