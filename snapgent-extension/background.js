// SPDX-License-Identifier: GPL-3.0-or-later
// background.js - service worker.
// Owns ONE resilient WebSocket to the local bridge (ws://127.0.0.1:PORT).
// Keeping the socket here (not in the content script) avoids https→ws mixed
// content issues and centralises reconnect / timeout logic.
//
// Contract with content.js: every sendMessage ALWAYS gets a response object,
// even when the bridge is offline. The agentic loop must never hang waiting.

// Classic service worker (no "type": "module"), so shared code is pulled in with
// importScripts. core/pairing.js builds the handshake URL and classifies closes;
// core/guard.js holds the shared heartbeat/retry policy (upstream 0110dec).
// Guard the calls so Node stub-DOM tests can evaluate this file without a worker.
if (typeof importScripts === "function") {
  importScripts("core/pairing.js");
  if (typeof ZSGuard === "undefined") importScripts("core/guard.js");
}

const PORT = 17613;
const URL = `ws://127.0.0.1:${PORT}`;
// Pairing secret issued by the bridge (~/.snapgent/bridge_token). The popup saves
// it here; the bridge rejects connections without it once auth is enabled.
const TOKEN_KEY = "bridgeToken";
// Persisted pairing state. The worker is evicted between events, so a bridge
// that refused our token (close 1008) has to be remembered in storage: without
// it the next wake re-dials, is refused again, and the popup loses the card.
const AUTH_STATE_KEY = "bridgeAuthRequired";

// Chat sites where a snapgentV3 provider content script runs. Status pushes go
// to every tab matching these. Add the new provider's URL pattern here (and in
// manifest.json content_scripts + host_permissions) when integrating another AI.
const PROVIDER_URLS = ["https://chat.deepseek.com/*", "https://chatgpt.com/*", "https://chat.openai.com/*", "https://claude.ai/*", "https://gemini.google.com/*", "https://www.kimi.ai/*", "https://kimi.ai/*", "https://chat.z.ai/*", "https://chat.qwen.ai/*", "https://arena.ai/*", "https://www.meta.ai/*", "https://meta.ai/*", "https://ptero.pro/*", "https://grok.com/*", "https://chat.mistral.ai/*", "https://rudder.chat/*"];

// Task category -> model tier -> provider preference. The A2A client declares
// the category in metadata; model names stay out of here so a provider renaming
// its model does not need a code change. See docs/model-routing.md.
const CATEGORY_TIER = {
  extract: "light",
  summarize: "light",
  classify: "light",
  "code-edit": "balanced",
  debug: "balanced",
  realtime: "balanced",
  chat: "light",
  orchestrate: "deep",
  review: "deep",
  architecture: "deep",
  security: "deep",
};
// Preference order inside each tier: the first provider with an open tab wins.
// The ladder reflects real account limits (Claude 5h window, Kimi often busy,
// Gemini 1M context but weakest multi-step), so this is a fallback order, not a
// ranking to optimise. See docs/model-routing.md.
const TIER_PROVIDERS = {
  light: ["deepseek", "gemini", "qwen", "glm", "mistral", "rudder"],
  balanced: ["deepseek", "gemini", "grok", "qwen", "glm", "kimi"],
  deep: ["claude", "chatgpt", "kimi"],
};
// A category may pin a short list when one site is clearly better regardless of
// tier: live information needs a search-first model, plain chat should not burn
// a frontier quota, and planning is ChatGPT's orchestrator job.
const CATEGORY_PROVIDERS = {
  realtime: ["grok", "chatgpt", "gemini"],
  chat: ["rudder", "mistral", "gemini"],
  orchestrate: ["chatgpt", "claude", "kimi"],
};
// A category's provider list outranks complexity on purpose; see docs/model-routing.md.
// Complexity only picks the tier when no category list applies.
const COMPLEXITY_TIER = { low: "light", medium: "balanced", high: "deep" };
const PROVIDER_HOSTS = {
  deepseek: ["chat.deepseek.com"],
  gemini: ["gemini.google.com"],
  chatgpt: ["chatgpt.com", "chat.openai.com"],
  claude: ["claude.ai"],
  kimi: ["kimi.ai"],
  glm: ["chat.z.ai"],
  qwen: ["chat.qwen.ai"],
  arena: ["arena.ai"],
  meta: ["meta.ai"],
  grok: ["grok.com"],
  mistral: ["chat.mistral.ai"],
  rudder: ["rudder.chat"],
  // Non-text providers: no tab is ever routed here by a text task.
  ptero: ["ptero.pro"],
  manus: ["manus.im"],
};

// Capabilities for A2A metadata filters. Source: docs/WEB_AI_CAPABILITIES.md.
const PROVIDER_CAPABILITIES = {
  gemini:   { vision: true,  webSearch: false, largeInput: false },
  glm:      { vision: true,  webSearch: false, largeInput: false },
  kimi:     { vision: true,  webSearch: false, largeInput: false },
  meta:     { vision: true,  webSearch: false, largeInput: false },
  arena:    { vision: true,  webSearch: false, largeInput: true },
  chatgpt:  { vision: false, webSearch: true,  largeInput: false },
  claude:   { vision: false, webSearch: false, largeInput: false },
  grok:     { vision: false, webSearch: true,  largeInput: false },
  mistral:  { vision: false, webSearch: true,  largeInput: false },
  rudder:   { vision: false, webSearch: false, largeInput: false },
  ptero:    { vision: false, webSearch: false, largeInput: false },
  // Vision is a per-model DOM getter in the content script, unknowable here.
  deepseek: { vision: false, webSearch: true,  largeInput: true },
  qwen:     { vision: false, webSearch: false, largeInput: true },
  manus:    { vision: false, webSearch: false, largeInput: false },
};

// ── usage-limit aware routing ──────────────────────────────────────────────
// A provider that reports a quota / rate-limit / free-tier block is sidelined
// for one cooldown window. The static ladder then falls through to the next
// open tab instead of sending every later task into the same dead provider.
// An explicit `provider` pin still wins: callers that test a specific site
// must be able to see its limit message for themselves.
const LIMIT_RE = /(quota|rate.?limit|rate limited|too many requests|free tier|free allowance|limit reached|usage limit|daily limit|hourly limit|token limit|per hour|1,000,000|try again in|resets? (?:in|at)|captcha|sign in to continue)/i;
const LIMIT_COOLDOWN_MS = 60 * 60 * 1000;
const limitedUntil = new Map(); // provider -> epoch ms

