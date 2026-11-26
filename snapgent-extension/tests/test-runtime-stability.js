// SPDX-License-Identifier: GPL-3.0-or-later
// Stub-DOM/Node stability tests for the extension runtime. Zero npm deps.
// Covers: (1) reconnect backoff/no-storm, (2) tab lifecycle recovery,
// (3) observer/interval/listener teardown, (4) hostile bridge frames.
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const realSetTimeout = setTimeout;
const realClearTimeout = clearTimeout;
const wait = (ms) => new Promise((r) => realSetTimeout(r, ms));

const unhandledRejections = [];
process.on("unhandledRejection", (error) => unhandledRejections.push(error));

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log("PASS  " + name);
  } else {
    failed++;
    console.error("FAIL  " + name, detail === undefined ? "" : detail);
  }
}

function loadCoreGlobal(filename, globalName, extraSandbox) {
  const full = path.join(ROOT, "core", filename);
  const code = fs.readFileSync(full, "utf8") + `\n;globalThis.${globalName} = ${globalName};`;
  const sandbox = Object.assign({ console, setTimeout: realSetTimeout, clearTimeout: realClearTimeout, Date }, extraSandbox || {});
  sandbox.globalThis = sandbox;
  vm.runInNewContext(code, sandbox, { filename: full }); // NOSONAR own local source read from disk, no external input
  return sandbox[globalName];
}

// Own local source read from disk; importScripts is deliberately absent so the
// worker's globals are injected as new Function parameters instead.
const ZSChannel = loadCoreGlobal("channel.js", "ZSChannel");
const ZSPairing = new Function(read("core/pairing.js") + "\n; return ZSPairing;")(); // NOSONAR test only
const ZSGuard = new Function(read("core/guard.js") + "\n; return ZSGuard;")(); // NOSONAR test only
const backgroundSource = read("background.js");
const exportTail = "\n; return { scheduleReconnect, connect, promptMeta, pending, statusObj, " +
  "broadcastStatus, forgetTab, handleBridgeMessage, sendToTab, sendToRuntime };";

// Minimal service-worker harness. Timers are wrapped so a reconnect can be
// fired by hand instead of waiting out the real backoff window.
function makeBackground(options) {
  const opts = options || {};
  const created = [];
  const store = Object.assign({}, opts.initialStore || {});
  const runtimeListeners = [];
  const tabListeners = { onRemoved: [], onUpdated: [], onActivated: [] };
  const timerCalls = [];
  const noEvent = { addListener: () => {} };

  class StubWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = StubWebSocket.CONNECTING;
      this.onopen = null;
      this.onmessage = null;
      this.onclose = null;
      this.onerror = null;
      created.push(this);
    }
    send() {}
    close() { this.readyState = StubWebSocket.CLOSED; }
  }
  StubWebSocket.CONNECTING = 0;
  StubWebSocket.OPEN = 1;
  StubWebSocket.CLOSING = 2;
  StubWebSocket.CLOSED = 3;

  const chrome = {
    runtime: {
      sendMessage: () => Promise.resolve(),
      onMessage: { addListener: (fn) => runtimeListeners.push(fn) },
      onStartup: noEvent,
      onInstalled: noEvent,
      get lastError() { return null; },
    },
    storage: {
      local: {
        get: (key, cb) => {
          const values = typeof key === "string" ? { [key]: store[key] }
            : Array.isArray(key) ? Object.fromEntries(key.map((k) => [k, store[k]]))
              : Object.assign({}, store);
          if (cb) cb(values);
          return Promise.resolve(values);
        },
        set: (obj, cb) => { Object.assign(store, obj); if (cb) cb(); return Promise.resolve(); },
        remove: (key, cb) => { delete store[key]; if (cb) cb(); return Promise.resolve(); },
      },
    },
    tabs: {
      query: (_info, cb) => { if (cb) cb([]); return Promise.resolve([]); },
      sendMessage: opts.tabsSendMessage || ((_tabId, _msg, cb) => { if (cb) cb(); return Promise.resolve(); }),
      update: (_tabId, _props) => Promise.resolve({}),
      onRemoved: { addListener: (fn) => tabListeners.onRemoved.push(fn) },
      onUpdated: { addListener: (fn) => tabListeners.onUpdated.push(fn) },
      onActivated: { addListener: (fn) => tabListeners.onActivated.push(fn) },
    },
    alarms: { create: () => {}, onAlarm: noEvent, clear: () => {} },
  };

  function trackedSetTimeout(fn, delay) {
    const handle = realSetTimeout(fn, delay);
    timerCalls.push({ handle, fn, delay, cleared: false });
    return handle;
  }
  function trackedClearTimeout(handle) {
    for (const entry of timerCalls) if (entry.handle === handle) entry.cleared = true;
    return realClearTimeout(handle);
  }
  const mathStub = Object.create(Math);
  mathStub.random = opts.random == null ? () => 0.5 : opts.random;

  const api = new Function( // NOSONAR own local source, no external input
    "chrome", "WebSocket", "ZSPairing", "ZSGuard", "setTimeout", "clearTimeout", "Math",
    backgroundSource + exportTail
  )(chrome, StubWebSocket, ZSPairing, ZSGuard, trackedSetTimeout, trackedClearTimeout, mathStub);

  function send(msg) {
    return new Promise((resolve) => {
      let answered = false;
      for (const listener of runtimeListeners) {
        listener(msg, {}, (response) => { answered = true; resolve(response); });
      }
      if (!answered) realSetTimeout(() => resolve(undefined), 0);
    });
  }
  // Only scheduleReconnect arms a timer whose callback calls connect(); other
  // timers (status refresh, request deadlines) are not dials.
  function pendingDialTimers() {
    return timerCalls.filter((entry) => !entry.cleared && /connect\(\)\.catch/.test(String(entry.fn)));
  }

  return { api, chrome, created, store, timerCalls, tabListeners, StubWebSocket, send, pendingDialTimers };
}

