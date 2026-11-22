// Node smoke test for background.js (run: node test-background.js). Not shipped.
//
// Why this exists: the review of PR #3 asked for one specific guarantee that
// cannot be checked by reading the diff - a retried call_tool must never repeat
// a side effect that already happened. `send()` therefore reports whether the
// frame actually left the extension:
//
//   sent: false - it never reached the bridge (failed while waiting for the
//                 socket, or ws.send threw), so re-sending is safe.
//   sent: true  - the frame went out; the bridge may have executed the tool,
//                 so the caller must NOT silently retry a write.
//
// These tests drive the REAL send()/failAllPending() against a stub WebSocket,
// so the behaviour is pinned to the code that ships rather than a copy of it.
const fs = require("fs");

const ok = (name, cond) => {
  console.log((cond ? "PASS" : "FAIL") + "  " + name);
  if (!cond) process.exitCode = 1;
};

// ── Minimal chrome + WebSocket stubs ───────────────────────────────────────
const listeners = [];
const createdAlarms = [];
const alarmListeners = [];
const noEvent = { addListener: () => {} };
global.chrome = {
  runtime: {
    onMessage: { addListener: (fn) => listeners.push(fn) },
    onStartup: noEvent,
    onInstalled: noEvent,
    sendMessage: () => Promise.resolve(),
  },
  tabs: { query: (_f, cb) => cb && cb([]), sendMessage: () => Promise.resolve() },
  storage: { local: { get: (_k, cb) => cb && cb({}), set: () => {} } },
  alarms: {
    create: (name, info) => createdAlarms.push({ name, info }),
    onAlarm: { addListener: (fn) => alarmListeners.push(fn) },
    clear: () => {},
  },
};

// A WebSocket that never opens and never delivers: lets us exercise the
// "waiting for a connection" path deterministically.
class DeadSocket {
  static OPEN = 1;
  constructor() {
    this.readyState = 0;
    DeadSocket.last = this;
  }
  send() {
    throw new Error("send on a closed socket");
  }
  close() {}
  addEventListener() {}
}
global.WebSocket = DeadSocket;

// background.js runs as an IIFE-less module body; evaluate it and grab the
// internals we need through a trailing export hook.
//
// ZSGuard is injected here exactly as the worker gets it via importScripts, so
// the heartbeat in the test runs the same rule the service worker runs.
const guardSrc = fs.readFileSync(__dirname + "/core/guard.js", "utf8");
const ZSGuard = (0, eval)(guardSrc + "\n; ZSGuard;"); // NOSONAR test only: own local guard.js read from disk, no external input
// background.js loads core/pairing.js for the handshake URL and close
// classification; inject it here so no importScripts is needed in Node.
const pairingSrc = fs.readFileSync(__dirname + "/core/pairing.js", "utf8");
const ZSPairing = (0, eval)(pairingSrc + "\n; ZSPairing;"); // NOSONAR test only: own local pairing.js read from disk, no external input
const src = fs.readFileSync(__dirname + "/background.js", "utf8");
const internals = new Function( // NOSONAR test only: own local background.js read from disk, no external input
  "chrome",
  "WebSocket",
  "ZSGuard",
  "ZSPairing",
  src + "\n; return { send, failAllPending, pending, routeFor, markProviderLimited, isProviderLimited, setConnected: (v) => { connected = v; }, setWs: (w) => { ws = w; } };"
)(global.chrome, global.WebSocket, ZSGuard, ZSPairing);

const { send, failAllPending, pending, routeFor, markProviderLimited, isProviderLimited } = internals;