function markProviderLimited(provider, error) {
  if (!provider || !LIMIT_RE.test(String(error || ""))) return false;
  limitedUntil.set(provider, Date.now() + LIMIT_COOLDOWN_MS);
  try {
    const plain = Object.fromEntries(limitedUntil);
    const stored = chrome.storage.local.set({ limitedUntil: plain });
    if (stored && typeof stored.catch === "function") stored.catch(() => {});
  } catch (e) { /* storage unavailable: in-memory cooldown still applies */ }
  return true;
}

function isProviderLimited(provider, now = Date.now()) {
  const until = limitedUntil.get(provider) || 0;
  if (until <= now) { limitedUntil.delete(provider); return false; }
  return true;
}

// Hydrate the cooldown across MV3 worker evictions (best effort: routing works
// without it, it just forgets recent limits after a restart).
try {
  const got = chrome.storage.local.get("limitedUntil", (r) => {
    const saved = r && r.limitedUntil;
    if (saved && typeof saved === "object") {
      for (const [k, v] of Object.entries(saved)) {
        if (typeof v === "number" && v > Date.now()) limitedUntil.set(k, v);
      }
    }
  });
  if (got && typeof got.then === "function") {
    got.then((r) => {
      const saved = r && r.limitedUntil;
      if (saved && typeof saved === "object") {
        for (const [k, v] of Object.entries(saved)) {
          if (typeof v === "number" && v > Date.now()) limitedUntil.set(k, v);
        }
      }
    }).catch(() => {});
  }
} catch (e) { /* no storage in this context */ }

function routeFor(metadata) {
  const m = metadata && typeof metadata === "object" ? metadata : {};
  // Explicit pin first: one provider, no fallback chain. Used by callers that
  // need a specific site (an A/B comparison, or a provider the harness knows is
  // free), and by the live test harness to reach each provider in turn.
  const pinned = String(m.provider || "").toLowerCase();
  const tier = String(m.modelTier || "").toLowerCase();
  const category = String(m.taskCategory || "").toLowerCase();
  const complexity = String(m.complexity || "").toLowerCase();
  // Base chain: pin > modelTier > category > complexity. Same as before.
  let baseRoute = null;
  if (PROVIDER_HOSTS[pinned]) baseRoute = { tier: "pinned", providers: [pinned] };
  else if (TIER_PROVIDERS[tier]) baseRoute = { tier, providers: TIER_PROVIDERS[tier] };
  else if (CATEGORY_PROVIDERS[category]) {
    baseRoute = { tier: CATEGORY_TIER[category] || "balanced", providers: CATEGORY_PROVIDERS[category] };
  } else {
    const derived = COMPLEXITY_TIER[complexity] || CATEGORY_TIER[category];
    if (derived) baseRoute = { tier: derived, providers: TIER_PROVIDERS[derived] };
  }
  if (!baseRoute) return null;

  // Sidelining happens BEFORE capability filters so the shortened chain is the
  // one capability filtering operates on. If every provider in the chain is
  // limited, keep the original chain: a visible limit message beats silence.
  if (baseRoute.tier !== "pinned") {
    const available = baseRoute.providers.filter((id) => !isProviderLimited(id));
    if (available.length) baseRoute = { ...baseRoute, providers: available };
  }

  const needsVision = m.needsVision === true;
  const needsWeb = m.needsWeb === true;
  const largeInput = m.largeInput === true;
  const avoid = m.avoidProviders;
  const hasAvoid = Array.isArray(avoid) && avoid.length > 0;
  if (!needsVision && !needsWeb && !largeInput && !hasAvoid) return withTabTarget(baseRoute, m);

  const avoided = new Set(hasAvoid ? avoid.map((id) => String(id).toLowerCase()) : []);
  const baseProviders = baseRoute.providers;
  const filtered = baseProviders.filter((id) => {
    const caps = PROVIDER_CAPABILITIES[id] || {};
    if (needsVision && caps.vision !== true) return false;
    if (needsWeb && caps.webSearch !== true) return false;
    if (largeInput && caps.largeInput !== true) return false;
    if (avoided.has(id)) return false;
    return true;
  });
  if (filtered.length === 0) {
    return withTabTarget({ ...baseRoute, providers: baseProviders, capabilityFallback: true }, m);
  }
  return withTabTarget({ ...baseRoute, providers: filtered }, m);
}

function withTabTarget(route, meta) {
  if (!route) return null;
  const tabId = typeof meta.tabId === "number" ? meta.tabId : null;
  const tabUrl = typeof meta.tabUrl === "string" ? meta.tabUrl.trim() : "";
  if (tabId === null && !tabUrl) return route;
  return {
    ...route,
    ...(tabId !== null ? { tabId } : {}),
    ...(tabUrl ? { tabUrl } : {}),
  };
}

// The only place a provider tab is chosen from a route. Returns null when no
// preferred provider is open so the caller can fall back to today's behaviour.
function tabForRoute(tabs, route) {
  if (!route) return null;
  for (const provider of route.providers) {
    const hosts = PROVIDER_HOSTS[provider] || [];
    const hits = tabs.filter((t) => hosts.some((h) => String(t.url || "").includes(h)));
    if (!hits.length) continue;
    if (typeof route.tabId === "number") {
      const byId = hits.find((t) => t.id === route.tabId);
      if (byId) return byId;
    }
    if (route.tabUrl) {
      const byUrl = hits.find((t) => String(t.url || "").includes(route.tabUrl));
      if (byUrl) return byUrl;
    }
    return hits.find((t) => t.active) || hits[0];
  }
  return null;
}

