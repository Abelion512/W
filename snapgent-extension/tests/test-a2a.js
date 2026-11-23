// Standalone Node smoke test for the A2A relay in snapgent-extension/background.js
// (run: node snapgent-extension/test-a2a.js). Not shipped, no npm.
//
// background.js is a browser service worker, so it is evaluated here against a
// minimal `chrome` + `WebSocket` stub - just enough surface for the relay path:
//   bridge "submit_prompt" -> tabs.sendMessage "zs-a2a-prompt"
//   runtime "a2a_result"   -> socket frame "prompt_result"
// Anything the relay does not touch stays undefined, so a future change that
// needs more browser API fails loudly here instead of silently passing.
//
// Scope: covers the background.js half of the relay only. The content script
// (core/main.js) and its real DOM loop are not exercised here.
const fs = require("fs");

// ── Stub WebSocket ──────────────────────────────────────────────────────────
// Captures the single instance background.js creates; the test fires onopen()
// by hand to drive `connected` true. Every outgoing frame is recorded parsed.
const frames = [];
class StubWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = StubWebSocket.CONNECTING;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    StubWebSocket.instance = this;
  }
  send(s) { frames.push(JSON.parse(s)); }
  close() { this.readyState = StubWebSocket.CLOSED; }
}
StubWebSocket.CONNECTING = 0;
StubWebSocket.OPEN = 1;
StubWebSocket.CLOSING = 2;
StubWebSocket.CLOSED = 3;

// ── Stub chrome ─────────────────────────────────────────────────────────────
const tabSends = [];   // {tabId, msg} from chrome.tabs.sendMessage
let onRuntimeMessage = null;
// Error a real tabs.sendMessage hands back on its callback. The relay must
// treat "message port closed" as SUCCESS (the content script replies later by
// runtime message) and only "no receiver" as failure.
let nextSendError = null;
let lastError = null;
const providerTab = { id: 7, active: true, url: "https://chatgpt.com/" };
// Route tests swap this list in; null means "just the default provider tab".
let tabsForQuery = null;
const chrome = {
  runtime: {
    sendMessage: () => Promise.resolve(),
    onMessage: { addListener: (fn) => { onRuntimeMessage = fn; } },
    onStartup: { addListener: () => {} },
    onInstalled: { addListener: () => {} },
    get lastError() { return lastError; },
  },
  // background.js reads the persisted pairing state before its first dial.
  storage: {
    local: {
      get: (key, cb) => {
        const values = typeof key === "string" ? { [key]: undefined } : {};
        if (cb) cb(values);
        return Promise.resolve(values);
      },
      set: (_obj, cb) => { if (cb) cb(); return Promise.resolve(); },
      remove: (_key, cb) => { if (cb) cb(); return Promise.resolve(); },
    },
  },
  tabs: {
    query: (info, cb) => {
      let tabs = tabsForQuery || [providerTab];
      if (info && info.active) tabs = tabs.filter((t) => t.active);
      if (cb) cb(tabs);
      return Promise.resolve(tabs);
    },
    sendMessage: (tabId, msg, cb) => {
      tabSends.push({ tabId, msg });
      // lastError persists across sends until a new error is set: a missing
      // receiver fails EVERY retry, not just the first one.
      if (cb) { lastError = nextSendError; cb(); }
      return Promise.resolve();
    },
  },
};

// ── Load background.js against the stubs ────────────────────────────────────
// background.js pulls core/pairing.js in with importScripts. The stub exposes
// it on the global, which is where the worker's bare `ZSPairing` resolves.
// new Function is safe here for the same reason as test-pairing.js: the
// evaluated string is this repo's own source read from disk, `relpath` is a
// literal, and no part of it is user input.
const importScripts = (relpath) => {
  globalThis.ZSPairing = new Function(
    fs.readFileSync(__dirname + "/../" + relpath, "utf8") + "; return ZSPairing;"
  )();
};

const src = fs.readFileSync(__dirname + "/../background.js", "utf8");
const api = new Function("chrome", "WebSocket", "importScripts",
  src + "; return { handleBridgeMessage, handleSubmitPrompt, routeFor, tabForRoute, TIER_PROVIDERS, CATEGORY_PROVIDERS, PROVIDER_HOSTS, PROVIDER_CAPABILITIES };"
)(chrome, StubWebSocket, importScripts);