// ── Area 1: reconnect escalation, jitter cap, and storm suppression ────────
async function testReconnectBackoff() {
  const bg = makeBackground({ random: () => 0.5 });
  await wait(30);
  check("startup dials exactly once", bg.created.length === 1);

  const delays = [];
  for (let i = 0; i < 6; i++) {
    bg.api.scheduleReconnect();
    delays.push(bg.timerCalls[bg.timerCalls.length - 1].delay);
  }
  check("backoff escalates 1.7x then caps at RECONNECT_MAX",
    JSON.stringify(delays) === JSON.stringify([1000, 1700, 2890, 4913, 5000, 5000]), delays);
  check("no delay ever exceeds the cap", delays.every((delay) => delay <= 5000), delays);

  for (const random of [0, 1]) {
    const jittered = makeBackground({ random: () => random });
    await wait(20);
    jittered.api.scheduleReconnect();
    const delay = jittered.timerCalls[jittered.timerCalls.length - 1].delay;
    check(`jitter at random=${random} stays within +/-20%`, delay >= 800 && delay <= 1200, delay);
  }

  const storm = makeBackground({ random: () => 0.5 });
  await wait(30);
  const socket = storm.created[0];
  socket.readyState = storm.StubWebSocket.CLOSED;
  socket.onclose({ code: 1006 });
  for (let i = 0; i < 6; i++) storm.api.scheduleReconnect();
  const pending = storm.pendingDialTimers();
  check("rapid drops and wakeups leave a single pending dial", pending.length === 1, pending.length);
  const before = storm.created.length;
  pending[0].fn();
  await wait(20);
  check("one timer wakeup produces exactly one dial", storm.created.length === before + 1,
    { before, after: storm.created.length });

  const parked = makeBackground();
  await wait(30);
  const refused = parked.created[0];
  refused.readyState = parked.StubWebSocket.OPEN;
  refused.onopen();
  refused.readyState = parked.StubWebSocket.CLOSED;
  refused.onclose({ code: 1008 });
  check("1008 parks without scheduling any dial", parked.pendingDialTimers().length === 0);
  check("1008 persists the pairing flag", parked.store.bridgeAuthRequired === true);
  const parkedStatus = await parked.send({ type: "status" });
  check("1008 still reports authRequired to the popup",
    !!(parkedStatus && parkedStatus.authRequired === true && parkedStatus.connected === false), parkedStatus);

  const rotated = makeBackground();
  await wait(30);
  const dropped = rotated.created[0];
  dropped.readyState = rotated.StubWebSocket.OPEN;
  dropped.onopen();
  dropped.readyState = rotated.StubWebSocket.CLOSED;
  dropped.onclose({ code: 1012 });
  check("1012 schedules a reconnect instead of parking", rotated.pendingDialTimers().length === 1);
  check("1012 does not set the pairing flag", rotated.store.bridgeAuthRequired !== true);
  const rotatedStatus = await rotated.send({ type: "status" });
  check("1012 still reports rotatingToken to the popup",
    !!(rotatedStatus && rotatedStatus.rotatingToken === true), rotatedStatus);
}