const RECONNECT_MIN = 1000;
const RECONNECT_MAX = 5000;
// Jitter spreads simultaneous re-dials from many workers/tabs so a bridge that
// just came back is not hit by a synchronised burst. Half-jitter keeps the
// first retry inside the 1.6 s window the reconnect tests rely on.
const RECONNECT_JITTER = 0.2;
// A malformed or oversized frame must never be handed to JSON.parse: the
// bridge may send project data, and a broken/giant payload would block the
// worker or blow memory without ever reaching a handler.
const MAX_FRAME_CHARS = 2 * 1024 * 1024;
// Heartbeat is driven by the MV3 chrome.alarms "zs-keepalive" (30s) alarm.
// If no message (incl. pong) arrives within this window while we believe we're
// connected, the socket is half-open: force a reconnect instead of letting
// pending requests slowly time out. Kept at 60s so a very large frame in flight
// (big project data) does not delay the pong past the limit and cause a false
// reconnect. Must stay below the bridge ping_timeout (90s).
const STALE_SOCKET_MS = 60000;
const REQUEST_TIMEOUT_DEFAULT = 130000; // a bit above the 120s tool timeout
// Cheap probe types (liveness pings, status reads) must not inherit the full
// tool budget: a local bridge answers in single-digit milliseconds, so waiting
// two minutes for a ping only delays the "offline" report the UI needs.
//
// MEASURED on a live bridge (v3.9.4, port 17613, 16 Nov 2026), including the
// worst case of a target server that is NOT connected:
//
//   ping              0.4 ms     list_tools                   2.3 ms (0.8 ms again)
//   get_tools         0.4 ms     get_tools(roblox, offline)   0.3 ms
//   capabilities      0.3 ms     studio_status               46.3 ms (0.2 ms again)
//   list_mcp_servers  0.8 ms     get_servers                  0.5 ms
//
// The slowest observed answer is one cold studio_status at 46 ms - three orders
// of magnitude below the 6000 ms cap. A false timeout therefore needs a bridge
// that is genuinely stuck, which is exactly what the cap is meant to surface.
const FAST_TIMEOUT = 6000;
// Probes the bridge answers instantly (single-digit ms on a healthy local
// socket). They must not inherit the full tool budget, otherwise the loop sits
// waiting two minutes just to learn the bridge is offline.
const FAST_TYPES = new Set([
  "ping", "studio_status", "list_mcp_servers", "get_servers",
  "list_tools", "get_tools", "capabilities",
]);
// How long to wait for a socket that is not open before declaring it offline.
// The reconnect ceiling is 2s and connecting to a LOCAL socket takes a few ms,
// so a healthy bridge reconnects well inside this window; waiting longer is
// exactly the "bridge is unreachable" delay users complained about.
//
// DELIBERATELY shorter than the 4314 ms measured for a socket that was MID-
// RECONNECT: the first probe is expected to lose that race, and runTool's
// preflight allows one more attempt.
//
// Be precise about what the two attempts cover. The 8000 ms in the preflight is
// only the RACE timeout around bg({type:"ping"}); the second ping still waits at
// most CONNECT_WAIT_MS (2.5 s) for the socket itself. So the two attempts spend
// roughly 2 x 2.5 s = 5 s waiting on the connection, which is what makes the
// measured 4.3 s case land on the retry. Without the retry, blocking the FIRST
// attempt for 4.3 s would tax every ordinary cold start to cover a case the
// second attempt already handles.
const CONNECT_WAIT_MS = 2500;

let ws = null;
let connected = false;
let authRequired = false; // bridge closed us with 1008: token missing or wrong
let rotatingToken = false; // bridge closed us with 1012: token changed, reconnecting
let bridgeToken = null; // cached chrome.storage value; null = not read yet
let connecting = false;
let reconnectDelay = RECONNECT_MIN;
let reconnectTimer = null;
const connectionWaiters = new Set();
let lastMessageAt = 0; // timestamp of the last frame received from the bridge
let nextId = 1;
const pending = new Map(); // id -> {resolve, timer}
let toolsCache = [];
let mcpAlive = false;
let serversCache = [];
let bridgeVersion = null;
// Last get_bridge_status payload from the bridge (sanitized: no log_tail
// contents, see refreshBridgeStatus). null = old bridge or not fetched yet.
let bridgeStatusCache = null;
let bridgeStatusAt = 0; // Date.now() of the last successful fetch
// true/false = a PLACE is loaded and usable in Roblox Studio; null = unknown.
// The MCP process stays alive when Studio is closed or its MCP option is off,
// so this is probed separately (bridge "studio_status").
let studioConnected = null;
// true/false = a Roblox Studio app is connected to the MCP server at all; null =
// unknown. studioApp=true with studioConnected=false means "Studio open but no
// place"; studioApp=false means "Studio closed OR its MCP option disabled".
let studioApp = null;
// true/false = a Roblox Studio WINDOW/PROCESS exists on this machine (checked
// bridge-side via tasklist); null = unknown/old bridge. Distinguishes the two
// studioApp=false sub-cases the UI must word differently: Studio genuinely not
// launched ("open Roblox Studio") vs Studio OPEN but its MCP plugin never
// registered with the bridge - the documented fix for the latter is opening
// Assistant Settings > MCP Servers inside Studio (validated live 3x), which
// "open Roblox Studio" wording completely fails to convey.
let studioProc = null;

function log(...a) {
  console.log("[zs-bg]", ...a);
}

// chrome.* has both callback and promise shapes across MV3 versions and test
// stubs. Consume lastError and swallow rejections so a closed tab or an
// invalidated context can never surface as an unhandled rejection.
function sendToRuntime(msg) {
  try {
    const p = chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError);
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch {}
}
function sendToTab(tabId, msg) {
  try {
    const p = chrome.tabs.sendMessage(tabId, msg, () => void chrome.runtime.lastError);
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch {}
}
function storageSet(obj) {
  try {
    const p = chrome.storage.local.set(obj);
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch {}
}
function storageRemove(key) {
  try {
    const p = chrome.storage.local.remove(key);
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch {}
}

// ── WebSocket lifecycle ─────────────────────────────────────────────────
function readBridgeToken() {
  // Never leave connect() awaiting this: it holds the `connecting` guard, and a
  // callback that never fires (invalidated extension context) would then block
  // every future reconnect for the life of the worker. Fall back to "no token".
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(""), 2000);
    const done = (value) => { clearTimeout(timer); resolve(value || ""); };
    try {
      chrome.storage.local.get(TOKEN_KEY, (values) => {
        done(values && values[TOKEN_KEY]);
      });
    } catch {
      done("");
    }
  });
}

