// tests/test-ptero.js - stub-DOM tests for providers/ptero.js (validated against live ptero.pro DOM).
const fs = require("fs");

const TEXT = 3;
const ELEM = 1;

function splitOutside(input, space) {
  const out = [];
  let buf = "", depth = 0, quote = null;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quote) { buf += ch; if (ch === quote && input[i - 1] !== "\\") quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
    if (ch === "[") depth += 1;
    if (ch === "]") depth = Math.max(0, depth - 1);
    const boundary = space ? /\s/.test(ch) : ch === ",";
    if (!depth && boundary) { if (buf.trim()) out.push(buf.trim()); buf = ""; continue; }
    buf += ch;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

function bracketEnd(input) {
  let depth = 0, quote = null;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quote) { if (ch === quote && input[i - 1] !== "\\") quote = null; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "[") depth += 1;
    else if (ch === "]" && --depth === 0) return i;
  }
  return -1;
}

function attrMatches(el, inner) {
  const m = /^([\w-]+)\s*(?:([~*^$|]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s]+)))?$/.exec(inner);
  if (!m) return false;
  const [, name, op, d1, d2, d3] = m;
  const want = d1 ?? d2 ?? d3 ?? "";
  const actual = name === "class" ? el.className : el.getAttribute(name);
  if (actual == null) return false;
  if (!op) return true;
  if (op === "=") return actual === want;
  if (op === "*=") return actual.includes(want);
  if (op === "^=") return actual.startsWith(want);
  return false;
}

function matchesCompound(el, selector) {
  if (!el || el.nodeType !== ELEM) return false;
  let neg = null;
  const notM = /:not\(([^)]+)\)/.exec(selector);
  if (notM) { neg = notM[1]; selector = selector.replace(notM[0], ""); }
  let rest = selector;
  const tag = /^[a-zA-Z][\w-]*/.exec(rest);
  if (tag) { if (el.tagName !== tag[0].toUpperCase()) return false; rest = rest.slice(tag[0].length); }
  while (rest.length) {
    if (rest[0] === ".") {
      const m = /^\.([\w-]+)/.exec(rest);
      if (!m || !el.classList.contains(m[1])) return false;
      rest = rest.slice(m[0].length);
    } else if (rest[0] === "#") {
      const m = /^#([\w-]+)/.exec(rest);
      if (!m || el.id !== m[1]) return false;
      rest = rest.slice(m[0].length);
    } else if (rest[0] === "[") {
      const end = bracketEnd(rest);
      if (end < 0 || !attrMatches(el, rest.slice(1, end))) return false;
      rest = rest.slice(end + 1);
    } else {
      return false;
    }
  }
  if (neg && matchesCompound(el, neg)) return false;
  return true;
}

function matches(el, selector) {
  return splitOutside(selector, false).some((part) => {
    const tokens = splitOutside(part, true);
    if (!tokens.length || !matchesCompound(el, tokens[tokens.length - 1])) return false;
    let node = el.parentElement;
    for (let i = tokens.length - 2; i >= 0; i -= 1) {
      while (node && !matchesCompound(node, tokens[i])) node = node.parentElement;
      if (!node) return false;
      node = node.parentElement;
    }
    return true;
  });
}

const textNode = (v) => ({ nodeType: TEXT, nodeValue: String(v), childNodes: [], parentElement: null, cloneNode() { return textNode(this.nodeValue); } });

