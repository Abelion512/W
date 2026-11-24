// SPDX-License-Identifier: GPL-3.0-or-later
// core/channel.js - runtime messaging, stale-extension detection, and status polling.
// Extracted from core/main.js so channel/reconnect handling stays isolated and testable.
const ZSChannel = (() => {
  "use strict";

  const CONTEXT_INVALIDATED_RE =
    /Extension context invalidated|Receiving end does not exist|message port closed/i;

  function isContextInvalidated(message) {
    return CONTEXT_INVALIDATED_RE.test(message || "");
  }

  function getRuntime(runtimeOverride) {
    if (runtimeOverride) return runtimeOverride;
    return typeof chrome !== "undefined" && chrome && chrome.runtime ? chrome.runtime : null;
  }

  function send(msg, runtimeOverride) {
    const runtime = getRuntime(runtimeOverride);
    return new Promise((resolve) => {
      const fail = (message) => resolve({
        ok: false,
        kind: isContextInvalidated(message) ? "stale-extension" : "disconnected",
        error: message,
      });
      if (!runtime || typeof runtime.sendMessage !== "function") {
        fail("runtime unavailable");
        return;
      }
      try {
        runtime.sendMessage(msg, (resp) => {
          if (runtime.lastError) fail(runtime.lastError.message);
          else resolve(resp || { ok: false, kind: "disconnected", error: "no response from background" });
        });
      } catch (error) {
        fail(String((error && error.message) || error));
      }
    });
  }

  function startStatusPolling(options) {
    const opts = options || {};
    const sendFn = opts.send || send;
    const onStatus = opts.onStatus || (() => {});
    const onStaleExtension = opts.onStaleExtension || (() => {});
    const intervalMs = opts.intervalMs == null ? 5000 : opts.intervalMs;
    const setIntervalFn = opts.setIntervalFn || setInterval;
    const clearIntervalFn = opts.clearIntervalFn || clearInterval;

    let timerId = 0;
    let stopped = false;

    function stop() {
      if (stopped) return;
      stopped = true;
      if (timerId) {
        clearIntervalFn(timerId);
        timerId = 0;
      }
    }

    function handleStatus(status) {
      if (!status || stopped) return;
      if (status.kind === "stale-extension") {
        stop();
        onStaleExtension(status);
        return;
      }
      onStatus(status);
    }

    function pollNow() {
      if (stopped) return Promise.resolve();
      // A throwing handler must not become an unhandled rejection on the
      // setInterval path (the initial poll already had its own catch).
      return Promise.resolve(sendFn({ type: "status" })).then(handleStatus).catch(() => {});
    }

    // Arm the interval before the first poll: a synchronous stop inside
    // handleStatus would otherwise leave an orphan timer behind.
    timerId = setIntervalFn(pollNow, intervalMs);
    pollNow().catch(() => {});
    return { stop, pollNow, handleStatus };
  }

  function listenRuntimeMessages(handlers, runtimeOverride) {
    const runtime = getRuntime(runtimeOverride);
    if (!runtime || !runtime.onMessage || typeof runtime.onMessage.addListener !== "function") {
      return () => {};
    }
    const h = handlers || {};
    const listener = (msg) => {
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "zs-status" && h.onStatus) {
        h.onStatus({
          connected: msg.connected,
          mcpAlive: msg.mcpAlive,
          studio: msg.studio,
          studioApp: msg.studioApp,
          studioProc: msg.studioProc,
          tools: msg.tools,
          servers: msg.servers,
        });
      }
      if (msg.type === "zs-open-menu" && h.onOpenMenu) {
        h.onOpenMenu(msg.atBottom ?? false);
      }
      if (msg.type === "zs-a2a-prompt" && h.onA2APrompt) {
        h.onA2APrompt(msg.prompt, msg.promptId, { mode: msg.mode, route: msg.route });
      }
      if (msg.type === "zs-a2a-abort" && h.onA2AAbort) {
        h.onA2AAbort(msg.promptId);
      }
    };
    runtime.onMessage.addListener(listener);
    let removed = false;
    return function stop() {
      if (removed) return;
      removed = true;
      if (typeof runtime.onMessage.removeListener === "function") {
        runtime.onMessage.removeListener(listener);
      }
    };
  }

  return {
    isContextInvalidated,
    send,
    startStatusPolling,
    listenRuntimeMessages,
  };
})();