// The persisted pairing state, read once per worker start. Every dial waits on
// it: a worker wake-up can deliver a message (the tabs poll `status` every 5 s)
// before the storage read resolves, and without this the handler would see the
// default `authRequired = false` and redial a bridge that already refused us.
let lastUsage = null;
const authReady = new Promise((resolve) => {
  // Mirror readBridgeToken's timeout: a storage callback that never fires must
  // not block every future dial for the life of the worker. Clear the timeout
  // once the read lands so a long-lived worker carries no orphan timers.
  let settled = false;
  let timer = null;
  const finish = () => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    resolve();
  };
  timer = setTimeout(finish, 2000);
  try {
    chrome.storage.local.get([AUTH_STATE_KEY, "lastUsage"], (stored) => {
      authRequired = !!(stored && stored[AUTH_STATE_KEY]);
      lastUsage = (stored && stored.lastUsage) || null;
      finish();
    });
  } catch {
    finish();
  }
});

async function connect() {
  await authReady;
  if (authRequired) return; // parked: only the popup saving a token dials again
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  if (connecting) return;
  connecting = true;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  try {
    if (bridgeToken === null) bridgeToken = await readBridgeToken();
    const url = ZSPairing.bridgeUrl(URL, bridgeToken);
    ws = new WebSocket(url);
  } catch (e) {
    log("WebSocket ctor failed", e);
    scheduleReconnect();
    return;
  } finally {
    connecting = false;
  }

  ws.onopen = () => {
    connected = true;
    authRequired = false;
    storageRemove(AUTH_STATE_KEY); // the token is accepted again
    rotatingToken = false;
    reconnectDelay = RECONNECT_MIN;
    lastMessageAt = Date.now();
    log("connected to bridge");
    flushConnectionWaiters();
    broadcastStatus();
    refreshBridgeStatus();
  };

  ws.onmessage = (ev) => {
    lastMessageAt = Date.now();
    // Fail closed at the boundary: only bounded strings are parsed. Oversized
    // or non-string frames are dropped before they can stall the worker.
    if (!ev || typeof ev.data !== "string" || ev.data.length > MAX_FRAME_CHARS) return;
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    handleBridgeMessage(msg);
  };

  ws.onclose = (ev) => {
    connected = false;
    authRequired = ZSPairing.isAuthClose(ev);
    rotatingToken = ZSPairing.isRotationClose(ev);
    mcpAlive = false;
    studioConnected = null;
    studioApp = null;
    studioProc = null;
    serversCache = [];
    bridgeVersion = null;
    bridgeStatusCache = null;
    bridgeStatusAt = 0;
    failAllPending("bridge connection closed");
    broadcastStatus();
    // 1008 is the bridge refusing our token, and redialling just repeats the
    // refusal once a second until the popup saves a token. Park instead, and
    // remember it in storage so the pairing card survives a worker eviction.
    // Transient disconnects keep promptMeta intact so cancel_prompt and
    // a2a_result keep their tab/provider mapping across the bridge's 15s
    // reconnect grace window.
    if (authRequired) {
      promptMeta.clear();
      savePromptMeta();
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
      storageSet({ [AUTH_STATE_KEY]: true });
      return;
    }
    scheduleReconnect();
  };

  ws.onerror = () => {
    // onclose will follow; nothing to do here but avoid an unhandled error.
    try { ws.close(); } catch {}
  };
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  // Full-jittered exponential backoff with a hard cap. One timer owns all
  // wake-up sources (onclose, onerror, alarms, tab/popup activity), so a burst
  // of triggers can never stack overlapping dials.
  const factor = 1 + (Math.random() * 2 - 1) * RECONNECT_JITTER;
  const delay = Math.min(Math.max(1, Math.round(reconnectDelay * factor)), RECONNECT_MAX);
  reconnectDelay = Math.min(reconnectDelay * 1.7, RECONNECT_MAX);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect().catch(() => {});
  }, delay);
}

function flushConnectionWaiters() {
  for (const fn of [...connectionWaiters]) {
    connectionWaiters.delete(fn);
    try { fn(); } catch {}
  }
}

// Driven by the MV3 chrome.alarms "zs-keepalive" alarm (no setInterval).
function runHeartbeatTick() {
  if (!connected || !ws || ws.readyState !== WebSocket.OPEN) return;
  // Shared rule from core/guard.js: elapsed time alone is not proof of a dead
  // socket (an idle MV3 worker is suspended). Probe first, close only when no
  // pong arrives. The rule is imported, not copied, so tests pin what runs.
  const decision = (typeof ZSGuard !== "undefined" && ZSGuard.heartbeatDecision)
    ? ZSGuard.heartbeatDecision({ lastMessageAt, staleMs: STALE_SOCKET_MS })
    : { shouldProbe: false };
  if (decision.shouldProbe) {
    send({ type: "ping" }, 4000).then((pong) => {
      const answered = !!(pong && (pong.type === "pong" || pong.ok));
      const final = ZSGuard.heartbeatDecision({
        lastMessageAt, staleMs: STALE_SOCKET_MS, pongAnswered: answered,
      });
      if (final.close) {
        log("socket stale, forcing reconnect");
        try { ws.close(); } catch {}
      }
    }).catch(() => {
      const final = ZSGuard.heartbeatDecision({
        lastMessageAt, staleMs: STALE_SOCKET_MS, pongAnswered: false,
      });
      if (final.close) {
        log("socket stale, forcing reconnect");
        try { ws.close(); } catch {}
      }
    });
    return;
  }
  try { ws.send(JSON.stringify({ type: "ping", id: `ka-${Date.now()}` })); } catch {}
  if (lastMessageAt > 0) setTimeout(refreshStudioStatus, 0);
}

// Resolve once the socket is OPEN, or false after `timeout` ms (event-driven).
function waitForConnection(timeout = 8000) {
  if (connected && ws && ws.readyState === WebSocket.OPEN) return Promise.resolve(true);
  connect().catch(() => {}); // nudge a (re)connection - important after a worker wake-up
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      connectionWaiters.delete(onOpen);
      resolve(ok);
    };
    const onOpen = () => finish(true);
    const timer = setTimeout(() => finish(!!(connected && ws && ws.readyState === WebSocket.OPEN)), timeout);
    connectionWaiters.add(onOpen);
    if (connected && ws && ws.readyState === WebSocket.OPEN) finish(true);
  });
}

