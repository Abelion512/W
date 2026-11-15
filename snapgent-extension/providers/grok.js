// SPDX-License-Identifier: GPL-3.0-or-later
// Provider for Grok (grok.com).
// eslint-disable-next-line no-unused-vars
const ZSProvider = (() => {
  "use strict";
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let diag = () => {};
  let missingEditorSince = 0;
  let lockedEditor = null;
  let sampledItem = null;
  let sampledLen = 0;
  let grewAt = 0;
  const ids = new WeakMap();
  let nextId = 0;

  const S = {
    user: '[data-message-author-role="user"],[data-testid*="user-message"],[data-testid*="user-turn"],[data-testid*="conversation-turn"][data-role="user"]',
    assistant: '[data-message-author-role="assistant"],[data-testid*="assistant-message"],[data-testid*="assistant-turn"],[data-testid*="conversation-turn"][data-role="assistant"]',
    // 2026-11 composer is a tiptap/ProseMirror div with no role and no aria-label
    // (measured live), so the role-based selectors alone left mode_ready false and
    // every start failed with "Grok mode not ready". The bare `textarea` at the
    // end is the HOME composer (grok.com/ before any thread opens): a plain
    // textarea with no class, placeholder or role - without it a cold start from
    // the site root never found an editor at all. Put last so the richer
    // thread-view selectors win on a conversation page.
    editor: '[contenteditable="true"][role="combobox"][aria-label*="Grok" i],[contenteditable="true"][role="combobox"][aria-label*="Ask" i],#chat, textarea[placeholder*="Message" i], [contenteditable="true"][role="textbox"],.tiptap[contenteditable="true"],.ProseMirror[contenteditable="true"],textarea',
    errors: '[role="alert"],[data-testid*="error"],[class*="error-message"]',
  };
  const timings = {
    GEN_IDLE_MS: 2000,
    REASON_IDLE_MS: 15000,
    WARMUP_MS: 60000,
    REASON_NOREPLY_MS: 120000,
    STABLE_MS: 10000,
    RESPONSE_TIMEOUT_MS: 300000,
  };
  const visible = (el) => !!el && el.isConnected && el.getClientRects().length > 0;
  const excluded = (el) => !el.closest("#zs-root");
  const isUserItem = (item) => !!item && item.matches(S.user);
  const isAssistantItem = (item) => !!item && item.matches(S.assistant);
  const allItems = () => [...document.querySelectorAll(`${S.user},${S.assistant}`)]
    .filter(excluded);
  const assistantItems = () => allItems().filter(isAssistantItem);
  const assistantCount = () => assistantItems().length;
  const userCount = () => allItems().filter(isUserItem).length;
  const lastAssistant = () => {
    const items = assistantItems();
    return items.length ? items[items.length - 1] : null;
  };

  function getEditor() {
    if (visible(lockedEditor) && excluded(lockedEditor)) return lockedEditor;
    for (const editor of document.querySelectorAll(S.editor)) {
      if (excluded(editor) && visible(editor)) return editor;
    }
    return null;
  }
  const editorText = () => {
    const editor = getEditor();
    return editor ? ("value" in editor ? editor.value : editor.innerText || editor.textContent || "") : "";
  };
  const chatIsEmpty = () => allItems().length === 0;
  const isFreshChat = () => chatIsEmpty() && !!getEditor();
  const composerFrame = () => {
    const editor = getEditor();
    return editor && (editor.closest("form") || editor.parentElement);
  };
  // The composer is BOTTOM-DOCKED: no ancestor's padding-top moves it (measured
  // live - the form stayed pinned while every ancestor got 57px of padding), so
  // the anchored mode's reserved strip can never reserve anything and the bar
  // overlaps the placeholder + the site's own model/voice buttons. An in-flow
  // mount is no better: inserting a foreign node into the composer's React
  // parent sent Grok into a re-render loop (measured live - repeated 2-25s main
  // thread stalls, the editor unmounted for good). So neither barMount nor
  // barAnchor is exported and the core's float-above-the-editor fallback is
  // used: a fixed panel hovering above the composer, no DOM insertion, no
  // padding.

  function textWithout(root, excludeSel) {
    if (!root) return "";
    // The turn carries a visible-in-a11y-tree author label ("Grok") and action
    // buttons; neither is the answer. Measured live: without this the reply read
    // "Grok\nPONG". Deliberately narrow - a class-name guess like
    // [class*="reasoning"] would also drop answer text on a redesign.
    const skip = [
      ".zs-chip",
      '[aria-hidden="true"]',
      ".sr-only",
      '[class*="sr-only"]',
      "button",
      excludeSel,
    ].filter(Boolean).join(",");
    let text = "";
    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.nodeValue || "";
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE || (skip && node.matches(skip))) return;
      if (node.tagName === "BR") {
        text += "\n";
        return;
      }
      const block = /^(ADDRESS|ARTICLE|BLOCKQUOTE|DIV|LI|P|PRE|SECTION)$/.test(node.tagName);
      if (block && text && !text.endsWith("\n")) text += "\n";
      for (const child of node.childNodes) walk(child);
      if (block && !text.endsWith("\n")) text += "\n";
    };
    walk(root);
    return text;
  }
  const itemText = (item) => textWithout(item);
  const classifyText = (item, excludeSel) => textWithout(item, excludeSel);
  const bodyOf = (item) => item;
  const streamText = (item) => textWithout(bodyOf(item));
  const streamLen = (item) => streamText(item === undefined ? lastAssistant() : item).length;
  const lastAssistantId = () => {
    const item = lastAssistant();
    if (!item) return null;
    const id = item.getAttribute("data-message-id") || item.getAttribute("data-messageid") || item.id;
    if (id) return id;
    if (!ids.has(item)) ids.set(item, ++nextId);
    return ids.get(item);
  };
  function sampleStream() {
    const item = lastAssistant();
    const length = streamLen(item);
    const now = Date.now();
    if (item !== sampledItem || length < sampledLen - 400) {
      sampledItem = item;
      sampledLen = length;
      grewAt = now;
    } else if (length > sampledLen) {
      sampledLen = length;
      grewAt = now;
    }
  }

  const form = () => {
    const editor = getEditor();
    return editor && editor.closest("form");
  };
  const buttons = () => {
    const root = form() || document;
    return [...root.querySelectorAll("button,[role='button']")]
      .filter((button) => excluded(button) && visible(button));
  };
  const buttonLabel = (button) => [
    button.getAttribute("aria-label"),
    button.getAttribute("title"),
    button.getAttribute("data-testid"),
    button.textContent,
    ...[...button.querySelectorAll("[aria-label]")].map((el) => el.getAttribute("aria-label")),
  ].filter(Boolean).join(" ");
  const stopButton = () => buttons().find((button) =>
    /\b(stop|cancel|halt)\b/i.test(buttonLabel(button))
  ) || null;
  const sendButton = () => {
    const candidates = buttons();
    return candidates.find((button) =>
      button.matches('button[type="submit"],button[data-testid="chat-submit"],button[aria-label="Submit"]') ||
      /\b(send|submit)\b/i.test(buttonLabel(button))
    ) || null;
  };
  const isHardGenerating = () => !!stopButton();
  const isGenerating = () => {
    sampleStream();
    return isHardGenerating() || (sampledLen > 0 && Date.now() - grewAt < timings.GEN_IDLE_MS);
  };
  const isBusyNow = isGenerating;

  function snapshot() {
    return { th: 0, rp: streamLen() };
  }
  function readAssistant() {
    const item = lastAssistant();
    return {
      present: !!item,
      reply: item ? streamText(item).trim() : "",
      thinking: "",
      item,
    };
  }
  async function waitFor(predicate, timeout) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (predicate()) return true;
      await sleep(120);
    }
    return false;
  }

  function setInputLock(on) {
    const editor = on ? getEditor() : (lockedEditor || getEditor());
    lockedEditor = on ? editor : null;
    if (!editor) return;
    if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
      if (on) editor.setAttribute("readonly", "");
      else editor.removeAttribute("readonly");
    } else {
      editor.setAttribute("contenteditable", on ? "false" : "true");
    }
  }
  function writeText(editor, text) {
    if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
      editor.removeAttribute("readonly");
      const prototype = editor instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value").set;
      setter.call(editor, text);
      editor.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: text,
      }));
      if (lockedEditor === editor) editor.setAttribute("readonly", "");
      return;
    }
    editor.focus();
    editor.setAttribute("contenteditable", "true");
    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(editor);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    const inserted = document.execCommand("insertText", false, text);
    if (!inserted || editorText().trim() !== text.trim()) {
      editor.textContent = text;
      editor.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: text,
      }));
    }
    if (lockedEditor === editor) editor.setAttribute("contenteditable", "false");
  }
  async function typeAndSend(text) {
    const editor = getEditor();
    if (!editor) throw new Error("Grok input box not found");
    const beforeUsers = userCount();
    writeText(editor, text);
    const ready = await waitFor(() => {
      const button = sendButton();
      return !!button && !button.disabled && button.getAttribute("aria-disabled") !== "true";
    }, 10000);
    const button = sendButton();
    if (!ready || !button || button.disabled || button.getAttribute("aria-disabled") === "true") {
      throw new Error("Grok send button did not become available");
    }
    button.click();
    const sent = await waitFor(() =>
      editorText().trim() === "" || userCount() > beforeUsers || isHardGenerating(),
    5000);
    if (!sent) throw new Error("Grok did not confirm the message was sent");
  }
  function stopGeneration() {
    const button = stopButton();
    if (button) button.click();
  }
  const enforceComposer = () => ({ ready: !!getEditor() });
  async function ensureComposerReady(reason) {
    // The shell paints before the tiptap composer mounts, and the core calls this
    // once right after load. Waiting here is what stops a spurious "Grok mode not
    // ready" on a fresh tab (same pattern as Rudder and Gemini).
    let ready = !!getEditor();
    if (!ready) {
      diag("mode_ready.wait", { reason, provider: "grok" });
      ready = await waitFor(() => !!getEditor(), 15000);
    }
    diag("mode_ready", { reason, provider: "grok", ready });
    return { ready };
  }

  function scanError() {
    for (const el of document.querySelectorAll(S.errors)) {
      if (!visible(el) || !excluded(el) || el.closest(`${S.user},${S.assistant}`)) continue;
      const text = (el.innerText || el.textContent || "").trim();
      if (text.length > 8 && text.length < 600) return text.slice(0, 240);
    }
    if (getEditor() && document.querySelector('a[href*="/sign-in"],a[href*="/sign-up"]')) {
      return "Sign in to Grok to use Grok chat.";
    }
    // A site can re-create the composer for a beat right after a send (Grok
    // rebuilds the tiptap node, Mistral the ProseMirror box). A missing editor
    // mid-generation is churn, NOT an error - the same false "context_limit"
    // failed the bootstrap every time (measured live 2026-11-15). Same rule as
    // Rudder: ignore it while generating, and for a short grace window after.
    const editor = getEditor();
    if (!editor) {
      if (isGenerating()) { missingEditorSince = 0; return null; }
      if (!missingEditorSince) missingEditorSince = Date.now();
      if (Date.now() - missingEditorSince < 4000) return null;
      return "The Grok input box is not available.";
    }
    missingEditorSince = 0;
    return null;
  }
  const isTooLongMsg = (text) => /conversation.{0,30}(too long|limit)|context.{0,20}limit/i.test(text);
  const isBusyMsg = (text) => /try again later|temporarily unavailable|rate limit|too many requests/i.test(text);
  const turnHalted = () => false;
  const findContinueBtn = () => null;
  const clickContinueBtn = () => false;
  const conversationKey = () =>
    location.pathname === "/" || location.pathname === "/new" ? "" : `grok:${location.pathname}`;

  function installSendHooks(handlers) {
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
      const editor = getEditor();
      if (!editor || !(editor === event.target || editor.contains(event.target)) ||
          !editorText().trim() || handlers.isBlocked()) return;
      if (!handlers.isStarted()) {
        if (chatIsEmpty()) handlers.onBlockedAttempt();
        return;
      }
      handlers.onUserMessage(assistantCount());
    }, true);
    document.addEventListener("click", (event) => {
      const target = event.target;
      const button = target && target.closest ? target.closest("button,[role='button']") : null;
      if (!button || !getEditor()) return;
      if (stopButton() === button) {
        handlers.onNativeStop();
        return;
      }
      if (sendButton() !== button || button.disabled ||
          button.getAttribute("aria-disabled") === "true" || handlers.isBlocked()) return;
      if (!handlers.isStarted()) {
        if (chatIsEmpty()) handlers.onBlockedAttempt();
        return;
      }
      handlers.onUserMessage(assistantCount());
    }, true);
  }

  const commandShape = /"(?:command|tool)"\s*:\s*"|###\s*(?:lua|mcp_tool)/i;
  function findToolBlockSpot(item) {
    let found = null;
    item.querySelectorAll("pre,code,p,li").forEach((el) => {
      if (el.closest(".zs-chip, .zs-tool-hide")) return;
      const text = (el.textContent || "").trim();
      if (text && commandShape.test(text)) {
        el.classList.add("zs-tool-hide");
        found = found || { parent: el.parentElement, ref: el };
      }
    });
    return found;
  }

  return {
    id: "grok",
    displayName: "Grok",
    sendRetryLimit: 1,
    supportsVision: false,
    timings,
    chipAtItemLevel: true,
    reliableCounts: true,
    init({ diag: d } = {}) { if (d) diag = d; },
    allItems, isUserItem, isAssistantItem, itemText, classifyText,
    assistantCount, userCount, lastAssistant, lastAssistantId, readAssistant,
    streamLen, snapshot,
    getEditor, editorText, chatIsEmpty, isFreshChat, composerFrame,
    setInputLock, typeAndSend, stopGeneration,
    isGenerating, isBusyNow, isHardGenerating,
    enforceComposer, ensureComposerReady,
    turnHalted, findContinueBtn, clickContinueBtn,
    scanError, isTooLongMsg, isBusyMsg,
    attachImages: () => false,
    clearAttachments: () => {},
    conversationKey, installSendHooks, findToolBlockSpot,
  };
})();