// ── Area 2: tab switch / reload / removal recovery without stale entries ───
async function testTabLifecycle() {
  const bg = makeBackground();
  await wait(30);
  bg.api.promptMeta.set("keep", { tabId: 11, started: Date.now() });
  bg.api.promptMeta.set("remove", { tabId: 22, started: Date.now() });
  bg.tabListeners.onRemoved[0](22);
  check("tab removal forgets only that tab's promptMeta",
    !bg.api.promptMeta.has("remove") && bg.api.promptMeta.has("keep"));

  bg.api.promptMeta.set("reload", { tabId: 33, started: Date.now() });
  bg.tabListeners.onUpdated[0](33, { status: "loading" });
  check("page reload drops the old document's promptMeta", !bg.api.promptMeta.has("reload"));
  bg.tabListeners.onUpdated[0](11, { status: "complete" });
  check("a completed load does not drop live promptMeta", bg.api.promptMeta.has("keep"));

  const socket = bg.created[0];
  socket.readyState = bg.StubWebSocket.CLOSED;
  socket.onclose({ code: 1006 });
  const before = bg.created.length;
  bg.tabListeners.onActivated[0]({ tabId: 33, windowId: 1 });
  await wait(20);
  check("tab switch recovers a disconnected bridge", bg.created.length === before + 1,
    { before, after: bg.created.length });
}

async function testClosedTabSafety() {
  const throwing = makeBackground({ tabsSendMessage: () => { throw new Error("closed tab"); } });
  await wait(20);
  let threw = false;
  try { throwing.api.broadcastStatus(); } catch (_) { threw = true; }
  check("broadcastStatus survives a throwing tabs.sendMessage", !threw);

  const rejecting = makeBackground({ tabsSendMessage: () => Promise.reject(new Error("closed tab")) });
  await wait(20);
  let threwAgain = false;
  try { rejecting.api.broadcastStatus(); } catch (_) { threwAgain = true; }
  await wait(20);
  check("broadcastStatus survives a rejecting tabs.sendMessage", !threwAgain);
  check("tab sends produce no unhandled rejections", unhandledRejections.length === 0,
    unhandledRejections.map(String));
}

// ── Area 3: teardown on re-init / unload across a long session ─────────────
function testChannelTeardown() {
  let cleared = 0;
  let nextId = 0;
  const activeIntervals = new Set();
  const pollOptions = {
    send: () => Promise.resolve({ connected: false }),
    setIntervalFn: () => { const id = ++nextId; activeIntervals.add(id); return id; },
    clearIntervalFn: (id) => { cleared++; activeIntervals.delete(id); },
  };
  for (let i = 0; i < 40; i++) {
    const poller = ZSChannel.startStatusPolling(pollOptions);
    poller.stop();
    poller.stop();
  }
  check("40 status pollers clear their interval exactly once",
    cleared === 40 && activeIntervals.size === 0, { cleared, active: activeIntervals.size });

  const listeners = [];
  let removed = 0;
  const runtime = {
    onMessage: {
      addListener: (fn) => listeners.push(fn),
      removeListener: (fn) => {
        const index = listeners.indexOf(fn);
        if (index >= 0) listeners.splice(index, 1);
        removed++;
      },
    },
  };
  for (let i = 0; i < 40; i++) {
    const stop = ZSChannel.listenRuntimeMessages({}, runtime);
    stop();
    stop();
  }
  check("40 runtime listeners are removed exactly once",
    removed === 40 && listeners.length === 0, { removed, live: listeners.length });
}

