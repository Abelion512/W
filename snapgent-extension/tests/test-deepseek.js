// tests/test-deepseek.js - stub-DOM tests for providers/deepseek.js.
// Covers: disabled send button (ds-button--disabled with NO disabled/aria-disabled
// attribute, validated live 2026-11), DeepThink + Search preserved ON at startup,
// and reply extraction excluding the reasoning area.
const fs = require("fs");

if (typeof global.KeyboardEvent !== "function") {
  global.KeyboardEvent = function KeyboardEvent(type, init = {}) { return Object.assign({ type }, init); };
}
if (typeof global.Event !== "function") {
  global.Event = function Event(type, init = {}) { return Object.assign({ type }, init); };
}

const txt = (v) => ({ nodeType: 3, nodeValue: v, childNodes: [] });
function el(tag, o = {}, ch = []) {
  const cls = new Set((o.class || "").split(/\s+/).filter(Boolean));
  const a = Object.assign({}, o.attrs || {});
  const n = {
    nodeType: 1, tagName: tag.toUpperCase(), id: o.id || "",
    offsetParent: "offsetParent" in o ? o.offsetParent : {},
    childNodes: ch.map((c) => (typeof c === "string" ? txt(c) : c)),
    classList: {
      contains: (c) => cls.has(c),
      add: (c) => cls.add(c),
      remove: (c) => cls.delete(c),
    },
    dataset: {},
    events: [],
    getAttribute: (k) => (k in a ? a[k] : null),
    setAttribute: (k, v) => { a[k] = String(v); },
    removeAttribute: (k) => { delete a[k]; },
    getClientRects: () => [{ width: 10, height: 10 }],
    getBoundingClientRect: () => ({ width: 10, height: 10, top: 0 }),
    focus: () => {},
    dispatchEvent: (ev) => { n.events.push(ev); return true; },
    click: () => { n.clicks = (n.clicks || 0) + 1; if (o.click) o.click(n); },
    clicks: 0,
    get className() { return [...cls].join(" "); },
    matches(sel) {
      return sel.split(",").some((p) => {
        const s = p.trim();
        if (!s) return false;
        // compound "tag.class" / ".a.b" / "[attr=v]"
        const parts = s.match(/^([a-z][\w-]*)?((?:\.[\w-]+)*)((?:\[[^\]]+\])*)$/i);
        if (!parts) return false;
        const [, t, classes, attrs] = parts;
        if (t && n.tagName !== t.toUpperCase()) return false;
        for (const c of (classes || "").split(".").filter(Boolean)) if (!cls.has(c)) return false;
        for (const m of (attrs || "").matchAll(/\[([-\w]+)(?:([*^]?=)["']?([^"'\]]*)["']?)?\]/g)) {
          const v = n.getAttribute(m[1]);
          if (m[1] === "class" && m[2] === "*=") { if (!n.className.includes(m[3])) return false; continue; }
          if (!m[2]) { if (v === null) return false; continue; }
          if (m[2] === "=" && v !== m[3]) return false;
          if (m[2] === "*=" && !(v || "").includes(m[3])) return false;
          if (m[2] === "^=" && !(v || "").startsWith(m[3])) return false;
        }
        return !!(t || classes || attrs);
      });
    },
  };
  Object.defineProperty(n, "textContent", { get() {
    const out = [];
    const w = (x) => x.nodeType === 3 ? out.push(x.nodeValue) : (x.childNodes || []).forEach(w);
    w(n); return out.join("");
  }});
  Object.defineProperty(n, "innerText", { get() { return n.textContent; } });
  Object.defineProperty(n, "children", { get() { return n.childNodes.filter((c) => c.nodeType === 1); } });
  Object.defineProperty(n, "parentElement", { get() { return n.parent || null; } });
  n.querySelectorAll = (sel) => {
    const hits = [];
    // descendant selector support: "A B"
    const chain = sel.includes(",") ? null : sel.trim().split(/\s+/);
    const w = (x) => (x.childNodes || []).forEach((c) => {
      if (c.nodeType !== 1) return;
      if (chain && chain.length > 1) {
        if (c.matches(chain[chain.length - 1])) {
          let anc = c.parent, i = chain.length - 2;
          while (anc && i >= 0) { if (anc.matches && anc.matches(chain[i])) i--; anc = anc.parent; }
          if (i < 0) hits.push(c);
        }
      } else if (c.matches(sel)) hits.push(c);
      w(c);
    });
    w(n); return hits;
  };
  n.querySelector = (sel) => n.querySelectorAll(sel)[0] || null;
  n.closest = (sel) => { for (let x = n; x && x.nodeType === 1; x = x.parent) if (x.matches(sel)) return x; return null; };
  n.contains = (o2) => { for (let x = o2; x; x = x.parent) if (x === n) return true; return false; };
  n.childNodes.forEach((c) => { if (c && c.nodeType === 1) c.parent = n; });
  return n;
}