// ── request/response over the socket ────────────────────────────────────
async function send(obj, timeout = REQUEST_TIMEOUT_DEFAULT) {
  // The MV3 service worker can be suspended; the first message after a wake-up
  // arrives before the socket has re-opened. Wait for it instead of failing -
  // otherwise Kimi wrongly hears "bridge offline". Probe types fail fast so the
  // loop learns "offline" quickly instead of staring at a spinner; a real tool
  // run still waits the longer budget.
  const fast = FAST_TYPES.has(obj && obj.type);
  if (!connected || !ws || ws.readyState !== WebSocket.OPEN) {
    await waitForConnection(fast ? CONNECT_WAIT_MS : 8000);
  }
  return new Promise((resolve) => {
    if (!connected || !ws || ws.readyState !== WebSocket.OPEN) {
      resolve({ ok: false, kind: "disconnected", sent: false, error: "bridge not connected" });
      return;
    }
    const id = nextId++;
    const payload = { ...obj, id };
    // A probe the bridge answers in milliseconds must not inherit the full tool
    // budget; otherwise "offline" takes two minutes to surface.
    const effectiveTimeout = fast ? Math.min(timeout, FAST_TIMEOUT) : timeout;
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        resolve({ ok: false, kind: "timeout", error: "bridge did not respond in time" });
      }
    }, effectiveTimeout);
    pending.set(id, { resolve, timer, sent: false });
    try {
      ws.send(JSON.stringify(payload));
      // Past this line the bridge may already have executed the request. A
      // caller that retries has to know the difference: retrying a write_file
      // or a git_commit that did land would apply it twice.
      const entry = pending.get(id);
      if (entry) entry.sent = true;
    } catch (e) {
      clearTimeout(timer);
      pending.delete(id);
      resolve({ ok: false, kind: "disconnected", sent: false, error: String(e) });
    }
  });
}

// Ask the bridge whether a Roblox Studio instance is actually connected to the
// MCP server. Broadcasts only on change so the UI updates promptly but quietly.
let studioProbing = false;
async function refreshStudioStatus() {
  if (studioProbing || !connected) return;
  studioProbing = true;
  try {
    const r = await send({ type: "studio_status" }, 12000);
    const v = r && r.ok && typeof r.studio === "boolean" ? r.studio : null;
    if (v !== studioConnected) {
      studioConnected = v;
      broadcastStatus();
    }
  } finally {
    studioProbing = false;
  }
}

// Ask the bridge for its diagnostic snapshot (pid, RSS, restart attempts,
// uptime). The log_tail lines are dropped here: the popup needs counts and
// per-server health, not raw log text. An old bridge that does not know
// the request answers with an error frame, which resolvePending maps to
// ok:false - the cache simply stays null and the popup keeps its old UI.
let bridgeStatusProbing = false;
async function refreshBridgeStatus(force = false) {
  if (bridgeStatusProbing || !connected) return;
  if (!force && bridgeStatusCache && Date.now() - bridgeStatusAt < 5000) return;
  bridgeStatusProbing = true;
  try {
    const r = await send({ type: "get_bridge_status" }, 12000);
    if (r && r.ok && r.status && typeof r.status === "object") {
      const s = r.status;
      bridgeStatusCache = {
        bridge_version: s.bridge_version || null,
        uptime_seconds: typeof s.uptime_seconds === "number" ? s.uptime_seconds : null,
        clients_connected: typeof s.clients_connected === "number" ? s.clients_connected : null,
        tools_available: typeof s.tools_available === "number" ? s.tools_available : null,
        servers: Array.isArray(s.servers) ? s.servers.map((x) => ({
          id: String(x.id || "?"),
          alive: !!x.alive,
          ready: !!x.ready,
          tools: typeof x.tools === "number" ? x.tools : 0,
          pid: typeof x.pid === "number" ? x.pid : null,
          error: typeof x.error === "string" ? x.error.slice(0, 120) : null,
          restart_attempts: typeof x.restart_attempts === "number" ? x.restart_attempts : 0,
          next_restart_in_seconds: typeof x.next_restart_in_seconds === "number" ? x.next_restart_in_seconds : 0,
          rss_kib: typeof x.rss_kib === "number" ? x.rss_kib : null,
        })) : [],
        log_tail_lines: Array.isArray(s.log_tail) ? s.log_tail.length : 0,
      };
      bridgeStatusAt = Date.now();
      broadcastStatus();
    }
  } finally {
    bridgeStatusProbing = false;
  }
}

