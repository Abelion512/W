const fs = require("fs");
if (typeof global.KeyboardEvent !== "function") {
  global.KeyboardEvent = function KeyboardEvent(type, init = {}) {
    return Object.assign({ type }, init);
  };
}
if (typeof global.MouseEvent !== "function") {
  global.MouseEvent = function MouseEvent(type, init = {}) {
    return Object.assign({ type }, init);
  };
}
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
const P = new Function(fs.readFileSync(__dirname + "/../providers/base.js", "utf8") + "\n" + fs.readFileSync(__dirname + "/../providers/gemini.js", "utf8") + "; return ZSProvider;")(); // NOSONAR test only: own local provider files read from disk, no external input
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

  // Live bug repro: Gemini keeps aria-busy="true" inside <message-content> after stop.
  c = 0; u = mkIn("stop", () => c++);
  setDOM([
    u.box,
    el("model-response", {}, [
      el("message-content", {}, [
        el("div", { class: "markdown markdown-main-panel", attrs: { "aria-busy": "true" } }, ["partial"])
      ])
    ])
  ]);
  ok("aria-busy inside message-content is ignored by isTaskModeWorking", !P.__test.isTaskModeWorking());
  P.__test.resetStreamState(); P.__test.genActive(); now += 31000;
  ok("aria-busy inside message-content does not block unwedgeStop past WEDGE_MS", !P.__test.genActive() && P.__test.unwedgeStop() && c === 1);
} finally { Date.now = realNow; }