class StubElement {
  constructor(tag, opts = {}) {
    this.nodeType = ELEM;
    this.tagName = tag.toUpperCase();
    this.childNodes = [];
    this.parentElement = null;
    this.attrs = { ...(opts.attrs || {}) };
    this._classes = new Set(String(opts.class || "").split(/\s+/).filter(Boolean));
    this._visible = opts.visible !== false;
    this._connected = true;
    this.disabled = !!opts.disabled;
    this.id = opts.id || "";
    this.dataset = Object.assign({}, opts.dataset || {});
    for (const [k, v] of Object.entries(this.dataset)) {
      this.attrs["data-" + k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase())] = String(v);
    }
    this._click = opts.click || null;
  }
  get className() { return [...this._classes].join(" "); }
  get textContent() {
    return this.childNodes.map((c) => (c.nodeType === TEXT ? c.nodeValue : c.textContent || "")).join("");
  }
  get innerText() { return this.textContent; }
  get isConnected() { return this._connected; }
  get classList() {
    return {
      add: (...xs) => xs.forEach((n) => this._classes.add(n)),
      remove: (...xs) => xs.forEach((n) => this._classes.delete(n)),
      contains: (n) => this._classes.has(n),
    };
  }
  getAttribute(name) {
    if (name === "class") return this.className;
    if (name === "id") return this.id || null;
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
  }
  setAttribute(name, v) { this.attrs[name] = String(v); }
  removeAttribute(name) { delete this.attrs[name]; }
  getClientRects() { return this._connected && this._visible ? [{ width: 10, height: 10 }] : []; }
  matches(sel) { return matches(this, sel); }
  closest(sel) {
    for (let n = this; n; n = n.parentElement) if (n.nodeType === ELEM && matches(n, sel)) return n;
    return null;
  }
  contains(node) {
    for (let n = node; n; n = n.parentElement) if (n === this) return true;
    return false;
  }
  querySelectorAll(sel) {
    const hits = [];
    const w = (node) => {
      for (const c of node.childNodes) {
        if (c.nodeType !== ELEM) continue;
        if (matches(c, sel)) hits.push(c);
        w(c);
      }
    };
    w(this);
    return hits;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  append(...children) {
    for (const c of children) { c.parentElement = this; this.childNodes.push(c); }
  }
  replaceChildren(...children) {
    this.childNodes = [];
    this.append(...children);
  }
  cloneNode(deep) {
    const copy = new StubElement(this.tagName.toLowerCase(), {
      id: this.id, class: this.className, attrs: this.attrs, visible: this._visible,
    });
    if (deep) copy.append(...this.childNodes.map((c) => c.cloneNode(true)));
    return copy;
  }
  click() {
    this.clicks = (this.clicks || 0) + 1;
    if (this._click) this._click(this);
  }
  remove() {
    this._connected = false;
    if (this.parentElement) {
      this.parentElement.childNodes = this.parentElement.childNodes.filter((c) => c !== this);
    }
  }
}

class StubTextArea extends StubElement {
  get value() { return this._value || ""; }
  set value(v) { this._value = String(v); }
}

const el = (tag, opts = {}, children = []) => {
  const n = tag === "textarea" ? new StubTextArea(tag, opts) : new StubElement(tag, opts);
  for (const c of children) n.append(typeof c === "string" ? textNode(c) : c);
  return n;
};

global.Node = { TEXT_NODE: TEXT, ELEMENT_NODE: ELEM };
global.HTMLTextAreaElement = StubTextArea;
global.Event = class { constructor(t, o) { this.type = t; Object.assign(this, o); } };
global.InputEvent = class extends global.Event {};
global.window = {};
global.location = { pathname: "/" };

const root = el("div");
const list = el("div", { id: "chat-messages" });
const editor = el("textarea", { id: "chat-input" });
const sendBtn = el("button", { id: "chat-send-btn" });
const inputArea = el("div", { id: "chat-input-area" }, [editor, sendBtn]);
root.append(list, inputArea);

global.document = {
  body: root,
  querySelector: (s) => root.querySelector(s),
  querySelectorAll: (s) => root.querySelectorAll(s),
  addEventListener: () => {},
};

const P = new Function( // NOSONAR test only: own local provider files
  fs.readFileSync(__dirname + "/../providers/base.js", "utf8") + "\n" +
  fs.readFileSync(__dirname + "/../providers/ptero.js", "utf8") + "; return ZSProvider;"
)();
P.init({ diag: () => {} });

const ok = (name, cond, detail) => {
  console.log((cond ? "PASS  " : "FAIL  ") + name + (cond || detail === undefined ? "" : "  " + JSON.stringify(detail)));
  if (!cond) process.exitCode = 1;
};