function handleBridgeMessage(msg) {
  // JSON.parse accepts "null", "42" and arrays; the `in`/property reads below
  // would throw on those and break the socket's message handler.
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;
  if ("studio" in msg && (typeof msg.studio === "boolean" || msg.studio === null)) {
    studioConnected = msg.studio;
  }
  if ("studio_app" in msg && (typeof msg.studio_app === "boolean" || msg.studio_app === null)) {
    studioApp = msg.studio_app;
  }
  if ("studio_proc" in msg && (typeof msg.studio_proc === "boolean" || msg.studio_proc === null)) {
    studioProc = msg.studio_proc;
  }
  if (msg.type === "studio_status") {
    resolvePending(msg.id, { ok: true, studio: studioConnected });
    broadcastStatus();
    return;
  }
  if (msg.type === "submit_prompt") {
    handleSubmitPrompt(msg);
    return;
  }
  if (msg.type === "cancel_prompt") {
    // The bridge hit its deadline. Tell the tab to stop generating, otherwise
    // the tab stays busy and refuses every later prompt until it is reloaded.
    cancelPrompt(msg.id).catch(() => {});
    return;
  }
  if (msg.type === "prompt_ack") {
    // Ack of OUR prompt_result send: clear its pending entry now instead of
    // waiting out the 15s request timeout.
    resolvePending(msg.id, { ok: true });
    return;
  }
  if (msg.type === "connected") {
    bridgeVersion = typeof msg.bridge_version === "string" ? msg.bridge_version : null;
    mcpAlive = !!msg.mcp_alive;
    if (Array.isArray(msg.tools)) toolsCache = msg.tools;
    if (Array.isArray(msg.servers)) serversCache = msg.servers;
    broadcastStatus();
    return;
  }
  if (msg.type === "bridge_status") {
    // send() resolves via resolvePending below; refreshBridgeStatus stores
    // the sanitized copy. This arm only feeds the pending request.
    resolvePending(msg.id, { ok: true, status: msg.status });
    return;
  }
  if (msg.type === "pong") {
    resolvePending(msg.id, { ok: true });
    return;
  }
  if (msg.type === "tools") {
    if (Array.isArray(msg.tools)) toolsCache = msg.tools;
    if (Array.isArray(msg.servers)) serversCache = msg.servers;
    mcpAlive = !!msg.mcp_alive;
    resolvePending(msg.id, { ok: true, tools: toolsCache });
    broadcastStatus();
    return;
  }
  if (msg.type === "tool_result") {
    resolvePending(msg.id, msg.ok
      ? { ok: true, text: msg.text, images: msg.images || [] }
      : { ok: false, kind: msg.kind, error: msg.error });
    return;
  }
  if (msg.type === "mcp_status") {
    mcpAlive = !!msg.alive;
    if (Array.isArray(msg.tools)) toolsCache = msg.tools;
    if (Array.isArray(msg.servers)) serversCache = msg.servers;
    resolvePending(msg.id, { ok: !!msg.ok, alive: msg.alive, error: msg.error });
    broadcastStatus();
    return;
  }
  if (msg.type === "token_rotated") {
    // The bridge answers with the new secret and only then drops the socket
    // (1012). Resolving here - before onclose can fail every pending request -
    // is what lets the worker store the token and reconnect with it instead of
    // retrying the old one into a 1008.
    resolvePending(msg.id, { ok: !!msg.ok, token: msg.token, error: msg.error });
    return;
  }
  if (msg.type === "server_changed") {
    // The bridge acks, then restarts itself to reload config.json. The socket
    // will drop right after this - the content script shows a spinner until the
    // reconnect lands and a fresh status arrives.
    resolvePending(msg.id, { ok: !!msg.ok, error: msg.error, restarting: !!msg.restarting });
    return;
  }
  if (msg.type === "error") {
    resolvePending(msg.id, { ok: false, error: msg.error });
    return;
  }
}

// Relay a bridge prompt to the active provider tab. Fire-and-forget: the
// content script answers later via an "a2a_result" runtime message. An MV3
// worker eviction between the two hops is expected and handled by reconnect.
// promptId -> { tabId, provider, tabUrl, route, started } persisted best-effort
// in chrome.storage.session so parallel providers and cancels survive worker
// restarts and transient WebSocket reconnects.
const PROMPT_META_KEY = "zsPromptMeta";
const PROMPT_META_TTL_MS = 2 * 60 * 60 * 1000;
const promptMeta = new Map();

function savePromptMeta() {
  const cutoff = Date.now() - PROMPT_META_TTL_MS;
  for (const [id, entry] of promptMeta) {
    if (entry && entry.started && entry.started < cutoff) promptMeta.delete(id);
  }
  while (promptMeta.size > 64) {
    const oldest = promptMeta.keys().next().value;
    promptMeta.delete(oldest);
  }
  try {
    const sess = typeof chrome !== "undefined" && chrome.storage && chrome.storage.session;
    if (sess && typeof sess.set === "function") {
      const p = sess.set({ [PROMPT_META_KEY]: [...promptMeta.entries()] });
      if (p && typeof p.catch === "function") p.catch(() => {});
    }
  } catch {}
}

const promptMetaReady = new Promise((resolve) => {
  let settled = false;
  let timer = null;
  const finish = () => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    resolve();
  };
  timer = setTimeout(finish, 500);
  try {
    const sess = typeof chrome !== "undefined" && chrome.storage && chrome.storage.session;
    if (!sess || typeof sess.get !== "function") { finish(); return; }
    const got = sess.get(PROMPT_META_KEY, (stored) => {
      const entries = stored && stored[PROMPT_META_KEY];
      if (Array.isArray(entries)) {
        const cutoff = Date.now() - PROMPT_META_TTL_MS;
        for (const pair of entries) {
          if (Array.isArray(pair) && pair[0] && pair[1] && (!pair[1].started || pair[1].started >= cutoff)) {
            if (!promptMeta.has(pair[0])) promptMeta.set(pair[0], pair[1]);
          }
        }
      }
      finish();
    });
    if (got && typeof got.then === "function") {
      got.then((stored) => {
        const entries = stored && stored[PROMPT_META_KEY];
        if (Array.isArray(entries)) {
          const cutoff = Date.now() - PROMPT_META_TTL_MS;
          for (const pair of entries) {
            if (Array.isArray(pair) && pair[0] && pair[1] && (!pair[1].started || pair[1].started >= cutoff)) {
              if (!promptMeta.has(pair[0])) promptMeta.set(pair[0], pair[1]);
            }
          }
        }
        finish();
      }).catch(finish);
    }
  } catch {
    finish();
  }
});

async function cancelPrompt(promptId) {
  if (!promptMeta.has(promptId)) await promptMetaReady;
  const meta = promptMeta.get(promptId);
  promptMeta.delete(promptId);
  savePromptMeta();
  const tabId = meta && meta.tabId;
  if (typeof tabId !== "number") return;
  try {
    chrome.tabs.sendMessage(tabId, { type: "zs-a2a-abort", promptId }, () => void chrome.runtime.lastError);
  } catch { /* tab is gone; nothing to cancel */ }
}

// DeepSeek unmounts virtualized turns when hidden, and Gemini's Angular streaming
// renderer pauses rAF stream-end cleanup while backgrounded (leaving stop/aria-busy wedged).
const NEEDS_VISIBLE_PROVIDERS = new Set(["deepseek", "gemini"]);

async function activateTab(tabId, settleMs = 250) {
  if (typeof tabId !== "number" || typeof chrome === "undefined" ||
      !chrome.tabs || typeof chrome.tabs.update !== "function") {
    return;
  }
  try {
    await new Promise((resolve) => {
      const maybePromise = chrome.tabs.update(tabId, { active: true }, () => {
        void (chrome.runtime && chrome.runtime.lastError);
        resolve();
      });
      if (maybePromise && typeof maybePromise.then === "function") {
        maybePromise.then(resolve, resolve);
      }
    });
  } catch {}
  if (settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs));
}

