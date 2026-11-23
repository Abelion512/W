// SPDX-License-Identifier: GPL-3.0-or-later
// Stub-DOM/Node unit tests for extracted core modules:
// core/channel.js, core/a2a-runner.js, core/dom-engine.js, core/ui-controller.js
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

function loadCoreGlobal(filename, globalName, extraSandbox) {
  const full = path.join(__dirname, "..", "core", filename);
  const code = fs.readFileSync(full, "utf8") + `\n;globalThis.${globalName} = ${globalName};`;
  const sandbox = Object.assign({ console, setTimeout, clearTimeout, setInterval, clearInterval, Date }, extraSandbox || {});
  sandbox.globalThis = sandbox;
  vm.runInNewContext(code, sandbox, { filename: full }); // NOSONAR test only: own local core/*.js read from disk, no external input
  return sandbox[globalName];
}

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log("PASS ", name);
  } else {
    failed++;
    console.error("FAIL ", name, detail === undefined ? "" : detail);
  }
}

(async () => {
  const ZSChannel = loadCoreGlobal("channel.js", "ZSChannel");
  const ZSA2ARunner = loadCoreGlobal("a2a-runner.js", "ZSA2ARunner");
  const ZSDomEngine = loadCoreGlobal("dom-engine.js", "ZSDomEngine");
  const ZSUiController = loadCoreGlobal("ui-controller.js", "ZSUiController");

  // ── ZSChannel ────────────────────────────────────────────────────────────
  check("channel detects Extension context invalidated", ZSChannel.isContextInvalidated("Extension context invalidated."));
  check("channel detects Receiving end does not exist", ZSChannel.isContextInvalidated("Could not establish connection. Receiving end does not exist."));
  check("channel ignores normal network error", !ZSChannel.isContextInvalidated("bridge offline"));

  const staleRuntime = {
    lastError: { message: "Extension context invalidated." },
    sendMessage(_msg, cb) { cb(undefined); },
  };
  const staleResp = await ZSChannel.send({ type: "status" }, staleRuntime);
  check("channel.send classifies stale-extension", staleResp.ok === false && staleResp.kind === "stale-extension", staleResp);

  const okRuntime = {
    lastError: null,
    sendMessage(msg, cb) { cb({ ok: true, echo: msg.type }); },
  };
  const okResp = await ZSChannel.send({ type: "status" }, okRuntime);
  check("channel.send forwards healthy response", okResp.ok === true && okResp.echo === "status", okResp);

  let cleared = false;
  let staleCalled = false;
  let statusCount = 0;
  let pollTick = 0;
  ZSChannel.startStatusPolling({
    send: () => Promise.resolve(pollTick++ === 0 ? { connected: true } : { ok: false, kind: "stale-extension", error: "gone" }),
    onStatus: () => { statusCount++; },
    onStaleExtension: () => { staleCalled = true; },
    setIntervalFn: (fn) => { setImmediate(fn); return 42; },
    clearIntervalFn: (id) => { if (id === 42) cleared = true; },
  });
  await new Promise((r) => setTimeout(r, 20));
  check("status poller forwards healthy status", statusCount === 1, statusCount);
  check("status poller stops and alerts on stale-extension", staleCalled && cleared, { staleCalled, cleared });

  let routed = {};
  let registeredListener = null;
  ZSChannel.listenRuntimeMessages({
    onStatus: (s) => { routed.status = s.connected; },
    onOpenMenu: (atBottom) => { routed.openMenu = atBottom; },
    onA2APrompt: (p, id) => { routed.prompt = `${id}:${p}`; },
    onA2AAbort: (id) => { routed.abort = id; },
  }, {
    onMessage: { addListener: (fn) => { registeredListener = fn; } },
  });
  registeredListener({ type: "zs-status", connected: true });
  registeredListener({ type: "zs-open-menu" });
  registeredListener({ type: "zs-a2a-prompt", prompt: "hi", promptId: "p1" });
  registeredListener({ type: "zs-a2a-abort", promptId: "p1" });
  check("runtime listener routes all message types", routed.status === true && routed.openMenu === false && routed.prompt === "p1:hi" && routed.abort === "p1", routed);

  // ── ZSA2ARunner ──────────────────────────────────────────────────────────
  check("cleanA2AText strips Thinking process header", ZSA2ARunner.cleanA2AText("\nThinking process\nPONG") === "PONG");
  check("cleanA2AText strips Thought for Xs header", ZSA2ARunner.cleanA2AText("Thought for 4.5 seconds: Answer") === "Answer");
  check("cleanA2AText preserves Reasoning: opening", ZSA2ARunner.cleanA2AText("Reasoning: step 1") === "Reasoning: step 1");

  const sentMsgs = [];
  const state = { running: false, starting: false, injecting: false, started: true, stop: false };
  const provider = {
    chatIsEmpty: () => true,
    stopGeneration: () => {},
    lastAssistant: () => ({ text: "Thinking complete: OK" }),
    itemText: (it) => it.text,
  };
  const runner = ZSA2ARunner.createRunner({
    provider,
    state,
    sleep: () => Promise.resolve(),
    diag: () => {},
    startSession: async () => {},
    submitAndGetBase: async () => 0,
    agentLoop: async () => {
      runner.emitChunkIfDue("hello", 1000);
      runner.emitChunkIfDue("hello world", 1200); // throttled (<600ms)
      runner.emitChunkIfDue("hello world!", 1700); // emitted
    },
    sendRuntimeMessage: (m) => sentMsgs.push(m),
  });
  await runner.runPrompt("ping", "req-1");
  const chunks = sentMsgs.filter((m) => m.type === "a2a_chunk");
  const results = sentMsgs.filter((m) => m.type === "a2a_result");
  check("a2a runner throttles and emits chunk deltas", chunks.length === 2 && chunks[0].text === "hello" && chunks[1].text === " world!", chunks);
  check("a2a runner sends cleaned final result", results.length === 1 && results[0].ok === true && results[0].text === "OK", results);
  check("a2a runner clears currentId after completion", runner.getCurrentId() === null);

  // ── ZSDomEngine ──────────────────────────────────────────────────────────
  const domState = { sendToken: null };
  const domEngine = ZSDomEngine.createDomEngine({
    provider: { timings: {}, lastAssistantId: () => "turn-7" },
    state: domState,
    a2a: { getCurrentId: () => null, resetChunk: () => {}, emitChunkIfDue: () => {} },
    sleep: () => Promise.resolve(),
    diag: () => {},
    log: () => {},
    getUi: () => ({}),
    jitterBeforeSend: () => Promise.resolve(),
    backgroundSessionsReady: async () => false,
    scrollSuppressed: () => false,
    bareToolName: (n) => n,
    knownTool: () => false,
    preHideWholeItems: () => {},
    scheduleSweep: () => {},
  });
  domEngine.captureSendToken();
  check("domEngine.captureSendToken stores provider token", domState.sendToken === "turn-7", domState.sendToken);
  let flips = 0;
  const waited = await domEngine.waitFor(() => ++flips >= 3, 500);
  check("domEngine.waitFor resolves true once predicate holds", waited === true && flips === 3, { waited, flips });

  // ── Hidden-tab A2A: must never park or time out when document.hidden=true ─
  const ZSParse = loadCoreGlobal("parser.js", "ZSParse");
  const visListeners = [];
  const hiddenDoc = {
    hidden: true,
    addEventListener(ev, fn) { if (ev === "visibilitychange") visListeners.push(fn); },
    removeEventListener(ev, fn) {
      const i = visListeners.indexOf(fn);
      if (i !== -1) visListeners.splice(i, 1);
    },
  };
  const hiddenWin = { addEventListener() {}, removeEventListener() {} };
  const ZSDomEngineHidden = loadCoreGlobal("dom-engine.js", "ZSDomEngine", {
    document: hiddenDoc,
    window: hiddenWin,
    ZSParse,
  });
  const hiddenDiag = [];
  const hiddenA = { running: false, starting: false, injecting: false, started: true, stop: false, parked: false, toolNames: new Set() };
  let hiddenSent = [];
  let hiddenAssistantReplies = 0;
  let hiddenGenTicks = 0;
  let hiddenEditor = "";
  const hiddenProvider = {
    timings: { RESPONSE_TIMEOUT_MS: 5000, STABLE_MS: 1200, WARMUP_MS: 2000, REASON_NOREPLY_MS: 2000 },
    reliableCounts: true,
    chatIsEmpty: () => true,
    isBusyNow: () => false,
    isGenerating: () => hiddenGenTicks > 0,
    assistantCount: () => hiddenAssistantReplies,
    userCount: () => hiddenSent.length,
    lastAssistant: () => (hiddenAssistantReplies ? { id: "a1", text: "" } : null),
    lastAssistantId: () => (hiddenAssistantReplies ? "a1" : "a0"),
    streamLen: () => 0,
    editorText: () => hiddenEditor,
    typeAndSend: async (txt) => {
      hiddenSent.push(txt);
      hiddenEditor = "";
      hiddenAssistantReplies = 1;
      hiddenGenTicks = 1;
    },
    readAssistant: () => {
      if (hiddenGenTicks > 0) hiddenGenTicks--;
      return { present: true, reply: "HIDDEN_A2A_OK", thinking: "", item: { id: "a1" } };
    },
    itemText: () => "", // simulate blank innerText read on hidden tab; must fall back to loopText/readAssistant
    scanError: () => "",
    isTooLongMsg: () => false,
    turnHalted: () => false,
    findContinueBtn: () => null,
    stopGeneration: () => {},
  };
  const hiddenMsgs = [];
  let hiddenDomEngine;
  const hiddenRunner = ZSA2ARunner.createRunner({
    provider: hiddenProvider,
    state: hiddenA,
    sleep: () => Promise.resolve(),
    diag: (ev, data) => hiddenDiag.push({ ev, data }),
    startSession: async () => {},
    submitAndGetBase: (text, images) => hiddenDomEngine.submitAndGetBase(text, images),
    agentLoop: async (base) => {
      const res = await hiddenDomEngine.waitForResponse(base);
      return res.kind === "text" ? res.text : "";
    },
    sendRuntimeMessage: (m) => hiddenMsgs.push(m),
  });
  hiddenDomEngine = ZSDomEngineHidden.createDomEngine({
    provider: hiddenProvider,
    timings: hiddenProvider.timings,
    state: hiddenA,
    a2a: hiddenRunner,
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
    diag: (ev, data) => hiddenDiag.push({ ev, data }),
    log: () => {},
    getUi: () => ({ inputCover: () => {}, setStarting: () => {}, banner: () => {} }),
    jitterBeforeSend: () => Promise.resolve(),
    backgroundSessionsReady: async () => false,
    scrollSuppressed: () => true, // even with scroll suppression active, A2A must not stall
    bareToolName: (n) => n,
    knownTool: () => false,
    preHideWholeItems: () => {},
    scheduleSweep: () => {},
  });
  await hiddenRunner.runPrompt("run in background", "a2a-hidden-1");
  const hiddenResult = hiddenMsgs.find((m) => m.type === "a2a_result" && m.promptId === "a2a-hidden-1");
  check("hidden-tab A2A completes and emits a2a_result without focus/scroll",
    !!(hiddenResult && hiddenResult.ok === true && hiddenResult.text === "HIDDEN_A2A_OK"), hiddenResult);
  check("hidden-tab A2A skipped parking via park.skipped.a2a",
    hiddenDiag.some((d) => d.ev === "park.skipped.a2a") && hiddenA.parked === false, hiddenDiag);
  check("parkHidden returns 0 immediately during active A2A",
    (await ZSDomEngineHidden.createDomEngine({
      provider: hiddenProvider, timings: hiddenProvider.timings, state: hiddenA,
      a2a: { getCurrentId: () => "a2a-live", resetChunk: () => {}, emitChunkIfDue: () => {} },
      sleep: () => { throw new Error("parkHidden must not sleep during A2A"); },
      diag: () => {}, log: () => {}, getUi: () => ({}),
      jitterBeforeSend: () => Promise.resolve(), backgroundSessionsReady: async () => false,
      scrollSuppressed: () => false, bareToolName: (n) => n, knownTool: () => false,
      preHideWholeItems: () => {}, scheduleSweep: () => {},
    }).parkHidden()) === 0);

  // findNewChatControl on a hidden tab still finds the button via textContent
  const hiddenBtn = {
    hidden: false,
    innerText: "",
    textContent: "New chat",
    getAttribute: () => null,
    getClientRects: () => [],
    closest: () => null,
  };
  check("findNewChatControl finds button on hidden tab without layout rects",
    ZSA2ARunner.findNewChatControl({ hidden: true, querySelectorAll: () => [hiddenBtn] }) === hiddenBtn);

  // Manual (non-A2A) session still parks while hidden when backgroundSessions=false
  const manualState = { stop: false, parked: false };
  const manualEngine = ZSDomEngineHidden.createDomEngine({
    provider: hiddenProvider, timings: hiddenProvider.timings, state: manualState,
    a2a: { getCurrentId: () => null, resetChunk: () => {}, emitChunkIfDue: () => {} },
    sleep: () => Promise.resolve(), diag: () => {}, log: () => {},
    getUi: () => ({ setStarting: () => {} }),
    jitterBeforeSend: () => Promise.resolve(), backgroundSessionsReady: async () => false,
    scrollSuppressed: () => false, bareToolName: (n) => n, knownTool: () => false,
    preHideWholeItems: () => {}, scheduleSweep: () => {},
  });
  const parkPromise = manualEngine.waitVisible();
  await new Promise((r) => setTimeout(r, 15));
  const parkedWhileHidden = manualState.parked === true;
  hiddenDoc.hidden = false;
  for (const fn of [...visListeners]) fn();
  const unparkedOk = await parkPromise;
  check("manual non-A2A session still parks while hidden and resumes on unhide",
    parkedWhileHidden && unparkedOk === true && manualState.parked === false,
    { parkedWhileHidden, unparkedOk, parked: manualState.parked });

  // ── ZSUiController & manifest.json ───────────────────────────────────────
  check("ZSUiController exports createUiController", typeof ZSUiController.createUiController === "function");

  // inputCover locks editor height on enable and unlocks cleanly on disable
  const mockClassSet = new Set();
  const mockStyles = {};
  const mockEditor = {
    offsetHeight: 46,
    getBoundingClientRect: () => ({ left: 100, top: 600, width: 500, height: 46, right: 600, bottom: 646 }),
    parentElement: null,
    classList: {
      add: (c) => mockClassSet.add(c),
      remove: (c) => mockClassSet.delete(c),
      contains: (c) => mockClassSet.has(c),
    },
    style: {
      setProperty: (k, v) => { mockStyles[k] = v; },
      removeProperty: (k) => { delete mockStyles[k]; },
    },
  };
  const mkEl = (tag) => {
    const cls = new Set();
    const attrs = {};
    const styleMap = {};
    const children = [];
    const node = {
      tagName: String(tag || "div").toUpperCase(),
      id: "", className: "", textContent: "", hidden: false, disabled: false, value: "",
      dataset: {}, children, options: children, selectedIndex: 0, parentElement: null, isConnected: true,
      offsetHeight: 36, offsetWidth: 400,
      classList: {
        add: (...cs) => cs.forEach((c) => cls.add(c)),
        remove: (...cs) => cs.forEach((c) => cls.delete(c)),
        toggle: (c, f) => { if (f === undefined ? !cls.has(c) : !!f) cls.add(c); else cls.delete(c); },
        contains: (c) => cls.has(c),
      },
      style: {
        setProperty: (k, v) => { styleMap[k] = v; },
        removeProperty: (k) => { delete styleMap[k]; },
      },
      setAttribute: (k, v) => { attrs[k] = v; },
      getAttribute: (k) => (k in attrs ? attrs[k] : null),
      addEventListener: () => {},
      appendChild: (c) => { if (c) { c.parentElement = node; children.push(c); } return c; },
      replaceChildren: (...cs) => { children.length = 0; cs.forEach((c) => node.appendChild(c)); },
      insertBefore: (c) => node.appendChild(c),
      remove: () => {},
      querySelector: (sel) => {
        if (sel.startsWith("#")) {
          const id = sel.slice(1);
          const walk = (n) => {
            if (n.id === id) return n;
            for (const ch of (n.children || [])) { const hit = walk(ch); if (hit) return hit; }
            return null;
          };
          return walk(node);
        }
        return null;
      },
      querySelectorAll: () => [],
      getBoundingClientRect: () => ({ left: 100, top: 600, width: 500, height: 46, right: 600, bottom: 646 }),
      _styleMap: styleMap,
    };
    return node;
  };
  const docEl = mkEl("html");
  const uiListeners = { window: {}, document: {} };
  const uiSandbox = {
    window: { addEventListener: (t, f) => { uiListeners.window[t] = f; }, innerWidth: 1280, innerHeight: 800 },
    performance: { now: () => 1000 },
    document: {
      documentElement: docEl,
      body: mkEl("body"),
      createElement: (tag) => mkEl(tag),
      createElementNS: (_ns, tag) => mkEl(tag),
      getElementById: () => null,
      addEventListener: (t, f) => { uiListeners.document[t] = f; },
      hidden: false,
    },
    getComputedStyle: () => ({ backgroundColor: "rgb(20, 20, 20)", borderRadius: "12px" }),
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    DOMRect: class { constructor(x, y, w, h) { this.left = x; this.top = y; this.width = w; this.height = h; this.right = x + w; this.bottom = y + h; } },
  };
  const ZSUiCtrlMock = loadCoreGlobal("ui-controller.js", "ZSUiController", uiSandbox);
  const uiCtrl = ZSUiCtrlMock.createUiController({
    state: { bridge: { servers: [] } },
    provider: { id: "gemini", displayName: "Gemini", getEditor: () => mockEditor, isFreshChat: () => true, chatIsEmpty: () => true },
    aiSites: [],
    githubUrl: "https://example.invalid",
    skillMaxBytes: 20480,
    targetStorageKey: "zsTarget",
    getSelectedTargetId: () => "repo",
    setSelectedTargetId: () => {},
    getBackgroundSessions: () => false,
    setBackgroundSessions: () => false,
    getAllSkills: () => [],
    getGlobalSkills: () => ({}),
    activeTools: () => [],
    bareToolName: (n) => n,
    bg: async () => ({}),
    ensureTools: async () => [],
    importSkillText: async () => ({ ok: true }),
    isMcpEnabled: () => true,
    isSkillEnabled: () => true,
    loadWorkspaceSkills: async () => {},
    refreshActiveToolNames: () => {},
    removeGlobalSkill: () => {},
    saveGlobalSkill: () => ({ ok: true }),
    scrollSuppressed: () => false,
    setMcpEnabled: () => {},
    setSkillEnabled: () => {},
    startSession: () => {},
    stopLoop: () => {},
    syncSessionState: () => {},
    validateSkillText: () => ({ ok: true }),
  });
  uiCtrl.inputCover(true);
  const lockedOk = mockClassSet.has("zs-typing") && mockClassSet.has("zs-height-locked") && mockStyles["--zs-lock-h"] === "46px";
  uiCtrl.inputCover(false);
  const unlockedOk = !mockClassSet.has("zs-typing") && !mockClassSet.has("zs-height-locked") && !("--zs-lock-h" in mockStyles);
  check("inputCover locks and unlocks editor height around Agent is working cover", lockedOk && unlockedOk, { lockedOk, unlockedOk, mockStyles });

  const resize = uiListeners.window.resize, onVisible = uiListeners.document.visibilitychange;
  const listenersOk = typeof resize === "function" && typeof onVisible === "function";
  if (listenersOk) { uiSandbox.document.hidden = false; resize(); onVisible(); }
  check("hidden-tab resize/visibility re-place bar and cover", listenersOk, { resize: !!resize, onVisible: !!onVisible });

  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"));
  const required = ["core/channel.js", "core/dom-engine.js", "core/a2a-runner.js", "core/ui-controller.js"];
  const mainEntries = manifest.content_scripts.filter((cs) => (cs.js || []).includes("core/main.js"));
  const allLoadedBeforeMain = mainEntries.length > 0 && mainEntries.every((cs) => {
    const mainPos = cs.js.indexOf("core/main.js");
    return required.every((mod) => {
      const pos = cs.js.indexOf(mod);
      return pos !== -1 && pos < mainPos;
    });
  });
  check("manifest loads all 4 extracted core modules before core/main.js", allLoadedBeforeMain, mainEntries.length);

  console.log(`\n${passed}/${passed + failed} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