const results = [];
const ok = (name, cond) => { results.push(cond); console.log((cond ? "PASS" : "FAIL") + "  " + name); };
const until = async (cond, ms = 1000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 10));
  }
  return true;
};

(async () => {
  // Load fires connect(), which awaits the stored pairing token before it dials,
  // so the socket only exists a microtask later.
  await until(() => !!StubWebSocket.instance);
  // Drive the handshake so the relay can send frames. A real WebSocket is
  // already OPEN when onopen fires; mirror that here or send() would treat the
  // socket as not yet open and buffer forever.
  StubWebSocket.instance.readyState = StubWebSocket.OPEN;
  StubWebSocket.instance.onopen();
  ok("socket connected after onopen", StubWebSocket.instance.readyState === StubWebSocket.OPEN);
  ok("runtime listener registered", typeof onRuntimeMessage === "function");

  // ── bridge "submit_prompt" -> tab "zs-a2a-prompt" ─────────────────────────
  // Simulate Chrome's port-closed callback: the content script does NOT respond
  // on the channel (it replies later by runtime message). The relay must NOT
  // report a failure here, or it double-replies and fails a healthy task.
  nextSendError = { message: "The message port closed before a response was received." };
  api.handleBridgeMessage({ type: "submit_prompt", id: "p1", prompt: "hi" });
  await until(() => tabSends.some((s) => s.msg.type === "zs-a2a-prompt"));
  const relayed = tabSends.filter((s) => s.msg.type === "zs-a2a-prompt");
  ok("submit_prompt relays exactly one zs-a2a-prompt", relayed.length === 1);
  ok("relayed prompt carries the prompt text", relayed[0] && relayed[0].msg.prompt === "hi");
  ok("relayed prompt carries promptId = bridge id", relayed[0] && relayed[0].msg.promptId === "p1");
  ok("relayed prompt targets the provider tab", relayed[0] && relayed[0].tabId === providerTab.id);
  await new Promise((r) => setTimeout(r, 50));
  ok("port-closed callback does not send a failure", frames.filter((f) => f.type === "prompt_result").length === 0);

  // ── runtime "a2a_result" -> socket frame "prompt_result" ──────────────────
  onRuntimeMessage({ type: "a2a_result", promptId: "p1", ok: true, text: "hello" }, {}, () => {});
  await until(() => frames.some((f) => f.type === "prompt_result"));
  const result = frames.find((f) => f.type === "prompt_result");
  ok("a2a_result forwards one prompt_result frame", frames.filter((f) => f.type === "prompt_result").length === 1);
  ok("prompt_result carries prompt_id", result && result.prompt_id === "p1");
  ok("prompt_result carries ok", result && result.ok === true);
  ok("prompt_result carries the text", result && result.text === "hello");
  ok("prompt_result carries an empty error on success", result && result.error === "");

  // ── no receiving end -> failure after the brief content-script retry ──────
  nextSendError = { message: "Could not establish connection. Receiving end does not exist." };
  api.handleBridgeMessage({ type: "submit_prompt", id: "p2", prompt: "hi again" });
  await until(() => frames.some((f) => f.type === "prompt_result" && f.prompt_id === "p2"), 8000);
  const missing = frames.find((f) => f.type === "prompt_result" && f.prompt_id === "p2");
  ok("missing content script reports failure", missing && missing.ok === false);
  ok("missing content script sends exactly one failure",
     frames.filter((f) => f.type === "prompt_result" && f.prompt_id === "p2").length === 1);
  // Clear the injected error: the stub keeps it on every later sendMessage, and
  // leaving it set made every routing test below look like a dead tab (the relay
  // retried 3x and replied failure, which the tabSends-only asserts never saw).
  nextSendError = null;

  // ── a2a_result failure path ───────────────────────────────────────────────
  onRuntimeMessage({ type: "a2a_result", promptId: "p3", ok: false, error: "boom" }, {}, () => {});
  await until(() => frames.some((f) => f.type === "prompt_result" && f.prompt_id === "p3"));
  const failed = frames.find((f) => f.type === "prompt_result" && f.prompt_id === "p3");
  ok("failed a2a_result forwards ok:false", failed && failed.ok === false);
  ok("failed a2a_result forwards the error", failed && failed.error === "boom");

  // ── model-tier routing ───────────────────────────────────────────────────
  tabsForQuery = [
    { id: 7, active: true, url: "https://chatgpt.com/c/1" },
    { id: 9, active: false, url: "https://chat.deepseek.com/a/chat" },
  ];
  tabSends.length = 0;
  await api.handleSubmitPrompt({ id: "p4", prompt: "quick", metadata: { taskCategory: "extract" } });
  const light = tabSends.find((s) => s.msg.type === "zs-a2a-prompt");
  ok("category 'extract' routes to the light provider (DeepSeek)", light && light.tabId === 9);
  ok("relayed prompt labels the light tier", light && light.msg.route === "light");

  tabSends.length = 0;
  await api.handleSubmitPrompt({ id: "p5", prompt: "design", metadata: { modelTier: "deep" } });
  const deep = tabSends.find((s) => s.msg.type === "zs-a2a-prompt");
  ok("explicit 'deep' tier routes to the deep provider (ChatGPT)", deep && deep.tabId === 7);
  ok("relayed prompt labels the deep tier", deep && deep.msg.route === "deep");

  // Complexity wins when a category has no pinned provider list: a small code
  // edit is a light task even though "code-edit" defaults to balanced.
  tabsForQuery = [
    { id: 21, active: true, url: "https://claude.ai/new" },
    { id: 22, active: false, url: "https://gemini.google.com/app" },
  ];
  tabSends.length = 0;
  await api.handleSubmitPrompt({ id: "p8", prompt: "rename", metadata: { taskCategory: "code-edit", complexity: "low" } });
  const small = tabSends.find((s) => s.msg.type === "zs-a2a-prompt");
  ok("complexity 'low' downgrades a code-edit to the light tier (Gemini)", small && small.tabId === 22);
  ok("relayed prompt labels the downgraded tier", small && small.msg.route === "light");

  // A category's specialist list outranks even a high-complexity deep tier:
  // "realtime" + "high" must still land on Grok, which can see the live page.
  tabsForQuery = [
    { id: 31, active: true, url: "https://gemini.google.com/app" },
    { id: 32, active: false, url: "https://grok.com/chat" },
  ];
  tabSends.length = 0;
  await api.handleSubmitPrompt({ id: "p9", prompt: "today's news", metadata: { taskCategory: "realtime", complexity: "high" } });
  const live = tabSends.find((s) => s.msg.type === "zs-a2a-prompt");
  ok("category 'realtime' + 'high' still routes to Grok", live && live.tabId === 32);
  ok("category provider list keeps its declared tier label", live && live.msg.route === "balanced");

  // Preferred providers are all closed -> fall back to the active tab, not the first.
  tabsForQuery = [{ id: 11, active: true, url: "https://chat.mistral.ai/chat" }];
  tabSends.length = 0;
  await api.handleSubmitPrompt({ id: "p6", prompt: "review", metadata: { modelTier: "deep" } });
  const fallback = tabSends.find((s) => s.msg.type === "zs-a2a-prompt");
  ok("missing preferred providers falls back to the active tab", fallback && fallback.tabId === 11);

  // No route metadata -> today's active-tab behaviour.
  tabsForQuery = null;
  tabSends.length = 0;
  await api.handleSubmitPrompt({ id: "p7", prompt: "plain" });
  const plain = tabSends.find((s) => s.msg.type === "zs-a2a-prompt");
  ok("no metadata keeps the active-tab behaviour", plain && plain.tabId === 7);

  // ── routing table covers all twelve configured providers ──────────────────
  const routing = api.TIER_PROVIDERS;
  const categories = api.CATEGORY_PROVIDERS;
  const hosts = api.PROVIDER_HOSTS;
  const allProviders = Object.keys(hosts).sort();
  // The twelve accounts the user actually holds, plus Arena and Meta which are
  // registered but untested (no routing weight).
  const coreProviders = ["claude", "chatgpt", "kimi", "grok", "deepseek", "glm", "gemini",
                         "qwen", "ptero", "manus", "mistral", "rudder"];
  ok("all twelve core providers have host patterns",
     coreProviders.every((p) => Array.isArray(hosts[p]) && hosts[p].length > 0) && allProviders.length === 14);

  // Ptero and Manus are listed for completeness but no text task may route there.
  const textProviders = [...new Set([...Object.values(routing).flat(), ...Object.values(categories).flat()])];
  const nonText = ["ptero", "manus"];
  ok("every text route names a provider with a host pattern",
     textProviders.every((p) => Array.isArray(hosts[p]) && hosts[p].length > 0));
  ok("non-text providers are excluded from every text route",
     nonText.every((p) => !textProviders.includes(p)) && nonText.every((p) => allProviders.includes(p)));

  // Every listed provider must resolve when its tab is the only one open.
  const unresolved = textProviders.filter((p) => {
    const tab = { id: 99, url: "https://" + hosts[p][0] + "/chat" };
    const hit = api.tabForRoute([tab], { providers: [p] });
    return !hit || hit.id !== 99;
  });
  ok("every routed provider matches its own host pattern", unresolved.length === 0, unresolved.join(","));

  // An explicit pin wins over tier/category/complexity and has no fallback: a
  // caller that asked for Grok must not silently get ChatGPT.
  tabsForQuery = [
    { id: 41, active: true, url: "https://chatgpt.com/c/1" },
    { id: 42, active: false, url: "https://grok.com/chat" },
  ];
  tabSends.length = 0;
  await api.handleSubmitPrompt({ id: "p10", prompt: "pinned", metadata: { provider: "grok", modelTier: "deep" } });
  const pinned = tabSends.find((s) => s.msg.type === "zs-a2a-prompt");
  ok("metadata.provider pins the provider over the tier list", pinned && pinned.tabId === 42);
  ok("pinned route is labelled as such", pinned && pinned.msg.route === "pinned");

  // A pin to a provider whose tab is closed falls back to the active tab, not
  // to another provider that happens to be open.
  tabsForQuery = [{ id: 43, active: true, url: "https://chatgpt.com/c/2" }];
  tabSends.length = 0;
  await api.handleSubmitPrompt({ id: "p11", prompt: "pinned missing", metadata: { provider: "grok" } });
  const pinnedMissing = tabSends.find((s) => s.msg.type === "zs-a2a-prompt");
  ok("a closed pinned provider falls back to the active tab", pinnedMissing && pinnedMissing.tabId === 43);

  // No text tier may list a provider twice (order is the contract).
  const duplicated = Object.entries(routing).filter(([, list]) => new Set(list).size !== list.length).map(([t]) => t);
  ok("no tier repeats a provider", duplicated.length === 0, duplicated.join(","));

  // ── capability-aware routing contract ───────────────────────────────────────
  // These checks target the agreed contract, not the current background.js code.
  const caps = api.PROVIDER_CAPABILITIES;
  const has = (id, cap) => !!(caps && caps[id] && caps[id][cap]);
  ok("capabilities: vision set", ["gemini", "glm", "kimi", "meta", "arena"].every((p) => has(p, "vision")));
  ok("capabilities: no vision on deepseek/qwen", !has("deepseek", "vision") && !has("qwen", "vision"));
  ok("capabilities: webSearch set", ["chatgpt", "deepseek", "grok", "mistral"].every((p) => has(p, "webSearch")));
  ok("capabilities: largeInput set", ["arena", "deepseek", "qwen"].every((p) => has(p, "largeInput")));

  // No capability flags: route is byte-for-byte the old shape, no fallback field.
  const plainRoute = api.routeFor({ complexity: "high" });
  ok("no flags: deep chain unchanged", plainRoute && plainRoute.tier === "deep" &&
     JSON.stringify(plainRoute.providers) === JSON.stringify(["claude", "chatgpt", "kimi"]));
  ok("no flags: no capabilityFallback field", plainRoute && !("capabilityFallback" in plainRoute));
  ok("no flags: only tier/providers keys", plainRoute &&
     Object.keys(plainRoute).sort((a, b) => String(a).localeCompare(String(b))).join(",") === "providers,tier");

  // A pin without flags is still an ordinary pinned route.
  const pinRoute = api.routeFor({ provider: "grok" });
  ok("pin without flags: tier is pinned", pinRoute && pinRoute.tier === "pinned" &&
     JSON.stringify(pinRoute.providers) === JSON.stringify(["grok"]));
  ok("pin without flags: no fallback field", pinRoute && !("capabilityFallback" in pinRoute));

  // Filters keep the tier label and base order, dropping providers without the flag.
  const visionRoute = api.routeFor({ modelTier: "balanced", needsVision: true });
  ok("needsVision filters balanced to gemini,glm,kimi", visionRoute &&
     JSON.stringify(visionRoute.providers) === JSON.stringify(["gemini", "glm", "kimi"]) &&
     visionRoute.tier === "balanced" && !visionRoute.capabilityFallback);

  const webRoute = api.routeFor({ modelTier: "balanced", needsWeb: true });
  ok("needsWeb filters balanced to deepseek,grok", webRoute &&
     JSON.stringify(webRoute.providers) === JSON.stringify(["deepseek", "grok"]));

  const largeRoute = api.routeFor({ modelTier: "balanced", largeInput: true });
  ok("largeInput filters balanced to deepseek,qwen", largeRoute &&
     JSON.stringify(largeRoute.providers) === JSON.stringify(["deepseek", "qwen"]));

  // avoidProviders removes ids after capability filtering; order survives.
  const avoidRoute = api.routeFor({ modelTier: "balanced", needsVision: true, avoidProviders: ["glm"] });
  ok("avoidProviders drops ids after capability filter", avoidRoute &&
     JSON.stringify(avoidRoute.providers) === JSON.stringify(["gemini", "kimi"]));

  // Empty after filtering -> original base list plus capabilityFallback.
  const pinAvoid = api.routeFor({ provider: "deepseek", avoidProviders: ["deepseek"] });
  ok("pinned avoid-all falls back to base", pinAvoid && pinAvoid.capabilityFallback === true &&
     JSON.stringify(pinAvoid.providers) === JSON.stringify(["deepseek"]) && pinAvoid.tier === "pinned");

  // Kimi is vision-capable per the capability map, so deep+vision keeps Kimi.
  const deepVision = api.routeFor({ modelTier: "deep", needsVision: true });
  ok("deep needsVision keeps only kimi", deepVision &&
     JSON.stringify(deepVision.providers) === JSON.stringify(["kimi"]) &&
     !deepVision.capabilityFallback);

  // No deep-chain provider supports largeInput, so this filter is the real fallback.
  const deepLarge = api.routeFor({ modelTier: "deep", largeInput: true });
  ok("deep largeInput falls back to base chain", deepLarge &&
     deepLarge.capabilityFallback === true &&
     JSON.stringify(deepLarge.providers) === JSON.stringify(["claude", "chatgpt", "kimi"]));

  const noOverlap = api.routeFor({ modelTier: "balanced", needsVision: true, needsWeb: true });
  ok("multiple filters are AND; empty falls back to base", noOverlap &&
     noOverlap.capabilityFallback === true &&
     JSON.stringify(noOverlap.providers) ===
       JSON.stringify(["deepseek", "gemini", "grok", "qwen", "glm", "kimi"]));

  // tabForRoute still chooses the first open tab among filtered providers only:
  // active ChatGPT is open but not in the vision-filtered list.
  const visionTabs = [
    { id: 70, active: true, url: "https://chatgpt.com/c/1" },
    { id: 71, active: false, url: "https://gemini.google.com/app" },
    { id: 72, active: false, url: "https://chat.z.ai/" },
  ];
  const visionHit = api.tabForRoute(visionTabs, visionRoute);
  ok("tabForRoute ignores open tabs outside filtered providers", visionHit && visionHit.id === 71);
  tabsForQuery = visionTabs;
  tabSends.length = 0;
  await api.handleSubmitPrompt({ id: "p12", prompt: "vision", metadata: { modelTier: "balanced", needsVision: true } });
  const visionRelay = tabSends.find((s) => s.msg.type === "zs-a2a-prompt");
  ok("relay honours capability-filtered route", visionRelay && visionRelay.tabId === 71);

  // ── prompt_ack is swallowed (fire-and-forget relay) ───────────────────────
  const before = frames.length;
  api.handleBridgeMessage({ type: "prompt_ack", id: 5 });
  await new Promise((r) => setTimeout(r, 50));
  ok("prompt_ack sends nothing back", frames.length === before);

  const failedCount = results.filter((r) => !r).length;
  console.log("\n" + (failedCount ? "FAIL" : "PASS") + "  " + (results.length - failedCount) + "/" + results.length + " checks passed");
  process.exit(failedCount ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