function makeElement(tag) {
  const classes = new Set();
  const attributes = {};
  const children = [];
  const node = {
    tagName: String(tag || "div").toUpperCase(),
    id: "", className: "", textContent: "", hidden: false, disabled: false, value: "",
    dataset: {}, children, options: children, selectedIndex: 0, parentElement: null,
    isConnected: true, offsetHeight: 36, offsetWidth: 400, scrollTop: 0, scrollHeight: 100,
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      toggle: (name, force) => {
        if (force === undefined ? !classes.has(name) : !!force) classes.add(name);
        else classes.delete(name);
      },
      contains: (name) => classes.has(name),
    },
    style: { setProperty() {}, removeProperty() {} },
    setAttribute: (key, value) => { attributes[key] = value; },
    getAttribute: (key) => (key in attributes ? attributes[key] : null),
    addEventListener() {},
    removeEventListener() {},
    appendChild: (child) => { if (child) { child.parentElement = node; children.push(child); } return child; },
    replaceChildren: (...nodes) => { children.length = 0; nodes.forEach((child) => node.appendChild(child)); },
    insertBefore: (child) => node.appendChild(child),
    remove: () => {
      if (!node.parentElement) return;
      const siblings = node.parentElement.children;
      const index = siblings.indexOf(node);
      if (index >= 0) siblings.splice(index, 1);
      node.parentElement = null;
    },
    querySelector: (selector) => {
      if (!selector.startsWith("#")) return null;
      const wanted = selector.slice(1);
      const walk = (current) => {
        if (current.id === wanted) return current;
        for (const child of (current.children || [])) {
          const hit = walk(child);
          if (hit) return hit;
        }
        return null;
      };
      return walk(node);
    },
    querySelectorAll: () => [],
    contains: () => false,
    closest: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 36, right: 400, bottom: 36 }),
    getClientRects: () => [],
    focus() {},
    click() {},
  };
  return node;
}

function makeUiHarness() {
  const observers = [];
  const activeTimers = new Set();
  let rafId = 0;
  let liveRaf = 0;
  let cancelledRaf = 0;
  const documentElement = makeElement("html");

  class StubMutationObserver {
    constructor(fn) {
      this.fn = fn;
      this.disconnects = 0;
      this.observes = 0;
      observers.push(this);
    }
    observe() { this.observes++; }
    disconnect() { this.disconnects++; }
  }

  const sandbox = {
    MutationObserver: StubMutationObserver,
    performance: { now: () => 1000 },
    DOMRect: class { constructor(x, y, width, height) { Object.assign(this, { x, y, width, height }); } },
    getComputedStyle: () => ({ backgroundColor: "rgb(20, 20, 20)", borderRadius: "12px" }),
    requestAnimationFrame: () => { liveRaf++; return ++rafId; },
    cancelAnimationFrame: () => { liveRaf--; cancelledRaf++; },
    setTimeout: (fn, ms) => {
      const handle = realSetTimeout(fn, ms);
      activeTimers.add(handle);
      return handle;
    },
    clearTimeout: (handle) => { activeTimers.delete(handle); realClearTimeout(handle); },
    document: {
      documentElement,
      body: makeElement("body"),
      hidden: false,
      createElement: makeElement,
      createElementNS: (_ns, tag) => makeElement(tag),
      createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
      getElementById: (id) => documentElement.querySelector("#" + id),
      addEventListener() {},
      removeEventListener() {},
    },
    window: {
      innerWidth: 1280,
      innerHeight: 800,
      addEventListener() {},
      removeEventListener() {},
      matchMedia: () => ({ addEventListener() {}, removeEventListener() {} }),
    },
  };
  const ZSUiController = loadCoreGlobal("ui-controller.js", "ZSUiController", sandbox);
  const deps = {
    state: { bridge: { servers: [] } },
    provider: { id: "gemini", displayName: "Gemini", getEditor: () => null, isFreshChat: () => true, chatIsEmpty: () => true },
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
    bareToolName: (name) => name,
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
  };
  function rootCount() {
    return documentElement.children.filter((child) => child.id === "zs-root").length;
  }
  return { create: () => ZSUiController.createUiController(deps), rootCount, observers, activeTimers,
    rafStats: () => ({ liveRaf, cancelledRaf }) };
}

