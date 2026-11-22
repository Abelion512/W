// SPDX-License-Identifier: GPL-3.0-or-later
// providers/base.js - shared thin base helper for all snapgentV3 site providers.
// Pulls repeated boilerplate (sleep, visibility, WeakMap turn IDs, stream-growth
// tracking, MutationObserver DOM watchers, and default ZSProvider adapters) out
// of individual providers/*.js so each provider only overrides its selectors and
// site-specific DOM adapters.
// eslint-disable-next-line no-unused-vars
const ZSProviderBase = (() => {
  "use strict";

  const DEFAULT_TOO_LONG_RE = /conversation.{0,30}(too long|limit)|context.{0,20}limit/i;
  const DEFAULT_BUSY_RE = /try again later|temporarily unavailable|rate limit|too many requests/i;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const visible = (el) =>
    !!el && el.isConnected && typeof el.getClientRects === "function" && el.getClientRects().length > 0;

  const notOverlay = (el) => !!el && (!el.closest || !el.closest("#zs-root"));

  function textWithout(root, excludeSel, opts) {
    if (!root) return "";
    const o = opts || {};
    const sel = excludeSel || "";
    if (!sel) return ((o.useInnerText ? root.innerText : root.textContent) || "").trim();
    const clone = root.cloneNode(true);
    try { clone.querySelectorAll(sel).forEach((n) => n.remove()); } catch {}
    return ((o.useInnerText ? clone.innerText : clone.textContent) || "").trim();
  }

  function createWeakIdTracker(prefix) {
    const pfx = prefix || "turn-";
    const map = new WeakMap();
    let seq = 0;
    function idOf(el) {
      if (!el) return null;
      if (!map.has(el)) map.set(el, pfx + (++seq));
      return map.get(el);
    }
    function lastId(getLast) {
      return idOf(typeof getLast === "function" ? getLast() : null);
    }
    return { idOf, lastId };
  }

  function createStreamTracker(streamText, lastAssistant, opts) {
    const o = opts || {};
    const minGrow = typeof o.minGrow === "number" ? o.minGrow : 1;
    let item = null;
    let maxLen = 0;
    let at = 0;
    function streamLen(target) {
      const el = target === undefined ? lastAssistant() : target;
      return (streamText(el) || "").length;
    }
    function sampleStream() {
      const cur = lastAssistant();
      const len = cur ? (streamText(cur) || "").length : 0;
      if (cur !== item) {
        item = cur;
        maxLen = len;
        at = len > 0 ? Date.now() : 0;
      } else if (len > maxLen) {
        maxLen = len;
        at = Date.now();
      }
      return { item, maxLen, at, len };
    }
    function grewWithin(ms) {
      return maxLen > minGrow && at > 0 && (Date.now() - at) < ms;
    }
    function reset() {
      item = null;
      maxLen = 0;
      at = 0;
    }
    return { streamLen, sampleStream, grewWithin, reset };
  }

  // Event-driven DOM watcher built on MutationObserver (replaces setInterval DOM polls).
  function watchDom(callback, opts) {
    if (typeof MutationObserver !== "function") return { disconnect() {} };
    const o = opts || {};
    const target = o.target || document.documentElement || document.body;
    if (!target) return { disconnect() {} };
    const debounceMs = typeof o.debounceMs === "number" ? o.debounceMs : 0;
    let timer = null;
    const run = () => {
      timer = null;
      try { callback(); } catch {}
    };
    const onMut = () => {
      if (debounceMs <= 0) { run(); return; }
      if (timer) return;
      timer = setTimeout(run, debounceMs);
    };
    const obs = new MutationObserver(onMut);
    const obsOpts = {
      childList: o.childList !== undefined ? o.childList : true,
      subtree: o.subtree !== undefined ? o.subtree : true,
    };
    if (o.attributes) obsOpts.attributes = true;
    if (o.characterData) obsOpts.characterData = true;
    if (o.attributeFilter) obsOpts.attributeFilter = o.attributeFilter;
    try { obs.observe(target, obsOpts); } catch {}
    return {
      disconnect() {
        clearTimeout(timer);
        timer = null;
        try { obs.disconnect(); } catch {}
      },
    };
  }

  // Watch a dynamically mounted native Stop button via MutationObserver + click listener.
  function watchStopButton(getStopBtn, onNativeStop, opts) {
    const o = opts || {};
    let boundBtn = null;
    const onClick = (e) => {
      if (o.trustedOnly !== false && e && e.isTrusted === false) return;
      try { onNativeStop(e); } catch {}
    };
    const sync = () => {
      const btn = typeof getStopBtn === "function" ? getStopBtn() : null;
      if (btn === boundBtn) return;
      if (boundBtn && boundBtn.removeEventListener) {
        try { boundBtn.removeEventListener("click", onClick, true); } catch {}
      }
      boundBtn = btn || null;
      if (boundBtn && boundBtn.addEventListener) {
        try { boundBtn.addEventListener("click", onClick, true); } catch {}
      }
    };
    sync();
    const watcher = watchDom(sync, { debounceMs: o.debounceMs || 60, attributes: true });
    return {
      sync,
      disconnect() {
        watcher.disconnect();
        if (boundBtn && boundBtn.removeEventListener) {
          try { boundBtn.removeEventListener("click", onClick, true); } catch {}
        }
        boundBtn = null;
      },
    };
  }

  function setNativeValue(el, value) {
    if (!el) return;
    const proto = el.tagName === "INPUT"
      ? (typeof HTMLInputElement !== "undefined" ? HTMLInputElement.prototype : null)
      : (typeof HTMLTextAreaElement !== "undefined" ? HTMLTextAreaElement.prototype : null);
    const desc = proto && Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function defaultEditorText(getEditor) {
    const ed = typeof getEditor === "function" ? getEditor() : null;
    if (!ed) return "";
    if (ed.tagName === "TEXTAREA" || ed.tagName === "INPUT") return ed.value || "";
    return (ed.innerText || ed.textContent || "").trim();
  }

  const COMMAND_SHAPE_RE = /"(?:command|tool)"\s*:\s*"|###\s*(?:lua|mcp_tool)/i;

  async function waitFor(predicate, timeout) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (predicate()) return true;
      await sleep(120);
    }
    return false;
  }

  function findToolBlockSpot(root) {
    if (!root || !root.querySelectorAll) return null;
    let found = null;
    root.querySelectorAll("pre,code,p,li").forEach((el) => {
      if (el.closest(".zs-chip, .zs-tool-hide")) return;
      const text = (el.textContent || "").trim();
      if (text && COMMAND_SHAPE_RE.test(text)) {
        el.classList.add("zs-tool-hide");
        found = found || { parent: el.parentElement, ref: el };
      }
    });
    return found;
  }

  function installStandardSendHooks(opts) {
    return function installSendHooks(handlers) {
      document.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
        const editor = opts.getEditor();
        if (!editor || !(editor === event.target || editor.contains(event.target)) ||
            !opts.editorText().trim() || handlers.isBlocked()) return;
        if (!handlers.isStarted()) {
          if (opts.chatIsEmpty()) handlers.onBlockedAttempt();
          return;
        }
        handlers.onUserMessage(opts.assistantCount());
      }, true);
      document.addEventListener("click", (event) => {
        const target = event.target;
        const button = target && target.closest ? target.closest("button,[role='button']") : null;
        if (!button || !opts.getEditor()) return;
        if (opts.stopButton() === button) {
          handlers.onNativeStop();
          return;
        }
        if (opts.sendButton() !== button || button.disabled ||
            button.getAttribute("aria-disabled") === "true" || handlers.isBlocked()) return;
        if (!handlers.isStarted()) {
          if (opts.chatIsEmpty()) handlers.onBlockedAttempt();
          return;
        }
        handlers.onUserMessage(opts.assistantCount());
      }, true);
    };
  }

  function createProvider(spec) {
    const api = Object.defineProperties({}, Object.getOwnPropertyDescriptors(spec || {}));
    if (!api.assistantItems && api.allItems && api.isAssistantItem) {
      api.assistantItems = () => api.allItems().filter(api.isAssistantItem);
    }
    if (!api.assistantCount && api.assistantItems) {
      api.assistantCount = () => api.assistantItems().length;
    }
    if (!api.userCount && api.allItems && api.isUserItem) {
      api.userCount = () => api.allItems().filter(api.isUserItem).length;
    }
    if (!api.lastAssistant && api.assistantItems) {
      api.lastAssistant = () => {
        const items = api.assistantItems();
        return items.length ? items[items.length - 1] : null;
      };
    }
    if (!api.chatIsEmpty && api.allItems) {
      api.chatIsEmpty = () => api.allItems().length === 0;
    }
    if (!api.isFreshChat && api.chatIsEmpty && api.getEditor) {
      api.isFreshChat = () => api.chatIsEmpty() && !!api.getEditor();
    }
    if (!api.editorText && api.getEditor) {
      api.editorText = () => defaultEditorText(api.getEditor);
    }
    if (!api.isBusyNow && api.isGenerating) {
      api.isBusyNow = api.isGenerating;
    }
    if (!api.enforceComposer && api.getEditor) {
      api.enforceComposer = () => ({ ready: !!api.getEditor() });
    }
    if (!api.turnHalted) api.turnHalted = () => false;
    if (!api.findContinueBtn) api.findContinueBtn = () => null;
    if (!api.clickContinueBtn) api.clickContinueBtn = () => false;
    if (!api.isTooLongMsg) api.isTooLongMsg = (text) => DEFAULT_TOO_LONG_RE.test(text || "");
    if (!api.isBusyMsg) api.isBusyMsg = (text) => DEFAULT_BUSY_RE.test(text || "");
    if (!api.init) api.init = () => {};
    return api;
  }

  return {
    DEFAULT_TOO_LONG_RE,
    DEFAULT_BUSY_RE,
    sleep,
    visible,
    notOverlay,
    textWithout,
    createWeakIdTracker,
    createStreamTracker,
    watchDom,
    watchStopButton,
    setNativeValue,
    defaultEditorText,
    waitFor,
    findToolBlockSpot,
    installStandardSendHooks,
    createProvider,
  };
})();