// 1. thinkingSel + thinking extraction (must NOT skip .chat-thinking inside thinking!)
{
  ok("thinkingSel is .chat-thinking", P.thinkingSel === ".chat-thinking", P.thinkingSel);
  const asst = el("div", { class: "chat-msg assistant" }, [
    el("div", { class: "chat-thinking" }, ["Step 1: inspect files"]),
    el("div", { class: "chat-msg-text" }, [
      el("div", { class: "chat-code-block" }, [
        el("div", { class: "chat-code-block-header" }, [
          el("span", {}, ["json"]),
          el("button", { class: "chat-copy-btn" }, ["Copy"]),
        ]),
        el("pre", {}, [el("code", {}, ['{"command":"read_file","params":{"path":"VERSION"}}'])]),
      ]),
      el("div", { class: "chat-model-switch-note" }, ["Switched model"]),
    ]),
  ]);
  list.replaceChildren(asst);
  const snap = P.snapshot();
  const ra = P.readAssistant();
  const it = P.itemText(asst);
  ok("snapshot().th captures .chat-thinking length", snap.th > 0, snap);
  ok("readAssistant().thinking returns thinking text", ra.thinking.includes("inspect files"), ra.thinking);
  ok("itemText excludes header, copy button, model-switch note, and thinking",
    it.includes('"read_file"') && !it.includes("Copy") && !it.includes("Switched model") && !it.includes("inspect files"),
    it);
  ok("readAssistant().reply excludes UI chrome cleanly",
    ra.reply.includes('"read_file"') && !ra.reply.includes("Copy") && !ra.reply.includes("Switched model"),
    ra.reply);
}

// 2. streamLen tracks thinking growth + turnHalted + reasoning busy signal
{
  const asst = el("div", { class: "chat-msg assistant" }, [
    el("div", { class: "chat-thinking" }, ["Thinking about the workspace structure..."]),
    el("div", { class: "chat-msg-text" }, []),
  ]);
  list.replaceChildren(asst);
  ok("streamLen counts .chat-thinking even before reply starts", P.streamLen(asst) > 10, P.streamLen(asst));
  ok("isBusyNow is true during active reasoning with empty reply", P.isBusyNow() === true, { gen: P.isGenerating() });

  const stopped = el("div", { class: "chat-stopped-note" }, ["Stopped generating"]);
  asst.querySelector(".chat-msg-text").append(stopped);
  ok("turnHalted detects .chat-stopped-note", P.turnHalted(asst) === true);
  ok("isBusyNow drops to false once turn is halted", P.isBusyNow() === false);
  ok("itemText excludes .chat-stopped-note", !P.itemText(asst).includes("Stopped generating"), P.itemText(asst));
}

// 3. >= 15-line code block collapse into .chat-file-card / .chat-artifact-card
{
  const multiLineCmd = [
    "{",
    '  "command": "multi_edit",',
    '  "params": {',
    '    "path": "a.txt",',
    '    "edits": [',
    '      {"old": "1", "new": "2"}',
    '    ]',
    "  }",
    "}\n\n\n\n\n\n\n\n",
  ].join("\n");
  const codeBlock = el("div", { class: "chat-code-block" }, [
    el("div", { class: "chat-code-block-header" }, [el("button", { class: "chat-copy-btn" }, ["Copy"])]),
    el("pre", {}, [el("code", {}, [multiLineCmd])]),
  ]);
  const msgText = el("div", { class: "chat-msg-text" }, [codeBlock]);
  const asst = el("div", { class: "chat-msg assistant" }, [msgText]);
  list.replaceChildren(asst);
  // Streaming passes sample streamLen / itemText while <pre> exists
  P.streamLen(asst);
  const streamed = P.itemText(asst);
  ok("streaming phase sees raw JSON command", streamed.includes('"multi_edit"'), streamed);
  // On stream end, Ptero's makeCodeBlock replaces <pre> with .chat-file-card.chat-artifact-card
  msgText.replaceChildren(
    el("div", { class: "chat-file-card chat-artifact-card" }, ["snippet.json (17 lines)"]),
  );
  const recoveredItem = P.itemText(asst);
  const recoveredRead = P.readAssistant().reply;
  ok("itemText recovers collapsed >=15-line JSON block after .chat-file-card swap",
    recoveredItem.includes('"multi_edit"'), recoveredItem);
  ok("readAssistant().reply recovers collapsed >=15-line JSON block",
    recoveredRead.includes('"multi_edit"'), recoveredRead);

  // Subsequent normal turn must NOT inherit previous turn's cached block
  const asst2 = el("div", { class: "chat-msg assistant" }, [
    el("div", { class: "chat-msg-text" }, ["Plain final answer."]),
  ]);
  list.append(asst2);
  ok("cache does not leak to next assistant turn",
    P.itemText(asst2) === "Plain final answer." && !P.readAssistant().reply.includes("multi_edit"),
    P.itemText(asst2));
}