async function handleSubmitPrompt(msg) {
  const promptId = msg.id;
  const reply = (payload) => {
    const meta = promptMeta.get(promptId) || null;
    promptMeta.delete(promptId);
    savePromptMeta();
    return send({
      type: "prompt_result",
      prompt_id: promptId,
      ok: !!payload.ok,
      text: payload.text || "",
      error: payload.error || "",
      provider: meta ? meta.provider : "",
      tab_id: meta ? meta.tabId : null,
      tab_url: meta ? meta.tabUrl : "",
    }, 15000);
  };
  try {
    const route = routeFor(msg.metadata);
    let tabs;
    let tab;
    if (route) {
      tabs = await chrome.tabs.query({ url: PROVIDER_URLS });
      tab = tabForRoute(tabs, route);
    }
    if (!tab) {
      tabs = await chrome.tabs.query({ url: PROVIDER_URLS, active: true, lastFocusedWindow: true });
      if (!tabs.length) tabs = await chrome.tabs.query({ url: PROVIDER_URLS });
      tab = tabs.find((t) => t.active) || tabs[0];
    }
    if (!tab) { await reply({ ok: false, error: "No AI chat tab is open." }); return; }
    const provider = providerOf(tab.url);
    const tabUrl = String(tab.url || "");
    const routeTier = route ? route.tier : "auto";
    if (NEEDS_VISIBLE_PROVIDERS.has(provider) && !tab.active) {
      await activateTab(tab.id, 250);
    }
    promptMeta.set(promptId, { tabId: tab.id, provider, tabUrl, route: routeTier, started: Date.now() });
    savePromptMeta();
    setUsage({ provider, effort: routeTier, tokens: null, seconds: null, ok: null, started: Date.now() });
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({
          type: "prompt_routed",
          prompt_id: promptId,
          provider,
          tab_id: tab.id,
          tab_url: tabUrl,
          route: routeTier,
        }));
      } catch {}
    }
    // A tab that was JUST navigated races the content script's MV3 injection:
    // the first sendMessage can fail with "Receiving end does not exist" even
    // though the script lands a beat later (measured live: Claude after reload).
    // Retry briefly before declaring the tab dead.
    const m = msg.metadata && typeof msg.metadata === "object" ? msg.metadata : {};
    const model = String(m.model || m.geminiModel || "").trim();
    const thinking = String(m.thinking || m.thinkingLevel || "").trim();
    const preserveMode = m.preserveMode === true;
    const modeOpt = (model || thinking || preserveMode)
      ? { model, thinking, preserveMode }
      : null;
    const trySend = () => new Promise((resolve, reject) => {
      // Callback form: the content script answers LATER via an "a2a_result"
      // runtime message, so the channel closing is expected — not a failure
      // ("message port closed" resolves null and must NOT produce a reply).
      // Only "no receiver" is a real error, and it must not race the content
      // script's own reply.
      try {
        chrome.tabs.sendMessage(
          tab.id,
          {
            type: "zs-a2a-prompt",
            prompt: msg.prompt,
            promptId,
            route: route ? route.tier : null,
            ...(modeOpt ? { mode: modeOpt } : {}),
          },
          () => resolve(chrome.runtime.lastError || null)
        );
      } catch (e) {
        reject(e);
      }
    });
    let err = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, 1200));
      err = await trySend();
      if (!err || !/Receiving end|Could not establish/i.test(err.message || "")) break;
    }
    if (err && /Receiving end|Could not establish/i.test(err.message || "")) {
      await reply({ ok: false, error: "No Snapgent content script in the AI chat tab. Reload it." });
    }
  } catch (e) {
    await reply({ ok: false, error: String((e && e.message) || e) });
  }
}

function resolvePending(id, value) {
  const p = pending.get(id);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(id);
  p.resolve(value);
}

function failAllPending(reason) {
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    // `sent` tells the caller whether the frame left the extension. A request
    // still waiting on waitForConnection never reached the bridge, so it is
    // safe to re-send; one that had gone out may already have run.
    p.resolve({ ok: false, kind: "disconnected", sent: !!p.sent, error: reason });
  }
  pending.clear();
}

// ── status push to any open DeepSeek tab + popup ─────────────────────────
// Last A2A task, so the popup can show which model ran, at what effort, for how
// many tokens and how long. Kept in storage because the MV3 worker is evicted.
// (`lastUsage` itself is declared with the other worker state, above authReady.)
function setUsage(patch) {
  lastUsage = { ...(lastUsage || {}), ...patch, at: Date.now() };
  storageSet({ lastUsage });
  broadcastStatus();
}
function providerOf(url) {
  for (const [name, hosts] of Object.entries(PROVIDER_HOSTS)) {
    if (hosts.some((h) => String(url || "").includes(h))) return name;
  }
  return "";
}

function statusObj() {
  return { type: "zs-status", connected, authRequired, rotatingToken, savedToken: !!bridgeToken, mcpAlive, bridgeVersion, bridgeStatus: bridgeStatusCache, studio: studioConnected, studioApp, studioProc, tools: toolsCache.length, servers: serversCache, usage: lastUsage };
}

function broadcastStatus() {
  sendToRuntime(statusObj());
  try {
    chrome.tabs.query({ url: PROVIDER_URLS }, (tabs) => {
      for (const t of (tabs || [])) sendToTab(t.id, statusObj());
    });
  } catch {}
}

// ── tab lifecycle: drop state bound to dead or reloading tabs ─────────────
function forgetTab(tabId) {
  if (typeof tabId !== "number") return;
  let changed = false;
  for (const [id, meta] of promptMeta) {
    if (meta && meta.tabId === tabId) { promptMeta.delete(id); changed = true; }
  }
  if (changed) savePromptMeta();
}

if (typeof chrome !== "undefined" && chrome.tabs) {
  if (chrome.tabs.onRemoved && typeof chrome.tabs.onRemoved.addListener === "function") {
    chrome.tabs.onRemoved.addListener((tabId) => forgetTab(tabId));
  }
  if (chrome.tabs.onUpdated && typeof chrome.tabs.onUpdated.addListener === "function") {
    chrome.tabs.onUpdated.addListener((tabId, info) => {
      // A reload/navigation destroys the content script; a prompt bound to the
      // old document can never report its result.
      if (info && info.status === "loading") forgetTab(tabId);
    });
  }
  if (chrome.tabs.onActivated && typeof chrome.tabs.onActivated.addListener === "function") {
    chrome.tabs.onActivated.addListener(() => {
      // Cheap, stale-guarded refresh after a tab switch. connect() is guarded
      // against overlapping dials and stays parked on a 1008 refusal.
      refreshBridgeStatus();
      if (!connected && !authRequired) connect().catch(() => {});
    });
  }
}