const doc = el("div");
const setDOM = (xs) => { doc.childNodes = xs; xs.forEach((x) => { if (x && x.nodeType === 1) x.parent = doc; }); };
global.document = {
  querySelector: (s) => doc.querySelector(s),
  querySelectorAll: (s) => doc.querySelectorAll(s),
  addEventListener: () => {},
  dispatchEvent: () => {},
  documentElement: { setAttribute: () => {}, dataset: {} },
};
global.window = { location: { pathname: "/" }, HTMLTextAreaElement: null };
global.location = global.window.location;
global.getComputedStyle = () => ({});
global.ZSParse = { LUA_START_RE: /###lua###/i, LUA_END_RE: /###end_lua###/i, DSML_RE: /<\uFF5CDSML\uFF5C/ };

const P = new Function( // NOSONAR test only: own local provider files read from disk
  fs.readFileSync(__dirname + "/../providers/base.js", "utf8") + "\n" +
  fs.readFileSync(__dirname + "/../providers/deepseek.js", "utf8") + "; return ZSProvider;")();
P.init({ diag: () => {} });

const ok = (m, c, extra) => {
  console.log((c ? "PASS" : "FAIL") + "  " + m + (c || extra === undefined ? "" : "  " + JSON.stringify(extra)));
  if (!c) process.exitCode = 1;
};

const sendArrow = () => el("svg", {}, [el("path", { attrs: { d: "M8.3125 0.981587C8.66767 1.0545" } })]);
const mkComposer = (sendBtn, toggles = []) => {
  const ta = el("textarea", { attrs: { placeholder: "Message DeepSeek" } });
  ta.value = "";
  return { ta, box: el("div", { class: "composer" }, [ta, ...toggles, sendBtn]) };
};
const mkToggle = (label, on) => el("div", {
  class: "ds-toggle-button" + (on ? " ds-toggle-button--selected" : ""),
  attrs: { role: "button", "aria-pressed": on ? "true" : "false" },
}, [label]);

(async () => {
  // ── 1. Disabled send button (live DeepSeek 2026-11: only the CSS class) ──
  {
    const btn = el("div", { class: "ds-button ds-button--primary ds-button--disabled", attrs: { role: "button" } }, [sendArrow()]);
    const { ta, box } = mkComposer(btn);
    setDOM([box]);
    const t0 = Date.now();
    await P.typeAndSend("hello");
    ok("disabled-class send button is NOT clicked", btn.clicks === 0, { clicks: btn.clicks });
    const enters = ta.events.filter((e) => e && e.key === "Enter").length;
    ok("disabled-class send button falls back to Enter", enters >= 1, { enters, waited: Date.now() - t0 });
  }

  // ── 2. Send button becomes enabled after React re-renders ──
  {
    const btn = el("div", { class: "ds-button ds-button--primary ds-button--disabled", attrs: { role: "button" },
      click: (n) => { n.clickedWhileDisabled = n.classList.contains("ds-button--disabled"); } }, [sendArrow()]);
    const { ta, box } = mkComposer(btn);
    setDOM([box]);
    setTimeout(() => btn.classList.remove("ds-button--disabled"), 250);
    await P.typeAndSend("hello");
    const enters = ta.events.filter((e) => e && e.key === "Enter").length;
    ok("send button clicked once ds-button--disabled is removed",
      btn.clicks === 1 && btn.clickedWhileDisabled === false && enters === 0,
      { clicks: btn.clicks, clickedWhileDisabled: btn.clickedWhileDisabled, enters });
  }

  // ── 3. Enabled send button clicked immediately ──
  {
    const btn = el("div", { class: "ds-button ds-button--primary", attrs: { role: "button" } }, [sendArrow()]);
    const { box } = mkComposer(btn);
    setDOM([box]);
    await P.typeAndSend("hello");
    ok("enabled send button clicked", btn.clicks === 1, { clicks: btn.clicks });
  }

  // ── 4. DeepThink + Search stay ON through startup enforcement ──
  {
    const btn = el("div", { class: "ds-button ds-button--primary ds-button--disabled", attrs: { role: "button" } }, [sendArrow()]);
    const dt = mkToggle("DeepThink", true);
    const se = mkToggle("Search", true);
    const { box } = mkComposer(btn, [dt, se]);
    setDOM([box]);
    const st = await P.ensureComposerReady("startup");
    ok("ensureComposerReady ready with DeepThink + Search ON", st.ready === true && st.deepThinkOn === true && st.searchOff === false, st);
    ok("DeepThink and Search were not toggled off", dt.clicks === 0 && se.clicks === 0, { dt: dt.clicks, se: se.clicks });
  }

  // ── 5. DeepThink OFF is turned ON once; Search left as user set it ──
  {
    const btn = el("div", { class: "ds-button ds-button--primary", attrs: { role: "button" } }, [sendArrow()]);
    const dt = mkToggle("DeepThink", false);
    dt.click = () => { dt.clicks = (dt.clicks || 0) + 1; dt.classList.add("ds-toggle-button--selected"); dt.setAttribute("aria-pressed", "true"); };
    const se = mkToggle("Search", true);
    const { box } = mkComposer(btn, [dt, se]);
    setDOM([box]);
    const st = await P.ensureComposerReady("startup");
    ok("DeepThink OFF gets enabled at startup, Search untouched", dt.clicks === 1 && se.clicks === 0 && st.deepThinkOn === true, { dt: dt.clicks, se: se.clicks, st });
  }

  // ── 6. Reply extraction ignores reasoning ──
  {
    const btn = el("div", { class: "ds-button ds-button--primary", attrs: { role: "button" } }, [sendArrow()]);
    const { box } = mkComposer(btn);
    const reply = el("div", { class: "ds-message" }, [
      el("div", { class: "ds-think-content" }, [el("div", { class: "ds-markdown" }, ['draft {"command":"rm"}'])]),
      el("div", { class: "ds-markdown" }, ['{"command":"read_file","params":{"path":"VERSION"}}']),
    ]);
    setDOM([reply, box]);
    const t = P.itemText(reply);
    ok("itemText excludes DeepThink reasoning", t.includes("read_file") && !t.includes('"rm"'), { t });
    const ra = P.readAssistant();
    ok("readAssistant splits reply and thinking", ra.reply.includes("read_file") && ra.thinking.includes("rm"), ra && { reply: ra.reply, thinking: ra.thinking });
  }
})();
