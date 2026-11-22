const fs = require("fs");
const txt = (v) => ({ nodeType: 3, nodeValue: v, childNodes: [] });
function el(tag, o = {}, ch = []) {
  const cls = (o.class || "").split(/\s+/).filter(Boolean);
  const a = Object.assign({}, o.attrs || {});
  const n = {
    nodeType: 1, tagName: tag.toUpperCase(), id: o.id || "",
    offsetParent: "offsetParent" in o ? o.offsetParent : {},
    childNodes: ch.map((c) => (typeof c === "string" ? txt(c) : c)),
    classList: { contains: (c) => cls.includes(c), add: () => {} },
    getAttribute: (k) => (k in a ? a[k] : null),
    getClientRects: o.getClientRects, click: o.click || (() => {}),
    matches(sel) {
      return sel.split(",").some((p) => {
        const s = p.trim();
        if (!s) return false;
        if (s[0] === "#") return n.id === s.slice(1);
        if (s[0] === ".") return cls.includes(s.slice(1));
        let m = /^\[([-\w]+)=["']([^"']+)["']\]$/.exec(s);
        if (m) return n.getAttribute(m[1]) === m[2];
        m = /^\[([-\w]+)\]$/.exec(s);
        if (m) return n.getAttribute(m[1]) !== null;
        return /^[a-z][\w-]*$/i.test(s) && n.tagName === s.toUpperCase();
      });
    },
  };
  Object.defineProperty(n, "textContent", { get() {
    const out = [];
    const w = (x) => x.nodeType === 3 ? out.push(x.nodeValue) : (x.childNodes || []).forEach(w);
    w(n); return out.join("");
  }});
  n.querySelectorAll = (sel) => {
    const hits = [];
    const w = (x) => (x.childNodes || []).forEach((c) => { if (c.nodeType === 1) { if (c.matches(sel)) hits.push(c); w(c); } });
    w(n); return hits;
  };
  n.querySelector = (sel) => n.querySelectorAll(sel)[0] || null;
  n.closest = (sel) => { for (let x = n; x && x.nodeType === 1; x = x.parent) if (x.matches(sel)) return x; return null; };
  n.childNodes.forEach((c) => { if (c && c.nodeType === 1) c.parent = n; });
  return n;
}
const ls = {}, doc = el("div");
const setDOM = (xs) => { doc.childNodes = xs; xs.forEach((x) => { if (x && x.nodeType === 1) x.parent = doc; }); };
global.document = { querySelector: (s) => doc.querySelector(s), querySelectorAll: (s) => doc.querySelectorAll(s), addEventListener: (t, f) => { ls[t] = f; }, dispatchEvent: () => {} };
global.window = { location: { pathname: "/app/t" }, getSelection: () => ({}) };
global.location = global.window.location;
global.getComputedStyle = () => ({});
const P = new Function(fs.readFileSync(__dirname + "/providers/gemini.js", "utf8") + "; return ZSProvider;")();
const ok = (m, c) => { console.log((c ? "PASS" : "FAIL") + "  " + m); if (!c) process.exitCode = 1; };
const mkIn = (ic, fn) => { const b = el("button", { click: fn }, [el("mat-icon", { attrs: { fonticon: ic } })]); return { box: el("input-area-v2", {}, [el("div", { class: "ql-editor", attrs: { contenteditable: "true" } }), b]), b }; };
ok("WEDGE_MS === 30000", P.__test.WEDGE_MS === 30000);
setDOM([el("mat-progress-bar")]); ok("progress bar -> working", P.__test.isTaskModeWorking());
setDOM([el("div", { attrs: { role: "progressbar" } })]); ok("role=progressbar -> working", P.__test.isTaskModeWorking());
setDOM([el("div", { attrs: { "aria-busy": "true" } })]); ok("aria-busy -> working", P.__test.isTaskModeWorking());
setDOM([el("model-response", {}, [el("model-thoughts", {}, ["Thinking it through..."]), el("message-content")])]); ok("Thinking it through in model-response -> working", P.__test.isTaskModeWorking());
setDOM([el("div", { attrs: { role: "status" } }, ["Thinking it through..."])]); ok("Thinking it through in status -> working", P.__test.isTaskModeWorking());
setDOM([el("mat-progress-bar", { offsetParent: null }), el("div", { id: "zs-root" }, [el("div", { attrs: { "aria-busy": "true" } })]), el("user-query", {}, ["Thinking it through"]), el("model-response", {}, [el("message-content", {}, ["Thinking it through"])])]);
ok("no false positive on hidden/#zs-root/prose", !P.__test.isTaskModeWorking());
setDOM([el("mat-dialog-container", { offsetParent: null, getClientRects: () => [{ width: 300, height: 150 }] }, ["Cancel response generation?"])]); ok("fixed cancel dialog detected", P.__test.isCancelDialogOpen());
setDOM([el("div", { attrs: { role: "dialog" } }, ["Share link"])]); ok("unrelated dialog ignored", !P.__test.isCancelDialogOpen());
const realNow = Date.now; let now = 1e6; Date.now = () => now;
try {
  let c = 0, u = mkIn("stop", () => c++);
  setDOM([u.box, el("model-response", {}, [el("div", {}, ["Thinking it through..."]), el("message-content")])]);
  P.__test.resetStreamState(); P.__test.genActive(); now += 45000;
  ok("Task Mode: genActive true & unwedgeStop skips", P.__test.genActive() && !P.__test.unwedgeStop() && c === 0);
  c = 0; u = mkIn("stop", () => c++);
  setDOM([u.box, el("model-response", {}, [el("message-content", {}, ["done"])]), el("div", { attrs: { role: "dialog" } }, ["Cancel response generation?"])]);
  P.__test.resetStreamState(); P.__test.genActive(); now += 45000;
  ok("Cancel dialog open: unwedgeStop skips", !P.__test.unwedgeStop() && c === 0);
  c = 0; u = mkIn("stop", () => c++);
  setDOM([u.box, el("model-response", {}, [el("message-content", {}, ["done"])])]);
  P.__test.resetStreamState(); P.__test.genActive(); now += 15000;
  ok("Quiet 15s (<30s): stays active, no unwedge", P.__test.genActive() && !P.__test.unwedgeStop());
  now += 16000;
  ok("Quiet 31s (>30s): wedged stop clicked", !P.__test.genActive() && P.__test.unwedgeStop() && c === 1);
  c = 0; u = mkIn("stop", () => c++);
  setDOM([u.box, el("mat-progress-bar")]); P.stopGeneration();
  ok("Manual stopGeneration() still clicks Stop", c === 1);
  let ns = 0; P.installSendHooks({ isBlocked: () => false, isStarted: () => true, onBlockedAttempt: () => {}, onUserMessage: () => {}, onNativeStop: () => ns++ });
  const oc = u.b.closest; u.b.closest = (s) => s === "input-area-v2 button" ? u.b : oc(s);
  ls.click({ target: u.b, isTrusted: false }); ls.click({ target: u.b, isTrusted: true });
  ok("Trusted manual Stop click triggers onNativeStop (synthetic ignored)", ns === 1);
} finally { Date.now = realNow; }
