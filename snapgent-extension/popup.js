// SPDX-License-Identifier: GPL-3.0-or-later
const SUPPORTED_HOSTS = [
  "chat.deepseek.com", "deepseek.com", "chatgpt.com", "chat.openai.com", "claude.ai",
  "gemini.google.com", "www.kimi.ai", "kimi.ai",
  "chat.z.ai", "chat.qwen.ai", "arena.ai", "www.meta.ai", "meta.ai", "ptero.pro", "grok.com", "chat.mistral.ai", "rudder.chat",
];
// const DEFAULT_AI_URL = "https://chat.deepseek.com/"; // DeepSeek hidden (disabled, not deleted)
const DEFAULT_AI_URL = "https://chatgpt.com/";

// One popup, three launchers. Name the file the user actually has; the README
// explains what each launcher configures. Linux is the default when the
// platform string is empty, because that is the only supported OS whose
// launcher is a script rather than a double-clickable file.
// `navigator` is absent in the stub-DOM test runner (plain Node), so read it
// defensively rather than crash the whole popup on load.
const PLATFORM = typeof navigator !== "undefined" && navigator.platform ? navigator.platform : "";
const LAUNCHER = /Mac/i.test(PLATFORM) ? "MacOS_Start.command"
  : /Linux|X11/i.test(PLATFORM) ? "Linux_Start.sh"
  : "start.bat";
const HAS_RUNTIME = typeof chrome !== "undefined" &&
  !!(chrome && chrome.runtime && typeof chrome.runtime.sendMessage === "function");