(async () => {
  // ── 1. Nothing connected: the request never left ─────────────────────────
  // waitForConnection runs for CONNECT_WAIT_MS, so keep this short by using a
  // fast probe type (CONNECT_WAIT_MS is 2500, well inside a test budget).
  {
    const t0 = Date.now();
    const r = await send({ type: "ping" }, 2000);
    ok("unconnected socket reports disconnected", r.ok === false && r.kind === "disconnected");
    ok("unconnected socket is NOT marked sent", r.sent === false);
    ok("the wait is bounded by CONNECT_WAIT_MS", Date.now() - t0 < 6000);
  }

  // ── 2. Frame went out, then the socket died ──────────────────────────────
  // This is the dangerous case: the bridge may already have run the tool.
  {
    const live = { readyState: 1, send: () => {}, close: () => {} };
    internals.setConnected(true);
    internals.setWs(live);
    const p = send({ type: "call_tool", name: "write_file", arguments: { path: "a.txt" } }, 5000);
    // Let send() register the pending entry before failing it.
    await new Promise((r) => setTimeout(r, 10));
    ok("a delivered request is pending", pending.size === 1);
    const [entry] = [...pending.values()];
    ok("the pending entry records that it was sent", entry.sent === true);
    failAllPending("connection lost");
    const r = await p;
    ok("dropped mid-flight reports disconnected", r.kind === "disconnected");
    ok("dropped mid-flight IS marked sent (no blind retry)", r.sent === true);
  }

  // ── 3. ws.send throws: nothing reached the bridge ────────────────────────
  {
    const throwing = {
      readyState: 1,
      send: () => { throw new Error("boom"); },
      close: () => {},
    };
    internals.setConnected(true);
    internals.setWs(throwing);
    const r = await send({ type: "call_tool", name: "list_dir", arguments: {} }, 5000);
    ok("a failed ws.send reports disconnected", r.kind === "disconnected");
    ok("a failed ws.send is NOT marked sent (safe to retry)", r.sent === false);
    ok("the failed entry is cleaned out of pending", pending.size === 0);
  }

  // ── 3b. Usage-limit aware routing ───────────────────────────────────────
  {
    ok("a plain error does not mark a provider limited",
      markProviderLimited("deepseek", "bridge offline") === false);
    ok("a rate-limit error marks the provider limited",
      markProviderLimited("deepseek", "429 Too Many Requests") === true);
    ok("limited provider is flagged",
      isProviderLimited("deepseek") === true);
    const routed = routeFor({ modelTier: "light" });
    ok("limited provider is dropped from the tier chain",
      routed && !routed.providers.includes("deepseek"));
    ok("another provider remains in the chain",
      routed && routed.providers.includes("gemini"));
    const pinned = routeFor({ provider: "deepseek" });
    ok("an explicit pin still reaches the limited provider",
      pinned && pinned.providers.length === 1 && pinned.providers[0] === "deepseek");
  }

  // ── 4. Ping has a real case in the dispatcher ────────────────────────────
  // Before the fix, bg({type:"ping"}) fell through to `default:` and answered
  // {ok:false,error:"unknown message"}, which every caller reads as "bridge
  // down" even though a manual ping answered in 1 ms.
  {
    ok("the dispatcher registered a listener", listeners.length > 0);
    const handler = listeners[0];
    const reply = await new Promise((resolve) => {
      // Bridge is disconnected: the honest answer is ok:false with a kind, NOT
      // an "unknown message" error from the default branch.
      handler({ type: "ping" }, {}, resolve);
      setTimeout(() => resolve({ timedOut: true }), 9000);
    });
    ok("ping is a known message type", !(reply && reply.error === "unknown message"));
    ok("ping answers a structured failure when the bridge is down",
      reply && (reply.ok === true || typeof reply.kind === "string"));
  }

  // ── 5. MV3 keepalive alarm (zs-keepalive, 30s) ───────────────────────────
  {
    const ka = createdAlarms.find((a) => a.name === "zs-keepalive");
    ok("zs-keepalive alarm is registered on startup", !!ka);
    ok("zs-keepalive alarm fires every 30 seconds (0.5 min)",
      ka && ka.info && ka.info.periodInMinutes === 0.5);
    ok("chrome.alarms.onAlarm listener is registered", alarmListeners.length > 0);
    const sent = [];
    const live = { readyState: 1, send: (s) => sent.push(JSON.parse(s)), close: () => {} };
    internals.setConnected(true);
    internals.setWs(live);
    alarmListeners[0]({ name: "unrelated" });
    ok("unrelated alarm does not send a keepalive ping", sent.length === 0);
    alarmListeners[0]({ name: "zs-keepalive" });
    ok("zs-keepalive alarm sends a ping frame when connected",
      sent.length === 1 && sent[0].type === "ping" && typeof sent[0].id === "string" && sent[0].id.startsWith("ka-"));
  }

  // ── 6. a2a_chunk forwarding to bridge ────────────────────────────────────
  {
    const handler = listeners[0];
    const sent = [];
    const live = { readyState: 1, send: (s) => sent.push(JSON.parse(s)), close: () => {} };
    internals.setConnected(true);
    internals.setWs(live);
    const reply = await new Promise((resolve) => {
      handler({ type: "a2a_chunk", promptId: "p-chunk-1", text: "hello delta" }, {}, resolve);
    });
    ok("a2a_chunk replies ok:true", reply && reply.ok === true);
    ok("a2a_chunk forwards a prompt_chunk frame to the bridge",
      sent.length === 1 &&
      sent[0].type === "prompt_chunk" &&
      sent[0].prompt_id === "p-chunk-1" &&
      sent[0].text === "hello delta");

    sent.length = 0;
    const emptyReply = await new Promise((resolve) => {
      handler({ type: "a2a_chunk", promptId: "p-chunk-1", text: "" }, {}, resolve);
    });
    ok("empty a2a_chunk still replies ok:true", emptyReply && emptyReply.ok === true);
    ok("empty a2a_chunk does not emit a bridge frame", sent.length === 0);
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
