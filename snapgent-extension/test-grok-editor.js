// Quick Node regression test for providers/grok.js (run: node test-grok-editor.js).
// Not shipped.
//
// Why this exists: grok.com keeps a hidden mirror `<textarea>` (0px tall,
// visibility:hidden, tabindex=-1) right next to the real tiptap composer, and
// the mirror can come FIRST in document order. querySelectorAll returns document
// order, so the provider typed the prompt into the mirror, the tiptap div stayed
// empty and every run died with "Grok send button did not become available"
// (diag: start.noToolCall {kind:"empty",textLen:0}). These tests pin that the
// editor is chosen by box size, and that a page with no boxed editor reports no
// editor at all instead of handing back the ghost.
const fs = require("fs");
const assert = require("assert");

class StubTextArea {}
Object.defineProperty(StubTextArea.prototype, "value", {
  get() { return this._value || ""; },
  set(value) { this._value = String(value); },
});
class StubInput {}
Object.defineProperty(StubInput.prototype, "value", {
  get() { return this._value || ""; },
  set(value) { this._value = String(value); },
});
class StubInputEvent {
  constructor(type, options) { this.type = type; Object.assign(this, options); }
}

global.window = { HTMLTextAreaElement: StubTextArea, HTMLInputElement: StubInput };
global.HTMLTextAreaElement = StubTextArea;
global.HTMLInputElement = StubInput;
global.InputEvent = StubInputEvent;
global.Event = StubInputEvent;

const noBox = { width: 614, height: 0 };

// The hidden mirror: a real element with a real rect, but no height.
const mirror = Object.assign(new StubTextArea(), {
  tagName: "TEXTAREA",
  isConnected: true,
  attrs: {},
  focus() {},
  contains() { return false; },
  closest() { return null; },
  querySelector() { return null; },
  setAttribute(name, value) { this.attrs[name] = value; },
  removeAttribute(name) { delete this.attrs[name]; },
  getAttribute(name) { return this.attrs[name] === undefined ? null : this.attrs[name]; },
  dispatchEvent() {},
  getClientRects() { return [noBox]; },
  getBoundingClientRect() { return noBox; },
});

let sentText = null;
const sendButton = {
  tagName: "BUTTON",
  type: "submit",
  isConnected: true,
  disabled: false,
  attrs: { "aria-label": "Send" },
  getAttribute(name) { return this.attrs[name] === undefined ? null : this.attrs[name]; },
  matches(selector) { return /type="submit"/.test(selector); },
  closest() { return null; },
  getClientRects() { return [{ width: 32, height: 32 }]; },
  getBoundingClientRect() { return { width: 32, height: 32 }; },
  click() {
    // Grok clears the composer as soon as it takes the prompt.
    sentText = tiptap.textContent;
    tiptap.textContent = "";
  },
};

const form = {
  tagName: "FORM",
  querySelectorAll(selector) {
    return /button/i.test(selector) ? [sendButton] : [];
  },
};

// The real composer: a tiptap/ProseMirror contenteditable with a 24px box.
const tiptap = {
  tagName: "DIV",
  isConnected: true,
  textContent: "",
  attrs: { contenteditable: "true" },
  get innerText() { return this.textContent; },
  focus() {},
  contains() { return false; },
  closest(selector) { return /form/i.test(selector) ? form : null; },
  querySelector() { return null; },
  setAttribute(name, value) { this.attrs[name] = value; },
  removeAttribute(name) { delete this.attrs[name]; },
  getAttribute(name) { return this.attrs[name] === undefined ? null : this.attrs[name]; },
  dispatchEvent() {},
  getClientRects() { return [{ width: 614, height: 24 }]; },
  getBoundingClientRect() { return { width: 614, height: 24 }; },
};

let editors = [mirror, tiptap]; // document order: the mirror is first

// grok.com's "Free tier limit reached" notice: role=status, testid usage-limit-notice.
let limitNotice = null;

const makeLimitNotice = (text) => ({
  tagName: "DIV",
  isConnected: true,
  innerText: text,
  textContent: text,
  getAttribute() { return null; },
  closest() { return null; },
  getClientRects() { return [{ width: 300, height: 20 }]; },
  getBoundingClientRect() { return { width: 300, height: 20 }; },
});

global.document = {
  querySelector() { return null; },
  querySelectorAll(selector) {
    // The provider's editor selector: the only list with .tiptap in it.
    if (selector.includes(".tiptap")) return editors;
    if (selector.includes("usage-limit-notice")) return limitNotice ? [limitNotice] : [];
    return [];
  },
  execCommand(command, _ui, text) {
    if (command !== "insertText") return false;
    const target = tiptap;
    target.textContent = text;
    return true;
  },
};
global.window.getSelection = () => null;
global.location = { pathname: "/" };

const provider = new Function(
  fs.readFileSync(__dirname + "/providers/grok.js", "utf8") + "; return ZSProvider;"
)();

(async () => {
  assert.strictEqual(provider.getEditor(), tiptap,
    "the zero-height mirror textarea is never picked as the editor");

  await provider.typeAndSend("PONG");
  assert.strictEqual(sentText, "PONG",
    "the prompt is typed into the visible tiptap composer");
  assert.strictEqual(mirror.value, "",
    "the hidden mirror is not the write target");

  // No boxed editor on the page (composer still mounting): report nothing so the
  // bootstrap keeps waiting instead of typing into the mirror.
  tiptap.attrs.contenteditable = "false";
  editors = [mirror];
  assert.strictEqual(provider.getEditor(), null,
    "a page with only the hidden mirror reports no editor");
  assert.strictEqual(provider.isFreshChat(), false,
    "a page with only the mirror is not a ready composer");

  // A cold tab that is still restoring /c/<id> must never look like an empty
  // chat, or the opening prompt is sent into a thread that re-renders under it.
  editors = [tiptap];
  tiptap.attrs.contenteditable = "true";
  global.location.pathname = "/c/3ff1cd3e";
  assert.strictEqual(provider.chatIsEmpty(), false,
    "a restored /c/<id> tab is not an empty chat even before its turns mount");
  global.location.pathname = "/";
  assert.strictEqual(provider.chatIsEmpty(), true, "the home composer is an empty chat");

  // The account's limit banner must be reported as the reason, not waited out.
  limitNotice = makeLimitNotice(
    "Free tier limit reached Try again later or upgrade for much higher limits and premium features."
  );
  const reason = provider.scanError();
  assert.ok(reason && /free tier limit reached/i.test(reason),
    "the usage-limit notice is surfaced as the failure reason");

  console.log("PASS grok types into the tiptap composer even when the mirror textarea comes first");
  console.log("PASS grok reports no editor (and keeps waiting) while only the mirror exists");
  console.log("PASS grok treats a restoring /c/<id> tab as a chat with messages");
  console.log("PASS grok reports the account's usage-limit notice instead of waiting it out");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