function testUiTeardownAndReinit() {
  const harness = makeUiHarness();
  const first = harness.create();
  check("one bar root mounted", harness.rootCount() === 1, harness.rootCount());
  check("theme MutationObserver installed", harness.observers.length === 1 && harness.observers[0].observes > 0);

  const second = harness.create();
  check("re-init removes the stale #zs-root (no duplicate bar)", harness.rootCount() === 1, harness.rootCount());
  first.destroy();
  second.destroy();
  check("destroy disconnects the theme observer once each",
    harness.observers.every((observer) => observer.disconnects === 1));
  check("destroy removes the bar root", harness.rootCount() === 0, harness.rootCount());
  check("destroy cancels rAF loops and clears the theme timer",
    harness.rafStats().liveRaf === 0 && harness.activeTimers.size === 0, harness.rafStats());

  const cycles = 40;
  for (let i = 0; i < cycles; i++) {
    const controller = harness.create();
    controller.destroy();
    controller.destroy();
  }
  check(`${cycles} init/destroy cycles leak no observers`, harness.observers.length === 2 + cycles &&
    harness.observers.every((observer) => observer.disconnects === 1),
    { total: harness.observers.length, live: harness.observers.filter((o) => o.disconnects === 0).length });
  check(`${cycles} init/destroy cycles leak no bars, timers, or frames`,
    harness.rootCount() === 0 && harness.activeTimers.size === 0 && harness.rafStats().liveRaf === 0,
    { roots: harness.rootCount(), timers: harness.activeTimers.size, raf: harness.rafStats() });
}

function testUnloadWiringInMain() {
  const mainSource = read("core/main.js");
  const popupSource = read("popup.js");
  check("main.js has one guarded unload teardown",
    /let tornDown = false;/.test(mainSource) &&
    /if \(tornDown \|\| \(event && event\.persisted\)\)/.test(mainSource) &&
    /window\.addEventListener\("pagehide", onPageHide\)/.test(mainSource) &&
    /window\.addEventListener\("beforeunload", onBeforeUnload\)/.test(mainSource) &&
    /window\.removeEventListener\("pagehide", onPageHide\)/.test(mainSource) &&
    /window\.removeEventListener\("beforeunload", onBeforeUnload\)/.test(mainSource));
  check("main.js teardown stops polling, observers, timers, and the UI",
    /statusPoll\.stop\(\)/.test(mainSource) &&
    /stopRuntimeMessages\(\)/.test(mainSource) &&
    /try \{ mo\.disconnect\(\); \} catch \{\}/.test(mainSource) &&
    /perfObserver\.disconnect\(\)/.test(mainSource) &&
    /clearTimeout\(_liveTimer\)/.test(mainSource) &&
    /clearTimeout\(_resumeTimer\)/.test(mainSource) &&
    /clearTimeout\(_sysResendTimer\)/.test(mainSource) &&
    /ui\.destroy\(\)/.test(mainSource));
  check("popup clears its poll on pagehide",
    /const refreshTimer = setInterval\(refresh, 2000\)/.test(popupSource) &&
    /window\.addEventListener\("pagehide", \(\) => clearInterval\(refreshTimer\), \{ once: true \}\)/.test(popupSource));
}

// ── Area 4: malformed and oversized bridge frames ──────────────────────────
async function testHostileFrames() {
  const bg = makeBackground();
  await wait(30);
  const socket = bg.created[0];
  socket.readyState = bg.StubWebSocket.OPEN;
  socket.onopen();
  const before = await bg.send({ type: "status" });

  const payloads = [
    undefined,
    null,
    {},
    { data: 12345 },
    { data: "{not json" },
    { data: "null" },
    { data: "42" },
    { data: "[]" },
    { data: "\"a bare string\"" },
    { data: "x".repeat(2 * 1024 * 1024 + 1) },
    { data: JSON.stringify({ type: "unknown_test_frame" }) },
  ];
  let thrown = 0;
  for (const payload of payloads) {
    try { socket.onmessage(payload); } catch (_) { thrown++; }
  }
  await wait(20);
  check("malformed / oversized frames never throw", thrown === 0, thrown);
  check("frame handling creates no unhandled rejections", unhandledRejections.length === 0,
    unhandledRejections.map(String));
  const after = await bg.send({ type: "status" });
  check("junk frames do not corrupt connection state",
    !!(after && after.connected === before.connected && after.authRequired === false), after);
}

(async () => {
  await testReconnectBackoff();
  await testTabLifecycle();
  await testClosedTabSafety();
  testChannelTeardown();
  testUiTeardownAndReinit();
  testUnloadWiringInMain();
  await testHostileFrames();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