(async () => {
  const autoBox = el("input-area-v2", {}, [
    el("div", { class: "ql-editor", attrs: { contenteditable: "true" } }),
    el("button", { attrs: { "aria-label": "Open mode picker, currently Auto" } }, ["Auto"]),
  ]);
  setDOM([autoBox]);
  const autoRes = await P.ensureComposerReady("startup");
  ok("ensureComposerReady reports Auto honestly when Hydrogen picker is absent",
    autoRes && autoRes.ready === true && autoRes.modeApplied === false && !/hydrogen/i.test(String(autoRes.model || "")));

  const hydroBox = el("input-area-v2", {}, [
    el("div", { class: "ql-editor", attrs: { contenteditable: "true" } }),
    el("button", { attrs: { "aria-label": "Open mode picker" } }, ["4 Hydrogen · High"]),
  ]);
  setDOM([
    hydroBox,
    el("gem-menu-item", { class: "selected", attrs: { role: "menuitemradio" } }, ["4 Hydrogen"]),
    el("gem-menu-item", { class: "selected", attrs: { role: "menuitemradio" } }, ["High"]),
  ]);
  const hydroRes = await P.ensureComposerReady("startup");
  ok("ensureComposerReady reports modeApplied=true when 4 Hydrogen High is active",
    hydroRes && hydroRes.ready === true && hydroRes.modeApplied === true && /hydrogen/i.test(String(hydroRes.model || "")));

  let wakeCount = 0, sendClicks = 0, stopClicks = 0;
  const stopBtn = el("button", { click: () => { stopClicks++; } }, [el("mat-icon", { attrs: { fonticon: "stop" } })]);
  const sendBtn = el("button", { click: () => { sendClicks++; } }, [el("mat-icon", { attrs: { fonticon: "arrow_upward" } })]);
  const wakeBox = el("input-area-v2", {}, [
    el("div", { class: "ql-editor", attrs: { contenteditable: "true" } }, ["hello"]),
    stopBtn,
  ]);
  setDOM([wakeBox]);
  const prevHidden = global.document.hidden;
  const prevChrome = global.chrome;
  try {
    global.document.hidden = true;
    global.chrome = {
      runtime: {
        lastError: null,
        sendMessage: (msg, cb) => {
          if (msg && msg.type === "zs-wake-tab") {
            wakeCount++;
            global.document.hidden = false;
            setDOM([el("input-area-v2", {}, [
              el("div", { class: "ql-editor", attrs: { contenteditable: "true" } }, ["hello"]),
              sendBtn,
            ])]);
          }
          if (typeof cb === "function") cb();
        },
      },
    };
    await P.typeAndSend("hello");
    ok("hidden typeAndSend wakes tab when stop button blocks send and avoids unwedge stop click",
      wakeCount === 1 && sendClicks === 1 && stopClicks === 0);
  } finally {
    if (prevHidden === undefined) delete global.document.hidden;
    else global.document.hidden = prevHidden;
    if (prevChrome === undefined) delete global.chrome;
    else global.chrome = prevChrome;
  }

  // Live Gemini concatenated button labels + preserveMode + switching across
  // 4 Hydrogen, 4 Neon, and Auto with Low/Medium/High thinking levels.
  let liveBtnText = "HydrogenHigh";
  let liveBtnAria = "Open mode picker, currently Hydrogen High";
  let liveModel = "4 Hydrogen";
  let liveThinking = "High";
  let pickerClicks = 0;
  let menuOpen = false;
  let subOpen = false;
  const makeMenuBtn = () => {
    const b = el("button", {
      attrs: { "data-test-id": "bard-mode-menu-button", "aria-label": liveBtnAria },
      click: () => { pickerClicks++; menuOpen = !menuOpen; if (!menuOpen) subOpen = false; syncMenuDOM(); },
    }, [liveBtnText]);
    Object.defineProperty(b, "innerText", { get: () => liveBtnText.replace(/([a-z])([A-Z])/g, "$1\n$2") });
    return b;
  };
  const syncLabel = () => {
    const mShort = liveModel.replace(/^4\s+/, "");
    if (liveModel === "Auto") {
      liveBtnText = "Auto";
      liveBtnAria = "Open mode picker, currently Auto";
    } else if (liveThinking === "Low") {
      liveBtnText = mShort;
      liveBtnAria = `Open mode picker, currently ${mShort}`;
    } else {
      liveBtnText = mShort + liveThinking;
      liveBtnAria = `Open mode picker, currently ${mShort} ${liveThinking}`;
    }
  };
  const syncMenuDOM = () => {
    const nodes = [
      el("input-area-v2", {}, [
        el("div", { class: "ql-editor", attrs: { contenteditable: "true" } }),
        makeMenuBtn(),
      ]),
    ];
    if (menuOpen) {
      const mkItem = (label, role, val, sel, onClick, hidden) => el("gem-menu-item", {
        class: sel ? "selected" : "",
        offsetParent: hidden ? null : {},
        getClientRects: () => (hidden ? [] : [{ width: 120, height: 32 }]),
        attrs: Object.assign({ role }, val ? { value: val } : {}, sel != null ? { "aria-checked": sel ? "true" : "false" } : {}),
        click: () => { onClick(); syncMenuDOM(); },
      }, [label]);
      nodes.push(mkItem("Auto Adapts to your needs", "menuitemradio", null, liveModel === "Auto", () => {
        liveModel = "Auto"; liveThinking = ""; syncLabel(); menuOpen = false; subOpen = false;
      }, false));
      nodes.push(mkItem("Everyday help 4 Hydrogen", "menuitemradio", null, liveModel === "4 Hydrogen", () => {
        liveModel = "4 Hydrogen"; if (!liveThinking) liveThinking = "Low"; syncLabel(); menuOpen = false; subOpen = false;
      }, false));
      nodes.push(mkItem("Deeper analysis 4 Neon", "menuitemradio", null, liveModel === "4 Neon", () => {
        liveModel = "4 Neon"; if (!liveThinking) liveThinking = "Low"; syncLabel(); menuOpen = false; subOpen = false;
      }, false));
      if (liveModel !== "Auto") {
        nodes.push(mkItem("Thinking level", "menuitem", "thinking_level", null, () => { subOpen = true; }, false));
        for (const lvl of ["Low", "Medium", "High"]) {
          nodes.push(mkItem(`${lvl} desc`, "menuitemradio", null, liveThinking === lvl, () => {
            liveThinking = lvl; syncLabel(); menuOpen = false; subOpen = false;
          }, !subOpen));
        }
      }
    }
    setDOM(nodes);
  };
  const prevDispatch = global.document.dispatchEvent;
  global.document.dispatchEvent = (ev) => {
    if (ev && ev.key === "Escape") { menuOpen = false; subOpen = false; syncMenuDOM(); }
  };
  try {
    syncMenuDOM();
    pickerClicks = 0;
    const fastHydro = await P.ensureComposerReady("startup");
    ok("live concatenated HydrogenHigh fast-paths without clicking picker",
      fastHydro.modeApplied === true && pickerClicks === 0 && fastHydro.model === "4 Hydrogen" && fastHydro.thinking === "High",
      { fastHydro, pickerClicks });

    liveModel = "4 Neon"; liveThinking = "Medium"; syncLabel(); syncMenuDOM(); pickerClicks = 0;
    const preservedNeon = await P.ensureComposerReady("startup", { preserveMode: true });
    ok("preserveMode keeps NeonMedium without clicking picker",
      preservedNeon.modeApplied === true && pickerClicks === 0 && preservedNeon.model === "4 Neon" && preservedNeon.thinking === "Medium",
      { preservedNeon, pickerClicks });

    liveModel = "Auto"; liveThinking = ""; syncLabel(); syncMenuDOM();
    const switchedNeon = await P.ensureComposerReady("startup", { model: "4 Neon", thinking: "Medium" });
    ok("can switch from Auto to 4 Neon + Medium",
      switchedNeon.modeApplied === true && switchedNeon.model === "4 Neon" && switchedNeon.thinking === "Medium",
      switchedNeon);

    const switchedLow = await P.ensureComposerReady("startup", { model: "4 Hydrogen", thinking: "Low" });
    ok("can switch to 4 Hydrogen + Low (button shows Hydrogen without Low suffix)",
      switchedLow.modeApplied === true && switchedLow.model === "4 Hydrogen" && switchedLow.thinking === "Low",
      switchedLow);

    const switchedAuto = await P.ensureComposerReady("startup", { model: "Auto" });
    ok("can switch to Auto",
      switchedAuto.modeApplied === true && switchedAuto.model === "Auto" && switchedAuto.thinking === "",
      switchedAuto);

    // Bare "Hydrogen" (without "Low" word) means Low thinking on live Gemini:
    // requesting 4 Hydrogen + Low must fast-path without clicking the picker.
    liveModel = "4 Hydrogen"; liveThinking = "Low"; syncLabel(); syncMenuDOM(); pickerClicks = 0;
    const fastLow = await P.ensureComposerReady("startup", { model: "4 Hydrogen", thinking: "Low" });
    ok("live bare Hydrogen fast-paths for 4 Hydrogen + Low without clicking picker",
      fastLow.modeApplied === true && pickerClicks === 0 && fastLow.model === "4 Hydrogen" && fastLow.thinking === "Low",
      { fastLow, pickerClicks });

    // Collapsed submenu items with 0x0 bounding rect must NOT count as visible,
    // AND closeModeMenu must dispatch Escape on gem-menu-item (not only document).
    global.document.dispatchEvent = () => {}; // simulate live Angular ignoring Escape on document
    let neonMenuOpened = false;
    let neonEscaped = false;
    let neonClickAttempt = 0;
    let neonSelected = false;
    let neonThink = "High";
    const syncRetryDOM = () => {
      const bText = neonSelected ? (neonThink === "Low" ? "Neon" : "Neon" + neonThink) : "HydrogenHigh";
      const bAria = neonSelected
        ? (neonThink === "Low" ? "Open mode picker, currently Neon" : `Open mode picker, currently Neon ${neonThink}`)
        : "Open mode picker, currently Hydrogen High";
      const b = el("button", {
        attrs: { "data-test-id": "bard-mode-menu-button", "aria-label": bAria },
        click: () => { neonMenuOpened = !neonMenuOpened; syncRetryDOM(); },
      }, [bText]);
      const items = [el("input-area-v2", {}, [
        el("div", { class: "ql-editor", attrs: { contenteditable: "true" } }),
        b,
      ])];
      if (neonMenuOpened) {
        const mkRetryItem = (label, role, val, sel, onClick, hidden) => {
          const it = el("gem-menu-item", {
            class: sel ? "selected" : "",
            offsetParent: hidden ? null : {},
            getClientRects: () => [{ width: hidden ? 0 : 120, height: hidden ? 0 : 32 }],
            attrs: Object.assign({ role }, val ? { value: val } : {}, sel != null ? { "aria-checked": sel ? "true" : "false" } : {}),
            click: () => { onClick(); syncRetryDOM(); },
          }, [label]);
          it.getBoundingClientRect = () => ({ width: hidden ? 0 : 120, height: hidden ? 0 : 32 });
          it.dispatchEvent = (ev) => {
            if (ev && ev.key === "Escape") { neonEscaped = true; neonMenuOpened = false; syncRetryDOM(); }
          };
          return it;
        };
        items.push(mkRetryItem("Everyday help 4 Hydrogen", "menuitemradio", null, !neonSelected, () => {}, false));
        items.push(mkRetryItem("Deeper analysis 4 Neon", "menuitemradio", null, neonSelected, () => {
          neonClickAttempt++;
          // First cold click drops; second attempt succeeds.
          if (neonClickAttempt >= 2) { neonSelected = true; neonMenuOpened = false; }
        }, false));
        // Collapsed 0x0 submenu item (offsetParent null + 0x0 getBoundingClientRect)
        items.push(mkRetryItem("Medium Balanced depth", "menuitemradio", null, false, () => {}, true));
      }
      setDOM(items);
    };
    syncRetryDOM();
    const retryRes = await P.ensureComposerReady("startup", { model: "4 Neon", thinking: "High" });
    ok("retries cold missed model click and closes menu via gem-menu-item Escape",
      retryRes.modeApplied === true && retryRes.model === "4 Neon" && neonClickAttempt === 2 && !neonMenuOpened,
      { retryRes, neonClickAttempt, neonMenuOpened, neonEscaped });

    // Explicit closeModeMenu test when Thinking level click leaves menu open in Angular
    let keepOpen = true;
    let itemEscapes = 0;
    const syncCloseDOM = () => {
      const b = el("button", {
        attrs: { "data-test-id": "bard-mode-menu-button", "aria-label": "Open mode picker, currently Hydrogen Medium" },
      }, ["HydrogenMedium"]);
      const nodes = [el("input-area-v2", {}, [
        el("div", { class: "ql-editor", attrs: { contenteditable: "true" } }),
        b,
      ])];
      if (keepOpen) {
        let subVisible = false;
        const tl = el("gem-menu-item", {
          attrs: { role: "menuitem", value: "thinking_level" },
          click: () => { subVisible = true; medItem.offsetParent = {}; medItem.getBoundingClientRect = () => ({ width: 120, height: 32 }); },
        }, ["Thinking level"]);
        const medItem = el("gem-menu-item", {
          offsetParent: null,
          getClientRects: () => [{ width: 0, height: 0 }],
          attrs: { role: "menuitemradio", "aria-checked": "false" },
          click: () => {
            // Simulate menu staying open after radio selection until Escape is dispatched on gem-menu-item
            b.textContent; // no-op
            medItem.parent.querySelector("button");
          },
        }, ["Medium Balanced depth"]);
        medItem.getBoundingClientRect = () => (subVisible ? { width: 120, height: 32 } : { width: 0, height: 0 });
        tl.dispatchEvent = (ev) => {
          if (ev && ev.key === "Escape") { itemEscapes++; keepOpen = false; syncCloseDOM(); }
        };
        medItem.dispatchEvent = tl.dispatchEvent;
        nodes.push(tl, medItem);
      }
      setDOM(nodes);
    };
    syncCloseDOM();
    // Simulate closing an open menu while starting from Hydrogen High -> Medium
    let switchBtnAria = "Open mode picker, currently Hydrogen High";
    let switchBtnText = "HydrogenHigh";
    let switchOpen = false;
    let switchSub = false;
    let switchEscapedOnItem = false;
    const syncSwitchCloseDOM = () => {
      const b = el("button", {
        attrs: { "data-test-id": "bard-mode-menu-button", "aria-label": switchBtnAria },
        click: () => { switchOpen = !switchOpen; if (!switchOpen) switchSub = false; syncSwitchCloseDOM(); },
      }, [switchBtnText]);
      const nodes = [el("input-area-v2", {}, [
        el("div", { class: "ql-editor", attrs: { contenteditable: "true" } }),
        b,
      ])];
      if (switchOpen) {
        const mkSwitchItem = (label, role, val, sel, onClick, hidden) => {
          const it = el("gem-menu-item", {
            class: sel ? "selected" : "",
            offsetParent: hidden ? null : {},
            getClientRects: () => [{ width: hidden ? 0 : 120, height: hidden ? 0 : 32 }],
            attrs: Object.assign({ role }, val ? { value: val } : {}, sel != null ? { "aria-checked": sel ? "true" : "false" } : {}),
            click: () => { onClick(); syncSwitchCloseDOM(); },
          }, [label]);
          it.getBoundingClientRect = () => ({ width: hidden ? 0 : 120, height: hidden ? 0 : 32 });
          it.dispatchEvent = (ev) => {
            if (ev && ev.key === "Escape") { switchEscapedOnItem = true; switchOpen = false; switchSub = false; syncSwitchCloseDOM(); }
          };
          return it;
        };
        nodes.push(mkSwitchItem("Everyday help 4 Hydrogen", "menuitemradio", null, true, () => {}, false));
        nodes.push(mkSwitchItem("Thinking level", "menuitem", "thinking_level", null, () => { switchSub = true; }, false));
        nodes.push(mkSwitchItem("Medium Balanced depth", "menuitemradio", null, false, () => {
          switchBtnText = "HydrogenMedium";
          switchBtnAria = "Open mode picker, currently Hydrogen Medium";
          // Intentionally keep switchOpen = true to verify closeModeMenu closes via gem-menu-item Escape!
        }, !switchSub));
      }
      setDOM(nodes);
    };
    syncSwitchCloseDOM();
    const escRes = await P.ensureComposerReady("startup", { model: "4 Hydrogen", thinking: "Medium" });
    ok("closeModeMenu dispatches Escape on gem-menu-item when document Escape is ignored",
      escRes.modeApplied === true && switchEscapedOnItem === true && !switchOpen,
      { escRes, switchEscapedOnItem, switchOpen });

    // Mobile/narrow layout lazy-mounts the mode picker only after .ql-editor focus/click
    let lazyMounted = false;
    let lazyOpen = false;
    let lazyAria = "Open mode picker, currently Auto";
    let lazyText = "Auto";
    const syncLazyDOM = () => {
      const ed = el("div", { class: "ql-editor", attrs: { contenteditable: "true" } });
      ed.focus = () => { lazyMounted = true; syncLazyDOM(); };
      const nodes = [el("input-area-v2", {}, [ed])];
      if (lazyMounted) {
        nodes.push(el("button", {
          attrs: { "aria-label": lazyAria },
          click: () => { lazyOpen = !lazyOpen; syncLazyDOM(); },
        }, [lazyText]));
      }
      if (lazyOpen) {
        nodes.push(el("gem-menu-item", { attrs: { role: "menuitemradio" }, click: () => {
          lazyAria = "Open mode picker, currently Hydrogen High"; lazyText = "HydrogenHigh"; lazyOpen = false; syncLazyDOM();
        } }, ["Everyday help 4 Hydrogen"]));
      }
      setDOM(nodes);
    };
    syncLazyDOM();
    const lazyRes = await P.ensureComposerReady("startup", { model: "4 Hydrogen", thinking: "High" });
    ok("ensureFocusMode focuses editor to mount lazy mobile mode picker",
      lazyMounted === true && lazyRes.modeApplied === true && lazyRes.model === "4 Hydrogen",
      { lazyMounted, lazyRes });

    // Upsell 4 Neon must not report modeApplied=true
    setDOM([
      el("input-area-v2", {}, [
        el("div", { class: "ql-editor", attrs: { contenteditable: "true" } }),
        el("button", { attrs: { "data-test-id": "bard-mode-menu-button", "aria-label": "Open mode picker, currently Hydrogen High" } }, ["HydrogenHigh"]),
      ]),
      el("gem-menu-item", { class: "selected", attrs: { role: "menuitemradio", "data-mode-id": "56fdd199312815e2" } }, ["Everyday help 4 Hydrogen"]),
      el("gem-menu-item", { attrs: { role: "menuitemradio", "data-mode-id": "upsell_MODE_CATEGORY_PRO" } }, ["Deeper analysis 4 Neon"]),
    ]);
    const upsellRes = await P.ensureComposerReady("startup", { model: "4 Neon", thinking: "High" });
    ok("upsell 4 Neon reports modeApplied=false",
      upsellRes && upsellRes.modeApplied === false, upsellRes);
  } finally {
    global.document.dispatchEvent = prevDispatch;
  }
})();