// ── messages from content.js / popup.js ─────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case "status":
        // Self-heal after a worker wake-up, but never while parked on a refused
        // token: an open tab polls this every 5 s and would redial each time.
        if (!connected && !authRequired) connect().catch(() => {});
        else refreshBridgeStatus(); // stale-guarded (5 s), fire-and-forget
        if (bridgeToken === null) bridgeToken = await readBridgeToken();
        sendResponse(statusObj());
        break;
      case "bridge_status":
        await refreshBridgeStatus(true);
        break;
      // Liveness probe for the content script: a healthy bridge answers in
      // milliseconds. Without this case a ping fell through to "unknown
      // message", which callers read as a bridge outage.
      case "ping": {
        const r = await send({ type: "ping" }, FAST_TIMEOUT);
        sendResponse(r && (r.type === "pong" || r.ok)
          ? { ok: true }
          : { ok: false, kind: (r && r.kind) || "no_pong", error: (r && r.error) || "bridge did not answer the ping" });
        break;
      }
      case "list_tools": {
        // Prefer a live refresh; fall back to cache so the loop never stalls.
        // 10s, not 25s: a catalogue request only blocks this long when one of the
        // MCP servers is dead (typically Roblox in a degraded, Blender-only
        // session), and in that exact case we already hold a perfectly good cached
        // catalogue. Waiting the full 25s just froze the boot for no new data.
        const r = await send({ type: "list_tools" }, 10000);
        if (r.ok) sendResponse({ ok: true, tools: r.tools });
        else sendResponse({ ok: toolsCache.length > 0, tools: toolsCache, error: r.error });
        break;
      }
      case "call_tool": {
        const timeout = (msg.timeout || 120000) + 10000;
        const r = await send(
          { type: "call_tool", name: msg.name, arguments: msg.arguments, timeout: msg.timeout, server: msg.server, promptId: msg.promptId },
          timeout
        );
        sendResponse(r);
        break;
      }
      case "rotate_token": {
        // The bridge replies with the new token and then closes every authenticated
        // socket (1012), so it must be saved here before onclose fires: the
        // reconnect then dials in with the new value instead of asking to pair.
        const r = await send({ type: "rotate_token" }, 15000);
        if (r.ok && r.token) {
          bridgeToken = r.token;
          await new Promise((resolve) =>
            chrome.storage.local.set({ [TOKEN_KEY]: r.token }, resolve)
          );
          broadcastStatus();
        }
        sendResponse(r);
        break;
      }
      case "restart_mcp": {
        const r = await send({ type: "restart_mcp" }, 30000);
        sendResponse(r);
        break;
      }
      case "add_server": {
        const r = await send({
          type: "add_server", server_id: msg.server_id,
          command: msg.command, args: msg.args, env: msg.env,
        }, 15000);
        sendResponse(r);
        break;
      }
      case "remove_server": {
        const r = await send({ type: "remove_server", server_id: msg.server_id }, 15000);
        sendResponse(r);
        break;
      }
      case "a2a_result": {
        if (!promptMeta.has(msg.promptId)) await promptMetaReady;
        const meta = promptMeta.get(msg.promptId) || null;
        promptMeta.delete(msg.promptId);
        savePromptMeta();
        const provider = (meta && meta.provider) || (lastUsage && lastUsage.provider) || "";
        const started = (meta && meta.started) || (lastUsage && lastUsage.started) || null;
        setUsage({
          ...(provider ? { provider } : {}),
          ...(meta && meta.route ? { effort: meta.route } : {}),
          tokens: typeof msg.tokens === "number" ? msg.tokens : null,
          seconds: started ? Math.round((Date.now() - started) / 1000) : null,
          ok: !!msg.ok,
          error: msg.ok ? "" : String(msg.error || "").slice(0, 120),
        });
        if (!msg.ok) {
          markProviderLimited(provider, msg.error);
        }
        await send({
          type: "prompt_result",
          prompt_id: msg.promptId,
          ok: !!msg.ok,
          text: msg.text || "",
          error: msg.error || "",
          provider: meta ? meta.provider : "",
          tab_id: meta ? meta.tabId : null,
          tab_url: meta ? meta.tabUrl : "",
        }, 15000);
        sendResponse({ ok: true });
        break;
      }
      case "a2a_chunk": {
        if (msg.promptId && msg.text && ws && ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(JSON.stringify({
              type: "prompt_chunk",
              prompt_id: msg.promptId,
              text: String(msg.text),
            }));
          } catch {}
        }
        sendResponse({ ok: true });
        break;
      }
      case "reconnect":
        reconnectDelay = RECONNECT_MIN;
        authRequired = false; // the popup may have just saved a valid token
        storageRemove(AUTH_STATE_KEY);
        bridgeToken = null; // re-read: the popup may have just saved a token
        connect().catch(() => {});
        sendResponse({ ok: true });
        break;
      case "zs-wake-tab":
        if (sender && sender.tab && typeof sender.tab.id === "number") {
          await activateTab(sender.tab.id, 0);
        }
        sendResponse({ ok: true });
        break;
      default:
        sendResponse({ ok: false, error: "unknown message" });
    }
  })().catch((error) => {
    // An async handler rejection must never become an unhandled promise; the
    // caller still needs a response so it cannot hang waiting for one.
    log("message handler failed", error);
    try { sendResponse({ ok: false, error: String((error && error.message) || error) }); } catch {}
  });
  return true; // async sendResponse
});

// Wake/keepalive hooks. connect() waits for the persisted pairing state and
// refuses to dial while parked, so these stay unconditional.
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);

// MV3 service-worker keepalive for long sessions (Brave suspends idle workers).
if (typeof chrome !== "undefined" && chrome.alarms) {
  try {
    chrome.alarms.create("zs-keepalive", { periodInMinutes: 0.5 });
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (!alarm || alarm.name !== "zs-keepalive") return;
      if (!connected && !authRequired) connect().catch(() => {});
      else runHeartbeatTick();
    });
  } catch {}
}

connect().catch(() => {});
