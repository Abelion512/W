// SPDX-License-Identifier: GPL-3.0-or-later
// core/main.js - the provider-agnostic agentic loop, UI and session state.
// Drives any AI chat site through the ZSProvider interface (providers/*.js):
// waits for the model's reply, parses snapgentV3 commands (ZSParse), asks the
// background worker to execute them on the Roblox MCP bridge, and feeds the
// result back. Camouflages the system prompt ("Starting Up") and tool JSON
// behind animated chips, masks injected input, and exposes a Stop button.
// The model ALWAYS receives an output.
//
// This file must NEVER touch the host site's DOM directly - everything
// site-specific goes through P (the provider). Our OWN UI (panel, chips,
// banners…) is plain DOM we create ourselves and is allowed here.

(() => {
  "use strict";
  const P = ZSProvider;
  const T = P.timings;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (...a) => console.log("[snapgentV3]", ...a);
  // One owner for every global observer/listener this IIFE installs, so a
  // re-injected content script cannot leave a second copy observing the page.
  const disposers = [];
  function track(target, type, fn, opts) {
    if (!target || typeof target.addEventListener !== "function") return;
    target.addEventListener(type, fn, opts);
    disposers.push(() => {
      if (target && typeof target.removeEventListener === "function") {
        target.removeEventListener(type, fn, opts);
      }
    });
  }

  // ── Send pacing ──────────────────────────────────────────────────────────
  // Back-to-back sends land at near-identical intervals, which reads as a loop.
  // Vary each wait. Longer window on DeepSeek: that account was flagged.
  // Pacing is comfort, not a captcha or account-flag fix.
  const SEND_JITTER_MS = [400, 1400]; // [min, max] ms, randomized per send
  function jitterBeforeSend() {
    const [lo, hi] = P.id === "deepseek" ? [1500, 4000] : SEND_JITTER_MS;
    return sleep(lo + Math.random() * (hi - lo));
  }

  // ── Diagnostics ───────────────────────────────────────────────────────────
  // Persistent, lightweight breadcrumb log of the agentic loop's key decisions
  // (sends, response kinds, tool start/end, resumes, stops). Read back from the
  // console (filter "[zs-diag]"). Kept in this closure only: this code runs in
  // the extension's isolated world, but a DOM/global mirror would still expose
  // prompts to the host site.
  const ZS_DIAG_MAX = 300;
  const _diag = [];
  function diag(event, data) {
    const snap = { ...P.snapshot(), gen: P.isGenerating(), run: A.running };
    const e = { t: Date.now(), iso: new Date().toISOString().slice(11, 23), event,
                data: data || null, snap };
    _diag.push(e);
    if (_diag.length > ZS_DIAG_MAX) _diag.shift();
    try { console.log("[zs-diag]", e.iso, event, JSON.stringify({ ...data, ...snap })); } catch {}
  }
  P.init({ diag });

  // ── [TRACE] Main-thread stall detector ─────────────────────────────────────
  // The reported bug ("tools spin 15-20s, the chip timer stops rising") can only
  // be a SYNCHRONOUS block of the page's main thread: an async bridge/network wait
  // yields, so the 200ms UI interval (and its chip timer) would keep ticking. This
  // fires every 250ms and, whenever the ACTUAL gap since the last tick is far more
  // than expected, logs the stall. A `stall.detected` with a big `ms` right when
  // the user sees the freeze = the smoking gun; correlate its timestamp with the
  // surrounding diag events (esp. code.snapAll / dom.read.slow) to see WHAT ran.
  // Event-driven main-thread stall detector via PerformanceObserver (no setInterval).
  let perfObserver = null;
  if (typeof PerformanceObserver === "function") {
    try {
      const STALL = 800;
      perfObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration > STALL) {
            diag("stall.detected", { ms: Math.round(entry.duration), overBy: Math.round(entry.duration - STALL),
              toolRunning: A.toolRunning, running: A.running, injecting: A.injecting });
          }
        }
      });
      perfObserver.observe({ entryTypes: ["longtask"] });
    } catch {}
  }

  // GitHub releases page - where users download the Bridge + start.bat.
  const GITHUB_URL = "https://github.com/herdodp/snapgent-connector";
  // AI chat sites snapgentV3 works on. Keep in sync with manifest.json
  // content_scripts and background.js PROVIDER_URLS when adding a provider.
  const AI_SITES = [
    // { name: "DeepSeek", url: "https://chat.deepseek.com/" }, // hidden from UI bar (disabled, not deleted)
    { name: "ChatGPT", url: "https://chatgpt.com/" },
    { name: "Claude", url: "https://claude.ai/new" },
    { name: "Gemini", url: "https://gemini.google.com/app" },
    { name: "Kimi", url: "https://www.kimi.ai/" },
    { name: "GLM", url: "https://chat.z.ai/" },
    { name: "Qwen", url: "https://chat.qwen.ai/" },
    { name: "Arena", url: "https://arena.ai/chat" },
    { name: "Meta AI", url: "https://www.meta.ai/" },
    { name: "Ptero", url: "https://ptero.pro/" },
    { name: "Grok", url: "https://grok.com/" },
    { name: "Mistral", url: "https://chat.mistral.ai/code" },
    { name: "Rudder", url: "https://rudder.chat/chat" },
  ];
  const TARGET_STORAGE_KEY = "zsSelectedMcpTarget";

  // ── Background (multi-tab) sessions ─────────────────────────────────────
  // By default a session PARKS while its tab is hidden (see waitVisible): a
  // hidden tab has no layout, so the first reads after unhide can come back
  // stale and the agent loop must not act on them. That is the right default for
  // a single session, but it also means that with several chats open only ONE
  // of them can make progress - the others sit on "Paused · open this tab"
  // indefinitely (user-reported).
  //
  // Opting in lets a hidden tab keep its session alive. It is deliberately NOT
  // the default: reading a hidden tab is the stale-DOM case the parking was
  // built for, so it must be an explicit choice. Off = previous behaviour,
  // byte for byte.
  const BACKGROUND_SESSIONS_KEY = "zsBackgroundSessions";
  let backgroundSessions = false;
  const backgroundSessionsLoaded = new Promise((resolve) => {
    try {
      chrome.storage.local.get(BACKGROUND_SESSIONS_KEY, (result) => {
        const saved = result && result[BACKGROUND_SESSIONS_KEY];
        if (saved === true) backgroundSessions = true;
        resolve();
      });
    } catch (error) {
      console.warn("[snapgentV3] Could not load background-session setting:", error);
      resolve();
    }
  });
  // Awaitable so a session that starts right after load does not race the flag.
  async function backgroundSessionsReady() {
    await backgroundSessionsLoaded;
    return backgroundSessions;
  }
  // Writer for the flag: without this the setting could only be flipped by
  // hand-editing chrome.storage.local in DevTools, so the multi-tab feature was
  // unreachable for users. Kept in memory too, so a toggle takes effect on the
  // NEXT waitVisible() of a running session without a page reload.
  function setBackgroundSessions(on) {
    backgroundSessions = on === true;
    try {
      chrome.storage.local.set({ [BACKGROUND_SESSIONS_KEY]: backgroundSessions }, () => {
        // Chrome reports storage failures through lastError, not a throw.
        const error = chrome.runtime && chrome.runtime.lastError;
        if (error) diag("backgroundSessions.persistFailed", { message: error.message || String(error) });
      });
    } catch (error) {
      diag("backgroundSessions.persistFailed", { message: String(error) });
    }
    return backgroundSessions;
  }

  let selectedTargetId = "vscode";
  try {
    chrome.storage.local.get(TARGET_STORAGE_KEY, (result) => {
      const saved = result && result[TARGET_STORAGE_KEY];
      if (typeof saved === "string" && saved) {
        selectedTargetId = saved;
        refreshActiveToolNames();
        if (ui.setTarget) {
          ui.setTarget(saved);
          bg({ type: "status" }).then((status) => status && ui.setStatus(status));
        }
      }
    });
  } catch (error) {
    console.warn("[snapgentV3] Could not load selected MCP target:", error);
  }

  // ── MCP enable/disable toggles ──────────────────────────────────────────
  // Persisted map { serverId: boolean }. A server that was never toggled counts
  // as enabled. Disabled servers are hidden from the target dropdown AND are
  // filtered out of everything the AI reads (tool lists, list_mcp_servers,
  // list_commands) so their tool schemas never cost tokens.
  const MCP_ENABLED_KEY = "zsMcpEnabled";
  let mcpEnabled = {};
  try {
    chrome.storage.local.get(MCP_ENABLED_KEY, (result) => {
      const saved = result && result[MCP_ENABLED_KEY];
      if (saved && typeof saved === "object" && !Array.isArray(saved)) {
        mcpEnabled = saved;
        if (typeof ui !== "undefined" && ui.setTarget) ui.setTarget(selectedTargetId);
      }
    });
  } catch (error) {
    console.warn("[snapgentV3] Could not load MCP toggles:", error);
  }
  function isMcpEnabled(id) {
    return mcpEnabled[id] !== false;
  }
  function setMcpEnabled(id, on) {
    mcpEnabled = { ...mcpEnabled, [id]: !!on };
    try { chrome.storage.local.set({ [MCP_ENABLED_KEY]: mcpEnabled }); } catch {}
  }

  const stopListeners = new Set();
  function onStop(fn) {
    stopListeners.add(fn);
    return () => stopListeners.delete(fn);
  }
  let _stopFlag = false;
  const A = {
    running: false,
    get stop() { return _stopFlag; },
    set stop(v) {
      const next = !!v;
      _stopFlag = next;
      if (next) {
        for (const fn of [...stopListeners]) { try { fn(); } catch {} }
      }
    },
    // stopping: the user clicked Stop and we are winding the loop down. Set the
    // instant the button is clicked so the bar can show immediate "Stopping…"
    // feedback and keep the button steady (no flicker) until the loop's finally
    // clears it - the live generation signal toggles off/on as the loop drains,
    // which otherwise made the Stop button vanish then reappear.
    stopping: false,
    // held: a command is parked waiting for the scroll window to lapse (see
    // waitScrollWindow). The Stop control must stay visible while it is set:
    // scrollSuppressed() hides the button for the very same reason the command
    // is being held, so without this the user would have no way to cancel.
    held: false,
    // userStopped: the user deliberately halted generation - via our "■ Stop"
    // button OR the site's native stop. While set, the auto-resume watchdog
    // must NOT relaunch or re-run a tool from the halted turn.
    userStopped: false,
    // lastGenAt: timestamp of the last moment the site was actively generating.
    // The auto-resume watchdog only acts on a tool call from a RECENT live
    // generation - never on a historical turn rendered by opening/scrolling.
    lastGenAt: 0,
    started: false,
    starting: false,
    // Why the last bootstrap refused the session (set by startSession, read by
    // runA2APrompt). Without it an A2A caller got the bare "could not start a
    // session" with no reason, so a site's own "Free tier limit reached" never
    // reached the matrix and a limit looked like a broken provider.
    lastStartFailure: "",
    // The conversation a bootstrap belongs to + a generation counter. If the user
    // navigates to another chat mid/post-bootstrap, syncSessionState bumps the
    // counter (invalidating the in-flight startSession) and clears `starting`, so
    // the new chat shows its own state instead of a stale "Starting…".
    startingKey: null,
    startGen: 0,
    // The conversation a RUNNING loop is bound to. If the user opens a new, empty
    // chat via the site's own button, syncSessionState abandons the loop so the
    // fresh chat shows "Start", not a stale "Agent active".
    loopKey: null,
    // Identity of the assistant turn ALREADY present when the current session
    // started. A page reload can RESTORE an in-progress generation (e.g. an
    // execute_luau that was mid-stream in an A/B turn); that restored turn looks
    // like a fresh live tool finish to the auto-resume watchdog, which then ran it
    // into the NEW conversation the user had just opened (validated live, 2026-06).
    // autoResume never resumes the turn whose id matches this baseline.
    bootBaselineId: null,
    injecting: false,
    toolRunning: false,
    toolStart: 0,
    toolName: "",
    toolItem: null,
    toolArg: "",
    toolList: [],
    toolNames: new Set(),
    // Successful tool calls since the last command-list reminder. DeepSeek (and
    // others) can drift away from the exact command names over a long session,
    // so we re-inject the list every REMIND_TOOLS_EVERY calls (see agentLoop).
    toolCallsSinceReminder: 0,
    // When the system prompt was last re-stated. Diagnostic only - whether one
    // is OWED is derived from the conversation itself, never from a counter
    // (see sinceLastSys / sysResendDue).
    sysResendAt: 0,
    // This page outlived its extension build - nothing works until a reload.
    // Latched (never cleared): the context cannot come back. See bg().
    staleExtension: false,
    bridge: { connected: false, mcpAlive: false, tools: 0 },
    // Images from the most recent tool result, stashed by runTool for the
    // upcoming submitAndGetBase/typeAndSend call to attach as the LAST step
    // before sending (see the comment in runTool's r.images branch).
    pendingImages: null,
    // BARE names of tools observed to return images at least once this session.
    // For the KNOWN Roblox vision tool (screen_capture) toolCategory already
    // gives the "screen" chip optimistically at run time; a custom MCP tool's
    // name tells us nothing, so we can't predict it - but once we've SEEN it
    // return an image we can be optimistic on its NEXT call. Populated in the
    // agent loop's result branch when A.pendingImages lands.
    imageTools: new Set(),
    // True while the loop is parked waiting for this tab to come back to the
    // foreground (see waitVisible/parkHidden). Drives the bar's "Paused" state.
    parked: false,
    // Timestamp of the last successful tool-catalogue refresh (see ensureTools).
    toolsAt: 0,
  };

  const a2a = ZSA2ARunner.createRunner({
    provider: P,
    state: A,
    sleep,
    diag,
    startSession: (modeOpts) => startSession(modeOpts),
    submitAndGetBase: (text, images) => submitAndGetBase(text, images),
    agentLoop: (base) => agentLoop(base),
    syncSessionState: () => syncSessionState(),
  });

  const {
    waitFor,
    waitVisible,
    parkHidden,
    captureSendToken,
    submitAndGetBase,
    waitForResponse,
  } = ZSDomEngine.createDomEngine({
    provider: P,
    timings: T,
    state: A,
    a2a,
    sleep,
    diag,
    log,
    getUi: () => ui,
    onStop,
    jitterBeforeSend: () => jitterBeforeSend(),
    backgroundSessionsReady: () => backgroundSessionsReady(),
    scrollSuppressed: () => scrollSuppressed(),
    bareToolName: (name) => bareToolName(name),
    knownTool: (name) => knownTool(name),
    preHideWholeItems: () => preHideWholeItems(),
    scheduleSweep: () => scheduleSweep(),
  });

  // ════════════════════════════════════════════════════════════════════════
  //  TOOL EXECUTION  (always returns a feedback string for the model)
  // ════════════════════════════════════════════════════════════════════════
  // An ORPHANED content script: the extension was reloaded, updated or disabled
  // while this page stayed open, so the script still running here belongs to a
  // version of the extension that no longer exists. Chrome tears down its
  // messaging port, and every chrome.runtime call then fails INSTANTLY with
  // "Extension context invalidated".
  //
  // This must be told apart from a real bridge outage. They are opposite
  // problems with opposite fixes: a bridge outage is fixed by start.bat and
  // resolves itself, while this one can ONLY be fixed by reloading the page and
  // never recovers on its own. Lumping them together (the old behaviour) told
  // the model "the local snapgentV3 bridge is unreachable", which sent the user
  // to check a bridge that was perfectly healthy. Diagnosed 2026-08-14 by the
  // giveaway timing: a genuine outage takes 8s (background.js `send` waits via
  // waitForConnection first), an invalidated context comes back in ~1ms.
  //
  // Every user meets this eventually - Chrome auto-updates extensions under
  // open tabs - so it is worth its own message.
  const isContextInvalidated = ZSChannel.isContextInvalidated;
  const bg = (msg) => {
    if (msg && msg.type === "call_tool" && !msg.promptId) {
      const current = a2a && a2a.getCurrentId && a2a.getCurrentId();
      if (current) msg = { ...msg, promptId: current };
    }
    return ZSChannel.send(msg);
  };

  // 'subagent' is always blocked (long-running, hangs the loop). 'screen_capture'
  // is only blocked on providers whose underlying model can't see images
  // (P.supportsVision === false) - see providers/*.js for the per-site flag.
  // Both are filtered out of the advertised command list AND refused in runTool.
  // Addon servers (Blender, Sketchfab, ...) can ALSO ship an image-returning
  // tool under any name we don't know in advance - rather than guess names,
  // any tool result carrying images is caught generically at the point results
  // are handled (see the `r.images.length` branch) and turned into a plain
  // error on non-vision providers, so nothing needs to be predicted here.
  const ALWAYS_BLOCKED_TOOLS = new Set(["subagent"]);
  const VISION_TOOLS = new Set(["screen_capture"]);
  const bareToolName = (name) => (name && name.includes("/") ? name.split("/").pop() : name) || "";
  // Is `name` a tool we actually have? The bridge ADVERTISES names that may carry
  // a per-server prefix when two MCP servers expose the same tool (see
  // list_tools in bridge.py), while the model always writes the bare name - so a
  // plain `A.toolNames.has(bare)` misses, and so does bareToolName(bare), which
  // cannot re-add a prefix it never had. Compare bare-to-bare in BOTH directions.
  const bareKey = (n) => String(n || "").split("/").pop().split(".").pop();
  function knownTool(name) {
    if (!name || !A.toolNames.size) return false;
    if (A.toolNames.has(name) || A.toolNames.has(bareToolName(name))) return true;
    const b = bareKey(name);
    for (const t of A.toolNames) if (bareKey(t) === b) return true;
    return false;
  }
  const isBlockedTool = (name) => {
    const bare = bareToolName(name);
    if (ALWAYS_BLOCKED_TOOLS.has(bare)) return true;
    if (VISION_TOOLS.has(bare) && !P.supportsVision) return true;
    return false;
  };

  // ── Learned image tools (reload-proof "screen" chip) ──────────────────────
  // The known Roblox vision tool (screen_capture) is themed "screen" by name via
  // ZS.toolCategory. A custom MCP tool's NAME reveals nothing, so we learn which
  // ones return images and persist that across reloads: with it, a revisited or
  // reloaded conversation still shows the image-capture chip (not the generic
  // wrench), and the NEXT call of a known image tool is optimistic from the start.
  // The marker below is the exact tail runTool appends to a feedback that carries
  // an image (see runTool's r.images branch) - the reload-proof signal, readable
  // straight from the injected result turn's text even when no loop is running.
  const IMAGE_FEEDBACK_RE = /image is attached to THIS message/i;
  function rememberImageTool(name) {
    const bare = bareToolName(name);
    if (!bare || A.imageTools.has(bare)) return;
    A.imageTools.add(bare);
    diag("imageTool.remember", { name: bare, total: A.imageTools.size });
    try { chrome.storage.local.set({ zsImageTools: [...A.imageTools].slice(-200) }); } catch {}
  }
  try {
    chrome.storage.local.get("zsImageTools", (r) => {
      if (r && Array.isArray(r.zsImageTools)) for (const n of r.zsImageTools) A.imageTools.add(n);
      diag("imageTool.loaded", { tools: [...A.imageTools] });
    });
  } catch {}

  // How long a fetched catalogue stays good enough to reuse without a round trip.
  const TOOLS_TTL_MS = 30000;

  function activeTools() {
    if (!isMcpEnabled(selectedTargetId)) return [];
    return A.toolList.filter((tool) => (tool.server || "roblox") === selectedTargetId);
  }

  function refreshActiveToolNames() {
    A.toolNames = new Set(activeTools().map((tool) => tool.name));
  }

  // Refresh the tool catalogue - but never pay for it twice in a row.
  //
  // DEGRADED MODE (Roblox Studio closed, running on an addon server like Blender)
  // is where this used to hurt: a list_tools whose Roblox half is dead blocks the
  // bridge until it gives up, and the extension waited the FULL background timeout
  // for it. The boot sequence calls this three times in a row - startSession(),
  // then the model's list_commands, then list_mcp_servers - so the user watched
  // ~a minute of dead air with the model's reply already finished on screen
  // ("the first commands take forever even though the model clearly stopped
  // writing"). A short TTL collapses those three calls into one, and the caller
  // keeps the catalogue it already has instead of stalling for a fresh one.
  async function ensureTools(force) {
    if (!force && A.toolList.length && Date.now() - A.toolsAt < TOOLS_TTL_MS) {
      diag("tools.cached", { age: Date.now() - A.toolsAt, n: A.toolList.length });
      return A.toolList;
    }
    const t0 = Date.now();
    const r = await bg({ type: "list_tools" });
    diag("tools.fetched", { ms: Date.now() - t0, n: (r && r.tools && r.tools.length) || 0 });
    if (r && r.tools && r.tools.length) {
      const tools = r.tools.filter((t) => !isBlockedTool(t.name));
      A.toolList = tools;
      refreshActiveToolNames();
      A.toolsAt = Date.now();
    }
    return A.toolList;
  }

  async function runTool(call) {
    const name = call.tool;
    const args = call.arguments || {};
    if (!name) return ZS.FEEDBACK.parseError("malformed");
    // SCROLL-AWAY RULE (final choke point): while the user is scrolling up
    // through history nothing is executed - but the command is HELD, not
    // cancelled. It used to return "skipped: conversation scrolled up", which
    // dropped the call entirely: if the user happened to scroll just as a
    // command became ready, the model was told its work had not run and the
    // task stalled. The PR describes a hold, so wait the suppression window out
    // and then proceed. A Stop still wins, and the wait is bounded.
    if (scrollSuppressed() && !a2a.getCurrentId()) {
      diag("tool.holdScrolling", { name });
      // Mark the hold so the busy surface keeps the Stop control visible while
      // we wait; scrollSuppressed() would otherwise hide it for the whole wait.
      A.held = true;
      renderBar();
      let waited = false;
      try {
        waited = await waitScrollWindow();
      } finally {
        A.held = false;
      }
      renderBar();
      if (!waited) {
        // Stopped by the user while parked - do not run the command.
        return "ERROR: the command was not run - stopped by the user.";
      }
      diag("tool.resumeAfterScroll", { name });
    }
    // ── Fast liveness probe ────────────────────────────────────────────────
    // A dead bridge used to cost the full tool budget before the loop learned it
    // was offline, so the chat felt far slower than on other providers for the
    // SAME work. A local bridge answers a ping in single-digit milliseconds when
    // the socket is WARM - but a COLD/reconnecting socket was measured at 4314ms,
    // so the budget must be generous (a false "offline" is far worse than a slow
    // probe) and one retry is allowed before giving up. The probe is paid only
    // when the cache is cold (>15s), so normal runs cost nothing.
    if (!A._bridgeProbeOkAt || Date.now() - A._bridgeProbeOkAt > 15000) {
      const probeOnce = (budget) => Promise.race([
        bg({ type: "ping" }),
        new Promise((res) => setTimeout(() => res({ ok: false, kind: "timeout" }), budget)),
      ]);
      let probe = await probeOnce(6000);
      let probeOk = probe && (probe.ok !== false) && probe.kind !== "disconnected" && probe.kind !== "timeout";
      if (!probeOk) {
        // One more chance: a socket that was mid-reconnect on the first attempt
        // is usually settled a couple of seconds later.
        probe = await probeOnce(8000);
        probeOk = probe && (probe.ok !== false) && probe.kind !== "disconnected" && probe.kind !== "timeout";
      }
      if (!probeOk) {
        diag("bridge.preflightFail", { name, kind: (probe && probe.kind) || "none" });
        A._bridgeProbeOkAt = 0;
        ui.banner("warn", "Bridge offline",
          "snapgentV3 bridge is unreachable - start it and keep the selected target app open.");
        return ZS.FEEDBACK.bridgeOffline;
      }
      A._bridgeProbeOkAt = Date.now();
    }
    // NEVER execute while the AI tab is backgrounded/minimized. This is the single
    // choke point for ALL execution (agentLoop's tool dispatch AND the bootstrap's
    // list_commands), so it closes the hole the loop-entry gate alone left open:
    // the tab is foreground when a cycle starts, the model then generates for
    // 30-120s, the user minimizes MID-generation, and waitForResponse returns a
    // tool call that fired into Studio off-screen (observed live: GLM minimized
    // still ran execute_luau). Parking here (no time cap) means the call runs the
    // moment the tab is foreground again, instead of being lost or run blind.
    if (document.hidden && !A.stop) {
      diag("tool.waitVisible", { name });
      // Only reachable via a user Stop while parked; agentLoop's post-runTool
      // A.stop check breaks the loop and discards this, so it just needs to be
      // a non-crashing, clearly-labelled string.
      if (!(await waitVisible()) || A.stop) return "ERROR: the command was not run - stopped by the user.";
    }
    // Blocked commands: refuse up-front with a clear, tailored error so the
    // model abandons it and continues instead of wasting/hanging a turn.
    const bareName = bareToolName(name);
    if (isBlockedTool(name)) {
      if (VISION_TOOLS.has(bareName)) {
        return `ERROR: '${bareName}' is unavailable here - this assistant cannot see images. Do NOT call it again. Inspect the place programmatically instead (e.g. inspect_instance, get_studio_state, search_game_tree, script_read).`;
      }
      return `ERROR: the '${bareName}' command timed out and is unavailable in this environment. Do NOT call it again - complete the task yourself using the other commands (execute_luau, multi_edit, etc.).`;
    }
    // Virtual command: list the MCP server(s) snapgentV3 is currently connected
    // to, with each one's REAL per-server health (from the bridge, never the
    // merged tool count - a dead server must not borrow another's numbers).
    if (name === "list_mcp_servers") {
      await ensureTools();
      // Isolation: the AI only ever sees the server selected in the dropdown (and only
      // if its toggle is on). Other servers, enabled or not, are invisible to it.
      const servers = ((A.bridge && A.bridge.servers) || [])
        .filter((sv) => sv.id === selectedTargetId && isMcpEnabled(sv.id));
      const lines = servers.length
        ? servers.map((sv) => {
            const label = sv.id === "vscode"
              ? "VS Code (default target)"
              : sv.id === "roblox" ? "Roblox Studio" : `${sv.id} (addon)`;
            return `- ${sv.id}: ${label} - ${sv.alive ? `${sv.tools || 0} commands available` : "offline (no tools)"}`;
          })
        : ["- vscode: VS Code (default target) - unknown (bridge did not report server health)"];
      return (
        `Output of 'list_mcp_servers':\n` +
        `Connected MCP servers (${lines.length}):\n${lines.join("\n")}\n` +
        `Use list_commands with a "server" param (one of the ids above) to see that server's exact commands. Without "server", list_commands defaults to "${selectedTargetId}".`
      );
    }
    // Virtual command: list available commands with full details. Defaults to
    // the primary Roblox server - a DIFFERENT server's tools only ever show up
    // if the model explicitly asks via {"server": "<id>"} (see list_mcp_servers).
    if (name === "list_commands" || name === "list_tools") {
      await ensureTools();
      const target = (selectedTargetId || "vscode").trim();
      const asked = typeof args.server === "string" ? args.server.trim() : "";
      // Isolation: only the server selected in the dropdown can be listed. A request
      // for any other server gets a generic refusal that does not reveal whether that
      // server exists, is connected, or is toggled on.
      if (asked && asked !== target) {
        return `Output of '${name}':\nERROR: server "${asked}" is not available. Only the selected target "${target}" can be used in this session. Do NOT try other servers; ask the user to switch the target in the snapgentV3 selector if needed.`;
      }
      const requested = target;
      if (!isMcpEnabled(requested)) {
        return `Output of '${name}':\nERROR: MCP server "${requested}" is disabled by the user. Do NOT use it. Tell the user to enable it in the MCP settings if it is needed.`;
      }
      // The MCP proxy keeps advertising Roblox's catalogue even with no Studio
      // attached, so list_commands would hand back the full command list and read
      // as "Roblox is fine" - then every command silently fails. When Roblox is
      // actually unusable, short-circuit the DEFAULT (roblox) listing into a plain
      // "Roblox is down" note that points the model at the other server(s), so it
      // can keep working in degraded mode instead of firing dead Roblox commands.
      if (requested === "roblox") {
        const s = A.bridge || {};
        const srv = s.servers || [];
        const rbx = srv.find((x) => x.id === "roblox");
        const rbxAlive = rbx ? !!rbx.alive : (!!s.mcpAlive || srv.some((x) => x.alive));
        const rbxUsable = !!s.connected && rbxAlive && s.studio !== false;
        if (!rbxUsable) {
          // Isolation: never reveal other servers here.
          const otherStr = "Do NOT try other servers; wait for the user to fix the target or switch it in the snapgentV3 selector.";
          return `Output of '${name}':\nRoblox Studio is currently OFFLINE (closed, no place open, or its MCP server disabled), so its commands cannot run. This is an environment problem on the user's machine, not your mistake. Tell the user in one short sentence to open their place in Roblox Studio and enable its MCP server. ${otherStr}`;
        }
      }
      const known = new Set(A.toolList.map((t) => t.server).filter(Boolean));
      // Tools from a bridge that doesn't tag "server" yet (old version) have no
      // .server field at all - treat those as the primary server rather than
      // hiding everything.
      const scoped = A.toolList.filter((t) => (t.server || "roblox") === requested);
      if (!A.toolList.length) return `Output of '${name}':\nNo commands available - the bridge or selected MCP server may be offline.`;
      if (!scoped.length) {
        return `Output of '${name}':\nERROR: the selected server "${requested}" has no commands available (it may be offline). Do NOT try other servers; tell the user to check the target in the snapgentV3 selector.`;
      }
      // Providers with a small per-message cap (Rudder: 4,000 chars) ask for the
      // compact catalogue. The detailed schemas and per-command notes blow past
      // that cap, and a rejected boot message would strand the whole session.
      if (P.compactToolList) {
        return `Output of '${name}':\n${requested} commands (${scoped.length}):\n\n${ZS.compactTools(scoped)}`;
      }
      const lines = scoped.map((t) => {
        const props = (t.inputSchema && t.inputSchema.properties) || {};
        const req = new Set((t.inputSchema && t.inputSchema.required) || []);
        // Two buckets: simple scalar params get packed onto ONE compact line;
        // params that need real explanation (array-of-object shape, or a long
        // description) keep their own line so nothing structurally important
        // gets flattened away (that per-item shape is what fixed "Unknown …
        // action: nil" bugs on user_keyboard_input/user_mouse_input).
        const compact = [];
        const detailed = [];
        for (const [k, v] of Object.entries(props)) {
          const items = v.items && typeof v.items === "object" ? v.items : null;
          const itemProps = items && items.properties;
          const mark = req.has(k) ? "" : "?";
          if (v.type === "array" && itemProps) {
            const itemReq = new Set(items.required || []);
            const fields = Object.entries(itemProps).map(([ik, iv]) => {
              const en = Array.isArray(iv.enum) && iv.enum.length <= 12 ? `(${iv.enum.join("|")})` : (iv.type || "any");
              return `${ik}${itemReq.has(ik) ? "" : "?"}:${en}`;
            });
            detailed.push(`    ${k}${mark}: array [each item: {${fields.join(", ")}}]${v.description ? " - " + v.description : ""}`);
          } else if (v.description && v.description.length > 45) {
            detailed.push(`    ${k}${mark}: ${v.type || "any"} - ${v.description}`);
          } else {
            const ty = Array.isArray(v.enum) && v.enum.length <= 8 ? `(${v.enum.join("|")})` : (v.type || "any");
            compact.push(`${k}${mark}:${ty}${v.description ? ` "${v.description}"` : ""}`);
          }
        }
        const paramLines = [compact.length ? `    ${compact.join(", ")}` : "", ...detailed].filter(Boolean).join("\n");
        // Tested usage note for the error-prone commands - kept full-length
        // (these are validated fixes for real bugs, not filler).
        const note = ZS.TOOL_NOTES[bareToolName(t.name)];
        const noteStr = note ? `\n    ⚠ ${note}` : "";
        return `${t.name}: ${(t.description || "").split("\n")[0]}${paramLines ? "\n" + paramLines : ""}${noteStr}`;
      });
      return `Output of '${name}':\n${requested} commands (${scoped.length}):\n\n${lines.join("\n\n")}`;
    }
    // Isolation: execution is hard-limited to the server selected in the dropdown.
    // 1) the selected target must be toggled on,
    // 2) an explicit "server/tool" prefix may only name the selected target,
    // 3) the tool must exist in the selected server's own catalogue (never skipped,
    //    even when that catalogue is empty).
    // The name sent to the bridge is NOT rewritten: the bridge only knows a "server/"
    // prefix for tools whose names collide across servers.
    if (!isMcpEnabled(selectedTargetId)) {
      return `ERROR: the selected MCP server "${selectedTargetId}" is disabled by the user, so '${name}' was not run. Do NOT retry. Tell the user to enable it in the MCP settings.`;
    }
    if (name.includes("/") && name.split("/")[0] !== selectedTargetId) {
      return `ERROR: '${name}' was not run. Only the selected target "${selectedTargetId}" can be used in this session. Use plain command names from list_commands.`;
    }
    if (!A.toolNames.size) await ensureTools();
    if (!knownTool(name)) {
      return ZS.FEEDBACK.unknownTool(name, [...A.toolNames]);
    }
    // The Roblox MCP REQUIRES datamodel_type on execute_luau (enum Edit/Client/
    // Server). The ###LUA### parser already fills it in, but the model may also
    // write the JSON form without it - default to "Edit" so the call never
    // soft-fails with "datamodel_type is required".
    if (bareName === "execute_luau" && !args.datamodel_type) args.datamodel_type = "Edit";
    // The player-input tools only run against the Client datamodel (play mode) and
    // "Client" is the sole allowed value, so default it when the model omits it -
    // it can only be right. (It still needs the game RUNNING; that's documented.)
    if ((bareName === "user_keyboard_input" || bareName === "user_mouse_input") && !args.datamodel_type)
      args.datamodel_type = "Client";
    const timeout = name === "execute_luau" ? 20000 : 120000;
    // Hard watchdog: even if the background worker never answers, the loop
    // gets a definitive result and continues.
    let hardCapTimer;
    const hardCap = new Promise((res) => {
      hardCapTimer = setTimeout(() => res({ ok: false, kind: "timeout", error: "no response from the extension worker" }), timeout + 30000);
    });
    // Stop watcher: a blocking tool (e.g. wait_job_finished) would otherwise keep
    // the loop awaiting the bridge for up to minutes, leaving the input locked and
    // the Stop button stuck. When the user halts (A.stop), abandon the wait within
    // ~150ms so the loop breaks and its finally unlocks everything. The in-flight
    // bridge call may still finish in the background; its result is just ignored.
    let unsubStop = null;
    const stopWatch = new Promise((res) => {
      if (A.stop) { res({ ok: false, kind: "stopped" }); return; }
      unsubStop = onStop(() => res({ ok: false, kind: "stopped" }));
    });
    let r = await Promise.race([bg({ type: "call_tool", name, arguments: args, timeout, server: selectedTargetId }), hardCap, stopWatch]);
    clearTimeout(hardCapTimer);
    if (unsubStop) unsubStop();
    if (r && r.kind === "stopped") return "(stopped by user)";
    if (!r) return ZS.FEEDBACK.bridgeOffline;
    // The MCP server answers SUCCESSFULLY (ok:true) when no Studio is attached
    // (Studio closed / no place / MCP option disabled) - with an explanatory
    // text instead of a result. Surface it as a proper environment ERROR so the
    // model stops and tells the user, instead of treating it as tool output.
    if (r.ok && selectedTargetId === "roblox" && /Unable to find an active Studio instance|previously active Studio has disconnected/i.test(r.text || "")) {
      ui.banner("warn", "Studio offline",
        "Open a place, enable MCP.");
      return ZS.FEEDBACK.studioOffline;
    }
    // The Roblox MCP reports missing/invalid required parameters as a SUCCESS
    // whose text is just the complaint (e.g. "datamodel_type is required").
    // Re-shape those into a real ERROR so the model corrects the call instead
    // of misreading it as tool output.
    if (r.ok && r.text && /^[\w .'"-]{0,60}\bis (required|not available|invalid)\b[\w .'"-]{0,80}$/i.test(r.text.trim())) {
      return `ERROR calling '${name}': ${r.text.trim()}.\nA required or invalid parameter - check the command's parameters with list_commands, fix the call and retry.`;
    }
    // The Roblox MCP also reports Luau PARSE/RUNTIME errors as a SUCCESS whose
    // text is the executor's own stack trace ("…ExecuteLuauTool:139: …
    // CommandExecution:54: <real error>" - validated live). Genuine script
    // output never contains those internal paths. Re-shape into a real ERROR so
    // the model gets the fix-it hints below and the chip settles red, not ✓
    // green - and strip the internal frames so only the useful part remains.
    if (r.ok && bareName === "execute_luau" && r.text &&
        /\b(?:ExecuteLuauTool|CommandExecution):\d+:/.test(r.text)) {
      r = { ok: false, error: r.text.replace(/^(?:\S*(?:ExecuteLuauTool|CommandExecution):\d+:\s*)+/, "").trim() || r.text };
    }
    if (r.ok) {
      if (r.images && r.images.length && !P.supportsVision) {
        // Any tool from ANY connected server can turn out to return images -
        // we don't try to predict this from its name in advance. This is the
        // generic catch: whatever just ran, if it handed back images and this
        // provider's model can't see them, refuse cleanly instead of silently
        // attaching a file it will never actually process.
        return `ERROR: '${bareName}' returned an image, but this assistant cannot see images. Do NOT call it again. Use a different command to get the information as text instead.`;
      }
      if (r.images && r.images.length) {
        // Show the capture in a left-hand snapgentV3 popup (from the in-memory
        // base64 - simple and reliable on every site; no DOM-embedded preview).
        ui.showImages(r.images, name);
        // Do NOT attach the image here: submitAndGetBase/typeAndSend types the
        // feedback text into the editor LATER, and on providers whose editor is
        // rebuilt via select-all + insertText (e.g. Gemini's setEditorText),
        // that wipe severs the site's internal binding between "pending upload"
        // and "message being composed" - the file then sits in the composer
        // forever while only the text goes out (validated live: Gemini kept
        // the file attached+unsent across the whole turn). Stash the images and
        // let the provider attach them as the LAST step, right before the send
        // click, so nothing mutates the editor afterward.
        A.pendingImages = r.images;
        diag("images.stashed", { count: r.images.length });
        const caption = r.text && r.text.trim()
          ? r.text.trim()
          : `${r.images.length} image(s) captured.`;
        return `Output of '${name}':\n${caption}\n(The image is attached to THIS message - you can see it directly. Analyse it and continue.)`;
      }
      const text = r.text && r.text.length ? r.text : "(tool returned an empty result)";
      return `Output of '${name}':\n${text}`;
    }
    // Orphaned content script - a page reload is the only cure, so say exactly
    // that instead of blaming the bridge (see bg / isContextInvalidated).
    if (r.kind === "stale-extension") {
      ui.banner("warn", "Reload page",
        "Updated. Press F5.");
      diag("bridge.staleExtension", { name, error: r.error });
      return ZS.FEEDBACK.staleExtension;
    }
    if (r.kind === "disconnected") {
      // A socket that is mid-reconnect reports "disconnected" even though the
      // bridge is alive (measured: reconnect takes ~4.3s). Retry ONCE after a
      // short settle before declaring the bridge offline - a false "offline"
      // makes the model stop working and shows "tool failed" to the user.
      //
      // BUT only when the request provably never left. The rule lives in
      // ZSGuard so the tested logic IS the running logic: `sent === false` means
      // the bridge cannot have run it; `sent === true` may already have executed
      // write_file / run_command / git_commit. A reply WITHOUT the field (an
      // older bridge) is treated as unsafe for the same reason - re-sending a
      // write that did land is worse than reporting the ambiguity.
      if (!ZSGuard.mayRetryAfterDisconnect(r)) {
        diag("bridge.noRetryAfterSend", { name, sent: r.sent });
        ui.banner("warn", "Connection dropped",
          `The bridge stopped answering while '${name}' was in flight. It may already have run - check the result before repeating it.`);
        return ZSGuard.inFlightFailure(name);
      }
      diag("bridge.disconnectedRetry", { name });
      await new Promise((res) => setTimeout(res, 1200));
      const retry = await Promise.race([
        bg({ type: "call_tool", name, arguments: args, timeout, server: selectedTargetId }),
        hardCap,
      ]);
      // The retry itself has to be judged by the same rule. A second attempt
      // that goes out and then drops must NOT be reported as "bridge offline":
      // the tool may have run, and the model would retry it again.
      if (retry && retry.kind === "disconnected" && !ZSGuard.mayRetryAfterDisconnect(retry)) {
        diag("bridge.noRetryAfterSend", { name, sent: retry.sent, attempt: 2 });
        ui.banner("warn", "Connection dropped",
          `The bridge stopped answering while '${name}' was in flight. It may already have run - check the result before repeating it.`);
        return ZSGuard.inFlightFailure(name);
      }
      if (retry && retry.kind !== "disconnected") {
        r = retry;
      } else {
        return ZS.FEEDBACK.bridgeOffline;
      }
    }
    if (r.kind === "timeout") {
      return `ERROR: tool '${name}' timed out after ${name === "execute_luau" ? 20 : 120}s.\n${r.error}\nTry a shorter/simpler call or check that the selected target app is open and responsive.`;
    }
    if (name === "execute_luau") {
      const err = r.error || "";
      // "Failed to parse command code" is StudioMCP's GENERIC parse rejection: an
      // empty/mis-marked block is only ONE of its causes. The others are ordinary
      // Luau syntax errors and - seen live on Meta AI 2026-08-13 - code that is
      // syntactically fine but too big for the parser: a `return 1+1+1+…` chain
      // ran at ~500 terms (1006 chars) and was rejected at ~1000 (2006 chars).
      // Telling the model its block was empty when we DID send it a full code
      // string sends it to fix something that isn't broken; it retries the same
      // payload and fails again (the reported spam of parse errors). Only give the
      // marker advice when the code we actually sent really was empty.
      const luaCode = args.code || "";
      const hint = err.includes("Failed to parse command code")
        ? !luaCode.trim()
          ? "Your code block was empty or the marker was wrong. Use exactly ###LUA### (three hashes) - never ###LUA---. The code must be between ###LUA### and ###END_LUA###."
          : `Roblox refused to PARSE the code (${luaCode.length} chars sent, so it was not empty). Either the Luau syntax is invalid, or the code is too large/complex for the parser - a single huge expression or a very long script can be rejected outright. Check the syntax first; if it looks correct, split the work into several smaller calls.`
        : err.includes("attempt to") || err.includes("nil value")
          ? "Lua runtime error. Check that the API you are calling exists (use game:GetService() to access services). Make sure you use 'return' to output values, not 'print()'."
          : "Check your Lua syntax, make sure you use 'return' to output values (not 'print()'), and that all APIs you call exist in the current Roblox Studio context.";
      return `ERROR in execute_luau: ${err}\n\n${hint}\n\nFix the code and retry.`;
    }
    return `ERROR calling '${name}': ${r.error}\nRead the error carefully, fix the call or try a different approach.`;
  }

  function argSummary(call) {
    if (!call) return "";
    if (call.tool === "execute_luau") {
      const code = (call.arguments && call.arguments.code) || "";
      const first = code.split("\n").map((s) => s.trim()).filter(Boolean)[0] || "";
      return first.slice(0, 46);
    }
    const a = call.arguments || {};
    const k = Object.keys(a)[0];
    if (!k) return "";
    let v = String(a[k]);
    if (v.length > 34) v = v.slice(0, 31) + "…";
    return `${k}: ${v}`;
  }

  // An MCP tool can report its OWN failure as a NORMAL result ("Output of '…':
  // Error executing code: …") instead of our ERROR wrapper - so a
  // startsWith("ERROR") test alone paints a FAILED call ✓ green and shows the
  // error as its summary (seen live on Blender's execute_blender_code, and it
  // will hit EVERY future MCP server the same way). Treat a result whose FIRST
  // line opens with an error lead-in as failed too. Deliberately PHRASE-based,
  // not the bare words "error"/"failed", so a genuine success line like
  // "Failed: 0" / "Error count: 0" is NOT misread as a failure.
  const BODY_ERR_RE =
    /^\s*(error executing|error:|erreur|exception|traceback|communication error|failed to|could ?not|cannot |unable to|fatal)\b/i;
  const stripOutputPrefix = (feedback) => feedback.replace(/^Output of '[^']*':\n?/, "");
  function bodyLooksFailed(feedback) {
    if (!feedback || feedback.startsWith("ERROR")) return false; // wrapper already flags it
    const first = stripOutputPrefix(feedback).split("\n").map((s) => s.trim()).find(Boolean) || "";
    return BODY_ERR_RE.test(first);
  }
  // True failure = OUR wrapper prefix OR an MCP tool's in-body error lead-in.
  const feedbackIsError = (feedback) => feedback.startsWith("ERROR") || bodyLooksFailed(feedback);

  // Some tools answer with raw JSON on one line, and a 44-char slice of it makes
  // a chip that says nothing: list_roblox_studios read
  // `{"studios":[{"id":"8521cfad-f8d9-46f4-8cbe-2`. Summarise the SHAPE instead,
  // in the same spirit as the boot chip's "25 commands". Returns null when the
  // body isn't JSON, so plain-text outputs keep their first line unchanged.
  function jsonSummary(body) {
    if (!/^[[{]/.test(body) || body.length > 200000) return null;
    let v;
    try { v = JSON.parse(body); } catch { return null; }
    if (Array.isArray(v)) return `${v.length} item${v.length === 1 ? "" : "s"}`;
    if (!v || typeof v !== "object") return null;
    const keys = Object.keys(v);
    // The common MCP shape: one wrapper key holding the list. Its name is already
    // plural ("studios", "scripts"), so it reads correctly as-is - just drop the
    // trailing "s" when there is exactly one, so it says "1 studio".
    if (keys.length === 1 && Array.isArray(v[keys[0]])) {
      const n = v[keys[0]].length;
      const word = n === 1 ? keys[0].replace(/s$/, "") : keys[0];
      return `${n} ${word}`;
    }
    // Otherwise show the scalar fields - that's what a human would read off.
    const scalars = keys
      .filter((k) => v[k] === null || typeof v[k] !== "object")
      .map((k) => `${k}: ${v[k]}`);
    if (scalars.length) return scalars.join(", ").slice(0, 44);
    return `${keys.length} field${keys.length === 1 ? "" : "s"}`;
  }

  function outSummary(feedback) {
    if (!feedback) return "";
    const isErr = feedbackIsError(feedback);
    const body = stripOutputPrefix(feedback).trim();
    if (!body) return "";
    // Errors are prose and read fine as-is; only reshape successful JSON.
    if (!isErr) { const j = jsonSummary(body); if (j) return j; }
    const all = body.split("\n").map((l) => l.trim()).filter(Boolean);
    const lines = all.length;
    // On SUCCESS, skip a leading non-fatal warning/note some MCP tools print
    // before the real status so the chip shows the useful line, not the noise.
    let first = all[0] || "";
    if (!isErr && lines > 1 && /^(warning|warn|note|deprecat|info)\b/i.test(first)) {
      first = all.find((l) => !/^(warning|warn|note|deprecat|info)\b/i.test(l)) || first;
    }
    first = first.slice(0, 44);
    if (isErr) return first;
    return lines > 1 ? `${first} · ${lines} lines` : first;
  }

  // Full args / code, shown in a tool chip's expandable body.
  function callBody(call) {
    const a = call.arguments || {};
    if (call.tool === "execute_luau") return (a.code || "").trim();
    try { return JSON.stringify(a, null, 2); } catch { return String(a); }
  }

  // ════════════════════════════════════════════════════════════════════════
  //  AGENTIC LOOP
  // ════════════════════════════════════════════════════════════════════════
  async function agentLoop(base) {
    if (A.running) return;
    A.running = true;
    A.resumeArmed = false; // loop now owns the turn; drop the regenerate grace
    A.stop = false;
    A.stopping = false; // clean slate: never inherit a stale "Stopping…" from a
                        // Stop click that landed before this loop actually started
    A.lastLoopError = "";
    A.loopKey = null; // pinned by syncSessionState once this chat has an id + content
    let truncCount = 0;
    const MAX_TRUNC = 6;
    let finalText = "";
    // Bounded retries for a turn the site leaves blank (most often right after a
    // tool result). One blank turn must not end the whole task with no answer.
    let emptyCount = 0;
    const MAX_EMPTY = 2;
    // Re-send the command list after this many successful tool calls. Kept high
    // so the reminder does not bloat the context too often.
    const REMIND_TOOLS_EVERY = 20;
    // A site rate limit with a stated cooldown is retryable. Cap it so a stuck
    // provider cannot keep the loop alive forever.
    const MAX_LIMIT_RETRIES = 2;
    let limitRetries = 0;
    ui.showStop(true);
    P.setInputLock(true); // prevent user from typing while the agent is active
    ui.inputCover(true);  // keep the "Agent is working" cover up for the WHOLE loop
    diag("loop.start", { base });
    // Watchdog: if the tab is visible, no tool is running and NOTHING has changed
    // (turn counts, stream length, generating flag) for WD_STALL_MS, the loop is
    // stuck waiting. Stop it so the cover and Stop button are released by the
    // finally block below, and tell the user instead of leaving a dead bar.
    const WD_STALL_MS = 180000;
    let _wdSig = "", _wdTimer = null, _wdObs = null;
    const _wdArm = () => {
      clearTimeout(_wdTimer);
      if (!A.running) return;
      _wdTimer = setTimeout(() => {
        if (!A.running) return;
        if (document.hidden || A.parked || A.toolRunning || A.injecting) { _wdArm(); return; }
        const sig = [P.assistantCount(), P.userCount(), P.streamLen ? P.streamLen() : 0, P.isGenerating() ? 1 : 0].join("|");
        if (sig !== _wdSig) { _wdSig = sig; _wdArm(); return; }
        diag("loop.watchdog", { sig });
        ui.banner("warn", "Agent stopped waiting", "No progress for 3 min. Send continue to resume.");
        A.stop = true;
      }, WD_STALL_MS);
    };
    const _wdTouch = () => {
      if (!A.running) return;
      const sig = [P.assistantCount(), P.userCount(), P.streamLen ? P.streamLen() : 0, P.isGenerating() ? 1 : 0].join("|");
      if (sig !== _wdSig) { _wdSig = sig; _wdArm(); }
    };
    if (typeof MutationObserver === "function") {
      _wdObs = new MutationObserver(_wdTouch);
      try { _wdObs.observe(document.documentElement, { childList: true, subtree: true, characterData: true }); } catch {}
    }
    document.addEventListener("visibilitychange", _wdArm);
    _wdArm();
    const _wdCleanup = () => {
      clearTimeout(_wdTimer);
      _wdTimer = null;
      if (_wdObs) { _wdObs.disconnect(); _wdObs = null; }
      document.removeEventListener("visibilitychange", _wdArm);
    };
    try {
      while (!A.stop) {
        // Gate the WHOLE cycle on tab visibility. We only advance - read the
        // reply, PARSE it, EXECUTE a tool, inject the result - while the AI tab
        // is the FOREGROUND tab of its Edge window. document.visibilityState
        // (mirrored by document.hidden) is the right signal, NOT window focus:
        //  - Edge loses OS focus but the AI tab stays the active tab (user is
        //    working in Roblox Studio) -> still "visible" -> the agent keeps
        //    running, exactly as wanted.
        //  - The AI tab is backgrounded (another tab in front) or the window is
        //    minimized -> "hidden" -> pause here. Background tabs throttle
        //    rendering/timers, which made DOM reads unreliable (misparse,
        //    duplicate sends - see the send-side guard in submitAndGetBase).
        // Parking here means we never START a parse/exec cycle off-screen; the
        // send step re-checks too, so a switch-away mid-generation is covered.
        if (document.hidden && !A.stop) {
          diag("loop.waitVisible");
          ui.inputCover(true); // keep the "Agent is working" cover up while parked
          if (!(await waitVisible()) || A.stop) break; // park (no cap) until foreground; break only on user stop
          diag("loop.visibleAgain");
        }
        const res = await waitForResponse(base);
        diag("response", { kind: res.kind });
        if (A.stop || res.kind === "stopped") break;

        if (res.kind === "context_limit") {
          const detail = res.detail || `${P.displayName} reached its context limit.`;
          const waitMs = ZS.parseRetryAfterMs(detail);
          if (waitMs && limitRetries < MAX_LIMIT_RETRIES && !A.stop) {
            limitRetries++;
            diag("loop.limitRetry", { attempt: limitRetries, waitMs });
            ui.banner("limit", `${P.displayName} rate limited`, detail, { countdownMs: waitMs });
            await sleep(waitMs + 500);
            if (A.stop) break;
            // The limit notice consumed the pending turn; nudge the model to
            // resume from the tool result it already has. Do NOT pass `base`
            // here - that is the assistant count, not prompt text.
            base = await submitAndGetBase(ZS.FEEDBACK.limitRetry);
            continue;
          }
          // Only a retry that gives up is a loop error (A2A reads this), so it
          // must not be set before a retry that may succeed.
          A.lastLoopError = detail;
          ui.banner("limit", `${P.displayName} reached its context limit`, detail + " New chat.");
          break;
        }
        if (res.kind === "too_long") {
          A.lastLoopError = "Conversation is too long. Start a new chat.";
          ui.banner("limit", "Conversation too long",
            `Too long. Start a new chat.`);
          break;
        }
        if (res.kind === "timeout") {
          A.lastLoopError = `No response from ${P.displayName} (timed out).`;
          ui.banner("warn", `No response from ${P.displayName}`,
            `Timed out. Agent stopped.`);
          break;
        }
        // 2026-11 ChatGPT saturation: the turn is a PLACEHOLDER (fallback-turn-*)
        // that never renders its text. Only the Start flow used to handle this,
        // so a session that saturated mid-conversation fell through every branch
        // and re-entered with an unchanged base - reading the same placeholder
        // every ~2.5s: no send, no banner, and (on a hidden tab) no watchdog to
        // end it. Stop with the same banner Start shows.
        if (res.kind === "fallback_turn") {
          A.lastLoopError = FALLBACK_TURN_TEXT;
          diag("fallback_turn.end");
          ui.banner("warn", "Conversation stopped responding", FALLBACK_TURN_TEXT);
          break;
        }

        // A genuinely empty turn is effectively never produced (the warm-up guard
        // waits out slow starts). It DOES happen when the site drops a reply, and
        // ending the loop silently is what made this the single most confusing
        // failure: the pending command just settles to a grey "not run" with no
        // explanation anywhere. Say what happened.
        if (res.kind === "empty") {
          // The site does occasionally create an assistant turn and leave it
          // blank - most visibly after a tool result. Ending here threw away a
          // task the model could usually finish, so nudge it once or twice with
          // a plain-text instruction before giving up. Bounded, so a genuinely
          // silent site still ends promptly.
          if (emptyCount < MAX_EMPTY && !A.stop) {
            emptyCount++;
            diag("empty.retry", { n: emptyCount });
            ui.toast("Empty reply - asking again…");
            base = await submitAndGetBase(ZS.FEEDBACK.emptyReply);
            continue;
          }
          diag("empty.end", { retries: emptyCount });
          ui.banner("warn", `${P.displayName} returned an empty reply`,
            `Nothing received. Try again.`);
          break;
        }

        // The turn stopped with the site's "Continue" affordance.
        if (res.kind === "truncated") {
          // If the turn carries the halted marker (a stop - user OR self-halt),
          // respect it and do NOT auto-resume.
          if (P.turnHalted(res.item)) { diag("truncated.halted"); break; }
          // Otherwise it truncated by length → continue the SAME turn. Prefer
          // the native Continue button; fall back to a continuation message.
          if (truncCount < MAX_TRUNC) {
            truncCount++;
            if (P.clickContinueBtn() && await waitFor(() => P.isGenerating(), 2500)) {
              diag("truncated.continued");
              continue; // same turn resumes (base unchanged)
            }
            diag("truncated.sendFallback");
            ui.toast("Resuming…");
            base = await submitAndGetBase(ZS.FEEDBACK.truncated);
            continue;
          }
          if (res.text) break; // give up resuming; keep what we have as the answer
          ui.banner("warn", "Reply kept getting cut off",
            "Too long. Try shorter.");
          break;
        }
        truncCount = 0;
        emptyCount = 0;

        if (res.kind === "parse_error") {
          // The command turn ended in a parse error - it NEVER ran. Paint its chip
          // as an error (owned, so the sweep won't repaint it the green ✓ "done" it
          // stamps on any command-shaped turn once generation ends - the misleading
          // "chip says OK, result says error" state seen live on GLM's truncated
          // execute_blender_code).
          const failName = ZSParse.toolNameFromText(res.raw || "") || "command";
          if (res.item) {
            const detail = res.reason === "unclosed" ? "cut off"
              : res.reason === "luaOpener" ? "missing ###LUA###"
              : res.reason === "envelope" ? "bad format"
              // DSML is not JSON at all - it is DeepSeek's own markup - so the
              // default "bad JSON" would send the user (and anyone reading a bug
              // report) looking for a syntax slip that does not exist.
              : res.reason === "dsml" ? "wrong format"
              : "bad JSON";
            decorate.toolBox(res.item, failName, "err", detail, true, "", ZS.toolCategory(failName));
          }
          // Pass the detected command name so the feedback only offers the
          // ###LUA### block when it actually applies (execute_luau) - never for a
          // truncated/broken execute_blender_code or other JSON-only command.
          base = await submitAndGetBase(ZS.FEEDBACK.parseError(res.reason, failName));
          continue;
        }
        if (res.kind === "text") { finalText = res.text || ""; break; } // final answer

        if (res.kind === "tool") {
          const calls = res.calls;
          if (calls.length > 1) {
            base = await submitAndGetBase(ZS.FEEDBACK.multiTool(calls.map((c) => c.tool || "?")));
            continue;
          }
          const call = calls[0];
          // A tool ALREADY seen to return an image this session gets the "screen"
          // chip optimistically at run time (parity with the known screen_capture),
          // even though its name alone wouldn't reveal it. First-ever call of an
          // unknown image tool stays generic here and upgrades at result time below.
          const learnedImg = A.imageTools.has(bareToolName(call.tool));
          const category = learnedImg ? "screen" : ZS.toolCategory(call.tool);
          diag("tool.runCat", { name: call.tool, learnedImg, category });

          // Park BEFORE painting the chip / stamping the clock / marking the turn
          // dispatched. runTool() gates on visibility too (it is the choke point
          // that also covers the bootstrap), but parking only there would leave
          // this block's side effects applied for the whole minimize:
          //   - the chip spins "running" while nothing actually runs, and
          //     elapsedOn(zsToolT0) counts the parked time, so a 20-min minimize
          //     renders a bogus "1200.0s" on the call;
          //   - rememberExecuted() would mark the turn dispatched before it ever
          //     ran, so a reload/close while parked loses the command for good -
          //     the auto-resume watchdog refuses to re-fire an "executed" turn.
          // Parking first keeps all of that truthful: we only commit once we are
          // foreground and about to really dispatch.
          if (document.hidden && !A.stop) {
            diag("tool.parkBeforeDispatch", { name: call.tool });
            if (!(await waitVisible()) || A.stop) break;
          }
          // Loading chip with the real args (loop owns this item from here).
          decorate.toolBox(res.item, call.tool, "run", argSummary(call), true, callBody(call), category);
          A.toolSettle = null; // a fresh call: no settled outcome yet
          A.toolRunning = true;
          A.toolStart = Date.now();
          A.toolName = call.tool;
          A.toolItem = res.item;
          A.toolArg = argSummary(call);
          // Record this turn as dispatched OFF the DOM so the auto-resume
          // watchdog never re-fires it after a scroll re-render wipes the node's
          // zloop/zResume markers (see the `executed` map).
          rememberExecuted(res.item);
          diag("tool.start", { name: call.tool });
          const feedback = await runTool(call);
          A.toolRunning = false;
          diag("tool.done", { name: call.tool, ok: !feedback.startsWith("ERROR"), out: feedback.slice(0, 50) });
          if (A.stop) {
            // User halted mid-tool: settle the spinning chip so it doesn't look
            // stuck loading forever, and MARK the turn so the sweep classifier
            // never repaints it ✓ done once generation ends (the real cause of a
            // stopped call still going green a moment later).
            if (res.item) { res.item.dataset.zStopped = "1"; rememberHalted(res.item); }
            decorate.toolBox(res.item, call.tool, "err", "stopped", true, "", category);
            break;
          }
          const isErr = feedbackIsError(feedback);
          const outBody = stripOutputPrefix(feedback);
          // Trace the chip's DERIVED phase vs summary. Blender (and any MCP whose
          // output leads with a warning/diagnostic line) resolves ✓ done - the
          // payload starts "Output of…", not "ERROR" - yet outSummary shows its
          // FIRST line, which is the warning. Captures firstLine vs a later
          // success line so we can see the mismatch without guessing.
          {
            const lns = outBody.split("\n").map((l) => l.trim()).filter(Boolean);
            diag("tool.result", { name: call.tool, isErr, phase: isErr ? "err" : "done",
              summary: outSummary(feedback), lineCount: lns.length,
              firstLine: (lns[0] || "").slice(0, 90), lastLine: (lns[lns.length - 1] || "").slice(0, 90) });
          }
          // A tool (Roblox OR any custom MCP server) that actually RETURNED an
          // image becomes a "screen" chip - even if its name never let us guess.
          // Reactive, not predictive: A.pendingImages is set by runTool before it
          // returns. Remember the name so its next call is optimistic (see above).
          const hasImages = !!(A.pendingImages && A.pendingImages.length);
          if (hasImages) rememberImageTool(call.tool);
          const resultCat = hasImages ? "screen" : category;
          decorate.toolBox(res.item, call.tool, isErr ? "err" : "done", outSummary(feedback),
            true, outBody, resultCat);
          // Snapshot the settled outcome. If the site swaps this turn's DOM node
          // while we wait for the model's next turn (wiping the chip AND the
          // zloop ownership dataset), the sweep re-owns the fresh node with this
          // outcome instead of letting branch-3 classification re-spin a "run"
          // chip on an already-executed call.
          A.toolSettle = {
            phase: isErr ? "err" : "done", detail: outSummary(feedback),
            body: outBody, category: resultCat, count: P.assistantCount(),
            // Node IDENTITY of the settled turn (virtualization-proof), when the
            // provider exposes it. The count guard alone misfires on Qwen: the
            // list virtualizes so assistantCount() doesn't grow for the model's
            // NEXT turn, and back-to-back calls to the SAME tool defeat the name
            // guard too - the sweep then re-owned the STREAMING next turn's chip
            // with the previous done/err outcome (seen live: 5x chip.reown with
            // gen:true, rp tiny).
            id: P.lastAssistantId ? P.lastAssistantId() : undefined,
          };

          // Re-inject the command list every REMIND_TOOLS_EVERY successful calls.
          // Appended UNDER the tool result and clearly marked as a reminder, so a
          // model that has drifted from the exact command names gets re-anchored
          // without it looking like a new result to act on. Errors don't count
          // (they already restate what's wrong) and list_commands is redundant.
          let toSend = feedback;
          if (!isErr && call.tool !== "list_commands" && A.toolList.length) {
            A.toolCallsSinceReminder++;
            if (A.toolCallsSinceReminder >= REMIND_TOOLS_EVERY) {
              A.toolCallsSinceReminder = 0;
              // Scope the reminder to the primary Roblox server, exactly like
              // list_commands: re-injecting EVERY connected server's tools (Blender
              // etc.) merged flat would bloat the model's context - the opposite of
              // what the model gets when it lists commands itself. Anti-drift only
              // needs the primary Roblox set; addon commands were listed on demand
              // and the bridge routes by name regardless.
              toSend += ZS.toolsReminder(activeTools(), ui.getTargetName(), selectedTargetId);
              if (selectedTargetId === "roblox") toSend += "\n" + ZS.memoryNudge();
              diag("tools.reminder", { after: REMIND_TOOLS_EVERY });
            }
          }
          // This result becomes a turn, so it counts toward the re-statement
          // budget - context volume is what makes the site summarise, and the
          // volume is overwhelmingly tool results, not how often the user types.
          bumpSys("results");
          // Ride the system-prompt re-statement out on this result if one is due
          // and it fits (see withSysResend - the result itself is never trimmed).
          toSend = withSysResend(toSend);
          const images = A.pendingImages;
          A.pendingImages = null;
          diag("images.consumed", { count: images ? images.length : 0 });
          base = await submitAndGetBase(toSend, images);
        }
      }
    } catch (e) {
      diag("loop.error", { msg: String((e && e.message) || e) });
      ui.banner("warn", "Internal loop error", String((e && e.message) || e));
    } finally {
      A.running = false;
      A.stop = false;
      // Keep the "Stopping…" state while the site's stream is still draining
      // after a user stop: the loop often ends BEFORE the native stop takes
      // effect (loop.end fires with gen still true - seen live on DeepSeek),
      // and clearing the flag here let the next sweep restore a clickable
      // "■ Stop" for the last beat of the dying stream (the Stopping… → Stop →
      // gone bounce). The sweep's self-heal clears it - and retries the native
      // stop - once the site is actually quiet.
      const draining = A.stopping && A.started && P.isHardGenerating();
      if (A.stopping && draining) diag("stop.drain", { keptStopping: true });
      A.stopping = draining;
      A.toolRunning = false;
      A.toolSettle = null;
      A.loopKey = null;
      ui.showStop(false);
      _wdCleanup();
      ui.inputCover(false); // lift the "Agent is working" cover when the loop ends
      P.setInputLock(false); // always unlock, even on error or stop
      diag("loop.end");
    }
    return finalText;
  }

  // Mark the current assistant turn as user-halted so the sweep classifier shows
  // its command chip as "stopped" instead of repainting it ✓ done when
  // generation ends. Cleared on a deliberate resume (native Continue).
  //
  // The dataset marker alone is NOT enough: sites re-render the whole history
  // when the next user message lands (seen live on DeepSeek), replacing the
  // halted turn's node and wiping dataset.zStopped - and since a fresh user
  // message also clears the A.userStopped latch by design, nothing said
  // "stopped" anymore and the chip went ✓ green. So halted turns are ALSO
  // remembered here, keyed independently of the DOM node (conversation +
  // position among assistant turns + a text prefix), and the sweep re-stamps
  // the marker whenever the node was swapped.
  const halted = new Map(); // "conv|turnKey" → text prefix at halt time
  const assistantIdx = (item) => P.allItems().filter(P.isAssistantItem).indexOf(item);
  // Virtualization-stable map key for the off-DOM executed/halted memories.
  // assistantIdx is POSITIONAL within the currently-rendered window, so on a
  // virtualized list (DeepSeek/Qwen/GLM/Arena) scrolling up renders a different
  // set of turns and an OLD command turn takes a low index that COLLIDES with a
  // current turn's key - the dedupe then misses and the watchdog re-fires the
  // scrolled-back tool. Prefer the provider's stable per-turn id when it exposes
  // one (P.itemKey); fall back to the index for non-virtualized providers.
  const turnKey = (item) => {
    if (P.itemKey) {
      const k = P.itemKey(item);
      if (k != null) return `k${k}`;
    }
    return String(assistantIdx(item));
  };
  function rememberHalted(item) {
    try {
      if (!item || assistantIdx(item) < 0) return;
      const pref = (P.itemText(item) || "").slice(0, 60);
      // A stop during the REASONING phase leaves the answer text EMPTY - an
      // empty/short prefix would then startsWith-match ANY later turn at this
      // index (seen live: a fresh streaming command went red "stopped" on the
      // spot). Too little text to identify → rely on the dataset marker only.
      if (pref.trim().length < 12) return;
      halted.set(`${P.conversationKey()}|${turnKey(item)}`, pref);
    } catch {}
  }
  function forgetHalted(item) {
    if (!item || !halted.size) return;
    try { halted.delete(`${P.conversationKey()}|${turnKey(item)}`); } catch {}
  }
  // The halt was recorded MID-stream, so the stored text is a PREFIX of the
  // turn's final text - match on startsWith, never equality.
  function isRememberedHalted(item, txt) {
    if (!halted.size) return false;
    try {
      const pref = halted.get(`${P.conversationKey()}|${turnKey(item)}`);
      return pref != null && (txt || "").startsWith(pref);
    } catch { return false; }
  }
  function markStoppedTurn() {
    const it = P.lastAssistant();
    if (!it) return;
    it.dataset.zStopped = "1";
    rememberHalted(it);
  }

  // Off-DOM record of assistant turns whose command has ALREADY been dispatched
  // (by the normal loop OR the auto-resume watchdog). The dataset markers that
  // dedupe re-execution (zResume / zloop) live on the DOM NODE - but sites
  // virtualize long conversations, so scrolling up DESTROYS and RECREATES a
  // turn's node, wiping those markers. The fresh node then looks un-run, and the
  // watchdog can re-fire the turn's tool with no live generation at all (the
  // "tools execute when I scroll back" bug). Mirror the `halted` map exactly
  // (keyed by conversation + assistant index + a text prefix, NOT the node) so
  // the "already ran this" memory survives node recreation. This makes
  // re-execution IDEMPOTENT regardless of any isGenerating/lastGenAt heuristic
  // misfire - the hard part (is this a live turn?) can be wrong without harm.
  const executed = new Map(); // "conv|turnKey" → text prefix at dispatch time
  // ── Scroll-away suppression ───────────────────────────────────────────────
  // The user's own rule, requested after the replay bug: while they scroll UP
  // through history, nothing about the agent may look alive. Scrolling a
  // virtualized transcript renders different turns, which makes the "last
  // rendered turn" lie about liveness (bar shows Stop, watchdog thinks a reply
  // is still coming). Rather than keeping a growing pile of per-turn heuristics,
  // we detect the gesture itself and SUPPRESS the busy surface for a short
  // window. This is a UI/`watchdog` gate only: it never cancels a real run, it
  // just stops the indicators (and the resume logic) from acting on a scroll.
  const SCROLL_SUPPRESS_MS = 4000;
  let scrollUpAt = 0;
  let scrollSuppressUntil = 0;
  function noteScrollUp() {
    const now = Date.now();
    scrollUpAt = now;
    scrollSuppressUntil = now + SCROLL_SUPPRESS_MS;
  }
  const scrollSuppressed = () => Date.now() < scrollSuppressUntil;
  // Hold until the suppression window lapses (see core/guard.js: logistics live
  // there so they can be tested in node without a DOM).
  const waitScrollWindow = () =>
    ZSGuard.holdUntilScrollLapses({
      isSuppressed: scrollSuppressed,
      isStopped: () => !!A.stop,
      sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
      capMs: SCROLL_SUPPRESS_MS * 2 + 500,
    });
  function installScrollDetector() {
    try {
      // Position must be tracked PER SCROLLABLE ELEMENT. The listener is on
      // `document` in the capture phase, so it sees the transcript, the sidebar,
      // code blocks and textareas alike. A single shared _lastScrollTop compared
      // a value from one element against a value from another: scrolling the
      // sidebar down to 900 and then the transcript (at 400) looked like an
      // upward move of 500px and suppressed execution for no reason. A WeakMap
      // keeps one last position per element and lets them be collected.
      const tracker = ZSGuard.createScrollTracker(24);
      // Is this target part of the CONVERSATION transcript? Both listeners must
      // answer the same question, otherwise the scroll and wheel paths disagree
      // about what counts as "scrolling history".
      //
      // `main` is deliberately NOT used as a fallback: it matches nearly the
      // whole page, which would let a sidebar or composer gesture through. The
      // provider's message selector is the real signal; a plain article is the
      // only generic fallback, and a composer/editor is always excluded.
      //
      // The two listeners get DIFFERENT kinds of target, so the test has to look
      // in both directions:
      //   wheel  -> the element under the cursor, a DESCENDANT of the transcript,
      //             so `closest()` walking up finds it;
      //   scroll -> the element that scrolled, normally the transcript CONTAINER
      //             (an ancestor of every message), so `closest()` finds nothing
      //             and the event has to be accepted when the target CONTAINS a
      //             message instead. Window-level scrolling reports `document`,
      //             which has no `closest` at all and is the provider's scroller
      //             for some layouts, so it is accepted as the transcript too.
      //
      // A filter that only walked up silently dropped scrollbar, keyboard and
      // touch scrolling while the wheel path kept working - a regression on the
      // exact gesture the suppression exists for.
      const inTranscript = (t) => {
        if (!t) return false;
        // The window/document scroller is the transcript for window-level
        // layouts; a composer or editor is never the transcript.
        if (t === document || t === document.documentElement || t === window) return true;
        if (!t.closest) return false;
        if (t.closest("textarea, input, .cm-editor, [contenteditable='true']")) return false;
        const msgSel = P.msgSel || "[data-message-author-role]";
        // Upward: the target sits inside a message (wheel, inner scrollables).
        if (t.closest(msgSel) || t.closest("article")) return true;
        // Downward: the target is the scroll container that holds messages.
        return !!(typeof t.querySelector === "function" && (t.querySelector(msgSel) || t.querySelector("article")));
      };
      const topOf = (t) => {
        if (t && typeof t.scrollTop === "number" && t !== document && t !== document.documentElement) {
          return { key: t, top: t.scrollTop };
        }
        return { key: document.documentElement, top: window.scrollY || document.documentElement.scrollTop || 0 };
      };
      const onScroll = (ev) => {
        const target = ev && ev.target;
        // The same transcript-only rule as the wheel listener below.
        if (!inTranscript(target)) return;
        const { key, top } = topOf(target);
        // Moving UP through a turn is the problematic gesture. The 24px
        // threshold ignores layout jitter and stream-driven auto-scroll (which
        // only ever moves DOWN as the reply grows).
        if (tracker.observe(key, top)) noteScrollUp();
      };
      // capture:true - ChatGPT scrolls inner containers, not just the window.
      track(document, "scroll", onScroll, { capture: true, passive: true });
      // WHEEL: only a gesture over the transcript counts. Scrolling up inside the
      // sidebar, a code block or the composer is unrelated to replaying history,
      // and used to hold execution as if the user had scrolled the conversation.
      const onWheel = (ev) => {
        if (!(ev && ev.deltaY < 0)) return;
        if (!inTranscript(ev.target)) return;
        noteScrollUp();
      };
      track(window, "wheel", onWheel, { passive: true });
    } catch {}
  }
  installScrollDetector();
  function rememberExecuted(item) {
    if (!item) return;
    try {
      if (assistantIdx(item) < 0) return;
      const pref = (P.itemText(item) || "").slice(0, 60);
      // Same guard as rememberHalted: too little text to identify the turn (a
      // command still streaming) would startsWith-match any later turn at this
      // index. Fall back to the dataset marker until there is enough text.
      if (pref.trim().length < 12) return;
      executed.set(`${P.conversationKey()}|${turnKey(item)}`, pref);
    } catch {}
  }
  function isRememberedExecuted(item, txt) {
    if (!executed.size) return false;
    try {
      const pref = executed.get(`${P.conversationKey()}|${turnKey(item)}`);
      return pref != null && (txt || "").startsWith(pref);
    } catch { return false; }
  }
  function stopLoop() {
    if (A.stopping) return; // already winding down - ignore double-clicks
    diag("stopLoop");
    A.stop = true;
    A.stopping = true;
    A.stopAt = Date.now(); // grace anchor for the regenerate-as-resume gates
    // Baseline for the stop-retry growth gate (see the self-heal in the meter
    // loop): a retry is only allowed if the reply keeps growing PAST this,
    // proving the first stop click was swallowed. Without it, retries clicked a
    // wedged (already-stopped) stop button and Gemini killed the NEXT turn.
    A.stopStreamLen = P.streamLen ? P.streamLen() : 0;
    A.userStopped = true; // suppress auto-resume until the next user message
    A.resumeArmed = false; // a stop overrides any pending regenerate grace
    // Disarm any pending optimistic pre-hide (armed in submitAndGetBase for the
    // feedback turn we just sent - see the re-arm note there). The input unlocks
    // right after this function returns, but the window can still be open for a
    // couple more seconds (e.g. mid-image-upload); without this, a message the
    // user types fast right after Stop could be the "next new user turn" the
    // window masks by mistake, instead of the (now abandoned) feedback turn.
    A.injectHideUntil = 0;
    markStoppedTurn();
    // A tool's loading chip is only settled AFTER its `await runTool()` resolves
    // (the if(A.stop) branch in agentLoop). A long-running call (e.g. a big
    // multi_edit) leaves that await pending, so the chip would keep spinning for
    // seconds after the user pressed Stop. Settle it to the stopped state right
    // now; the loop's own settle on resolve is idempotent.
    if (A.toolRunning && A.toolItem) {
      A.toolItem.dataset.zStopped = "1";
      rememberHalted(A.toolItem);
      decorate.toolBox(A.toolItem, A.toolName, "err", "stopped", true, "", ZS.toolCategory(A.toolName));
    }
    ui.markStopping();    // instant feedback: button → "⏳ Stopping…", disabled
    P.stopGeneration();
    ui.toast("Stopping…");
  }

  // The full system prompt for the CURRENT provider and user settings. One
  // definition, used both by the bootstrap and by the periodic re-injection, so
  // the two can never drift apart.
  // Skills found in the workspace (.snapgent/skills/<name>/SKILL.md), as
  // [{ name, description, path }]. Filled by the skills loader; empty = feature off.
  let workspaceSkills = [];
  // Every skill found on disk (enabled or not), for the Skills settings popup.
  let allSkills = [];
  // Persisted map { skillName: boolean }. A skill never toggled counts as enabled.
  const SKILLS_ENABLED_KEY = "zsSkillsEnabled";
  let skillsEnabled = {};
  try {
    chrome.storage.local.get(SKILLS_ENABLED_KEY, (result) => {
      const saved = result && result[SKILLS_ENABLED_KEY];
      if (saved && typeof saved === "object" && !Array.isArray(saved)) skillsEnabled = saved;
    });
  } catch (error) {
    console.warn("[snapgentV3] Could not load skill toggles:", error);
  }
  function isSkillEnabled(name) {
    return skillsEnabled[name] !== false;
  }
  function setSkillEnabled(name, on) {
    skillsEnabled = { ...skillsEnabled, [name]: !!on };
    try { chrome.storage.local.set({ [SKILLS_ENABLED_KEY]: skillsEnabled }); } catch {}
    workspaceSkills = allSkills.filter((s) => isSkillEnabled(s.name));
  }

  // Scan .snapgent/skills/*/SKILL.md and fill workspaceSkills with name +
  // one-line description (progressive disclosure: bodies are read on demand by
  // the model via read_file). Never throws; on any problem the list stays empty.
  async function loadWorkspaceSkills() {
    workspaceSkills = [];
    try {
      const tools = activeTools();
      const findTool = tools.find((t) => bareToolName(t.name) === "find_files");
      const readTool = tools.find((t) => bareToolName(t.name) === "read_file");
      if (!findTool || !readTool) return;
      const found = await bg({ type: "call_tool", name: findTool.name,
        arguments: { path: ".snapgent/skills", pattern: "**/SKILL.md" }, timeout: 5000 });
      if (!found || !found.ok || !found.text) return;
      let paths;
      try { paths = JSON.parse(found.text); } catch { return; }
      if (!Array.isArray(paths)) return;
      const out = [];
      for (const p of paths.slice(0, 30)) {
        if (typeof p !== "string") continue;
        const r = await bg({ type: "call_tool", name: readTool.name,
          arguments: { path: p }, timeout: 5000 });
        if (!r || !r.ok || !r.text) continue;
        const fm = r.text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
        if (!fm) continue;
        const clean = (v) => (v || "").trim().replace(/^["']|["']$/g, "").replace(/\s+/g, " ");
        const name = clean((fm[1].match(/^name:\s*(.+)$/m) || [])[1]);
        const description = clean((fm[1].match(/^description:\s*(.+)$/m) || [])[1]).slice(0, 200);
        if (!name || !description) continue;
        out.push({ name, description, path: p });
      }
      allSkills = out;
      workspaceSkills = out.filter((s) => isSkillEnabled(s.name));
      diag("skills.loaded", { count: out.length, enabled: workspaceSkills.length });
    } catch (error) {
      log("Could not load workspace skills:", error);
    }
  }

  // Validate pasted SKILL.md text. Returns { ok, name, description } or { ok:false, error }.
  const SKILL_MAX_BYTES = 20 * 1024;
  function validateSkillText(text) {
    if (typeof text !== "string" || !text.trim()) return { ok: false, error: "Empty content." };
    if (new Blob([text]).size > SKILL_MAX_BYTES) return { ok: false, error: "Too large (max 20 KB)." };
    const fm = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
    if (!fm) return { ok: false, error: "Missing frontmatter (--- name / description ---)." };
    const clean = (v) => (v || "").trim().replace(/^["']|["']$/g, "").replace(/\s+/g, " ");
    const name = clean((fm[1].match(/^name:\s*(.+)$/m) || [])[1]);
    const description = clean((fm[1].match(/^description:\s*(.+)$/m) || [])[1]);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64)
      return { ok: false, error: "name must be lowercase letters, digits and hyphens only (max 64)." };
    if (!description) return { ok: false, error: "description is required." };
    if (description.length > 200) return { ok: false, error: "description is too long (max 200 characters)." };
    return { ok: true, name, description };
  }

  // Write a validated skill to .snapgent/skills/<name>/SKILL.md. create_file never
  // overwrites, so an existing name is rejected. Imported skills start DISABLED.
  async function importSkillText(text) {
    const v = validateSkillText(text);
    if (!v.ok) return v;
    const createTool = activeTools().find((t) => bareToolName(t.name) === "create_file");
    if (!createTool) return { ok: false, error: "create_file is not available on this server." };
    if (allSkills.some((s) => s.name === v.name)) return { ok: false, error: `A skill named "${v.name}" already exists.` };
    const r = await bg({ type: "call_tool", name: createTool.name,
      arguments: { path: `.snapgent/skills/${v.name}/SKILL.md`, content: text }, timeout: 8000 });
    if (!r || !r.ok) return { ok: false, error: (r && (r.error || r.text)) || "Write failed." };
    setSkillEnabled(v.name, false);
    return { ok: true, name: v.name };
  }

  // Global skill library: stored in chrome.storage (not in any workspace). The
  // model cannot read these, so they must be installed into a workspace (through
  // the same review + importSkillText path) before they take effect.
  const GLOBAL_SKILLS_KEY = "zsGlobalSkills";
  let globalSkills = {}; // { name: { description, text } }
  try {
    chrome.storage.local.get(GLOBAL_SKILLS_KEY, (result) => {
      const saved = result && result[GLOBAL_SKILLS_KEY];
      if (saved && typeof saved === "object" && !Array.isArray(saved)) globalSkills = saved;
    });
  } catch (error) {
    console.warn("[snapgentV3] Could not load global skills:", error);
  }
  function persistGlobalSkills() {
    try { chrome.storage.local.set({ [GLOBAL_SKILLS_KEY]: globalSkills }); } catch {}
  }
  function saveGlobalSkill(text) {
    const v = validateSkillText(text);
    if (!v.ok) return v;
    if (globalSkills[v.name]) return { ok: false, error: `A global skill named "${v.name}" already exists.` };
    globalSkills = { ...globalSkills, [v.name]: { description: v.description, text } };
    persistGlobalSkills();
    return { ok: true, name: v.name };
  }
  function removeGlobalSkill(name) {
    const next = { ...globalSkills };
    delete next[name];
    globalSkills = next;
    persistGlobalSkills();
  }

  function systemPrompt() {
    return ZS.buildSystemPrompt({
      siteName: P.displayName,
      customPrompt: ui.getCustomPrompt(),
      providerNotes: P.promptExtra || "",
      targetServer: selectedTargetId,
      targetName: ui.getTargetName(),
      skills: workspaceSkills,
      compact: !!P.compactPrompt,
    });
  }

  // ── Periodic system-prompt re-injection (opt-in, per provider) ────────────
  // Some sites aggressively summarise their own context mid-conversation. When
  // that happens the model keeps the gist of the task but loses the MECHANISM:
  // it forgets that an extension reads its replies and executes them, and starts
  // answering "I can't invoke those commands in this session" while the
  // extension sits there ready and waiting. Observed repeatedly on ChatGPT.
  //
  // The periodic tools reminder does NOT fix this: it re-anchors command NAMES,
  // but it never restates that the commands actually run. So providers that need
  // it set `resendSystemEvery`, and the whole prompt goes back in.
  //
  // Delivery rides on the next injected tool result rather than costing its own
  // message - free and invisible. But that channel dries up in exactly the case
  // this exists for (a model that has forgotten it can call tools stops calling
  // them, so no results flow), so a fallback sends it as its own masked turn
  // once the window has elapsed with nothing to piggyback on.
  const RESEND_SYS_EVERY = P.resendSystemEvery || 0;
  // Injected tool results get their own, larger budget (see sysResendDue).
  const RESEND_SYS_EVERY_RESULTS = 12;

  // How much conversation has accumulated since the operating instructions were
  // last stated. PERSISTED per conversation, because both simpler designs failed
  // in opposite directions - each caught live on 2026-08-14:
  //
  //  - An in-memory counter RESETS on every page reload, while the session
  //    itself survives one (A.started is persisted). After an F5, or a silent
  //    Chrome extension auto-update, the tally restarted and the re-statement
  //    could be postponed indefinitely.
  //  - Walking the DOM back to the last SYS_MARKER turn is reload-proof but
  //    UNDER-counts badly: these sites virtualize. Measured on a real ChatGPT
  //    session that had long passed the threshold - only 12 turns were rendered,
  //    the marker was not among them (so the walk silently counted from the top
  //    of the window) and it saw 5 injected results instead of the true total.
  //
  // Counting at INJECTION time and persisting sidesteps both: it is exact, and
  // virtualization cannot erase it. The DOM walk is kept as a floor, since a
  // conversation that visibly shows the threshold is due no matter what storage
  // says (e.g. a session adopted from another device, or storage cleared).
  const sysKey = () => `zsSys:${P.conversationKey() || "new"}`;
  let sysCount = { users: 0, results: 0 };
  let sysCountKey = "";

  // Hydrate from storage. Only meaningful at startup / on a conversation switch;
  // it never overwrites counts already accumulated in this tick's memory (a
  // bump that landed while the async read was in flight must not be lost).
  async function loadSysCount() {
    const k = sysKey();
    if (k === sysCountKey) return sysCount;
    sysCountKey = k;
    const local = sysCount;
    sysCount = { users: 0, results: 0 };
    try {
      const r = await new Promise((res) => chrome.storage.local.get(k, res));
      const saved = r && r[k];
      if (saved) sysCount = {
        users: Math.max(saved.users || 0, local.users || 0),
        results: Math.max(saved.results || 0, local.results || 0),
      };
    } catch {}
    return sysCount;
  }
  function saveSysCount() {
    try { chrome.storage.local.set({ [sysCountKey]: sysCount }); } catch {}
  }
  // Increment SYNCHRONOUSLY, persist asynchronously. sysResendDue() reads
  // sysCount in the same tick as the bump that should trip it, so deferring the
  // increment into the storage promise made the tally lag a full turn behind and
  // the threshold was never seen at the moment it mattered (caught live: 12 tool
  // results, counter still reading 11, no rider). Storage is a durability
  // mechanism here, not the source of truth for the current tick.
  function bumpSys(field) {
    if (!RESEND_SYS_EVERY) return;
    if (sysCountKey !== sysKey()) { sysCountKey = sysKey(); }
    sysCount[field]++;
    saveSysCount();
  }
  function resetSysCount() {
    sysCount = { users: 0, results: 0 };
    saveSysCount();
  }

  // Lower bound read straight from what is on screen (see above).
  function sinceLastSysInDom() {
    const items = P.allItems();
    let users = 0, results = 0;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      const txt = P.classifyText(it, ".zs-chip");
      // The bootstrap turn and every rider both carry the marker - either one
      // means the rules were fully stated here, so stop counting.
      if (txt.includes(ZS.SYS_MARKER)) break;
      if (!P.isUserItem(it)) continue;
      if (ZSParse.isInjectedFeedback(txt)) results++;
      else users++;
    }
    return { users, results };
  }

  function sinceLastSys() {
    const dom = sinceLastSysInDom();
    return {
      users: Math.max(sysCount.users, dom.users),
      results: Math.max(sysCount.results, dom.results),
    };
  }

  // A re-statement is owed once EITHER budget is spent. Two triggers because
  // they measure different things: user turns track a long back-and-forth, while
  // injected results track context VOLUME - and volume is what actually makes
  // the site summarise. Measured live on 2026-08-14: in a real session 5 of the
  // 6 "user" turns were injected tool results and only ONE was typed by Seb, so
  // a user-turn-only trigger sat at 1/6 while five full tool payloads had
  // already landed. The results budget is the one that fires in practice.
  function sysResendDue() {
    if (!RESEND_SYS_EVERY) return false;
    const { users, results } = sinceLastSys();
    const due = users >= RESEND_SYS_EVERY || results >= RESEND_SYS_EVERY_RESULTS;
    // Logged sparsely on purpose: this is consulted on EVERY tool result, and an
    // entry each time would flush the 300-slot diag ring of everything else -
    // exactly the history you need when something goes wrong. The verdict turn
    // and every 4th result is enough to reconstruct the tally.
    if (due || results % 4 === 0) {
      diag("sys.tally", {
        users, results, due,
        mem: `${sysCount.users}/${sysCount.results}`,
        need: `${RESEND_SYS_EVERY}u ${RESEND_SYS_EVERY_RESULTS}r`,
      });
    }
    return due;
  }
  // Attach the prompt to an outgoing tool result IF it fits. The result is never
  // truncated to make room: the passenger is dropped and the flag stays raised,
  // so it rides the next result instead. A tool result the model is waiting on
  // is always worth more than a reminder.
  function withSysResend(text) {
    if (!sysResendDue()) return text;
    const prompt = systemPrompt();
    const rider =
      "\n\n────────────────────────────────\n" +
      ZS.RESEND_MARKER + "\n" +
      "(System note from snapgentV3 - an automatic re-statement of your operating " +
      "instructions, NOT a new request and NOT something to reply to. This conversation " +
      "may have been summarised, which drops the part explaining how you actually run " +
      "commands. To be explicit: the snapgentV3 extension IS running in this page right " +
      "now, it DOES read your replies, and the commands below DO execute for real - the " +
      "results you have been receiving are proof of it. Keep using them exactly as " +
      "described. Just carry on with the task; do not acknowledge this note.)\n" +
      prompt;
    const cap = P.sendCharBudget || Infinity;
    if (text.length + rider.length > cap) {
      // Stays due - the next (smaller) result carries it.
      diag("sys.resendDeferred", { result: text.length, rider: rider.length, cap });
      return text;
    }
    const spent = sinceLastSys();
    resetSysCount();
    A.sysResendAt = Date.now();
    diag("sys.resend", { via: "toolResult", chars: rider.length, ...spent });
    return text + rider;
  }

  // ════════════════════════════════════════════════════════════════════════
  //  SESSION BOOTSTRAP  ("Starting Up" animated chip, shown in the conversation)
  // ════════════════════════════════════════════════════════════════════════
  async function startSession(modeOpts) {
    if (A.running || A.starting) return;
    // "Start session" is allowed ONLY on a blank conversation. Opening an
    // EXISTING conversation must never trigger the bootstrap.
    if (!P.chatIsEmpty() && !A.started) {
      ui.toast("Use an empty chat.");
      return;
    }
    A.userStopped = false;
    A.lastStartFailure = "";
    A.failedBoot = false;
    const bootKey0 = P.conversationKey();
    if (bootKey0) failedStartKeys.delete(bootKey0);
    A.stop = false;               // clear any halt left by a prior aborted bootstrap
    // Snapshot any turn already on screen at session start (normally none on a
    // clean new chat; on a reload-restored generation it's the stray turn). The
    // auto-resume watchdog refuses to run a tool from this baseline turn so a
    // restored execute_luau can't leak into the freshly started conversation.
    A.bootBaselineId = P.lastAssistantId ? P.lastAssistantId() : null;
    A.starting = true;
    const myGen = ++A.startGen;   // identity of THIS bootstrap
    A.startingKey = null;          // unknown until the conversation gets an id
    const alive = () => A.startGen === myGen; // false once superseded/aborted
    A.toolCallsSinceReminder = 0; // fresh reminder cadence for the new session
    ui.setStarting(true);
    ui.updateStartGate(); // refresh the bar into its "starting" state
    P.setInputLock(true); // block user input during bootstrap
    ui.inputCover(true);  // cover the composer ("Working…") for the WHOLE Starting Up
    try {
      await ensureTools(true); // boot: always take a fresh catalogue (the TTL then
                               // covers the list_commands / list_mcp_servers calls
                               // the model makes seconds later)
      if (!alive()) return;
      const selectedTools = activeTools();
      const vscodeServer = (A.bridge && A.bridge.servers || []).find((server) => server.id === "vscode");
      if (selectedTargetId === "vscode" && A.bridge && A.bridge.connected &&
          vscodeServer && vscodeServer.alive &&
          !selectedTools.some((tool) => bareToolName(tool.name) === "list_dir")) {
        ui.banner("warn", "VS Code workspace required",
          "Open a project folder in VS Code, then try again.");
        return;
      }
      if (!activeTools().length) {
        ui.banner("warn", `${ui.getTargetName()} tools unavailable`,
          `Is the server online?`);
        return;
      }
      if (selectedTargetId === "vscode") {
        const workspaceTool = activeTools().find((tool) => bareToolName(tool.name) === "list_dir");
        if (!workspaceTool) {
          ui.banner("warn", "VS Code workspace required",
            "Open a project folder in VS Code, then try again.");
          return;
        }
        const probe = await bg({
          type: "call_tool",
          name: workspaceTool.name,
          arguments: { path: "." },
          timeout: 5000,
        });
        if (!alive()) return;
        if (!probe || !probe.ok) {
          ui.banner("warn", "VS Code workspace required",
            "Open a project folder in VS Code, then try again.");
          return;
        }
      }
      const modeState = await P.ensureComposerReady("startup", modeOpts);
      if (!alive()) return;
      if (!modeState.ready) {
        A.lastStartFailure = `${P.displayName} mode not ready`;
        ui.banner("warn", `${P.displayName} mode not ready`,
          `Try a new chat or reload.`);
        return;
      }
      if (selectedTargetId === "vscode") await loadWorkspaceSkills();
      if (!alive()) return;
      const prompt = systemPrompt();
      const base = await submitAndGetBase(prompt);
      if (!alive()) return;
      // (syncSessionState pins A.startingKey to the conversation id once the chat
      // has content, and aborts this bootstrap if the user opens a new empty chat.)
      decorate.sweep(); // show the animated "Starting Up" chip immediately
      const startRes = await waitForResponse(base);
      if (!alive()) return;
      // The user halted the bootstrap (our Stop or the site's native stop). Do
      // NOT declare the session ready - abort quietly so "Start" stays available.
      if (A.stop || startRes.kind === "stopped") { diag("start.aborted", { kind: startRes.kind }); return; }

      // If the model calls list_commands as instructed, run it and wait for the "ready" reply.
      const firstName = startRes.calls && startRes.calls[0] && startRes.calls[0].tool;
      if (startRes.kind === "tool" && startRes.calls && startRes.calls.length === 1 &&
          (firstName === "list_commands" || firstName === "list_tools")) {
        decorate.toolBox(startRes.item, "Loading commands", "run", "", true);
        const toolFeedback = await runTool(startRes.calls[0]);
        // Roblox down short-circuits list_commands into a plain "offline" note
        // (main.js, list_commands handler) instead of the real catalogue - detect
        // that and show it as such, rather than the STALE cached tool count below
        // (the bridge keeps advertising Roblox's catalogue even with no Studio
        // attached, so A.toolList still has 25+ entries that were never actually
        // usable this boot).
        if (/currently OFFLINE|No commands available|no server named/i.test(toolFeedback)) {
          decorate.toolBox(startRes.item, "Loading commands", "err", `${ui.getTargetName()} unavailable`, true);
        } else {
          decorate.toolBox(startRes.item, "Loading commands", "done", `${activeTools().length} commands`, true);
        }
        const base2 = await submitAndGetBase(toolFeedback);
        const readyRes = await waitForResponse(base2); // wait for "I'm ready" reply
        if (!alive()) return;
        if (A.stop || readyRes.kind === "stopped") { diag("start.aborted", { kind: readyRes.kind }); return; }
        if (readyRes.kind === "empty" || readyRes.kind === "timeout" ||
            readyRes.kind === "context_limit" || readyRes.kind === "too_long" ||
            readyRes.kind === "fallback_turn") {
          diag("start.readyFailed", { kind: readyRes.kind, detail: readyRes.detail || "" });
          A.lastStartFailure = readyRes.detail || `bootstrap acknowledgement failed (${readyRes.kind})`;
          ui.banner("warn", "Start did not complete", A.lastStartFailure);
          return;
        }
      } else if (startRes.kind === "fallback_turn") {
        // 2026-11 ChatGPT: the bootstrap was answered with a placeholder turn that
        // never renders its text. Declaring the session ready here would leave the
        // bar on a false "Active" with no agent behind it, so say what happened
        // and keep Start available.
        diag("start.noToolCall", { kind: startRes.kind });
        A.lastStartFailure = FALLBACK_TURN_TEXT;
        ui.banner("warn", "Start did not complete", FALLBACK_TURN_TEXT);
        return; // do NOT mark the session ready
      } else if (startRes.kind !== "tool") {
        // The bootstrap used to fall through to A.started = true with NO command
        // ever executed - the bar flipped to "Ready", yet nothing was wired and
        // every later tool call died silently. Report the real outcome instead.
        const kind = startRes.kind || "?";
        const raw = String(startRes.text || startRes.raw || "");
        diag("start.noToolCall", { kind, textLen: raw.length, head: raw.slice(0, 240) });
        const why = {
          empty: "reply was never read (0 chars) - message DOM not matched",
          timeout: "no reply appeared within the timeout",
          text: /"command"\s*:/.test(raw)
            ? "reply has a command block the parser rejected"
            : "model answered in prose without a command block",
          parse_error: `command block malformed (${startRes.reason || "?"})`,
          truncated: "reply was cut off before the command finished",
          context_limit: "conversation hit the context limit",
          too_long: "the message was too long for the site",
        }[kind] || `unexpected reply kind "${kind}"`;
        // Carry the site's own words (a quota banner, a length refusal) plus the
        // plain-English reason, so an A2A caller learns WHY it failed.
        A.lastStartFailure = startRes.detail ? `${startRes.detail} (${why})` : why;
        ui.banner("warn", "Start did not complete", why);
        return; // do NOT mark the session ready - "Start" must stay available
      }
      A.started = true;
      A.failedBoot = false;
      const bootOkKey = P.conversationKey();
      if (bootOkKey) failedStartKeys.delete(bootOkKey);
      rememberSession(bootOkKey); // survives virtualization AND reloads
      ui.setStarted(true);
      ui.toast(`Agent on.`);
    } catch (e) {
      A.lastStartFailure = String((e && e.message) || e);
      if (alive()) ui.banner("warn", "Startup failed", String((e && e.message) || e));
    } finally {
      // Only tear down our OWN starting state. If we were superseded (the user
      // opened another chat), the newer flow / syncSessionState owns it now.
      if (alive()) {
        if (!A.started && A.lastStartFailure) {
          A.failedBoot = true;
          const failKey = P.conversationKey();
          if (failKey) failedStartKeys.add(failKey);
        }
        A.starting = false;
        A.startingKey = null;
        ui.setStarting(false);
        ui.inputCover(false); // lift the Starting Up composer cover
        P.setInputLock(false); // always unlock after bootstrap
        decorate.sweep();
      }
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  //  SVG ICON SET  (stroke = currentColor, inherits the chip's theme colour)
  // ════════════════════════════════════════════════════════════════════════
  const SVG_NS = "http://www.w3.org/2000/svg";
  function chipEl(tag, className, text, ...children) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    for (const child of children) {
      if (child) node.appendChild(child);
    }
    return node;
  }
  function svgIcon(shapes) {
    const svg = document.createElementNS(SVG_NS, "svg");
    for (const [k, v] of Object.entries({
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "2",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    })) svg.setAttribute(k, v);
    for (const [tag, attrs] of shapes) {
      const shape = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) shape.setAttribute(k, String(v));
      svg.appendChild(shape);
    }
    return svg;
  }
  const CHEVRON_SHAPES = [["polyline", { points: "6 9 12 15 18 9" }]];
  const ICON_SHAPES = {
    screen: [["rect", { x: 3, y: 4, width: 18, height: 13, rx: 2 }], ["line", { x1: 8, y1: 21, x2: 16, y2: 21 }], ["line", { x1: 12, y1: 17, x2: 12, y2: 21 }]],
    roblox: [["path", { d: "M12 2 3 7v10l9 5 9-5V7z" }], ["path", { d: "M3 7l9 5 9-5M12 12v10" }]],
    read: [["circle", { cx: 11, cy: 11, r: 7 }], ["line", { x1: 21, y1: 21, x2: 16.65, y2: 16.65 }]],
    edit: [["path", { d: "M12 20h9" }], ["path", { d: "M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" }]],
    generate: [["path", { d: "M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8" }]],
    tool: [["path", { d: "M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2-2z" }]],
    result: [["path", { d: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" }], ["polyline", { points: "7 10 12 15 17 10" }], ["line", { x1: 12, y1: 15, x2: 12, y2: 3 }]],
    check: [["polyline", { points: "20 6 9 17 4 12" }]],
    // Bell - the mid-session system-prompt re-statement. Deliberately NOT the
    // gear: the gear means "the agent is starting up", and a reminder is the
    // opposite (a session already long enough to need re-anchoring).
    remind: [["path", { d: "M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" }], ["path", { d: "M13.7 21a2 2 0 0 1-3.4 0" }]],
    error: [["path", { d: "M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" }], ["line", { x1: 12, y1: 9, x2: 12, y2: 13 }], ["line", { x1: 12, y1: 17, x2: 12.01, y2: 17 }]],
    gear: [["circle", { cx: 12, cy: 12, r: 3 }], ["path", { d: "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-2.82 1.17V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 8 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15H4.5a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 6 8a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 11 4.6h.09A1.65 1.65 0 0 0 12 3.09 2 2 0 0 1 16 3v.09A1.65 1.65 0 0 0 19 4.6l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 21.4 11h.1a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.5 1z" }]],
  };

  function iconNodeFor(category, phase) {
    if (phase === "run") return chipEl("span", "zs-spin");
    const key = phase === "err" ? "error"
      : phase === "done" ? "check"
      : phase === "result" ? "result"
      : phase === "sys" ? "gear"
      : phase === "remind" ? "remind"
      : category;
    return svgIcon(ICON_SHAPES[key] || ICON_SHAPES.tool);
  }

  // ════════════════════════════════════════════════════════════════════════
  //  CAMOUFLAGE / DECORATION  (chips are real "tool cards": header + an
  //  expandable body, themed by tool category and execution state)
  // ════════════════════════════════════════════════════════════════════════

  // Strip every trace of our decoration from a node. Needed because sites
  // virtualize (recycle) turn nodes: a node that was a command/result card can
  // be reused to render unrelated text.
  function resetDecoration(item) {
    const chip = item.querySelector(".zs-chip");
    if (chip) chip.remove();
    item.classList.remove("zs-hidden");
    item.querySelectorAll(".zs-tool-hide").forEach((e) => e.classList.remove("zs-tool-hide"));
    item.querySelectorAll(".zs-cmd-mask").forEach((e) => e.classList.remove("zs-cmd-mask"));
    delete item.dataset.zs;
    delete item.dataset.zsig;
    delete item.dataset.zphase;
    delete item.dataset.zStopped;
    delete item.dataset.zRegenLen;
    delete item.dataset.zRegenAt;
    delete item.__zsChip;
  }

  const decorate = {
    // Core renderer. opts: {label, detail, body, category, phase, cls, whole}
    chip(item, opts) {
      const { label, detail = "", body = "", category = "tool", phase, cls, whole } = opts;
      let chip = item.querySelector(".zs-chip");
      const hasBody = !!body;
      // While a command streams, the site re-renders the raw block on every token
      // and we get called on nearly every sweep. If what we'd draw is identical,
      // we must NOT rebuild the chip's innerHTML: doing so re-creates the
      // <span class="zs-spin"> and restarts its CSS animation each time, so the
      // spinner looks frozen / stutters ("retry en rafale"). Rebuild the inner
      // markup ONLY when the rendered content actually changes; otherwise reuse
      // the existing element (and keep its expand/collapse state) so the spinner
      // keeps spinning smoothly. Re-anchoring + masking below still run each pass.
      const sig = `${category}|${phase}|${cls || ""}|${whole ? 1 : 0}|${label}|${detail}|${hasBody ? body.length : 0}`;
      if (!chip) chip = document.createElement("div");
      if (chip.dataset.csig !== sig) {
        chip.dataset.csig = sig;
        chip.className = `zs-chip cat-${category} ${cls || ""}`;
        const head = chipEl(
          "div",
          "zs-chip-head",
          null,
          chipEl("span", "zs-chip-ic", null, iconNodeFor(category, phase)),
          chipEl("span", "zs-chip-tx", label),
          chipEl("span", "zs-chip-dt", detail || ""),
          hasBody ? chipEl("span", "zs-chip-cv", null, svgIcon(CHEVRON_SHAPES)) : null
        );
        const chipNodes = [head];
        if (hasBody) {
          chipNodes.push(chipEl("div", "zs-chip-body", null, chipEl("pre", "", body)));
          head.style.cursor = "pointer";
          head.onclick = () => chip.classList.toggle("open");
        }
        chip.replaceChildren(...chipNodes);
      }

      if (whole) {
        // Fully injected turn (result / sys) → hide the whole item.
        if (chip.parentElement !== item) item.insertBefore(chip, item.firstChild);
        item.classList.add("zs-hidden");
      } else {
        item.classList.remove("zs-hidden");
        // findToolBlockSpot ALSO applies the .zs-tool-hide classes (its real job);
        // we call it for that even when we don't use its returned position.
        const spot = P.findToolBlockSpot(item, chip);
        if (P.chipAtItemLevel) {
          // Site re-renders the turn's content subtree (Angular/Gemini), which
          // wipes any chip placed INSIDE it. Anchor the chip at the turn-element
          // level instead, where it survives those re-renders; the hide classes
          // (re-applied by the sweep) handle masking the raw block.
          // A provider may supply chipAnchor(item) to redirect the chip into a
          // descendant (e.g. Kimi's turn is a flex ROW [avatar | content];
          // inserting at item.firstChild would make the chip the avatar's flex
          // sibling and shove the layout sideways, so it anchors in the content
          // column instead). Default: the turn root.
          const anchor = (P.chipAnchor && P.chipAnchor(item)) || item;
          // Default: pin the chip as the FIRST child - simple and immune to the
          // site re-appending fresh content later. A provider may opt into
          // `chipAppend` to place it LAST instead (reads in the model's actual
          // order: narration, then the tool call it wrote at the end of the
          // turn). `chipTrailRef(item)` lets it name a fixed trailing sibling
          // (e.g. Qwen's action-buttons row) the chip must stay BEFORE even
          // when "last" - see ensureOwnedChip's drift check for why this needs
          // upkeep that firstChild pinning never did.
          const wantLast = !!P.chipAppend;
          const trailRef = wantLast && P.chipTrailRef ? P.chipTrailRef(item) : null;
          const inPlace = chip.parentElement === anchor &&
            (wantLast ? chip.nextElementSibling === trailRef : anchor.firstElementChild === chip);
          if (!inPlace) {
            if (wantLast) anchor.insertBefore(chip, trailRef); // trailRef=null -> append
            else anchor.insertBefore(chip, anchor.firstChild);
          }
        } else if (spot) {
          spot.parent.insertBefore(chip, spot.ref);
        } else if (!chip.parentElement) {
          item.insertBefore(chip, item.firstChild);
        }
      }
      item.dataset.zs = cls || "1";
      // Remember the exact opts so a chip wiped by a site re-render can be
      // rebuilt identically (see ensureOwnedChip / the chipGone guards).
      item.__zsChip = { ...opts };
      return chip;
    },

    // Re-apply a loop-owned chip after a site re-render wiped it (chip removed
    // and/or the .zs-tool-hide classes stripped). The loop owns the label/phase,
    // so we rebuild from the stored opts rather than re-running classification.
    ensureOwnedChip(item) {
      const opts = item.__zsChip;
      if (!opts) return;
      const chipEl = item.querySelector(".zs-chip");
      const chipGone = !chipEl;
      let rawVisible = false;
      if (!opts.whole) {
        // NOTE the thinking exclusion: reasoning models QUOTE the command
        // JSON/###LUA### in their think area, which the camouflage never hides
        // (by design) - counting those as "raw block visible" made this
        // rebuild fire on EVERY sweep forever (60Hz spam, seen live).
        rawVisible = [...item.querySelectorAll("pre, p, [class*='code'], .cm-line")].some(
          (e) => !e.closest(".zs-tool-hide") && !e.closest(".zs-chip") &&
                 !(P.thinkingSel && e.closest(P.thinkingSel)) &&
                 // Some sites (Arena) wrap a code block in a bare outer <pre>
                 // that has no hide class of its own - the real content (and
                 // the .zs-tool-hide class) live on a child wrapper instead.
                 // closest() only checks ancestors, so without this the outer
                 // <pre> reads as "raw command visible" FOREVER (its own
                 // textContent includes the hidden child's text), causing an
                 // infinite rebuild loop (~60/s, seen live on Arena).
                 !e.querySelector(".zs-tool-hide") &&
                 ZSParse.hasCommandShape(e.textContent || ""));
      }
      // A provider opted into `chipAppend` (chip trails the reply text instead
      // of pinning first) has no equivalent of firstChild's immunity to churn:
      // a site re-render can re-append fresh reply content AFTER our chip,
      // silently shoving it back above the text it was meant to trail. Catch
      // that drift too, not just an outright wipe - it's cheap (one property
      // read) and only applies to opted-in providers (Qwen).
      let drifted = false;
      if (!opts.whole && !chipGone && P.chipAtItemLevel && P.chipAppend) {
        const anchor = (P.chipAnchor && P.chipAnchor(item)) || item;
        const trailRef = P.chipTrailRef ? P.chipTrailRef(item) : null;
        drifted = chipEl.parentElement === anchor && chipEl.nextElementSibling !== trailRef;
      }
      if (chipGone || rawVisible || drifted) {
        // Tracker: the site wiped a loop-owned chip (re-render/node churn).
        diag("chip.rebuild", { name: opts.label, phase: opts.phase, chipGone, rawVisible, drifted });
        this.chip(item, opts);
      }
    },

    // owned=true → the agentic loop manages this item; the observer backs off.
    toolBox(item, name, phase, detail, owned, body, category) {
      if (!item) return;
      // Tracker: every phase TRANSITION of a command chip, with who drove it.
      // "loop" = the agentic loop (authoritative), "sweep" = DOM classification.
      if (item.dataset.zphase !== phase) {
        diag("chip.phase", {
          name, from: item.dataset.zphase || "(new)", to: phase,
          by: owned ? "loop" : "sweep", detail: detail || "",
        });
      }
      const cls = phase === "run" ? "run" : phase === "err" ? "err" : phase === "idle" ? "idle" : "done";
      this.chip(item, {
        label: name, detail: detail || "", body: body || "",
        category: category || ZS.toolCategory(name), phase, cls,
      });
      item.dataset.zphase = phase;
      if (owned) item.dataset.zloop = "1";
    },

    classify(item, next) {
      if (item.dataset.zloop) { this.ensureOwnedChip(item); return; } // loop owns it
      const txt = P.classifyText(item, ".zs-chip"); // excludes thinking AND our chip

      // NOTE on the "needs re-apply" guards below: some sites (Gemini/Angular)
      // re-render a turn's CHILDREN on every update - our chip and the
      // .zs-tool-hide classes are wiped while the dataset flags on the turn
      // element itself survive. So "already decorated" must always be
      // double-checked against the chip actually being present in the DOM.
      const chipGone = !item.querySelector(".zs-chip");

      // 1a. A mid-session RE-STATEMENT of the system prompt. Checked before the
      //     bootstrap branch because it carries SYS_MARKER too (that marker is
      //     what hides it), and without this it inherited the bootstrap's
      //     "Starting Up" gear - which reads as if the agent restarted, exactly
      //     the confusion Seb reported. Never animated: nothing is starting.
      if (txt.includes(ZS.RESEND_MARKER)) {
        if (item.dataset.zs !== "resend" || chipGone) {
          // The rider travels ON a tool result, so this one turn is both things.
          // Name the tool in the detail rather than dropping it - otherwise that
          // result is the only one in the conversation with no visible outcome.
          const m = txt.match(/Output of '([^']+)'/);
          this.chip(item, {
            label: "Reminder",
            detail: m ? `with ${m[1]} result` : "",
            category: "remind", phase: "remind", cls: "sys", whole: true,
          });
          item.dataset.zs = "resend";
          item.dataset.zphase = "remind";
        }
        return;
      }

      // 1. System-prompt bootstrap turn → animated while starting, gear when done.
      if (txt.includes(ZS.SYS_MARKER)) {
        const phase = A.starting ? "run" : "sys";
        if (item.dataset.zs !== "sys" || item.dataset.zphase !== phase || chipGone) {
          this.chip(item, { label: "Starting Up", category: "tool", phase, cls: "sys", whole: true });
          item.dataset.zphase = phase;
        }
        return;
      }

      // 2. Injected result / ERROR / note turns. ALWAYS a user turn we sent,
      //    keyed off our fixed output shapes (never command keywords).
      if (P.isUserItem(item) && ZSParse.isInjectedFeedback(txt)) {
        const m = txt.match(/Output of '([^']+)'/);
        const isErr = /^\s*ERROR\b/.test(txt);
        // Reload-proof image detection: a feedback carrying an image ends with the
        // IMAGE_FEEDBACK_RE marker. Learn the tool (persisted) so its command turn
        // above AND its next call get the "screen" chip even with no loop running.
        const hasImg = !isErr && IMAGE_FEEDBACK_RE.test(txt);
        if (hasImg && m) rememberImageTool(m[1]);
        const sig = (m ? m[1] : "note") + "|" + (isErr ? "err" : hasImg ? "img" : "result");
        if (item.dataset.zsig !== sig || !item.classList.contains("zs-hidden") || chipGone) {
          this.chip(item, {
            label: m ? `${m[1]} · result` : "result",
            category: hasImg ? "screen" : m ? ZS.toolCategory(m[1]) : "tool",
            body: txt, phase: isErr ? "err" : "result",
            cls: isErr ? "err" : "result", whole: true,
          });
          item.dataset.zsig = sig;
        }
        return;
      }

      // 2b. FALLBACK for a command turn whose raw tool-call text is no longer
      // readable (e.g. Qwen disposes/never fully renders an off-screen Monaco
      // code block on a COLD page load - the dataset.zsCode cache only helps
      // WITHIN a session, since it needs to observe the block live to capture
      // it before disposal; reported live: every past tool-call chip vanished
      // after a page reload, leaving only its "· result" box). The turn's own
      // text no longer "looks like" a command, but the VERY NEXT turn being
      // our injected result (`Output of 'name'`) is definitive proof it WAS
      // one - settle it from that evidence instead of leaving the chip gone.
      if (P.isAssistantItem(item) && !ZSParse.hasCommandShape(txt) &&
          next && P.isUserItem(next)) {
        const nt = P.classifyText(next, ".zs-chip");
        const m = nt.match(/^\s*Output of '([^']+)'/);
        if (m) {
          const isErr = /^\s*ERROR\b/.test(nt);
          const phase = isErr ? "err" : "done";
          if (item.dataset.zphase !== phase || chipGone) {
            this.toolBox(item, m[1], phase, "", false);
          }
          return;
        }
      }

      // 3. Assistant command turns → live loading while streaming, ✓ when done.
      // ONLY in a real snapgentV3 session (started or bootstrapping). Without
      // this gate, a plain never-started chat where the model merely EXPLAINS
      // the command format (a {"command":...} example in its answer) got the
      // example MASKED behind a tool chip - hiding genuine content the user
      // asked for. Same principle as domHasZsSignal: a command shape alone is
      // not proof of a session. (Branches 1/2 above key off OUR OWN injected
      // markers, which only exist in real sessions, so they need no gate.)
      if (P.isAssistantItem(item) && ZSParse.hasCommandShape(txt) &&
          (A.started || A.starting)) {
        // Regenerate transition (see zRegenLen capture in regenResume): the site is
        // still showing the OLD command text after a post-stop regenerate, before it
        // wipes and re-streams. Keep the coherent red "stopped" look instead of
        // re-animating the stale old call as a fresh "run" spinner. Clears the moment
        // the content is actually replaced (stream length drops below the captured
        // baseline) or a short safety window elapses, after which normal
        // classification paints the freshly regenerated command.
        if (item.dataset.zRegenLen) {
          const baseLen = Number(item.dataset.zRegenLen);
          const armedAt = Number(item.dataset.zRegenAt || 0);
          const replaced = txt.length < baseLen - 8;      // old content wiped
          const expired = Date.now() - armedAt > 6000;    // safety fallback
          if (!replaced && !expired) {
            const nm = ZSParse.toolNameFromText(txt) || "command";
            this.toolBox(item, nm, "err", "stopped", false);
            return;
          }
          delete item.dataset.zRegenLen;
          delete item.dataset.zRegenAt;
        }
        // A turn the user manually halted (Stop / native stop) stays "stopped" -
        // never let this sweep repaint it ✓ done (or worse, re-spin it) just
        // because generation is still settling. The dataset marker is set where we
        // halt, but on Arena the A/B carousel re-renders the turn node on every
        // token, wiping the marker - so the spinner came back even after Stop. Also
        // derive "stopped" from the userStopped latch (which survives node swaps)
        // for the last turn; it's cleared on the next user message / deliberate
        // resume, so a settled turn is never falsely frozen later.
        // A turn that is GENERATING again (or whose tool the loop is actively
        // running), with NO active user-stop latch, has been REGENERATED - it is no
        // longer the halted turn. Clear its stale halt so isRememberedHalted (index
        // + text-prefix based) can't keep repainting the FRESH command red: a Gemini
        // regenerate reuses the same assistant index and a similar opening prefix,
        // so the old halt otherwise matches and the running command shows "stopped"
        // (red) until it settles. Gated on !A.userStopped so a real Stop that is
        // still settling (isGenerating can lag true for a beat) is NEVER cleared.
        const regenerating = !A.userStopped && (
          (item === P.lastAssistant() && P.isGenerating()) ||
          (A.running && A.toolItem === item)
        );
        if (regenerating) { delete item.dataset.zStopped; forgetHalted(item); }
        const stopped = !regenerating && (
          item.dataset.zStopped === "1" ||
          (A.userStopped && item === P.lastAssistant()) ||
          isRememberedHalted(item, txt));
        // Self-heal: a site re-render that swapped this turn's node wiped the
        // dataset marker - re-stamp it so the stop survives the next wipe of
        // the A.userStopped latch (a fresh user message clears it by design).
        if (stopped && item.dataset.zStopped !== "1") {
          item.dataset.zStopped = "1";
          diag("chip.rehalt", { name: ZSParse.toolNameFromText(txt) });
        }
        // The loop already SETTLED this very call (tool finished, we're waiting
        // for the model's next turn) but the site swapped the turn's DOM node,
        // wiping the chip, the zloop ownership AND the __zsChip opts. Without
        // this, the fresh node re-classifies as a spinning "run" chip (A.running
        // is still true) on an already-executed call. Re-own it with the settled
        // outcome. The count guard skips this once the model's NEXT turn exists,
        // so a follow-up call to the same tool still classifies live.
        if (!stopped && A.running && !A.toolRunning && A.toolSettle &&
            // Same TURN check. Node identity when available (virtualization-proof:
            // on Qwen the count doesn't grow for a new turn, and a back-to-back
            // call to the same tool defeats the name guard - the old outcome then
            // repainted the STREAMING next turn's chip as done/err). Falls back to
            // the count guard for providers without lastAssistantId.
            (A.toolSettle.id !== undefined && P.lastAssistantId
              ? P.lastAssistantId() === A.toolSettle.id
              : A.toolSettle.count === P.assistantCount()) &&
            item === P.lastAssistant() &&
            ZSParse.toolNameFromText(txt) === A.toolName) {
          diag("chip.reown", { name: A.toolName, phase: A.toolSettle.phase });
          this.toolBox(item, A.toolName, A.toolSettle.phase, A.toolSettle.detail,
            true, A.toolSettle.body, A.toolSettle.category);
          return;
        }
        // Is this command turn the IN-FLIGHT call - the one a running loop or the
        // bootstrap is about to own? The tell: it has NO injected result turn after
        // it yet. Every ALREADY-EXECUTED command turn is followed by its injected
        // result (a user turn matching isInjectedFeedback), so keying off that,
        // rather than item === lastAssistant(), robustly separates the in-flight
        // turn from settled history. This gives us the best of both:
        //  - The Kimi/bootstrap flash fix: while a loop/bootstrap is active, the
        //    in-flight turn stays "run" in the window between generation ending and
        //    the loop painting its own chip, WITHOUT depending on the flickery
        //    lastAssistant() (Kimi's Vue swaps the node) - no premature green flash.
        //  - No re-spin on REVISIT: when a started chat is re-opened and the loop
        //    or bootstrap runs again, every PAST command turn already has its result
        //    below it, so it settles to "done" instead of every old chip re-loading
        //    to a blue spinner (the Arena "all chips restarted loading" report).
        const resultAfter = next && P.isUserItem(next) &&
          ZSParse.isInjectedFeedback(P.classifyText(next, ".zs-chip"));
        const inFlight = (A.running || A.starting) && !resultAfter;
        // Regenerate grace: keep the freshly-regenerated command turn "run" in the
        // gap between regenResume clearing the stop latch and the watchdog starting
        // the loop, so it never flashes a premature ✓ "done" (see regenResume). The
        // anchor slides with generation and expires ~2.5s after it truly stops.
        const resumeGrace = A.resumeArmed && item === P.lastAssistant() &&
          Date.now() - (A.resumeArmedAt || 0) < 2500;
        const live = !stopped && (
          inFlight || resumeGrace || (item === P.lastAssistant() && P.isGenerating())
        );
        // Orphaned command: a COMPLETE command turn that is the last assistant with
        // NO result below it, not live and not loop-owned, whose generation is now
        // stale (typically the page/extension was reloaded while this command sat
        // un-executed). The auto-resume watchdog deliberately refuses to run a
        // reload-restored generation (the "execute_luau leaked into the new chat"
        // leak guard - same lastGenAt staleness test used here), so it will NEVER
        // execute. Painting it a green ✓ "done" falsely implies the tool ran and
        // succeeded; show a neutral, greyed "not run" state instead (cosmetic only -
        // we intentionally do NOT auto-execute it).
        // A command turn we have no evidence ever executed: not loop-owned, no
        // injected result below it, and not in the off-DOM executed memory (the
        // memory keeps this virtualization-safe - a scrolled-back turn whose result
        // detached is still known-executed and never mislabelled).
        const neverRun = !item.dataset.zloop && !resultAfter &&
          !isRememberedExecuted(item, txt);
        // Superseded orphan: abandoned command - a NEWER assistant turn exists below
        // it yet it never ran (e.g. stopped then regenerated into a fresh turn on
        // Qwen). It will never execute, so it must show neither a green ✓ "done" NOR
        // a live spinner. inFlight is not turn-specific: with the loop running the
        // NEW turn, this old no-result turn would otherwise also read as "run" - the
        // "both the old and the new chip spinning at once" seen live.
        const supersededOrphan = neverRun && item !== P.lastAssistant();
        // Reload orphan: the LAST command turn, not live, whose generation is stale -
        // the page/extension was reloaded while it sat un-executed and the watchdog
        // refuses to run a reload-restored generation (leak guard). Also never a
        // false green ✓; show a neutral, greyed "not run" (we do NOT auto-execute it).
        // Tied to RESUME_FRESH_MS, never a separate literal: this must not paint
        // "not run" while the resume watchdog is still entitled to execute the
        // command. With the two numbers out of step (8s here vs the watchdog's
        // window) a command that WAS about to run got labelled dead first.
        const staleLastOrphan = neverRun && item === P.lastAssistant() && !live &&
          Date.now() - A.lastGenAt > RESUME_FRESH_MS;
        const orphanPending = !stopped && (supersededOrphan || staleLastOrphan);
        // Handoff window: a JUST-finished last-assistant command with no result yet
        // that the loop has not taken over (A.running not yet true, so `live` is
        // false). Without this it flashes a premature ✓ "done" for the frames
        // between generation ending and the loop starting, THEN re-spins when the
        // loop paints its own chip - most visible on the instant virtual commands
        // (list_mcp_servers/list_commands). Keep it spinning instead; staleLastOrphan
        // takes over after 8s if the loop genuinely never runs it.
        // Same window as the watchdog: while it can still fire, the honest state
        // is "waiting to run" (spinner), not a settled verdict either way.
        const pendingExec = !stopped && !orphanPending && !live &&
          neverRun && item === P.lastAssistant() && Date.now() - A.lastGenAt <= RESUME_FRESH_MS;
        let phase = stopped ? "err" : (orphanPending ? "idle" : ((live || pendingExec) ? "run" : "done"));
        let detail = stopped ? "stopped" : (orphanPending ? "not run" : "");
        // A DSML turn is the model calling a tool in its OWN markup, which can
        // never be executed - it always resolves to the "dsml" parse_error. So
        // once it has FINISHED streaming, "waiting to run" (spinner) and "not
        // run" (grey) are both wrong: it is not pending, it is already decided.
        // Left alone it inherited pendingExec and span for the whole
        // RESUME_FRESH_MS window before settling grey (reported live 2026-08-22).
        // Gated on !live on purpose: while the model is still WRITING the block
        // it must behave like any other command and show the spinner, or a slow
        // generation gives the user no feedback at all that anything is happening
        // - the chip paints "run" as it streams, then repaints red here the
        // moment generation ends. When our error result lands below, the
        // error-aware settle just below is skipped (phase is no longer "done") so
        // the more precise "bad format" wording survives.
        if (!stopped && !live && phase !== "err" && ZSParse.DSML_RE.test(txt)) {
          phase = "err"; detail = "wrong format";
        }
        // Error-aware settle: a command whose injected result RIGHT BELOW is an
        // ERROR must never wear a green ✓. The loop paints this correctly while
        // it owns the turn, but a revisited conversation (or a node swap that
        // dropped ownership) re-derives the phase here - from the conversation
        // itself, so it stays correct without any loop state.
        if (phase === "done" && next && P.isUserItem(next)) {
          const nt = P.classifyText(next, ".zs-chip");
          // feedbackIsError also catches an MCP tool's in-body error (the result
          // reads "Output of '…': Error executing code…", which our ERROR prefix
          // test would miss - the Blender case), so a revisited conversation
          // re-settles it red, matching what the loop painted live.
          if (ZSParse.isInjectedFeedback(nt) && feedbackIsError(nt)) {
            phase = "err"; detail = "error";
            if (item.dataset.zphase !== "err") diag("chip.errSettle", { name: ZSParse.toolNameFromText(txt) });
          }
        }
        // A command block that is VISIBLE right now (its hide classes live on
        // child nodes that sites like Gemini re-create on every update, and the
        // block may render only AFTER the chip was first placed mid-stream).
        // Excludes the reasoning area (P.thinkingSel) like ensureOwnedChip:
        // thinking-quoted commands otherwise keep this true forever, and the
        // forced repaint recomputes `live` each sweep - the chip then FLAPS
        // done→run→done with the generation flicker (seen live as a settled
        // green chip blinking back to a blue spinner).
        const rawVisible = [...item.querySelectorAll("pre, p, [class*='code'], .cm-line")].some(
          (e) => !e.classList.contains("zs-tool-hide") && !e.closest(".zs-tool-hide") &&
                 !e.closest(".zs-chip") && !(P.thinkingSel && e.closest(P.thinkingSel)) &&
                 // see ensureOwnedChip's matching guard: a bare outer <pre>
                 // wrapping a hidden child wrapper otherwise reads as visible
                 // forever (Arena code-block markup).
                 !e.querySelector(".zs-tool-hide") &&
                 ZSParse.hasCommandShape(e.textContent || ""));
        // A tool learned to return images gets the "screen" chip even though its
        // name alone wouldn't reveal it (parity with Roblox screen_capture). The
        // fact can land AFTER this turn first settled (imageTools loads from
        // storage async, or the result turn below is classified later the same
        // pass), so repaint when the current chip's category is stale too - the
        // phase-only guard would otherwise freeze it on the generic wrench.
        const nm = ZSParse.toolNameFromText(txt);
        const cat = A.imageTools.has(bareToolName(nm)) ? "screen" : undefined;
        const chipNow = item.querySelector(".zs-chip");
        const catStale = cat === "screen" && chipNow && !chipNow.classList.contains("cat-screen");
        // Chip drift for chipAppend providers (Kimi): the RUN chip is painted by
        // the SWEEP (owned=false, no zloop) until the loop takes over at
        // tool.start ~2s later, so ensureOwnedChip's drift fix (zloop-only) does
        // NOT run during that window. Meanwhile Vue mounts the copy/regenerate
        // toolbar (chipTrailRef) and inserts it ABOVE our chip node, flashing the
        // action buttons over the chip until something repaints it. Detect that
        // drift here too so the sweep re-seats the chip (chip() re-anchors before
        // trailRef) without waiting for the loop. Mirrors ensureOwnedChip.
        let drifted = false;
        if (P.chipAtItemLevel && P.chipAppend && chipNow) {
          const anchor = (P.chipAnchor && P.chipAnchor(item)) || item;
          const trailRef = P.chipTrailRef ? P.chipTrailRef(item) : null;
          drifted = chipNow.parentElement === anchor && chipNow.nextElementSibling !== trailRef;
        }
        if (item.dataset.zphase !== phase || chipGone || rawVisible || catStale || drifted) {
          // Tracker: WHY the sweep chose this phase (only when it changes -
          // chipGone/rawVisible repaints of the same phase stay silent).
          if (item.dataset.zphase !== phase) {
            // Extra suspicion flag: a command that settled ✓ done while it is
            // still the LAST assistant with NO injected result below it - the
            // exact shape of the "chip shows done but the model is still writing"
            // report. genDebug() (if the provider exposes it) breaks isGenerating
            // into its sub-signals so we can see WHICH one flickered false.
            const suspectDone = phase === "done" &&
              item === P.lastAssistant() && !resultAfter;
            diag("chip.why", {
              name: nm, to: phase,
              stopped, live, inFlight, resumeGrace, pendingExec,
              isLast: item === P.lastAssistant(), resultAfter,
              gen: P.isGenerating(), run: A.running, starting: A.starting,
              zStopped: item.dataset.zStopped === "1",
              remembered: isRememberedHalted(item, txt),
              lastGenAgoMs: Date.now() - A.lastGenAt,
              suspectDone,
              ...(P.genDebug ? { g: P.genDebug() } : {}),
            });
          }
          this.toolBox(item, nm, phase, detail, false, undefined, cat);
        }
        return;
      }

      // A user-halted turn whose CONTENT the site cleared. Arena's native stop
      // (which our Stop button clicks) empties the turn's .prose and shows
      // "Generation stopped" - so the command JSON vanishes, branch 3's command
      // shape no longer matches, and the empty-text guard just below would bail
      // every sweep, freezing a spinning "run" chip forever. Settle any lingering
      // run chip to "stopped" right here, BEFORE that guard. Idempotent: skips
      // once already at the err phase.
      const haltedTurn =
        item.dataset.zStopped === "1" ||
        (A.userStopped && item === P.lastAssistant());
      if (haltedTurn && P.isAssistantItem(item) && item.dataset.zphase !== "err"
          && item.querySelector(".zs-chip")) {
        const tx = item.querySelector(".zs-chip-tx");
        const name = ZSParse.toolNameFromText(txt) || (tx && tx.textContent) || "tool";
        this.toolBox(item, name, "err", "stopped", false);
        return;
      }

      // Transient empty render (Angular swaps a turn's subtree before refilling
      // it): the text vanishes for a frame. Never strip a decorated turn on
      // that - the next sweep re-evaluates it with real content.
      if (!txt.trim() && (item.dataset.zphase || item.dataset.zs)) return;

      // 4. Plain text turn. If this node still wears decoration (a recycled
      //    virtualized node), strip it so we never hide genuine content.
      if (item.dataset.zs || item.dataset.zphase || item.querySelector(".zs-chip")) {
        // Tracker: a decorated node re-classified as PLAIN TEXT (virtualized
        // node recycled, or the turn's command text vanished) - its decoration
        // (chip + zStopped marker) is stripped here. If a chip "un-settles"
        // mysteriously, this is the smoking gun to look for.
        diag("chip.reset", { was: item.dataset.zphase || item.dataset.zs || "chip-only" });
        resetDecoration(item);
      }
    },

    sweep() {
      // Pass each turn's FOLLOWING turn too: a command chip needs it to know
      // whether its injected result was an ERROR (error-aware settle above).
      const items = P.allItems();
      for (let i = 0; i < items.length; i++) this.classify(items[i], items[i + 1] || null);
      // Safety net for stopped turns whose chip lives OUTSIDE the enumerated
      // message list. On Arena an A/B comparison renders each candidate as a
      // slide in the carousel's OWN nested <ol>, not the main flex-col-reverse
      // list - so allItems()/classify never see that node and a "run" spinner
      // left by a Stop would spin forever. zStopped is only ever set on a
      // deliberate halt, so settling any run-phase chip under such a node is
      // safe wherever it lives. Idempotent: skips once at the err phase.
      for (const chip of document.querySelectorAll(".zs-chip.run")) {
        let item = chip.parentElement;
        while (item && !(item.dataset && item.dataset.zStopped)) item = item.parentElement;
        if (item && item.dataset.zphase !== "err") {
          const tx = chip.querySelector(".zs-chip-tx");
          this.toolBox(item, (tx && tx.textContent) || "tool", "err", "stopped", false);
        }
      }
    },
  };

  // ════════════════════════════════════════════════════════════════════════
  //  UI  (control panel, onboarding, stop button, banners, toast, input cover)
  // ════════════════════════════════════════════════════════════════════════
  const ui = ZSUiController.createUiController({
    state: A,
    provider: P,
    aiSites: AI_SITES,
    githubUrl: GITHUB_URL,
    skillMaxBytes: SKILL_MAX_BYTES,
    targetStorageKey: TARGET_STORAGE_KEY,
    getSelectedTargetId: () => selectedTargetId,
    setSelectedTargetId: (id) => { selectedTargetId = id; },
    getBackgroundSessions: () => backgroundSessions,
    setBackgroundSessions: (on) => setBackgroundSessions(on),
    getAllSkills: () => allSkills,
    getGlobalSkills: () => globalSkills,
    activeTools: () => activeTools(),
    bareToolName: (name) => bareToolName(name),
    bg: (msg) => bg(msg),
    ensureTools: (force) => ensureTools(force),
    importSkillText: (text) => importSkillText(text),
    isMcpEnabled: (id) => isMcpEnabled(id),
    isSkillEnabled: (name) => isSkillEnabled(name),
    loadWorkspaceSkills: () => loadWorkspaceSkills(),
    refreshActiveToolNames: () => refreshActiveToolNames(),
    removeGlobalSkill: (name) => removeGlobalSkill(name),
    saveGlobalSkill: (text) => saveGlobalSkill(text),
    scrollSuppressed: () => scrollSuppressed(),
    setMcpEnabled: (id, on) => setMcpEnabled(id, on),
    setSkillEnabled: (name, on) => setSkillEnabled(name, on),
    startSession: () => startSession({ preserveMode: true }),
    stopLoop: () => stopLoop(),
    syncSessionState: () => syncSessionState(),
    validateSkillText: (text) => validateSkillText(text),
  });

  // ── Live token + timer, shown ONLY on a tool call's chip detail. The
  //    elapsed-time ANCHOR is stored on the chip's DOM node (dataset) so the
  //    timer survives re-renders / conversation switches. ────────────────────
  const TOKEN_CHARS = 4;

  // 0-999 as-is; 1000+ compacted to 1k/1.1k/99k/1M... (one decimal below 10 of
  // the unit, none at/above it, trailing ".0" dropped) so a live token count
  // doesn't grow into a wide, jumpy number as the reply streams in.
  function formatCount(n) {
    if (n < 1000) return String(n);
    const units = [[1e9, "B"], [1e6, "M"], [1e3, "k"]];
    for (const [div, suf] of units) {
      if (n >= div) {
        const v = n / div;
        const rounded = v < 10 ? Math.round(v * 10) / 10 : Math.round(v);
        return rounded + suf;
      }
    }
    return String(n);
  }

  function setChipDetail(item, text) {
    const dt = item && item.querySelector(".zs-chip .zs-chip-dt");
    if (dt) dt.textContent = text;
  }

  // Update ONLY the chip's label text (no innerHTML rebuild), so live-correcting
  // the name mid-stream doesn't restart the spinner or wipe the token meter.
  function setChipLabel(item, text) {
    const tx = item && item.querySelector(".zs-chip .zs-chip-tx");
    if (tx && tx.textContent !== text) tx.textContent = text;
  }

  // Elapsed seconds since a per-item anchor (persisted on the node).
  function elapsedOn(item, key, fallbackStart) {
    if (!item) return 0;
    let t0 = Number(item.dataset[key] || 0);
    if (!t0) { t0 = fallbackStart || Date.now(); item.dataset[key] = String(t0); }
    return (Date.now() - t0) / 1000;
  }

  // Timestamp of the user's last REAL click on the site (trusted event, outside
  // snapgentV3's own UI). A genuine "regenerate ↻" is always such a click;
  // DeepSeek's post-stop phantom generations and stop-button re-mount flickers
  // never are - this is what tells them apart (seen live: two false regenResume
  // fired 8s/2s after a Stop with no user action, un-stopping the halted turn).
  let _userClickAt = 0;
  track(document, "click", (e) => {
    if (e.isTrusted && !(e.target && e.target.closest && e.target.closest("#zs-root"))) {
      _userClickAt = Date.now();
    }
  }, true);

  let _prevHardGen = null, _prevSoftGen = null;
  let _liveTimer = null;
  function scheduleLiveTick(delay = 150) {
    if (_liveTimer) return;
    _liveTimer = setTimeout(() => { _liveTimer = null; runLiveTick(); }, delay);
  }
  function runLiveTick() {
    const gen = P.isGenerating(); // growth-tolerant: used for the live token meter
    // Watchdog freshness clock. Growth-tolerant (not just the hard stop-button
    // signal): a SHORT command after a long reasoning phase shows its stop
    // square for only a frame or two - too briefly for this 200ms sampler.
    if (gen) A.lastGenAt = Date.now();
    // High-water mark of the newest turn id seen this session (virtualization-
    // safe). The auto-resume watchdog uses it to IGNORE a scrolled-back OLD turn:
    // on a virtualized list lastAssistant() is the last RENDERED turn, which when
    // scrolled up is old, and its injected-result row is off-screen/unrendered so
    // the "result below" guard can't see it. A numeric provider id (DeepSeek's
    // data-virtual-list-item-key) is monotonic per turn, so the max only grows at
    // the live bottom and a scrolled-back turn reads strictly below it.
    if (P.itemKey && P.lastAssistantId) {
      const nk = Number(P.lastAssistantId());
      if (Number.isFinite(nk) && (A.maxTurnId == null || nk > A.maxTurnId)) A.maxTurnId = nk;
    }
    // Slide the regenerate grace anchor while generation is still (intermittently)
    // active, so the chip stays "run" across gen-false blips right up to the moment
    // the watchdog re-owns the tool (see regenResume).
    if (A.resumeArmed && gen) A.resumeArmedAt = Date.now();
    const hardGen = A.started && P.isHardGenerating();

    // Regenerate-as-resume: after a manual stop (A.userStopped) the agent stays
    // dormant until fresh user intent. Typing a message or the native Continue
    // clears the latch, but clicking the site's "regenerate ↻" does not - and on
    // Qwen that control is unlabeled and indistinguishable from copy/like, so we
    // can't hook the button reliably. Detect the EFFECT instead: a brand-new
    // generation (gen false→true) while we are stopped and otherwise idle can only
    // come from a user action (there is no spontaneous generation). Treat it as
    // resume - clear the stop latch and drop the turn's stopped/no-resume markers
    // so the auto-resume watchdog can pick the regenerated reply's tool back up.
    // Providers with NO native "regenerate" control (e.g. ReidChat) can opt out
    // via hasRegenerate:false - for them a gen false→true blip while stopped is
    // only abort/caret churn, never a real regenerate, so honouring it would
    // spuriously clear the manual-stop latch and auto-resume against the user.
    // HARD edge only: the growth-tolerant `gen` blips false→true when the site
    // re-renders the HALTED turn after a stop (adding its "Stopped" marker grows
    // streamText, which counts as growth for 800ms) - that blip falsely cleared
    // the latch, repainted the stopped chip ✓ green and re-armed auto-resume. A
    // real regenerate always raises the site's stop control, so require it; on
    // DeepSeek (no stop control during reasoning) this merely delays the resume
    // to the answer phase, after which the watchdog acts anyway.
    // Tracker: a soft (growth-only) blip in the stopped-idle state - exactly the
    // false trigger the hard-edge gate above filters out. Log it so live tests
    // can SEE the old bug firing and being ignored.
    if (A.started && A.userStopped && !A.running && !A.injecting && !A.stopping &&
        gen && _prevSoftGen === false && !hardGen) {
      diag("regenBlip.ignored");
    }
    if (P.hasRegenerate !== false &&
        A.started && A.userStopped && !A.running && !A.injecting && !A.stopping &&
        hardGen && _prevHardGen === false) {
      // Gate on ACTUAL user intent: a real regenerate is always a trusted click
      // moments before the new generation, and never the Stop click itself.
      // Distinguish the two by ORDER, not a fixed delay: require the latest
      // trusted click to fall clearly AFTER the Stop (clickAfterStop). A native
      // stop click lands ~at A.stopAt, so it fails this and can't self-resume;
      // the extension's own "■ Stop" is inside #zs-root and never updates
      // _userClickAt at all, so only the later regenerate qualifies. This
      // replaces the old absolute `stopAge > 3000` grace, which also blocked a
      // user who regenerated quickly (~1.5s) after Stop - the real bug seen live.
      // DeepSeek's post-stop phantom generations carry no fresh trusted click,
      // so they still fail the gate.
      const clickAge = Date.now() - _userClickAt;
      const stopAge = Date.now() - (A.stopAt || 0);
      const clickAfterStop = _userClickAt - (A.stopAt || 0);
      if (clickAge < 2500 && clickAfterStop > 400) {
        A.userStopped = false;
        const it = P.lastAssistant();
        if (it) {
          delete it.dataset.zStopped; delete it.dataset.zResume;
          delete it.dataset.zResumeLen; delete it.dataset.zloop;
          forgetHalted(it);
          // Strip the OLD command's chip immediately. The regenerate reuses this
          // turn node, and without this the previous execute_luau chip (with its
          // spinner/settled state) lingers for ~200ms until the sweep repaints the
          // node - the visible "it keeps running the old call for a beat before
          // restarting" flash reported on Kimi. resetDecoration clears the chip and
          // every marker so the regenerated reply classifies fresh.
          resetDecoration(it);
          // Kimi (and other node-reusing sites) leave the OLD command text in the
          // reply DOM for ~2s after regenerate starts, before wiping it and
          // streaming the new reply. resetDecoration only removes OUR chip - the
          // sweep then re-derives a fresh "run" chip from that stale old command
          // (old token count and all) until the content is replaced: the "red
          // stopped chip turns into a grey spinner on the OLD call" flash reported
          // live. Capture the old text length so the sweep can tell the DOM still
          // holds the stale command and keep the coherent red "stopped" look until
          // Kimi actually replaces it (see the zRegenLen guard in classify).
          try {
            it.dataset.zRegenLen = String(P.classifyText(it, ".zs-chip").length);
            it.dataset.zRegenAt = String(Date.now());
          } catch {}
        }
        // Bridge the gap until the auto-resume watchdog (1s interval) re-owns the
        // tool: regenResume only CLEARS the stop latch, it does not start the loop
        // (the regenerated command hasn't finished streaming yet, so there's
        // nothing to dispatch). In that ~1s window A.running is still false and
        // Gemini's generation signal blips false between reasoning and command
        // settle, so the sweep painted the chip a premature ✓ "done" before the
        // real execution began. Arm a grace anchor the sweep honours as "live"; it
        // slides while generation blips (refreshed in the meter loop) and expires
        // shortly after generation truly stops, by which point the watchdog has
        // taken over (A.running) or the reply was plain text with no tool.
        A.resumeArmed = true;
        A.resumeArmedAt = Date.now();
        diag("regenResume", { clickAge, stopAge, clickAfterStop });
      } else {
        diag("regenEdge.ignored", { clickAge, stopAge, clickAfterStop });
      }
    }
    _prevHardGen = hardGen;
    _prevSoftGen = gen;
    // Our "■ Stop" button stays visible for the WHOLE active turn (generation,
    // reasoning, or a tool/wait running on the bridge). It is complete on its own
    // - stopLoop both halts our loop AND clicks the site's native stop - and the
    // site's native stop likewise halts our loop via onNativeStop, so either one
    // fully stops everything. Two stop buttons at once is fine.
    // The bare isHardGenerating() term is gated on a live snapgentV3 session: on
    // a plain chat with no session, a user's own message makes the site generate,
    // and we must NOT briefly flash our Stop button over that.
    // Self-heal a stuck "Stopping…": if we flagged stopping but nothing is
    // actually busy anymore (the loop's finally never ran because the Stop landed
    // before a loop started, or a pending start was cancelled), release it so the
    // button doesn't freeze on "Stopping…". While the site is STILL streaming,
    // re-click its native stop (throttled) instead of releasing: the first click
    // sometimes gets swallowed by a re-render, and handing back a clickable
    // "■ Stop" the user has to press again is exactly the bounce we're killing.
    if (A.stopping && !A.running && !A.toolRunning) {
      if (A.started && P.isHardGenerating()) {
        // CRITICAL: only re-click the native stop if the reply has ACTUALLY kept
        // growing since the last stop click. On Gemini (and GLM) the stop button
        // WEDGES visible for up to ~10s after a successful stop, so the old
        // unconditional retry clicked a stop with NO live stream behind it -
        // and Gemini queues that stray abort against the conversation, then
        // KILLS THE NEXT reply the instant it starts ("Vous avez interrompu
        // cette réponse" on a message the user never stopped - validated live,
        // 2026-07: two stray stop.retry clicks after a ZS Stop made the next
        // two user turns die instantly; with no stray clicks the same flow
        // worked). A swallowed first click - the case this retry exists for -
        // always shows up as the stream STILL writing, i.e. growth past the
        // baseline captured at stop time (A.stopStreamLen, set in stopLoop /
        // onNativeStop and re-based after each retry so every retry needs
        // fresh growth of its own).
        const grown = (P.streamLen ? P.streamLen() : 0) > (A.stopStreamLen || 0) + 24;
        if (grown && Date.now() - (A.stopRetryAt || 0) > 800) {
          A.stopRetryAt = Date.now();
          A.stopStreamLen = P.streamLen ? P.streamLen() : 0;
          try { P.stopGeneration(); } catch {}
          diag("stop.retry");
        } else if (!grown && Date.now() - (A.stopAt || 0) > 2500) {
          // Wedged stop button on a dead stream (text frozen since the stop):
          // the site is effectively quiet - release "Stopping…" instead of
          // holding it for the whole wedge window.
          A.stopping = false;
          diag("stop.quiet", { wedged: true });
        }
      } else {
        A.stopping = false;
        diag("stop.quiet"); // drain over: site quiet, Stopping… released
      }
    }
    // While the user scrolls up through history the transcript re-renders and
    // every liveness signal becomes unreliable, so the busy surface is
    // suppressed outright (user rule, 14 Nov 2026): no Stop, no working cover.
    // EXCEPTION: a command parked by the hold (A.held) keeps the Stop control
    // visible - otherwise the suppression hides the only way to cancel it.
    ui.showStop((A.held || !scrollSuppressed()) &&
      (A.running || A.toolRunning || A.stopping || (A.started && P.isHardGenerating())));

    // Tool is executing on the MCP → timer on its chip.
    if (A.toolRunning && A.toolItem) {
      const s = elapsedOn(A.toolItem, "zsToolT0", A.toolStart).toFixed(1);
      setChipDetail(A.toolItem, (A.toolArg ? A.toolArg + " · " : "") + `${s}s`);
      scheduleLiveTick(250);
      return;
    }
    // The site is streaming a tool call → token count + timer on its chip.
    if (gen) {
      const item = P.lastAssistant();
      const reply = item ? P.itemText(item) : ""; // non-thinking only
      const zphase = item && item.dataset.zphase;
      // Skip items already settled (done/err) - don't overwrite the finished chip.
      if (item && zphase !== "done" && zphase !== "err" && ZSParse.hasToolSignature(reply)) {
        // Live-correct the label as soon as the real name streams in.
        const name = ZSParse.toolNameFromText(reply);
        if (name && name !== "command") setChipLabel(item, name);
        const tokens = Math.floor(reply.length / TOKEN_CHARS);
        const s = Math.round(elapsedOn(item, "zsGenT0"));
        setChipDetail(item, `~${formatCount(tokens)} tokens · ${s}s`);
      }
    }
    // Keep elapsed chip timers / stopping drain updating via one-shot timeout
    // only while actively running, stopping, or streaming (idle = zero timers).
    if (A.toolRunning || A.stopping || gen) scheduleLiveTick(250);
    if (!gen && A.started && !A.running && !A.userStopped) {
      scheduleAutoResume(400);
      scheduleSysResend();
    }
  }
  track(document, "visibilitychange", () => { if (!document.hidden) scheduleLiveTick(0); });
  onStop(() => scheduleLiveTick(0));

  // ════════════════════════════════════════════════════════════════════════
  //  WIRING
  // ════════════════════════════════════════════════════════════════════════

  // A2A delegation: run one prompt to completion and report the final text
  // back to the background worker. The background relays it to the bridge.
  // ── A2A cancellation ────────────────────────────────────────────────────
  // The caller (bridge) gives up on a deadline, but the tab used to keep
  // generating forever: A.running stayed true, so every later prompt hit
  // "already working on another task" until the page was reloaded by hand.
  // The bridge now sends zs-a2a-abort on timeout; the hard cap below is the
  // safety net for when even that message cannot arrive (extension reloaded,
  // socket gone). Both routes stop the native generation and let the loop end.
  // A delegation must never hijack a thread a human is typing in, so it starts
  // from an empty chat. Most providers restore the last conversation on load
  // (measured live: qwen and rudder both come back on an old thread), so the
  // "open a new chat" click has to be done for the caller instead of failing
  // with "Use an empty chat" and leaving the A2A client to guess why.
  const stopRuntimeMessages = ZSChannel.listenRuntimeMessages({
    onStatus: (status) => ui.setStatus(status),
    onOpenMenu: (atBottom) => ui.openMenu(atBottom),
    onA2APrompt: (prompt, promptId, opts) => a2a.runPrompt(prompt, promptId, opts),
    onA2AAbort: (promptId) => a2a.abortIfMatches(promptId, "bridge-cancel"),
  });

  // Hydrate the persisted re-statement budget for this conversation up front, so
  // the first tool result after a reload already knows the real tally.
  loadSysCount();
  const statusPoll = ZSChannel.startStatusPolling({
    send: bg,
    intervalMs: 5000,
    onStatus: (status) => ui.setStatus(status),
    onStaleExtension: (status) => {
      ui.staleExtensionAlert();
      diag("bridge.staleExtension", { via: "status", error: status.error });
    },
  });

  // Session state is derived from the ACTUAL chat, but sites VIRTUALIZE their
  // message lists: the system-prompt turn is dropped from the DOM once it
  // scrolls out of the window. So we key "started" by conversation
  // (P.conversationKey()): once we have seen the marker for a key, we remember
  // it (persisted so it survives reloads). We never flip while busy.
  const startedSessions = new Set();
  const failedStartKeys = new Set();
  let lastSyncPath = null;
  function rememberSession(path) {
    // A falsy key = a TRANSIENT conversation URL (e.g. Gemini's /app before an
    // id is assigned). Remembering it would mark every future fresh chat as
    // "already started" and kill the Start gate. The real key is remembered by
    // the next sync once the site assigns the conversation its id.
    if (!path) return;
    if (startedSessions.has(path)) return;
    startedSessions.add(path);
    try { chrome.storage.local.set({ zsStartedSessions: [...startedSessions].slice(-300) }); } catch {}
  }
  // Load the persisted set once, then re-sync.
  try {
    chrome.storage.local.get("zsStartedSessions", (r) => {
      if (r && Array.isArray(r.zsStartedSessions)) {
        for (const p of r.zsStartedSessions) startedSessions.add(p);
        syncSessionState();
      }
    });
  } catch {}
  // A conversation IS a snapgentV3 session if any rendered turn carries a
  // telltale artefact: the system-prompt marker, an injected tool-result /
  // system-note turn, or a snapgentV3 command an assistant wrote. Works even
  // after a full cold start and regardless of scroll position.
  function domHasZsSignal(opts) {
    const requireToolOutput = !!(opts && opts.requireToolOutput);
    for (const it of P.allItems()) {
      const txt = it.textContent || "";
      if (!requireToolOutput && txt.includes(ZS.SYS_MARKER)) return true;
      if (/(^|\n)\s*Output of '[^']+':/.test(txt) || txt.includes("(System note:")) return true;
      // Deliberately NO bare command-shape test here. An assistant turn that
      // merely CONTAINS {"command":...} / ###LUA### is NOT proof of a session:
      // in a plain, never-started chat the model can simply EXPLAIN the format
      // (docs, examples, the user pasting our README) - that false positive
      // flipped A.started on, which armed the auto-resume watchdog, EXECUTED
      // the quoted JSON as a real command and injected its result into a chat
      // that had no agent at all (user-reported). A command only counts as a
      // session signal once it was actually RUN - and an executed command is
      // always followed by our injected "Output of '...'" feedback turn, which
      // the test above already catches. Virtualization (the marker turns
      // scrolling out of the DOM) is covered by the persisted per-conversation
      // key set (startedSessions / zsStartedSessions in rememberSession), not
      // by this heuristic.
    }
    return false;
  }
  function syncSessionState() {
    // While a bootstrap runs, track its conversation. The bootstrap chat gets a
    // real id only AFTER the prompt lands (fresh "/app" → "/app/<id>"), so we pin
    // the id the first time the chat has content. A change to a DIFFERENT, EMPTY
    // chat means the user opened a new conversation → abort: bump the generation
    // (the in-flight startSession bails at its next checkpoint) and clear state so
    // the new chat shows its own status instead of a stale "Starting…".
    if (A.starting) {
      const key = P.conversationKey();
      if (A.startingKey == null) {
        if (key && !P.chatIsEmpty()) A.startingKey = key; // pin the stable id
      } else if (key !== A.startingKey && P.chatIsEmpty()) {
        A.startGen++;
        A.starting = false;
        A.startingKey = null;
        P.setInputLock(false);
        ui.setStarting(false);
        // CRITICAL: startSession's own finally is gated on `alive()` (this abandon
        // just invalidated it via startGen++), so it will NEVER run and never
        // lift the "Agent is working…" cover. Without this line the cover was
        // stuck forever on the fresh chat whenever the user opened a new,
        // empty conversation WHILE the bootstrap's tool call (list_commands) was
        // still in flight - validated live 2026-07 on Cloudflare AI Playground.
        ui.inputCover(false);
      }
    }
    // Same idea for a RUNNING loop: if the user opens a NEW, empty conversation
    // via the SITE's own new-chat (not snapgentV3's button), the loop is bound to
    // a chat the user left, so abandon it. Otherwise A.running keeps this function
    // early-returning below and the stale "Agent active" / Stop button lingers on
    // the fresh chat instead of "Start Roblox agent". The "/app" → "/app/<id>" id
    // assignment of the SAME chat is not a move (loopKey is pinned only once the
    // chat has both an id and content), so a normal session is never disturbed.
    if (A.running) {
      const key = P.conversationKey();
      if (A.loopKey == null) {
        if (key && !P.chatIsEmpty()) A.loopKey = key; // pin the loop's conversation
      } else if (key !== A.loopKey && P.chatIsEmpty()) {
        diag("loop.abandonedNewChat", { from: A.loopKey, to: key });
        A.stop = true;       // the loop breaks at its next checkpoint; its finally
        A.loopKey = null;    // resets A.running / cover / lock, then state recomputes
      }
    }
    if (A.starting || A.injecting || A.running) return;
    if (P.chatIsEmpty()) A.failedBoot = false;
    const path = P.conversationKey();
    const failed = A.failedBoot || (!!path && failedStartKeys.has(path));
    const markerInDom = domHasZsSignal({ requireToolOutput: failed });
    if (markerInDom) rememberSession(path);
    let has;
    if (path && path === lastSyncPath) {
      // SAME, REAL conversation: never downgrade a known-started session just
      // because virtualization scrolled the marker out of the DOM. "started" is
      // sticky until the key actually changes (a different conversation).
      // NOTE: a falsy key ("" = a transient/fresh chat with no id yet) is NEVER
      // sticky - every fresh chat shares "", so a brief transient sweep during
      // navigation would otherwise PIN lastSyncPath="" with has=true and then keep
      // "Agent active" forever on the next empty chat (it would never recompute).
      has = A.started || markerInDom || (!!path && startedSessions.has(path));
    } else {
      // Different conversation → recompute from scratch.
      has = markerInDom || (!!path && startedSessions.has(path));
      lastSyncPath = path;
    }
    if (has !== A.started) {
      A.started = has;
      ui.setStarted(has);
    }
  }

  // Schedule a debounced sweep. requestAnimationFrame is PAUSED in a background
  // tab, so when hidden we fall back to a timer (throttled, but it runs).
  let sweepScheduled = false;
  function scheduleSweep() {
    if (sweepScheduled) return;
    sweepScheduled = true;
    const run = () => {
      sweepScheduled = false;
      syncSessionState();
      P.enforceComposer();  // keep the composer in the provider's required modes
      ui.updateStartGate(); // block the input until a session is started
      decorate.sweep();
    };
    if (document.hidden) setTimeout(run, 100);
    else requestAnimationFrame(run);
  }
  // Synchronous pre-hide: MutationObserver callbacks run as a microtask BEFORE
  // the browser paints, but the debounced sweep above waits one extra rAF -
  // long enough for a freshly-sent system-prompt/injected-feedback turn's raw
  // text to paint for a single frame before decorate.sweep() builds its chip
  // and hides it (seen live on DeepSeek: "Starting Up" flashed the raw prompt
  // for an instant). Do the cheap whole-item hide test right here, synchronously,
  // so the class lands before that first paint; the full sweep still runs after
  // to build the actual chip.
  function preHideWholeItems() {
    const items = P.allItems();
    // Optimistic pre-hide of a freshly injected result turn (armed in
    // submitAndGetBase). The text-based match below can only fire once the
    // "Output of '…'" caption has rendered, but the turn's NODE appears first
    // (with its attached image) and the caption fills a tick later - so the raw
    // output would flash until a post-send sweep nudge. We know the newest user
    // turn in this window is ours: hide it on sight (blank, no raw text), and let
    // the normal sweep swap in the real "· result" chip when the caption lands.
    if (A.injectHideUntil && Date.now() < A.injectHideUntil) {
      const users = items.filter((it) => P.isUserItem(it));
      const last = users[users.length - 1];
      if (last && !last.classList.contains("zs-hidden") &&
          users.length > (A.injectPreUser || 0)) {
        last.classList.add("zs-hidden");
        A.injectHideUntil = 0; // one-shot: this turn is now masked
        diag("result.prehide", { users: users.length });
      }
    }
    for (const item of items) {
      if (item.classList.contains("zs-hidden")) continue;
      const txt = P.classifyText(item, ".zs-chip");
      if (txt.includes(ZS.SYS_MARKER) ||
          (P.isUserItem(item) && ZSParse.isInjectedFeedback(txt))) {
        item.classList.add("zs-hidden");
      }
    }
  }
  const mo = new MutationObserver(() => {
    preHideWholeItems();
    scheduleSweep();
    scheduleLiveTick(150);
  });
  mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  // When the user returns to the tab, immediately refresh camouflage/state.
  track(document, "visibilitychange", () => {
    if (!document.hidden) {
      scheduleSweep();
      scheduleAutoResume(250);
      scheduleSysResend();
    }
  });
  scheduleLiveTick(0);

  syncSessionState();

  // User-send interception: the provider wires the site's composer events to
  // these callbacks.
  P.installSendHooks({
    isBlocked: () => A.injecting || A.running || A.starting,
    isStarted: () => A.started,
    onBlockedAttempt: () => ui.nudgeStart(),
    onUserMessage: (base) => {
      // A fresh user message = fresh intent: clear any previous manual stop so
      // the loop is allowed to run again.
      A.userStopped = false;
      bumpSys("users");
      captureSendToken(); // identity of the assistant turn before this reply
      // A Stop clicked during this 300ms window sets A.userStopped → honor it and
      // do NOT start the loop (otherwise the stop is silently ignored and the
      // freshly-started loop strands the "Stopping…" flag).
      setTimeout(() => { if (!A.running && !A.userStopped) agentLoop(base); }, 300);
    },
    onNativeStop: () => {
      // A click on the site's own stop = a deliberate manual stop → suppress
      // auto-resume.
      A.userStopped = true;
      A.stop = true;
      A.resumeArmed = false; // a stop overrides any pending regenerate grace
      A.stopAt = Date.now(); // grace anchor for the regenerate-as-resume gates
      // Same growth baseline as stopLoop: the stop-retry self-heal must only
      // re-click if the stream keeps writing past this point (see stop.retry).
      A.stopStreamLen = P.streamLen ? P.streamLen() : 0;
      // If our loop is live, mirror the same "Stopping…" feedback as our own
      // Stop button so the bar reflects the wind-down instead of flickering.
      if (A.running && !A.stopping) { A.stopping = true; ui.markStopping(); }
      markStoppedTurn();
      diag("nativeStop");
    },
    onNativeContinue: () => {
      // The site's "Continue" button = a clear intent to RESUME after a stop/
      // truncation. Clear the manual-stop latch so auto-resume can pick the
      // (resumed) turn's tool call back up cleanly.
      A.userStopped = false;
      A.stop = false;
      const it = P.lastAssistant();   // a real resume → drop the stopped marker
      if (it) { delete it.dataset.zStopped; forgetHalted(it); }
      diag("nativeContinue");
    },
  });

  // Auto-resume watchdog - the safety net that keeps the agentic loop alive when
  // a tool call finished AFTER the loop finalized early (huge multi_edit, tab
  // returning from background). It must NEVER fire on a tool call merely
  // PRESENT in the DOM without a fresh live generation. Guards:
  //   • A.userStopped - the user halted; never relaunch against their intent.
  //   • lastGenAt recency - only resume a turn from a generation in the last
  //     few seconds; a turn rendered by load/scroll has no recent generation.
  //   • turnHalted - the turn itself carries the site's "stopped" marker.
  // Each turn is still resumed at most once (zResume marker).
  // Freshness window for the resume watchdog. Widened from 8s to 3 minutes
  // (2026-08) because 8s was the ONLY thing standing between an orphaned command
  // and its execution, and it was firing on legitimate work: a long generation
  // (a Qwen reply seen live writing for 400s+) makes the loop finalize early, the
  // generation then genuinely ends, lastGenAt goes stale within 8s and the
  // completed command is stranded forever with a grey "not run" - the user's
  // whole point being that they wanted it to RUN. This is safe because every
  // guard below is independent of lastGenAt and covers the cases this window was
  // nominally protecting: bootBaselineId (a reload-restored generation),
  // maxTurnId (a scrolled-back old turn), the result-below settled-history test
  // (survives a reload, unlike the executed map), the `executed` map, the
  // zResume dedupe and A.userStopped. As the `executed` map's own comment puts
  // it, re-execution is idempotent regardless of any lastGenAt misfire - "the
  // hard part (is this a live turn?) can be wrong without harm". The window is
  // kept, rather than removed, so a tab left open for hours still never
  // spontaneously fires a command on some later unrelated DOM churn.
  const RESUME_FRESH_MS = 180000;
  let _resumeTimer = null;
  function scheduleAutoResume(delay = 600) {
    clearTimeout(_resumeTimer);
    _resumeTimer = setTimeout(() => { _resumeTimer = null; checkAutoResume(); }, delay);
  }
  function checkAutoResume() {
    if (!A.started || A.running || A.starting || A.injecting) return;
    if (document.hidden) return;                         // AI tab not foreground → don't parse/exec off-screen (agentLoop gates too)
    if (A.userStopped) return;                          // user halted → never relaunch
    // Scrolling up through history means the transcript is re-rendering, not the
    // agent working: suppress resume entirely for the gesture window so no
    // historical command can be re-dispatched (user rule, 14 Nov 2026).
    if (scrollSuppressed()) return;
    if (P.isGenerating()) return;
    if (Date.now() - A.lastGenAt > RESUME_FRESH_MS) return; // not a fresh live turn
    const item = P.lastAssistant();
    if (!item || item.dataset.zloop) return;
    // Never resume the turn that already existed when this session started - it is
    // a reload-restored generation, not a reply to one of our sends (see
    // A.bootBaselineId). Guards the "execute_luau leaked into the new chat" bug.
    if (A.bootBaselineId && P.lastAssistantId && P.lastAssistantId() === A.bootBaselineId) return;
    if (P.turnHalted(item)) return;                     // this turn was stopped → leave it
    // Scrolled-back OLD turn guard (virtualization). lastAssistant() is the last
    // RENDERED turn; scrolling up makes it an old command whose id is below the
    // session's high-water mark. Its result row may be off-screen (unrendered), so
    // the result-below guard alone can miss it - this catches it directly. Only
    // applies when the provider exposes a numeric monotonic id (DeepSeek).
    const curId = P.itemKey ? Number(P.itemKey(item)) : NaN;
    if (Number.isFinite(curId) && A.maxTurnId != null && curId < A.maxTurnId) {
      // Log once per distinct turn, not every 1s tick while the user stays up.
      if (A._skipOldId !== curId) { A._skipOldId = curId; diag("resume.skipOld", { curId, maxTurnId: A.maxTurnId }); }
      return;
    }
    // Settled-history guard (survives a page reload, unlike the executed map).
    // A genuine resume target is a command whose tool NEVER produced a result;
    // it has NO injected-feedback turn after it. Every ALREADY-EXECUTED command
    // is followed by its injected result. On a virtualized list, scrolling up
    // makes lastAssistant() an OLD command turn AND flickers isGenerating() true
    // (sampleStream resets on the node change), refreshing lastGenAt - so the
    // freshness guard alone doesn't stop it, and after a reload the executed map
    // is empty. Keying off the result-below turn robustly separates the in-flight
    // command from settled history: a scrolled-back tool with its result already
    // present is never re-fired. (Confirmed live: same-conv reload + scroll up
    // re-executed a historical command.)
    const all = P.allItems();
    const after = all[all.indexOf(item) + 1];
    if (after && P.isUserItem(after) &&
        ZSParse.isInjectedFeedback(P.classifyText(after, ".zs-chip"))) return;
    const txt = P.itemText(item);
    if (!ZSParse.hasToolSignature(txt)) return;
    // Node-independent dedupe: this turn's command was already dispatched (by the
    // loop or a prior resume). The dataset guards below are wiped when the site
    // recreates the node on scroll, so without this off-DOM check the watchdog
    // re-runs a historical tool with no live generation. See the `executed` map.
    if (isRememberedExecuted(item, txt)) return;
    // Resume only when a COMPLETE, parseable command is present - and re-attempt
    // if the turn has GROWN since our last try.
    if (!ZSParse.parseToolCalls(txt).length) return;
    const len = txt.length;
    if (item.dataset.zResume && Number(item.dataset.zResumeLen || 0) >= len) return;
    item.dataset.zResume = "1";
    item.dataset.zResumeLen = String(len);
    rememberExecuted(item);
    diag("autoResume", { len });
    // The reply turn is ALREADY present - act on it immediately. Null token makes
    // the identity-based newReply test unconditionally true (any current id != null).
    A.sendToken = null;
    agentLoop(P.assistantCount() - 1);
  }

  // ── System-prompt re-injection fallback ───────────────────────────────────
  // The piggyback path (withSysResend) is free but needs a tool result to ride
  // on, and the failure this feature exists for - the model forgetting it can
  // run commands at all - is precisely the state where no tool results are being
  // produced. So when a re-statement has been owed for a while and nothing has
  // carried it, send it as its own turn: masked exactly like the bootstrap (the
  // SYS_MARKER makes the camouflage sweep hide the whole item), so the user sees
  // nothing but ChatGPT's short acknowledgement.
  //
  // This costs one message from the site's quota, which is why it is a fallback
  // and not the primary path. Deliberately conservative about WHEN it may fire:
  // never mid-generation, never while the loop or bootstrap owns the composer,
  // and never while the user has text sitting in the composer (we would wipe
  // what they were typing).
  const SYS_FALLBACK_IDLE_MS = 20000;
  let _sysResendTimer = null;
  function scheduleSysResend() {
    clearTimeout(_sysResendTimer);
    if (!sysResendDue() || !A.started || A.running || A.starting || A.injecting) return;
    if (document.hidden || A.userStopped) return;
    const wait = Math.max(500, SYS_FALLBACK_IDLE_MS - (Date.now() - (A.lastGenAt || 0)));
    _sysResendTimer = setTimeout(async () => {
      _sysResendTimer = null;
      if (!sysResendDue()) return;
      if (!A.started || A.running || A.starting || A.injecting) return;
      if (document.hidden || A.userStopped) return;
      if (P.isGenerating()) return;
      // The user is composing - their draft owns the editor, leave it alone.
      try { if ((P.editorText() || "").trim() !== "") return; } catch { return; }
      if (Date.now() - (A.lastGenAt || 0) < SYS_FALLBACK_IDLE_MS) { scheduleSysResend(); return; }
      const spent = sinceLastSys();
      resetSysCount();
      A.sysResendAt = Date.now();
      diag("sys.resend", { via: "ownTurn", ...spent });
      try {
        const base = await submitAndGetBase(systemPrompt());
        await waitForResponse(base);
      } catch (e) {
        diag("sys.resendFailed", { err: String(e && e.message || e) });
      }
    }, wait);
  }

  // ── teardown: one owner for unload and re-injection ───────────────────────
  // A bfcache pagehide (event.persisted) keeps the document alive, so observers
  // must stay attached there; a real unload/reload detaches everything once.
  let tornDown = false;
  let onPageHide = null;
  let onBeforeUnload = null;
  function teardown(event) {
    if (tornDown || (event && event.persisted)) return;
    tornDown = true;
    statusPoll.stop();
    stopRuntimeMessages();
    for (const dispose of disposers.slice().reverse()) { try { dispose(); } catch {} }
    try { mo.disconnect(); } catch {}
    if (perfObserver) { try { perfObserver.disconnect(); } catch {} perfObserver = null; }
    if (_liveTimer) { clearTimeout(_liveTimer); _liveTimer = null; }
    if (_resumeTimer) { clearTimeout(_resumeTimer); _resumeTimer = null; }
    if (_sysResendTimer) { clearTimeout(_sysResendTimer); _sysResendTimer = null; }
    if (typeof ui.destroy === "function") ui.destroy();
    if (onPageHide) window.removeEventListener("pagehide", onPageHide);
    if (onBeforeUnload) window.removeEventListener("beforeunload", onBeforeUnload);
  }
  if (typeof window !== "undefined" && window && typeof window.addEventListener === "function") {
    onPageHide = (event) => teardown(event);
    onBeforeUnload = () => teardown();
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("beforeunload", onBeforeUnload);
  }

  log(`snapgentV3 content script ready (provider: ${P.id})`);
})();
