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
  const ZS = loadCoreGlobal("config.js", "ZS");

  const repoPrompt = ZS.buildSystemPrompt({ siteName: "Gemini", targetServer: "repo", targetName: "repo" });
  check("buildSystemPrompt prepends SYS_MARKER for non-Roblox targets",
    repoPrompt.startsWith(ZS.SYS_MARKER + "\n"), repoPrompt.slice(0, 60));

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
    onA2APrompt: (p, id, opts) => { routed.prompt = `${id}:${p}`; routed.opts = opts; },
    onA2AAbort: (id) => { routed.abort = id; },
  }, {
    onMessage: { addListener: (fn) => { registeredListener = fn; } },
  });
  registeredListener({ type: "zs-status", connected: true });
  registeredListener({ type: "zs-open-menu" });
  registeredListener({ type: "zs-a2a-prompt", prompt: "hi", promptId: "p1", mode: { model: "4 Neon", thinking: "High" }, route: "pinned" });
  registeredListener({ type: "zs-a2a-abort", promptId: "p1" });
  check("runtime listener routes all message types", routed.status === true && routed.openMenu === false && routed.prompt === "p1:hi" && routed.abort === "p1", routed);
  check("runtime listener forwards mode opts on zs-a2a-prompt",
    !!(routed.opts && routed.opts.mode && routed.opts.mode.model === "4 Neon" && routed.opts.route === "pinned"),
    routed.opts);

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
  check("A2A_HARD_CAP_MS matches server 30m default", ZSA2ARunner.A2A_HARD_CAP_MS === 30 * 60 * 1000, ZSA2ARunner.A2A_HARD_CAP_MS);

  let freshNow = false;
  let newChatClicks = 0;
  const newChatCtrl = {
    hidden: false,
    innerText: "New chat",
    textContent: "New chat",
    getAttribute: () => null,
    getClientRects: () => [{ width: 80, height: 24 }],
    closest: () => null,
    click() { newChatClicks++; freshNow = true; },
  };
  const virtualizedStaleRunner = ZSA2ARunner.createRunner({
    provider: {
      chatIsEmpty: () => true, // virtualized 0 items while hidden
      isFreshChat: () => freshNow, // false on /s/<id> until New chat clicked
      getEditor: () => ({}),
      stopGeneration: () => {},
      lastAssistant: () => null,
      itemText: () => "",
    },
    state: { running: false, starting: false, injecting: false, started: false, stop: false },
    doc: { hidden: false, querySelectorAll: () => [newChatCtrl] },
    sleep: () => Promise.resolve(),
    diag: () => {},
    startSession: async () => {},
    submitAndGetBase: async () => 0,
    agentLoop: async () => "",
    sendRuntimeMessage: () => {},
  });
  const openedFresh = await virtualizedStaleRunner.openFreshChat();
  check("openFreshChat clicks New chat when virtualized /s/<id> looks empty but isFreshChat=false",
    openedFresh === true && newChatClicks === 1, { openedFresh, newChatClicks });

  const capMsgs = [];
  const capState = { running: false, starting: false, injecting: false, started: true, stop: false };
  const capRunner = ZSA2ARunner.createRunner({
    provider: { chatIsEmpty: () => true, stopGeneration: () => {}, lastAssistant: () => null, itemText: () => "" },
    state: capState,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    diag: () => {},
    startSession: async () => {},
    submitAndGetBase: async () => 0,
    agentLoop: async () => { await new Promise((r) => setTimeout(r, 80)); return ""; },
    sendRuntimeMessage: (m) => capMsgs.push(m),
    hardCapMs: 20,
  });
  await capRunner.runPrompt("slow", "req-cap");
  const capRes = capMsgs.find((m) => m.type === "a2a_result" && m.promptId === "req-cap");
  check("a2a runner hard-cap reports hard cap instead of caller cancel",
    !!(capRes && capRes.ok === false && /hard cap/i.test(capRes.error || "") && !/caller stopped waiting/i.test(capRes.error || "")),
    capRes);

  let receivedStartMode = null;
  const modeState = { running: false, starting: false, injecting: false, started: false, stop: false };
  const modeRunner = ZSA2ARunner.createRunner({
    provider: {
      chatIsEmpty: () => true,
      isFreshChat: () => true,
      getEditor: () => ({}),
      stopGeneration: () => {},
      lastAssistant: () => ({ text: "OK" }),
      itemText: (it) => it.text,
    },
    state: modeState,
    sleep: () => Promise.resolve(),
    diag: () => {},
    startSession: async (opts) => { receivedStartMode = opts; modeState.started = true; },
    submitAndGetBase: async () => 0,
    agentLoop: async () => "OK",
    sendRuntimeMessage: () => {},
  });
  await modeRunner.runPrompt("ping", "req-mode", { mode: { model: "4 Neon", thinking: "Medium" } });
  check("a2a runner forwards mode opts to startSession",
    !!(receivedStartMode && receivedStartMode.model === "4 Neon" && receivedStartMode.thinking === "Medium"),
    receivedStartMode);

  // 1. Abort during submitAndGetBase must never invoke agentLoop and must clear state.stop
  const abortSendMsgs = [];
  const abortSendState = { running: false, starting: false, injecting: false, started: true, stop: false };
  let abortSendLoopCalls = 0;
  let abortSendRunner;
  abortSendRunner = ZSA2ARunner.createRunner({
    provider: {
      chatIsEmpty: () => false,
      stopGeneration: () => {},
      lastAssistant: () => ({ text: "AFTER_ABORT_OK" }),
      itemText: (it) => it.text,
    },
    state: abortSendState,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    diag: () => {},
    startSession: async () => {},
    submitAndGetBase: async (prompt) => {
      if (prompt === "abort-me") abortSendRunner.abortIfMatches("req-abort-send", "bridge-cancel");
      return 0;
    },
    agentLoop: async () => { abortSendLoopCalls++; return "AFTER_ABORT_OK"; },
    sendRuntimeMessage: (m) => abortSendMsgs.push(m),
  });
  await abortSendRunner.runPrompt("abort-me", "req-abort-send");
  const abortedSendRes = abortSendMsgs.find((m) => m.type === "a2a_result" && m.promptId === "req-abort-send");
  await abortSendRunner.runPrompt("ok", "req-after-abort");
  const afterAbortRes = abortSendMsgs.find((m) => m.type === "a2a_result" && m.promptId === "req-after-abort");
  check("abort during submitAndGetBase never calls agentLoop, clears stop, and allows follow-up",
    abortSendLoopCalls === 1 &&
    !!(abortedSendRes && abortedSendRes.ok === false && /cancelled/i.test(abortedSendRes.error || "")) &&
    abortSendState.stop === false &&
    !!(afterAbortRes && afterAbortRes.ok === true && afterAbortRes.text === "AFTER_ABORT_OK"),
    { abortSendLoopCalls, abortedSendRes, stop: abortSendState.stop, afterAbortRes });

  // 2. Rejected concurrent runPrompt must not disturb in-flight task cancellation
  const concMsgs = [];
  const concState = { running: false, starting: false, injecting: false, started: true, stop: false };
  const concRunner = ZSA2ARunner.createRunner({
    provider: {
      chatIsEmpty: () => false,
      stopGeneration: () => {},
      lastAssistant: () => ({ text: "CONC_DONE" }),
      itemText: (it) => it.text,
    },
    state: concState,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    diag: () => {},
    startSession: async () => {},
    submitAndGetBase: async () => 0,
    agentLoop: async () => {
      concState.running = true;
      try { await new Promise((r) => setTimeout(r, 60)); return "CONC_DONE"; }
      finally { concState.running = false; }
    },
    sendRuntimeMessage: (m) => concMsgs.push(m),
  });
  const concP1 = concRunner.runPrompt("first", "req-conc-1");
  await new Promise((r) => setTimeout(r, 10));
  const concP2 = concRunner.runPrompt("bump", "req-conc-2");
  await new Promise((r) => setTimeout(r, 10));
  concRunner.abortIfMatches("req-conc-1", "bridge-cancel");
  await Promise.all([concP1, concP2]);
  const concR1 = concMsgs.find((m) => m.type === "a2a_result" && m.promptId === "req-conc-1");
  const concR2 = concMsgs.find((m) => m.type === "a2a_result" && m.promptId === "req-conc-2");
  check("rejected concurrent runPrompt preserves in-flight abort outcome",
    !!(concR2 && concR2.ok === false && /already working/i.test(concR2.error || "")) &&
    !!(concR1 && concR1.ok === false && /cancelled/i.test(concR1.error || "")),
    { concR1, concR2 });

  // 3. Immediate follow-up runPrompt right after abortIfMatches waits for unwind and succeeds
  const unwindMsgs = [];
  const unwindState = { running: false, starting: false, injecting: false, started: true, stop: false };
  let unwindRunner;
  unwindRunner = ZSA2ARunner.createRunner({
    provider: {
      chatIsEmpty: () => false,
      stopGeneration: () => {},
      lastAssistant: () => ({ text: "UNWIND_OK" }),
      itemText: (it) => it.text,
    },
    state: unwindState,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    diag: () => {},
    startSession: async () => {},
    submitAndGetBase: async (prompt) => {
      if (prompt === "slow-send") {
        unwindState.injecting = true;
        await new Promise((r) => setTimeout(r, 60));
        unwindState.injecting = false;
      }
      return 0;
    },
    agentLoop: async () => "UNWIND_OK",
    sendRuntimeMessage: (m) => unwindMsgs.push(m),
  });
  const uP1 = unwindRunner.runPrompt("slow-send", "req-unwind-1");
  await new Promise((r) => setTimeout(r, 10));
  unwindRunner.abortIfMatches("req-unwind-1", "bridge-cancel");
  await new Promise((r) => setTimeout(r, 5));
  const uP2 = unwindRunner.runPrompt("next", "req-unwind-2");
  await Promise.all([uP1, uP2]);
  const uR1 = unwindMsgs.find((m) => m.type === "a2a_result" && m.promptId === "req-unwind-1");
  const uR2 = unwindMsgs.find((m) => m.type === "a2a_result" && m.promptId === "req-unwind-2");
  check("follow-up runPrompt right after abortIfMatches waits for unwind and succeeds",
    !!(uR1 && uR1.ok === false && /cancelled/i.test(uR1.error || "")) &&
    !!(uR2 && uR2.ok === true && uR2.text === "UNWIND_OK"),
    { uR1, uR2 });

  // 4. Stale started=true after SPA New Chat syncs before checking !A.started
  const staleMsgs = [];
  const staleState = { running: false, starting: false, injecting: false, started: true, stop: false };
  let staleStartCalls = 0;
  const staleRunner = ZSA2ARunner.createRunner({
    provider: {
      chatIsEmpty: () => true,
      isFreshChat: () => true,
      getEditor: () => ({}),
      stopGeneration: () => {},
      lastAssistant: () => ({ text: "STALE_NEWCHAT_OK" }),
      itemText: (it) => it.text,
    },
    state: staleState,
    syncSessionState: () => { staleState.started = false; },
    sleep: () => Promise.resolve(),
    diag: () => {},
    startSession: async () => { staleStartCalls++; staleState.started = true; },
    submitAndGetBase: async () => 0,
    agentLoop: async () => "STALE_NEWCHAT_OK",
    sendRuntimeMessage: (m) => staleMsgs.push(m),
  });
  await staleRunner.runPrompt("use tool", "req-stale-newchat");
  const staleRes = staleMsgs.find((m) => m.type === "a2a_result" && m.promptId === "req-stale-newchat");
  check("runPrompt syncs session state so stale started=true triggers startSession on fresh chat",
    staleStartCalls === 1 && !!(staleRes && staleRes.ok === true && staleRes.text === "STALE_NEWCHAT_OK"),
    { staleStartCalls, staleRes });

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

  // 5. ZSDomEngine.submitAndGetBase bails on A.stop without calling typeAndSend and clears A.injecting immediately
  let stopTypeCalls = 0;
  const stopDomState = { running: false, starting: false, injecting: false, started: true, stop: true, sendToken: null };
  const stopDomEngine = ZSDomEngine.createDomEngine({
    provider: {
      timings: {},
      lastAssistantId: () => "t0",
      isBusyNow: () => false,
      lastAssistant: () => null,
      streamLen: () => 0,
      isGenerating: () => false,
      assistantCount: () => 2,
      userCount: () => 1,
      editorText: () => "",
      typeAndSend: async () => { stopTypeCalls++; },
    },
    state: stopDomState,
    a2a: { getCurrentId: () => "req-stop-dom", resetChunk: () => {}, emitChunkIfDue: () => {} },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    diag: () => {},
    log: () => {},
    getUi: () => ({ inputCover: () => {}, banner: () => {} }),
    jitterBeforeSend: () => Promise.resolve(),
    backgroundSessionsReady: async () => false,
    scrollSuppressed: () => false,
    bareToolName: (n) => n,
    knownTool: () => false,
    preHideWholeItems: () => {},
    scheduleSweep: () => {},
  });
  const stopBase1 = await stopDomEngine.submitAndGetBase("hi");
  const injectingImmediate1 = stopDomState.injecting;
  stopDomState.stop = false;
  const flipDomEngine = ZSDomEngine.createDomEngine({
    provider: {
      timings: {},
      lastAssistantId: () => "t0",
      isBusyNow: () => false,
      lastAssistant: () => null,
      streamLen: () => 0,
      isGenerating: () => false,
      assistantCount: () => 3,
      userCount: () => 1,
      editorText: () => "",
      typeAndSend: async () => { stopTypeCalls++; },
    },
    state: stopDomState,
    a2a: { getCurrentId: () => "req-stop-dom-flip", resetChunk: () => {}, emitChunkIfDue: () => {} },
    sleep: async () => { stopDomState.stop = true; },
    diag: () => {},
    log: () => {},
    getUi: () => ({ inputCover: () => {}, banner: () => {} }),
    jitterBeforeSend: () => Promise.resolve(),
    backgroundSessionsReady: async () => false,
    scrollSuppressed: () => false,
    bareToolName: (n) => n,
    knownTool: () => false,
    preHideWholeItems: () => {},
    scheduleSweep: () => {},
  });
  const stopBase2 = await flipDomEngine.submitAndGetBase("hi-flip");
  const injectingImmediate2 = stopDomState.injecting;
  check("submitAndGetBase bails on A.stop without calling typeAndSend and clears A.injecting immediately",
    stopTypeCalls === 0 && stopBase1 === 2 && stopBase2 === 3 &&
    injectingImmediate1 === false && injectingImmediate2 === false,
    { stopTypeCalls, stopBase1, stopBase2, injectingImmediate1, injectingImmediate2 });

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

  // Collapsed sidebar drawer (e.g. DeepSeek): tabindex="0" div with 0 client rects on visible tab
  const collapsedNewChat = {
    hidden: false,
    innerText: "",
    textContent: "New chat",
    getAttribute: (k) => (k === "tabindex" ? "0" : null),
    getClientRects: () => [],
    closest: () => null,
  };
  check("findNewChatControl finds collapsed-sidebar [tabindex=0] New chat control on visible tab",
    ZSA2ARunner.findNewChatControl({ hidden: false, querySelectorAll: () => [collapsedNewChat] }) === collapsedNewChat);

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
      createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
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

  const zsBar = docEl.querySelector("#zs-bar");
  const zsState = docEl.querySelector("#zs-state");
  check("#zs-bar exposes toolbar semantics",
    !!(zsBar && zsBar.getAttribute("role") === "toolbar" && zsBar.getAttribute("aria-label") === "Snapgent controls"),
    zsBar && { role: zsBar.getAttribute("role"), label: zsBar.getAttribute("aria-label") });
  check("#zs-state exposes status live region",
    !!(zsState && zsState.getAttribute("role") === "status" && zsState.getAttribute("aria-live") === "polite"),
    zsState && { role: zsState.getAttribute("role"), live: zsState.getAttribute("aria-live") });
  uiCtrl.setStatus({ connected: false, servers: [] });
  const collectTexts = (n) => {
    if (!n) return "";
    if (n.nodeType === 3) return n.textContent || "";
    return (n.children || []).map(collectTexts).join("") || n.textContent || "";
  };
  const hasStrongTag = (n) => !!n && (n.tagName === "STRONG" || (n.children || []).some(hasStrongTag));
  const stateRenderedText = collectTexts(zsState);
  check("ui-controller renders <b> as <strong> with zero literal tags",
    hasStrongTag(zsState) && stateRenderedText.includes("start.bat") && !/<b>|<\/b>/.test(stateRenderedText),
    { hasStrong: hasStrongTag(zsState), stateRenderedText });

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

  // ── Site errors must never report A2A ok:true or miss fast scanError ───
  const errProvider = {
    timings: { RESPONSE_TIMEOUT_MS: 3000, STABLE_MS: 800, WARMUP_MS: 800, REASON_NOREPLY_MS: 800 },
    reliableCounts: true,
    chatIsEmpty: () => false,
    isBusyNow: () => false,
    isGenerating: () => false,
    assistantCount: () => 2,
    lastAssistant: () => ({ id: "err-2" }),
    lastAssistantId: () => "err-2",
    streamLen: () => 0,
    readAssistant: () => ({ present: true, reply: "Error: AI request failed.", thinking: "", item: { id: "err-2" } }),
    itemText: () => "Error: AI request failed.",
    scanError: () => "Error: AI request failed.",
    isTooLongMsg: () => false,
    turnHalted: () => false,
    findContinueBtn: () => null,
    stopGeneration: () => {},
  };
  const errEngine = ZSDomEngineHidden.createDomEngine({
    provider: errProvider,
    timings: errProvider.timings,
    state: { sendToken: "err-1", toolNames: new Set(), stop: false },
    a2a: { getCurrentId: () => "err-rpc", resetChunk: () => {}, emitChunkIfDue: () => {} },
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
    diag: () => {},
    log: () => {},
    getUi: () => ({ inputCover: () => {}, setStarting: () => {}, banner: () => {} }),
    jitterBeforeSend: () => Promise.resolve(),
    backgroundSessionsReady: async () => false,
    scrollSuppressed: () => false,
    bareToolName: (n) => n,
    knownTool: () => false,
    preHideWholeItems: () => {},
    scheduleSweep: () => {},
  });
  const errRes = await errEngine.waitForResponse(1);
  check("domEngine.waitForResponse runs final scanError before returning short text",
    errRes && errRes.kind === "context_limit" && errRes.detail === "Error: AI request failed.",
    errRes);

  const errMsgs = [];
  const errState = { running: false, starting: false, injecting: false, started: true, stop: false, lastLoopError: "" };
  const errRunner = ZSA2ARunner.createRunner({
    provider: {
      chatIsEmpty: () => false,
      stopGeneration: () => {},
      lastAssistant: () => ({ text: "Error: AI request failed." }),
      itemText: (it) => it.text,
    },
    state: errState,
    sleep: () => Promise.resolve(),
    diag: () => {},
    startSession: async () => {},
    submitAndGetBase: async () => 1,
    agentLoop: async () => { errState.lastLoopError = "Error: AI request failed."; return ""; },
    sendRuntimeMessage: (m) => errMsgs.push(m),
  });
  await errRunner.runPrompt("check", "req-err-1");
  const errReply = errMsgs.find((m) => m.type === "a2a_result" && m.promptId === "req-err-1");
  check("a2a-runner fails with A.lastLoopError instead of returning ok:true error prose",
    !!(errReply && errReply.ok === false && errReply.error === "Error: AI request failed."),
    errReply);

  // ── noTurnGrace must not finalize on old turn or emit old-turn chunks ───
  let ntgTicks = 0;
  const ntgChunks = [];
  const ntgProvider = {
    timings: { RESPONSE_TIMEOUT_MS: 3000, STABLE_MS: 40, WARMUP_MS: 80, REASON_NOREPLY_MS: 80, NO_TURN_GRACE_MS: 90 },
    reliableCounts: true,
    chatIsEmpty: () => false,
    isBusyNow: () => false,
    isGenerating: () => (++ntgTicks <= 3),
    assistantCount: () => 1,
    lastAssistant: () => ({ id: "old-1" }),
    lastAssistantId: () => "old-1",
    streamLen: () => 40,
    readAssistant: () => ({ present: true, reply: '```json\n{"command":"list_commands"}\n```', thinking: "", item: { id: "old-1" } }),
    itemText: () => '```json\n{"command":"list_commands"}\n```',
    scanError: () => null,
    isTooLongMsg: () => false,
    turnHalted: () => false,
    findContinueBtn: () => null,
    stopGeneration: () => {},
  };
  const ntgEngine = ZSDomEngineHidden.createDomEngine({
    provider: ntgProvider,
    timings: ntgProvider.timings,
    state: { sendToken: "old-1", toolNames: new Set(), stop: false },
    a2a: { getCurrentId: () => "ntg-rpc", resetChunk: () => {}, emitChunkIfDue: (t) => ntgChunks.push(t) },
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 15))),
    diag: () => {},
    log: () => {},
    getUi: () => ({ inputCover: () => {}, setStarting: () => {}, banner: () => {} }),
    jitterBeforeSend: () => Promise.resolve(),
    backgroundSessionsReady: async () => false,
    scrollSuppressed: () => false,
    bareToolName: (n) => n,
    knownTool: () => false,
    preHideWholeItems: () => {},
    scheduleSweep: () => {},
  });
  const ntgRes = await ntgEngine.waitForResponse(1);
  check("waitForResponse with reliableCounts and !newReply returns empty instead of old tool block or chunk",
    ntgRes && ntgRes.kind === "empty" && ntgChunks.length === 0,
    { ntgRes, ntgChunks });

  // ── A2A start retry: opens fresh chat on transient fail, skips fatal ────
  const origDoc = global.document;
  try {
    let transEmpty = true;
    let transStartCalls = 0;
    let transNewClicks = 0;
    const transMsgs = [];
    const transState = { running: false, starting: false, injecting: false, started: false, stop: false, lastStartFailure: "" };
    const newChatBtn = {
      hidden: false,
      innerText: "New chat",
      getAttribute: () => "New chat",
      closest: () => null,
      getClientRects: () => [{ width: 40, height: 24 }],
      click: () => { transNewClicks++; transEmpty = true; },
    };
    const transRunner = ZSA2ARunner.createRunner({
      doc: { querySelectorAll: () => (transEmpty ? [] : [newChatBtn]) },
      provider: {
        chatIsEmpty: () => transEmpty,
        isFreshChat: () => transEmpty,
        getEditor: () => ({}),
        stopGeneration: () => {},
        lastAssistant: () => ({ text: "TRANS_OK" }),
        itemText: (it) => it.text,
      },
      state: transState,
      sleep: () => Promise.resolve(),
      diag: () => {},
      startSession: async () => {
        transStartCalls++;
        if (transStartCalls === 1) {
          transEmpty = false;
          transState.lastStartFailure = "model answered in prose without a command block";
          return;
        }
        transState.started = true;
      },
      submitAndGetBase: async () => 0,
      agentLoop: async () => "TRANS_OK",
      sendRuntimeMessage: (m) => transMsgs.push(m),
    });
    await transRunner.runPrompt("hi", "req-trans-retry");
    const transRes = transMsgs.find((m) => m.type === "a2a_result" && m.promptId === "req-trans-retry");
    check("a2a-runner Attempt 2 opens fresh chat after transient start failure",
      transStartCalls === 2 && transNewClicks === 1 && !!(transRes && transRes.ok === true && transRes.text === "TRANS_OK"),
      { transStartCalls, transNewClicks, transRes });

    let fatalStartCalls = 0;
    const fatalMsgs = [];
    const fatalState = { running: false, starting: false, injecting: false, started: false, stop: false, lastStartFailure: "" };
    const fatalRunner = ZSA2ARunner.createRunner({
      doc: { querySelectorAll: () => [] },
      provider: {
        chatIsEmpty: () => true,
        isFreshChat: () => true,
        getEditor: () => ({}),
        stopGeneration: () => {},
        lastAssistant: () => null,
        itemText: () => "",
      },
      state: fatalState,
      sleep: () => Promise.resolve(),
      diag: () => {},
      startSession: async () => {
        fatalStartCalls++;
        fatalState.lastStartFailure = "Error: Rate limited by provider";
      },
      submitAndGetBase: async () => 0,
      agentLoop: async () => "",
      sendRuntimeMessage: (m) => fatalMsgs.push(m),
    });
    await fatalRunner.runPrompt("hi", "req-fatal-no-retry");
    const fatalRes = fatalMsgs.find((m) => m.type === "a2a_result" && m.promptId === "req-fatal-no-retry");
    check("a2a-runner skips Attempt 2 on fatal site/quota start failure",
      fatalStartCalls === 1 && !!(fatalRes && fatalRes.ok === false && /Rate limited by provider/i.test(fatalRes.error || "")),
      { fatalStartCalls, fatalRes });
  } finally {
    global.document = origDoc;
  }

  console.log(`\n${passed}/${passed + failed} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