function fmtUptime(seconds) {
  if (typeof seconds !== "number" || seconds < 0) return "";
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m`;
}

function fmtRss(kib) {
  if (typeof kib !== "number" || kib < 0) return "";
  return kib >= 1024 * 1024
    ? `${(kib / 1024 / 1024).toFixed(1)} GB`
    : `${(kib / 1024).toFixed(1)} MB`;
}

// One line per server from the bridge diagnostic snapshot. Falls back to
// the plain servers list when the bridge is old (no bridgeStatus).
// textContent only - bridge error strings are never injected as HTML.
function serverLines(s, list) {
  const diag = s.bridgeStatus;
  if (diag && Array.isArray(diag.servers) && diag.servers.length) {
    return diag.servers.map((x) => {
      // "● repo" reads as one token; a separator between the dot and the id
      // looked like a missing server name.
      const parts = [`${x.alive ? "●" : "○"} ${x.id}`];
      parts.push(x.alive ? `${x.tools} tools` : "down");
      const rss = fmtRss(x.rss_kib);
      if (rss && x.alive) parts.push(rss);
      if (x.restart_attempts > 0) {
        parts.push(x.next_restart_in_seconds > 0
          ? `retry ${x.restart_attempts} in ${Math.round(x.next_restart_in_seconds)}s`
          : `retries ${x.restart_attempts}`);
      }
      let line = parts.join(" · ");
      if (!x.alive && x.error) line += ` — ${String(x.error).slice(0, 60)}`;
      return line;
    });
  }
  return list.map((x) => `${x.alive ? "●" : "○"} ${x.id} (${x.alive ? x.tools + " tools" : "down"})`);
}

// The pairing controls are optional to the rest of the popup: the stub-DOM tests
// (test-popup-status.js) define only the status nodes, and a popup.html from
// before pairing has no #pair at all, so every lookup has to tolerate null.
function element(id) {
  return document.getElementById(id);
}

function setHidden(id, hidden) {
  const node = element(id);
  if (node) node.hidden = hidden;
}

function onClick(id, handler) {
  const node = element(id);
  if (node) node.addEventListener("click", handler);
}

function render(s) {
  const state = document.getElementById("state");
  const tools = document.getElementById("tools");
  const servers = document.getElementById("servers");
  const list = s.servers || [];
  const up = list.filter((x) => x.alive).length;
  const mcpOk = s.connected && (s.mcpAlive || up > 0 || s.tools > 0);
  const studioOff = mcpOk && s.studio === false; // MCP up but no Studio attached
  const ok = mcpOk && !studioOff;
  const dot = document.getElementById("dot");
  dot.className = "dot " + (!s.connected ? (s.rotatingToken ? "warn" : "bad") : ok ? "ok" : "warn");
  state.textContent = s.connected
    ? (ok ? "Connected"
        : studioOff ? "No Studio"
        : "Open Studio")
    : s.authRequired ? "Bridge token required"
    // 1012: the bridge rotated the token and dropped us on purpose; the new one
    // is already stored, so this is a reconnect, not a pairing problem.
    : s.rotatingToken ? "Token rotated · reconnecting"
    : "Bridge offline";
  // Only prompt for the token while the bridge is actively refusing us.
  setHidden("pair", !(s.authRequired && !s.connected));
  // Offer to re-pair whenever a token is stored, including while connected.
  setHidden("forget-token", !s.savedToken);
  // Rotation needs an authenticated socket; the bridge applies the new token live.
  setHidden("rotate-token", !(s.connected && s.savedToken));
  const ver = document.getElementById("ver");
  const extVer = (typeof chrome !== "undefined" && chrome && chrome.runtime &&
    typeof chrome.runtime.getManifest === "function")
    ? chrome.runtime.getManifest().version
    : "";
  // One version normally. The bridge is only named when it differs from the
  // extension, because that mismatch is the only time the number matters.
  const bridgeMismatch = s.connected && s.bridgeVersion && extVer && s.bridgeVersion !== extVer;
  ver.textContent = !extVer ? "" : bridgeMismatch ? `v${extVer} · bridge ${s.bridgeVersion}` : `v${extVer}`;
  tools.textContent = s.connected
    ? `${s.tools || 0} tools`
      + (s.bridgeStatus && s.bridgeStatus.uptime_seconds != null
          ? ` · up ${fmtUptime(s.bridgeStatus.uptime_seconds)}`
          : "")
    : s.authRequired ? "Paste the token below"
    : s.rotatingToken ? "New token saved"
    : `Run ${LAUNCHER}`;
  servers.textContent = s.connected ? serverLines(s, list).join("\n") : "";
  servers.title = "MCP servers: state dot, name, tool count, memory";
  renderUsage(s.usage);
}

// Last task, one short line: `deepseek · light · ~120 tok · 21s`. Model and
// effort come from the routing decision, tokens are an estimate (the web UI
// never exposes real usage), and a failed task is marked so it is not mistaken
// for a healthy run.
function renderUsage(u) {
  const node = document.getElementById("usage");
  if (!node) return;
  node.textContent = "";
  if (!u || !u.provider) return;
  // A labelled line, so "deepseek · ~1 tok · 31s" reads as history rather than
  // as five unlabelled numbers.
  const label = document.createElement("span");
  label.className = "u-label";
  label.textContent = "Last task";
  node.appendChild(label);
  node.appendChild(document.createTextNode(" "));
  const parts = [];
  const model = document.createElement("span");
  model.className = "u-model";
  model.textContent = u.provider;
  parts.push(model);
  // "pinned" is a routing label, not an effort tier the user chose - omit it.
  if (u.effort && u.effort !== "pinned") parts.push(` · ${u.effort}`);
  if (typeof u.tokens === "number") parts.push(` · ~${u.tokens} tok`);
  if (typeof u.seconds === "number") parts.push(` · ${u.seconds}s`);
  if (u.ok === false) {
    const bad = document.createElement("span");
    bad.className = "u-bad";
    bad.textContent = " · failed";
    parts.push(bad);
  }
  for (const part of parts) {
    node.appendChild(typeof part === "string" ? document.createTextNode(part) : part);
  }
}

// Set once per popup load, so a bridge that keeps refusing cannot loop.
let unparkedOnce = false;

// A parked extension waits for a token the bridge may no longer want: it was
// restarted, or re-run without `ZS_BRIDGE_AUTH=strict`. Opening the popup is
// the moment the user is looking, so try once instead of leaving a stale
// `Bridge token required` until they find the Reconnect button.
function shouldUnpark(status) {
  return !unparkedOnce && !!(status && status.authRequired && !status.connected);
}

function refresh() {
  if (!HAS_RUNTIME) return;
  chrome.runtime.sendMessage({ type: "status" }, (s) => {
    if (!s) return;
    if (shouldUnpark(s)) {
      unparkedOnce = true;
      chrome.runtime.sendMessage({ type: "reconnect" }, () => setTimeout(refresh, 800));
      return;
    }
    render(s);
  });
}

onClick("reconnect", () => {
  chrome.runtime.sendMessage({ type: "reconnect" }, () => setTimeout(refresh, 600));
});
onClick("restart", (e) => {
  e.target.textContent = "Restarting…";
  chrome.runtime.sendMessage({ type: "restart_mcp" }, () => {
    e.target.textContent = "⟳ Restart";
    setTimeout(refresh, 600);
  });
});
onClick("save-token", () => {
  const input = element("token");
  if (!input) return;
  const value = input.value.trim();
  if (!value) return;
  chrome.storage.local.set({ bridgeToken: value }, () => {
    input.value = "";
    chrome.runtime.sendMessage({ type: "reconnect" }, () => setTimeout(refresh, 800));
  });
});
onClick("rotate-token", (e) => {
  const button = e.target;
  button.textContent = "Rotating…";
  chrome.runtime.sendMessage({ type: "rotate_token" }, (r) => {
    if (r && r.ok) {
      button.textContent = "Rotate token";
    } else {
      button.textContent = "✗ Rotation failed";
      setTimeout(() => { button.textContent = "Rotate token"; }, 3000);
      console.warn("token rotation failed:", r && r.error);
    }
    setTimeout(refresh, 600);
  });
});
onClick("forget-token", () => {
  chrome.storage.local.remove("bridgeToken", () => {
    const input = element("token");
    if (input) input.value = "";
    // Reconnect without a token: the bridge answers 1008 and the pairing card
    // comes back, so a fresh token can be pasted.
    chrome.runtime.sendMessage({ type: "reconnect" }, () => setTimeout(refresh, 800));
  });
});
// Settings live in the in-page panel, so it needs a supported AI tab. Never
// make the user open one first: reuse an open tab if there is one, otherwise
// open one and wait for its content script before asking for the panel.
const openSettings = () => {
  chrome.tabs.query({}, (tabs) => {
    const supported = (tabs || []).filter(
      (t) => t.url && SUPPORTED_HOSTS.some((h) => t.url.includes(h))
    );
    const target = supported.find((t) => t.active) || supported[0];
    if (target) {
      chrome.tabs.update(target.id, { active: true });
      chrome.tabs.sendMessage(target.id, { type: "zs-open-menu" });
      return;
    }
    chrome.tabs.create({ url: DEFAULT_AI_URL }, (tab) => {
      if (!tab || typeof chrome.tabs.onUpdated?.addListener !== "function") return;
      const onUpdated = (id, info) => {
        if (id !== tab.id || info.status !== "complete") return;
        chrome.tabs.onUpdated.removeListener(onUpdated);
        // The content script mounts the bar right after load, so give it a beat
        // before asking it to open the panel (a lost message is silent).
        setTimeout(() => chrome.tabs.sendMessage(tab.id, { type: "zs-open-menu" }), 1200);
      };
      chrome.tabs.onUpdated.addListener(onUpdated);
    });
  });
};
const settingsButton = document.getElementById("settings");
if (settingsButton && HAS_RUNTIME) settingsButton.addEventListener("click", openSettings);

if (HAS_RUNTIME && chrome.runtime.onMessage && typeof chrome.runtime.onMessage.addListener === "function") {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "zs-status") render(msg);
  });
}
// The static HTML names the Windows launcher so it stays readable without JS;
// correct it to the platform the user is actually on.
const hint = document.getElementById("launch-hint");
if (hint) {
  const code = document.createElement("code");
  code.textContent = LAUNCHER;
  hint.textContent = "Start with ";
  hint.appendChild(code);
  hint.appendChild(document.createTextNode("."));
}
if (HAS_RUNTIME) {
  refresh();
  setInterval(refresh, 2000);
}