// 4. findToolBlockSpot hides .chat-code-block wrapper
{
  const cb = el("div", { class: "chat-code-block" }, [
    el("div", { class: "chat-code-block-header" }, [el("button", { class: "chat-copy-btn" }, ["Copy"])]),
    el("pre", {}, [el("code", {}, ['{"command":"read_file","params":{"path":"VERSION"}}'])]),
  ]);
  const asst = el("div", { class: "chat-msg assistant" }, [el("div", { class: "chat-msg-text" }, [cb])]);
  list.replaceChildren(asst);
  const spot = P.findToolBlockSpot(asst);
  ok("findToolBlockSpot hides whole .chat-code-block wrapper",
    !!spot && cb.classList.contains("zs-tool-hide"), { spot: !!spot, cls: cb.className });
}

// 5. scanError / isBusyMsg / isTooLongMsg against real Ptero surfaces
{
  const errTurn = el("div", { class: "chat-msg assistant" }, [
    el("div", { class: "chat-msg-text" }, ["⚠️ Hourly token limit reached (1,000,000 tokens per hour)."]),
  ]);
  list.replaceChildren(errTurn);
  ok("scanError detects 1M/1h token quota error inside .chat-msg-text",
    (P.scanError() || "").includes("1,000,000"), P.scanError());

  const cookieTurn = el("div", { class: "chat-msg assistant" }, [
    el("div", { class: "chat-msg-text" }, ["Error: Cookie check failed. Please reload."]),
  ]);
  list.replaceChildren(cookieTurn);
  ok("scanError detects Cookie check failed error",
    (P.scanError() || "").includes("Cookie check failed"), P.scanError());

  const tlsTurn = el("div", { class: "chat-msg assistant" }, [
    el("div", { class: "chat-msg-text" }, ["TLS connect error: error:0A000458:SSL routines::tlsv1 unrecognized name"]),
  ]);
  list.replaceChildren(tlsTurn);
  ok("scanError detects TLS connect error notice",
    (P.scanError() || "").includes("TLS connect error"), P.scanError());

  const unavailTurn = el("div", { class: "chat-msg assistant" }, [
    el("div", { class: "chat-msg-text" }, ["All models are currently unavailable. Please try again shortly."]),
  ]);
  list.replaceChildren(unavailTurn);
  ok("scanError detects all_models_unavailable text notice",
    (P.scanError() || "").includes("currently unavailable"), P.scanError());

  const proseTurn = el("div", { class: "chat-msg assistant" }, [
    el("div", { class: "chat-msg-text" }, ["The function returns an error object when validation fails."]),
  ]);
  list.replaceChildren(proseTurn);
  ok("scanError ignores ordinary model prose mentioning error", P.scanError() === null, P.scanError());

  const toast = el("div", { class: "chat-model-toast" }, ["Ptero a bit busy right now, please retry."]);
  root.append(toast);
  ok("scanError detects .chat-model-toast busy/error notice",
    (P.scanError() || "").includes("Ptero a bit busy"), P.scanError());
  toast.remove();

  const infoToast = el("div", { class: "chat-model-toast" }, ["Switched to Agnes 3.0 Flash"]);
  root.append(infoToast);
  ok("scanError ignores benign .chat-model-toast model-switch notice", P.scanError() === null, P.scanError());
  infoToast.remove();

  const hiddenModal = el("div", { id: "chat-username-modal", attrs: { "data-hidden": "1" } }, ["Choose username / verify you are human"]);
  root.append(hiddenModal);
  ok("scanError ignores #chat-username-modal[data-hidden]", P.scanError() === null, P.scanError());
  hiddenModal.removeAttribute("data-hidden");
  ok("scanError detects visible #chat-username-modal gate",
    (P.scanError() || "").length > 0, P.scanError());
  hiddenModal.remove();

  ok("isBusyMsg matches Ptero busy & cookie notices",
    P.isBusyMsg("Ptero a bit busy, please try again") && P.isBusyMsg("Cookie check failed"));
  ok("isTooLongMsg matches Ptero context/hourly limit notices",
    P.isTooLongMsg("Hourly token limit reached (1,000,000 tokens per hour)") &&
    P.isTooLongMsg("Conversation is too long for context limit"));
}

