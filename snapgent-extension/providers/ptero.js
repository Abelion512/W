// SPDX-License-Identifier: GPL-3.0-or-later
// providers/ptero.js - the Ptero (ptero.pro) provider.
// eslint-disable-next-line no-unused-vars
const ZSProvider = (() => {
  "use strict";
  const B = ZSProviderBase;
  const sleep = B.sleep;
  const visible = B.visible;
  const waitFor = B.waitFor;
  const idTracker = B.createWeakIdTracker("ptero-");
  let diag = () => {};
  let lockedEditor = null;

  const S = {
    list: "#chat-messages",
    user: ".chat-msg.user",
    assistant: ".chat-msg.assistant",
    editor: "#chat-input",
    send: "#chat-send-btn",
    thinking: ".chat-thinking",
    codeStatus: ".chat-code-status",
    reply: ".chat-msg-text",
    codeBlock: ".chat-code-block",
    artifactCard: ".chat-file-card, .chat-artifact-card",
    feedbackBar: ".chat-feedback-bar",
    halted: ".chat-stopped-note",
    modelTrigger: "#chat-model-picker-trigger",
    modelLabel: "#chat-model-picker-trigger-label",
    modelOpt: ".chat-model-picker-option",
    replyNoise:
      ".chat-thinking,.chat-code-status,.chat-code-block-header,.chat-copy-btn," +
      ".chat-stopped-note,.chat-model-switch-note,.zs-chip",
    errors:
      '[role="alert"],.chat-model-toast,[class*="chat-error"],[class*="chat-notice"],#chat-username-modal',
  };

  const RE = {
    turnError: /^(?:\u26a0\ufe0f?\s*|(?:tls\s+connect\s+|api\s+|ssl\s+)?error:\s*)/i,
    pteroNotice: /cookie check failed|ptero a bit busy|hourly limit|token limit|per hour|1,000,000|tls connect error|all models are currently unavailable|rate limited by provider|free allowance/i,
    tooLong: /conversation.{0,30}(too long|limit)|context.{0,20}limit|hourly limit|token limit|per hour|1,000,000/i,
    busy: /ptero a bit busy|cookie check failed|rate.?limit|rate limited by provider|free allowance|too many requests|hourly limit|token limit|per hour|1,000,000|tls connect error|all models are currently unavailable|try again|temporarily unavailable/i,
  };

  // Ptero collapses streamed code blocks >= 15 lines into .chat-artifact-card on
  // stream end; cache command blocks seen during streaming per turn item.
  const cmdBlockCache = new WeakMap();
  const commandShape = /"(?:command|tool)"\s*:\s*"|###\s*(?:lua|mcp_tool)/i;

  const PROMPT_EXTRA =
    "- Keep every JSON command block COMPACT (under 12 lines, preferably single-line JSON) " +
    "because Ptero collapses code blocks of 15 or more lines into artifact file cards.\n" +
    "- Do NOT invoke Ptero's built-in tools, actions, or GitHub connectors; emit only a plain-text ```json {\"command\": ...}``` block.";

  const timings = {
    GEN_IDLE_MS: 2000,
    REASON_IDLE_MS: 15000,
    WARMUP_MS: 60000,
    REASON_NOREPLY_MS: 120000,
    STABLE_MS: 10000,
    RESPONSE_TIMEOUT_MS: 300000,
  };
  // visible inherited from ZSProviderBase.
  const allItems = () => {
    const list = document.querySelector(S.list);
    return list ? [...list.querySelectorAll(`${S.user},${S.assistant}`)] : [];
  };
  const isAssistantItem = (item) => !!item && item.matches(S.assistant);
  const isUserItem = (item) => !!item && item.matches(S.user);
  const assistantItems = () => allItems().filter(isAssistantItem);
  const assistantCount = () => assistantItems().length;
  const userCount = () => allItems().filter(isUserItem).length;
  const lastAssistant = () => {
    const items = assistantItems();
    return items.length ? items[items.length - 1] : null;
  };
  const bodyOf = (item) => item && item.querySelector(S.reply);

  function textExcluding(root, excludeSel) {
    if (!root) return "";
    let text = "";
    const visit = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.nodeValue || "";
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (excludeSel && node.matches && node.matches(excludeSel)) return;
      for (const child of node.childNodes) visit(child);
    };
    visit(root);
    return text;
  }

  function cacheStreamedCommands(item, body) {
    if (!item || !body || !body.querySelectorAll) return;
    const cmds = [];
    for (const pre of body.querySelectorAll("pre")) {
      if (pre.closest && pre.closest(S.thinking)) continue;
      const t = (pre.textContent || "").trim();
      if (t && commandShape.test(t)) cmds.push(t);
    }
    if (cmds.length) cmdBlockCache.set(item, cmds.join("\n"));
  }

  function extractReply(item, extraExclude) {
    if (!item) return "";
    if (!isAssistantItem(item)) return textExcluding(item, extraExclude);
    const body = bodyOf(item);
    if (!body) return "";
    cacheStreamedCommands(item, body);
    const skip = [S.replyNoise, extraExclude].filter(Boolean).join(",");
    const text = textExcluding(body, skip);
    if (!commandShape.test(text) && body.querySelector && body.querySelector(S.artifactCard) && cmdBlockCache.has(item)) {
      const cached = cmdBlockCache.get(item);
      return text ? `${text}\n${cached}` : cached;
    }
    return text;
  }

  function thinkingText(item) {
    const th = item && item.querySelector && item.querySelector(S.thinking);
    return th ? textExcluding(th, ".zs-chip").trim() : "";
  }

  const itemText = (item) => extractReply(item);
  const classifyText = (item, excludeSel) => extractReply(item, excludeSel);
  const chatIsEmpty = () => allItems().length === 0;
  const isFreshChat = () => chatIsEmpty() && !!getEditor();

  function getEditor() {
    if (visible(lockedEditor) && !lockedEditor.closest("#zs-root")) return lockedEditor;
    const editor = document.querySelector(S.editor);
    return editor && !editor.closest("#zs-root") && visible(editor) ? editor : null;
  }
  const editorText = () => {
    const editor = getEditor();
    return editor ? editor.value || "" : "";
  };
  const composerFrame = () => document.querySelector("#chat-input-area");
  const barAnchor = () => {
    const area = composerFrame();
    return area && visible(area) ? area : null;
  };

  function lastAssistantId() {
    const item = lastAssistant();
    if (!item) return null;
    const id = item.dataset.msgId || item.dataset.messageId;
    return id || idTracker.idOf(item);
  }
  const turnHalted = (item) => !!(item && item.querySelector && item.querySelector(S.halted));
  const streamText = (item) => {
    if (!item) return "";
    const th = thinkingText(item);
    const rp = extractReply(item, ".zs-chip").trim();
    return th && rp ? `${th}\n${rp}` : (th || rp);
  };
  const stream = B.createStreamTracker(streamText, lastAssistant, { minGrow: 0 });
  const streamLen = stream.streamLen;
  const stopButton = () => {
    const button = document.querySelector(S.send);
    return button && button.classList.contains("is-stop") && visible(button) ? button : null;
  };
  const sendButton = () => {
    const button = document.querySelector(S.send);
    return button && !button.classList.contains("is-stop") && visible(button) ? button : null;
  };
  const hasLiveCodeStatus = (item) => {
    if (!item || turnHalted(item) || !item.querySelector) return false;
    const status = item.querySelector(S.codeStatus);
    return !!status && visible(status);
  };
  const reasoningInProgress = (item) => {
    if (!item || turnHalted(item)) return false;
    return thinkingText(item).length > 0 && extractReply(item).trim().length === 0;
  };
  const isHardGenerating = () => !!stopButton();
  // Ptero leaves the native Stop button and the code-status banner mounted after
  // the answer landed; the feedback bar on the finished turn is the reliable
  // completion marker. Without this, waitForResponse() keeps gen true until its
  // 300s timeout and never parses the command already sitting in the DOM.
  const turnSettled = (item) => {
    if (!item || !item.querySelector || !item.querySelector(S.feedbackBar)) return false;
    const text = extractReply(item).trim();
    if (!text) return false;
    if (!commandShape.test(text)) return true;
    const opens = (text.match(/\{/g) || []).length;
    const closes = (text.match(/\}/g) || []).length;
    return opens === 0 || opens <= closes;
  };
  const isGenerating = () => {
    const last = lastAssistant();
    if (turnSettled(last)) return false;
    if (isHardGenerating() || hasLiveCodeStatus(last)) return true;
    stream.sampleStream();
    if (reasoningInProgress(last)) return stream.grewWithin(timings.REASON_IDLE_MS);
    return stream.grewWithin(timings.GEN_IDLE_MS);
  };
  const isBusyNow = () => {
    const last = lastAssistant();
    if (turnSettled(last)) return false;
    if (isHardGenerating() || hasLiveCodeStatus(last)) return true;
    stream.sampleStream();
    if (!reasoningInProgress(last)) return false;
    return stream.grewWithin(timings.REASON_IDLE_MS);
  };

  function snapshot() {
    const item = lastAssistant();
    return { th: thinkingText(item).length, rp: extractReply(item).trim().length };
  }
  function readAssistant() {
    const item = lastAssistant();
    return {
      present: !!item,
      reply: item ? extractReply(item, ".zs-chip").trim() : "",
      thinking: thinkingText(item),
      item,
    };
  }
  // waitFor inherited from ZSProviderBase.

  function setInputLock(on) {
    const editor = on ? getEditor() : (lockedEditor || getEditor());
    lockedEditor = on ? editor : null;
    if (editor) {
      if (on) editor.setAttribute("readonly", "");
      else editor.removeAttribute("readonly");
    }
  }
  function setTextareaValue(editor, text) {
    editor.removeAttribute("readonly");
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setter.call(editor, text);
    editor.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: text,
    }));
    if (lockedEditor === editor) editor.setAttribute("readonly", "");
  }
  async function typeAndSend(text) {
    const editor = getEditor();
    if (!editor) throw new Error("Ptero input box not found");
    const beforeUsers = userCount();
    // A cold page hydrates AFTER first paint. A write that lands before Ptero's
    // own state is live gets wiped by the next render, so its Send button never
    // mounts and the prompt is refused. Write until the text STICKS, then wait
    // for the button - the same sticky-write fix proven on Rudder.
    let ready = false;
    for (let attempt = 0; attempt < 24 && !ready; attempt++) {
      if (!editorText().trim()) {
        setTextareaValue(editor, text);
        await sleep(600);
        continue;
      }
      ready = await waitFor(() => {
        const button = sendButton();
        return !!button && !button.disabled && button.getAttribute("aria-disabled") !== "true";
      }, 4000);
      if (!ready) await sleep(300);
    }
    const button = sendButton();
    if (!ready || !button || button.disabled ||
        button.getAttribute("aria-disabled") === "true") {
      throw new Error("Ptero send button did not become available");
    }
    button.click();
    const sent = await waitFor(() =>
      editorText().trim() === "" || userCount() > beforeUsers || isHardGenerating(),
    5000);
    if (!sent) throw new Error("Ptero did not confirm the message was sent");
  }
  function stopGeneration() {
    const button = stopButton();
    if (button) button.click();
  }
  function activeModelOption() {
    const opts = [...document.querySelectorAll(S.modelOpt)];
    return opts.find((o) => o.getAttribute("aria-selected") === "true") ||
      opts.find((o) => o.classList.contains("is-active")) || null;
  }

  function findModelOption(want) {
    const needle = String(want || "").trim().toLowerCase();
    if (!needle) return null;
    const opts = [...document.querySelectorAll(S.modelOpt)];
    const byId = opts.find((o) => String((o.dataset && o.dataset.modelId) || o.getAttribute("data-model-id") || "").toLowerCase() === needle);
    if (byId) return byId;
    const byLabel = opts.find((o) => String((o.dataset && o.dataset.label) || o.getAttribute("data-label") || "").toLowerCase() === needle);
    if (byLabel) return byLabel;
    return opts.find((o) => {
      const id = String((o.dataset && o.dataset.modelId) || o.getAttribute("data-model-id") || "").toLowerCase();
      const lbl = String((o.dataset && o.dataset.label) || o.getAttribute("data-label") || "").toLowerCase();
      return id.includes(needle) || lbl.includes(needle);
    }) || null;
  }

  async function selectModel(want) {
    const target = findModelOption(want);
    const cur = activeModelOption();
    const sel = document.querySelector("#chat-model-select");
    const idOf = (o) => (o && ((o.dataset && o.dataset.modelId) || o.getAttribute("data-model-id") || (o.dataset && o.dataset.label))) || "";
    if (!target) return { applied: false, model: idOf(cur) };
    const wantId = idOf(target);
    if (cur === target && target.getAttribute("aria-selected") === "true" && (!sel || sel.value === wantId)) {
      return { applied: true, model: wantId };
    }
    const trigger = document.querySelector(S.modelTrigger);
    if (!trigger) return { applied: false, model: idOf(cur) };
    if (trigger.getAttribute("aria-expanded") !== "true") {
      try { trigger.click(); } catch {}
      await waitFor(() => visible(target), 1000);
    }
    try { target.click(); } catch {}
    if (sel && wantId && sel.value !== wantId) {
      try {
        sel.value = wantId;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      } catch {}
    }
    const lblText = () => ((document.querySelector(S.modelLabel) || {}).textContent || "").trim().toLowerCase();
    const wantLbl = String((target.dataset && target.dataset.label) || target.getAttribute("data-label") || "").toLowerCase();
    const ok = await waitFor(() =>
      (target.getAttribute("aria-selected") === "true" || (wantLbl && lblText() === wantLbl)) &&
      (!sel || !wantId || sel.value === wantId), 2000);
    return { applied: ok, model: ok ? wantId : idOf(activeModelOption()) };
  }

  const enforceComposer = () => ({ ready: !!getEditor() });
  async function ensureComposerReady(reason, opts) {
    const ready = !!getEditor();
    const wantModel = opts && !opts.preserveMode && typeof opts.model === "string" ? opts.model.trim() : "";
    let mode = { applied: true, model: ((activeModelOption() || {}).dataset || {}).modelId || "" };
    if (ready && wantModel && (reason === "startup" || reason === "mode")) {
      mode = await selectModel(wantModel);
    }
    diag("mode_ready", { reason, provider: "ptero", ready, model: mode.model, modeApplied: mode.applied });
    return { ready, model: mode.model, modeApplied: mode.applied };
  }

  function scanError() {
    const list = document.querySelector(S.list);
    for (const el of document.querySelectorAll(S.errors)) {
      if (el.id === "chat-username-modal" && el.getAttribute("data-hidden") !== null) continue;
      if (!visible(el) || el.closest("#zs-root") || (list && list.contains(el))) continue;
      const text = (el.innerText || el.textContent || "").trim();
      if (el.classList && el.classList.contains("chat-model-toast") &&
          !(RE.turnError.test(text) || RE.busy.test(text) || RE.tooLong.test(text) ||
            /\b(?:error|failed|limit|quota|busy|blocked|unavailable|expired)\b/i.test(text))) {
        continue;
      }
      if (text.length > 8 && text.length < 600) return text.slice(0, 240);
    }
    const last = lastAssistant();
    const body = bodyOf(last);
    if (body) {
      const text = textExcluding(body, S.replyNoise).trim();
      if (text.length > 5 && text.length < 600 &&
          (RE.turnError.test(text) || RE.pteroNotice.test(text))) {
        return text.slice(0, 240);
      }
    }
    return getEditor() ? null : "The Ptero input box is not available.";
  }
  const isTooLongMsg = (text) => RE.tooLong.test(text || "");
  const isBusyMsg = (text) => RE.busy.test(text || "");
  const conversationKey = () => {
    const items = allItems();
    const first = items[0];
    if (!first) return "";
    const firstAssistant = items.find(isAssistantItem);
    const id = (firstAssistant && (firstAssistant.dataset.msgId || firstAssistant.dataset.messageId)) ||
      first.dataset.msgId || first.dataset.messageId;
    if (id) return `ptero:${id}`;
    return `ptero:${idTracker.idOf(first)}`;
  };

  function installSendHooks(handlers) {
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
      const editor = getEditor();
      if (!editor || event.target !== editor || !editorText().trim()) return;
      if (handlers.isBlocked()) return;
      if (!handlers.isStarted()) {
        if (chatIsEmpty()) handlers.onBlockedAttempt();
        return;
      }
      handlers.onUserMessage(assistantCount());
    }, true);
    document.addEventListener("click", (event) => {
      const target = event.target;
      const button = target && target.closest ? target.closest(S.send) : null;
      if (!button || !getEditor()) return;
      if (button.classList.contains("is-stop")) {
        handlers.onNativeStop();
        return;
      }
      if (button.disabled || button.getAttribute("aria-disabled") === "true") return;
      if (handlers.isBlocked()) return;
      if (!handlers.isStarted()) {
        if (chatIsEmpty()) handlers.onBlockedAttempt();
        return;
      }
      handlers.onUserMessage(assistantCount());
    }, true);
  }

  function findToolBlockSpot(item) {
    const body = bodyOf(item);
    if (!body) return null;
    let found = null;
    body.querySelectorAll(".chat-code-block,pre,code,p,li").forEach((el) => {
      if (el.closest(".zs-chip, .zs-tool-hide")) return;
      const text = (el.textContent || "").trim();
      if (text && commandShape.test(text)) {
        el.classList.add("zs-tool-hide");
        found = found || { parent: el.parentElement, ref: el };
      }
    });
    if (!found && cmdBlockCache.has(item)) {
      body.querySelectorAll(S.artifactCard).forEach((el) => {
        if (el.closest(".zs-chip, .zs-tool-hide")) return;
        el.classList.add("zs-tool-hide");
        found = found || { parent: el.parentElement, ref: el };
      });
    }
    return found;
  }

  return B.createProvider({
    id: "ptero",
    displayName: "Ptero",
    sendRetryLimit: 1,
    supportsVision: false,
    thinkingSel: S.thinking,
    promptExtra: PROMPT_EXTRA,
    timings,
    chipAtItemLevel: true,
    reliableCounts: true,
    init({ diag: d } = {}) { if (d) diag = d; },
    allItems, isUserItem, isAssistantItem, itemText, classifyText,
    assistantCount, userCount, lastAssistant, lastAssistantId, readAssistant,
    streamLen, snapshot,
    getEditor, editorText, chatIsEmpty, isFreshChat, composerFrame, barAnchor,
    setInputLock, typeAndSend, stopGeneration,
    isGenerating, isBusyNow, isHardGenerating, turnHalted,
    enforceComposer, ensureComposerReady,
    scanError, isTooLongMsg, isBusyMsg,
    attachImages: () => false,
    clearAttachments: () => {},
    conversationKey, installSendHooks, findToolBlockSpot,
  });
})();
