// SPDX-License-Identifier: GPL-3.0-or-later
// Provider for Mistral Le Chat / Vibe Code (chat.mistral.ai).
// NOTE: DOM selectors are best-effort generic guesses; verify them against the live site.
// eslint-disable-next-line no-unused-vars
const ZSProvider = (() => {
  "use strict";
  const B = ZSProviderBase;
  const sleep = B.sleep;
  const visible = B.visible;
  const excluded = B.notOverlay;
  const waitFor = B.waitFor;
  const idTracker = B.createWeakIdTracker("mistral-");
  let diag = () => {};
  let missingEditorSince = 0;
  let lockedEditor = null;

  const S = {
    user: '[data-message-author-role="user"],[data-testid*="user-message"],[data-testid*="user-turn"],[data-role="user"]',
    assistant: '[data-message-author-role="assistant"],[data-testid*="assistant-message"],[data-testid*="assistant-turn"],[data-role="assistant"]',
    editor: 'div.ProseMirror[contenteditable="true"],textarea[placeholder*="Ask" i],textarea[placeholder*="Message" i],textarea,[contenteditable="true"][role="textbox"]',
    errors: '[role="alert"],[data-testid*="error"],[class*="error-message"]',
    // Reasoning renders as a Radix disclosure INSIDE the answer turn: a trigger
    // button ("Thought for 1s") plus a collapsible content panel. When the panel
    // is open its full reasoning text is inside the turn, so a command the model
    // merely DRAFTS while thinking would be read as a real tool call (same
    // hazard Kimi's `.thinking-container` skip solves). The generated ids are
    // the stable marker: `collapsible-trigger-*` / `collapsible-content-*`.
    reasoning: '[id^="collapsible-trigger-"],[id^="collapsible-content-"]',
    // The turn footer's timestamp ("11:45pm") is metadata, not reply text -
    // measured live it rode along as the last line of every extracted reply.
    hint: ".text-hint",
  };
  const timings = {
    GEN_IDLE_MS: 2000,
    REASON_IDLE_MS: 15000,
    WARMUP_MS: 60000,
    REASON_NOREPLY_MS: 120000,
    STABLE_MS: 10000,
    RESPONSE_TIMEOUT_MS: 300000,
  };
  // visible & excluded inherited from ZSProviderBase.
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
  const barAnchor = () => composerFrame();

  function textWithout(root, excludeSel) {
    if (!root) return "";
    const skip = [".zs-chip", excludeSel].filter(Boolean).join(",");
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
  // The reasoning-area and footer-hint exclusions ride along with any
  // caller-supplied selector.
  const notReasoning = (excludeSel) =>
    S.reasoning + ", " + S.hint + (excludeSel ? ", " + excludeSel : "");
  // Final reply text: never includes the reasoning disclosure.
  const itemText = (item) => textWithout(item, notReasoning());
  const classifyText = (item, excludeSel) => textWithout(item, notReasoning(excludeSel));
  const bodyOf = (item) => item;
  // Stream text keeps the reasoning subtree: while the disclosure is open the
  // growing reasoning IS the growth signal that keeps isGenerating() true until
  // the answer text starts arriving.
  const streamText = (item) => textWithout(bodyOf(item));
  const stream = B.createStreamTracker(streamText, lastAssistant, { minGrow: 0 });
  const streamLen = stream.streamLen;
  const lastAssistantId = () => {
    const item = lastAssistant();
    if (!item) return null;
    const id = item.getAttribute("data-message-id") || item.getAttribute("data-messageid") || item.id;
    return id || idTracker.idOf(item);
  };

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
      button.matches('button[type="submit"],button[aria-label="Send" i],button[aria-label="Submit" i]') ||
      /\b(send|submit)\b/i.test(buttonLabel(button))
    ) || null;
  };
  const isHardGenerating = () => !!stopButton();
  const isGenerating = () => {
    stream.sampleStream();
    return isHardGenerating() || stream.grewWithin(timings.GEN_IDLE_MS);
  };

  function snapshot() {
    const think = lastAssistant();
    const panel = think && think.querySelector('[id^="collapsible-content-"]');
    return { th: panel ? (panel.textContent || "").length : 0, rp: streamLen() };
  }
  function readAssistant() {
    const item = lastAssistant();
    const panel = item && item.querySelector('[id^="collapsible-content-"]');
    return {
      present: !!item,
      // The parse loop reads this: reasoning + footer metadata excluded, so a
      // command drafted inside the reasoning is never detected or executed.
      reply: item ? textWithout(item, notReasoning()).trim() : "",
      thinking: panel ? (panel.textContent || "").trim() : "",
      item,
    };
  }
  // waitFor inherited from ZSProviderBase.

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
    if (!editor) throw new Error("Mistral input box not found");
    const beforeUsers = userCount();
    writeText(editor, text);
    const ready = await waitFor(() => {
      const button = sendButton();
      return !!button && !button.disabled && button.getAttribute("aria-disabled") !== "true";
    }, 10000);
    const button = sendButton();
    if (!ready || !button || button.disabled || button.getAttribute("aria-disabled") === "true") {
      throw new Error("Mistral send button did not become available");
    }
    button.click();
    const sent = await waitFor(() =>
      editorText().trim() === "" || userCount() > beforeUsers || isHardGenerating(),
    5000);
    if (!sent) throw new Error("Mistral did not confirm the message was sent");
  }
  function stopGeneration() {
    const button = stopButton();
    if (button) button.click();
  }
  const enforceComposer = () => ({ ready: !!getEditor() });
  async function ensureComposerReady(reason) {
    const ready = !!getEditor();
    diag("mode_ready", { reason, provider: "mistral", ready });
    return { ready };
  }

  function scanError() {
    for (const el of document.querySelectorAll(S.errors)) {
      if (!visible(el) || !excluded(el) || el.closest(`${S.user},${S.assistant}`)) continue;
      const text = (el.innerText || el.textContent || "").trim();
      if (text.length > 8 && text.length < 600) return text.slice(0, 240);
    }
    if (!getEditor() && document.querySelector('a[href*="login"],a[href*="signin"],a[href*="sign-in"]')) {
      return "Sign in to Mistral to use Le Chat / Vibe Code.";
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
      return "The Mistral input box is not available.";
    }
    missingEditorSince = 0;
    return null;
  }
  // isTooLongMsg, isBusyMsg, turnHalted, findContinueBtn, clickContinueBtn inherited from ZSProviderBase.
  const conversationKey = () =>
    location.pathname === "/" || location.pathname === "/chat" || location.pathname === "/code" || location.pathname === "/code/"
      ? "" : `mistral:${location.pathname}`;

  const installSendHooks = B.installStandardSendHooks({
    getEditor, editorText, chatIsEmpty, assistantCount, sendButton, stopButton,
  });
  const findToolBlockSpot = (item) => B.findToolBlockSpot(item);

  return B.createProvider({
    id: "mistral",
    displayName: "Mistral",
    sendRetryLimit: 1,
    supportsVision: false,
    timings,
    chipAtItemLevel: true,
    reliableCounts: true,
    init({ diag: d } = {}) { if (d) diag = d; },
    allItems, isUserItem, isAssistantItem, itemText, classifyText,
    assistantCount, userCount, lastAssistant, lastAssistantId, readAssistant,
    streamLen, snapshot,
    getEditor, editorText, chatIsEmpty, isFreshChat, composerFrame, barAnchor,
    setInputLock, typeAndSend, stopGeneration,
    isGenerating, isHardGenerating,
    enforceComposer, ensureComposerReady,
    scanError,
    attachImages: () => false,
    clearAttachments: () => {},
    conversationKey, installSendHooks, findToolBlockSpot,
  });
})();