// 6. promptExtra reminds model to keep JSON blocks compact (<12 lines) and avoid built-in actions
ok("promptExtra exists and warns about compact JSON blocks",
  typeof P.promptExtra === "string" && /compact|single.?line|12 lines|15 lines/i.test(P.promptExtra),
  P.promptExtra);
ok("promptExtra steers Ptero models away from built-in tools or GitHub connectors",
  typeof P.promptExtra === "string" &&
  /built-in tools|github connectors/i.test(P.promptExtra) &&
  /compact/i.test(P.promptExtra),
  P.promptExtra);

(async () => {
  // 7. .chat-code-status thinking banner keeps isGenerating() and isBusyNow() true
  {
    const statusBanner = el("div", { class: "chat-code-status", attrs: { "data-type": "thinking" } }, [
      "Generating the response · 204 chars received",
    ]);
    const stalledTurn = el("div", { class: "chat-msg assistant" }, [
      statusBanner,
      el("div", { class: "chat-msg-text" }, []),
    ]);
    list.replaceChildren(stalledTurn);
    sendBtn.classList.remove("is-stop");
    ok(".chat-code-status keeps isGenerating() and isBusyNow() true",
      P.isGenerating() === true && P.isBusyNow() === true,
      { gen: P.isGenerating(), busy: P.isBusyNow() });
    statusBanner.remove();
  }

  // 8. Model picker switching + fast-path when aria-selected="true"
  {
    let pickerTriggerClicks = 0;
    const triggerLabel = el("span", { id: "chat-model-picker-trigger-label" }, ["Agnes 2.5 Flash"]);
    const optAgnes = el("div", {
      class: "chat-model-picker-option is-active",
      dataset: { modelId: "agnes-2.5-flash:agnes", label: "Agnes 2.5 Flash" },
      attrs: { "aria-selected": "true" },
      visible: false,
    }, ["Agnes 2.5 Flash Free"]);
    const optMimo = el("div", {
      class: "chat-model-picker-option",
      dataset: { modelId: "mimo-v2.6-flash:tokenharbor", label: "MiMo V2.6 Flash" },
      attrs: { "aria-selected": "false" },
      visible: false,
    }, ["MiMo V2.6 Flash Free"]);
    const selectOpt = (chosen, other) => {
      chosen.setAttribute("aria-selected", "true");
      chosen.classList.add("is-active");
      other.setAttribute("aria-selected", "false");
      other.classList.remove("is-active");
      triggerLabel.replaceChildren(chosen.dataset.label);
      optAgnes._visible = false;
      optMimo._visible = false;
    };
    optAgnes._click = () => selectOpt(optAgnes, optMimo);
    optMimo._click = () => selectOpt(optMimo, optAgnes);
    const trigger = el("button", {
      id: "chat-model-picker-trigger",
      click: () => {
        pickerTriggerClicks++;
        optAgnes._visible = true;
        optMimo._visible = true;
      },
    }, [triggerLabel]);
    const picker = el("div", { id: "chat-model-picker" }, [trigger, optAgnes, optMimo]);
    root.append(picker);

    const switched = await P.ensureComposerReady("startup", { model: "mimo-v2.6-flash:tokenharbor" });
    ok("ensureComposerReady switches Ptero model via #chat-model-picker-trigger",
      switched.ready === true && switched.modeApplied === true &&
      switched.model === "mimo-v2.6-flash:tokenharbor" &&
      optMimo.getAttribute("aria-selected") === "true" && pickerTriggerClicks === 1,
      switched);

    pickerTriggerClicks = 0;
    const fast = await P.ensureComposerReady("startup", { model: "mimo-v2.6-flash:tokenharbor" });
    ok("ensureComposerReady fast-paths when requested Ptero model is already aria-selected",
      fast.ready === true && fast.modeApplied === true && pickerTriggerClicks === 0,
      { fast, pickerTriggerClicks });

    // 9. aria-expanded="true" avoids toggling dropdown closed, and #chat-model-select.value syncs
    const selectEvents = [];
    const hiddenSelect = el("select", { id: "chat-model-select" }, []);
    hiddenSelect.value = "agnes-2.5-flash:agnes";
    hiddenSelect.dispatchEvent = (ev) => { selectEvents.push(ev && ev.type); return true; };
    picker.append(hiddenSelect);
    pickerTriggerClicks = 0;
    // Reset to agnes option, mark mimo already mismatching only on select.value, then test open menu -> mimo
    const syncedFast = await P.ensureComposerReady("mode", { model: "mimo-v2.6-flash:tokenharbor" });
    ok("ensureComposerReady syncs #chat-model-select.value when aria-selected option already matched",
      syncedFast.applied !== false && syncedFast.modeApplied === true &&
      hiddenSelect.value === "mimo-v2.6-flash:tokenharbor" && selectEvents.includes("change"),
      { syncedFast, val: hiddenSelect.value, selectEvents });

    // Now test already-open dropdown (aria-expanded="true") switching back to agnes without clicking trigger
    trigger.setAttribute("aria-expanded", "true");
    optAgnes._visible = true;
    optMimo._visible = true;
    pickerTriggerClicks = 0;
    selectEvents.length = 0;
    const switchedOpen = await P.ensureComposerReady("mode", { model: "agnes-2.5-flash:agnes" });
    ok("selectModel does not click trigger when aria-expanded=true and syncs #chat-model-select.value",
      switchedOpen.modeApplied === true && switchedOpen.model === "agnes-2.5-flash:agnes" &&
      hiddenSelect.value === "agnes-2.5-flash:agnes" && selectEvents.includes("change") &&
      pickerTriggerClicks === 0,
      { switchedOpen, val: hiddenSelect.value, pickerTriggerClicks, selectEvents });

    picker.remove();
  }

  // 10. A finished Ptero turn keeps .chat-feedback-bar[data-model] mounted even
  // while the native Stop button / code-status banner lag behind. Once the full
  // command reply is present the provider must report NOT generating, or
  // waitForResponse() never reaches parseToolCalls and the turn stalls.
  {
    const cmd = '{"command":"read_file","params":{"path":"VERSION"}}';
    const codeBlock = el("div", { class: "chat-code-block" }, [
      el("div", { class: "chat-code-block-header" }, [
        el("span", {}, ["json"]),
        el("button", { class: "chat-copy-btn" }, ["Copy"]),
      ]),
      el("pre", {}, [el("code", {}, [cmd])]),
    ]);
    const feedback = el("div", {
      class: "chat-feedback-bar",
      dataset: { model: "agnes-3.0-flash:agnes" },
    }, ["i"]);
    const doneTurn = el("div", { class: "chat-msg assistant" }, [
      el("div", { class: "chat-msg-text" }, [codeBlock]),
      feedback,
    ]);
    list.replaceChildren(doneTurn);
    sendBtn.classList.add("is-stop");
    ok("feedback bar + complete command settles isGenerating despite sticky Stop button",
      P.isGenerating() === false && P.isBusyNow() === false,
      { gen: P.isGenerating(), busy: P.isBusyNow(), reply: P.readAssistant().reply });
    sendBtn.classList.remove("is-stop");
  }

  // 11. A feedback bar with a still-streaming (unbalanced) command must NOT
  // settle generation - Ptero mounts the bar before the answer finishes.
  {
    const partial = el("div", { class: "chat-msg assistant" }, [
      el("div", { class: "chat-msg-text" }, ['{"command":"read_file"']),
      el("div", { class: "chat-feedback-bar", dataset: { model: "agnes-3.0-flash:agnes" } }, ["i"]),
    ]);
    list.replaceChildren(partial);
    sendBtn.classList.add("is-stop");
    ok("feedback bar with partial command keeps isGenerating true",
      P.isGenerating() === true,
      { gen: P.isGenerating(), reply: P.readAssistant().reply });
    sendBtn.classList.remove("is-stop");
  }
})();
