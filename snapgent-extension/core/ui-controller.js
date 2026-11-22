// SPDX-License-Identifier: GPL-3.0-or-later
// core/ui-controller.js - floating bar, menus, settings popups, theme, banners, and status UI.
// Extracted from core/main.js so overlay UI controls stay isolated from the agent loop.
const ZSUiController = (() => {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";
  const DOM_PROPS = new Set([
    "id", "className", "title", "type", "value", "hidden", "disabled",
    "checked", "readOnly", "rows", "placeholder", "accept",
  ]);
  const CHEVRON_SHAPES = [["polyline", { points: "6 9 12 15 18 9" }]];

  function domEl(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [key, val] of Object.entries(attrs)) {
        if (val === undefined || val === null || val === false) continue;
        if (key === "text") node.textContent = String(val);
        else if (key === "dataset") Object.assign(node.dataset, val);
        else if (key === "style") {
          if (typeof val === "string") node.style.cssText = val;
          else Object.assign(node.style, val);
        } else if (DOM_PROPS.has(key)) node[key] = val;
        else node.setAttribute(key, val === true ? "" : String(val));
      }
    }
    for (const child of children) {
      if (child === undefined || child === null || child === false) continue;
      node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return node;
  }

  function svgEl(shapes, attrs = {}) {
    const svg = document.createElementNS(SVG_NS, "svg");
    const base = {
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "2.5",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      ...attrs,
    };
    for (const [k, v] of Object.entries(base)) svg.setAttribute(k, String(v));
    for (const [tag, sAttrs] of shapes) {
      const shape = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(sAttrs)) shape.setAttribute(k, String(v));
      svg.appendChild(shape);
    }
    return svg;
  }

  function createUiController(deps) {
    const A = deps.state;
    const P = deps.provider;
    const AI_SITES = deps.aiSites;
    const GITHUB_URL = deps.githubUrl;
    const SKILL_MAX_BYTES = deps.skillMaxBytes;
    const TARGET_STORAGE_KEY = deps.targetStorageKey;
    const getSelectedTargetId = deps.getSelectedTargetId;
    const setSelectedTargetId = deps.setSelectedTargetId;
    const getBackgroundSessions = deps.getBackgroundSessions;
    const setBackgroundSessions = deps.setBackgroundSessions;
    const getAllSkills = deps.getAllSkills;
    const getGlobalSkills = deps.getGlobalSkills;
    const activeTools = deps.activeTools;
    const bareToolName = deps.bareToolName;
    const bg = deps.bg;
    const ensureTools = deps.ensureTools;
    const importSkillText = deps.importSkillText;
    const isMcpEnabled = deps.isMcpEnabled;
    const isSkillEnabled = deps.isSkillEnabled;
    const loadWorkspaceSkills = deps.loadWorkspaceSkills;
    const refreshActiveToolNames = deps.refreshActiveToolNames;
    const removeGlobalSkill = deps.removeGlobalSkill;
    const saveGlobalSkill = deps.saveGlobalSkill;
    const scrollSuppressed = deps.scrollSuppressed;
    const setMcpEnabled = deps.setMcpEnabled;
    const setSkillEnabled = deps.setSkillEnabled;
    const startSession = deps.startSession;
    const stopLoop = deps.stopLoop;
    const syncSessionState = deps.syncSessionState;
    const validateSkillText = deps.validateSkillText;

    let root, bar, stateEl, actionBtn, stopBtn, targetSelect, targetWrap, switchBtn, menuEl, unstableEl;
    let targetBtn, targetMenuEl;
    let cover, coverRaf, barRaf;
    let coverLockedH = 0, coverLockedEl = null, anchorLockedBh = 0;
    // placeBar runs every frame. Sampling computed styles and walking ancestors
    // on each frame is measurable work on a busy chat page, so cache the two
    // composer-derived values and refresh them at most twice per second.
    let glowNode = null, glowAt = 0, glowRadius = "18px", glowBg = "";
    let openMenuFn = null; // set by build(); lets the popup force the panel open via runtime message
    let bridgeOk = false, workspaceReady = false, workspaceProbePending = false, workspaceProbeAt = 0;
    let workspaceProbeFails = 0;
    let studioDown = false, placeDown = false, appDown = false, addonOk = false, studioProcUp = false;
    let wasConnected = false, bridgeBannerEl = null;

    function positionMenu(anchor) {
      if (!menuEl || menuEl.hidden) return;
      const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
      const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
      const menuWidth = Math.min(menuEl.offsetWidth || 274, viewportWidth - 16);
      const left = Math.max(8, Math.min(anchor.right - menuWidth, viewportWidth - menuWidth - 8));
      const spaceAbove = anchor.top - 16;
      if (spaceAbove >= 180 || spaceAbove >= viewportHeight - anchor.bottom - 16) {
        menuEl.style.left = `${Math.round(left)}px`;
        menuEl.style.right = "auto";
        menuEl.style.top = "auto";
        menuEl.style.bottom = `${Math.round(viewportHeight - anchor.top + 6)}px`;
        menuEl.style.maxHeight = `${Math.max(100, Math.min(spaceAbove, viewportHeight - 16))}px`;
      } else {
        const top = Math.min(viewportHeight - 108, anchor.bottom + 6);
        menuEl.style.left = `${Math.round(left)}px`;
        menuEl.style.right = "auto";
        menuEl.style.top = `${Math.round(top)}px`;
        menuEl.style.bottom = "auto";
        menuEl.style.maxHeight = `${Math.max(100, viewportHeight - top - 8)}px`;
      }
    }

    function build() {
      root = document.createElement("div");
      root.id = "zs-root";
      // One consolidated status bar, anchored just above the site's composer
      // (positioned every frame by placeBar). It carries everything: live status,
      // the primary action (Start / Stop) and a "more"
      // menu (other AI sites and options). No floating panel,
      // no overlay on the input - the composer stays fully usable for plain chat.
      const chevronAttrs = { width: 11, height: 11 };
      const barNodes = [
        domEl("div", { id: "zs-composer-glow", "aria-hidden": "true" }),
        domEl(
          "div",
          { id: "zs-bar" },
          domEl("span", { id: "zs-state" }),
          domEl("button", { id: "zs-action" }),
          domEl("button", { id: "zs-stop", hidden: true, text: "■ Stop" }),
          domEl(
            "div",
            { className: "zs-target-wrap", title: "Choose which MCP server receives commands" },
            domEl(
              "select",
              { id: "zs-target", "aria-label": "MCP target", hidden: true, tabindex: "-1" },
              domEl("option", { value: "vscode", text: "VS Code" }),
              domEl("option", { value: "roblox", text: "Roblox Studio" })
            ),
            domEl(
              "button",
              { id: "zs-target-btn", type: "button", "aria-haspopup": "listbox", "aria-label": "Choose MCP target" },
              domEl("span", { id: "zs-target-name" })
            ),
            svgEl(CHEVRON_SHAPES, chevronAttrs)
          ),
          domEl(
            "button",
            { id: "zs-switch", "aria-label": "Switch AI and options", title: "Switch AI and options" },
            domEl("span", { id: "zs-switch-name" }),
            svgEl(CHEVRON_SHAPES, chevronAttrs)
          )
        ),
        domEl("div", { id: "zs-menu", hidden: true }),
        domEl("div", { id: "zs-target-menu", hidden: true }),
      ];
      if (P.unstableWarning) {
        barNodes.push(domEl("button", { id: "zs-unstable", "aria-label": "Provider may be unstable", hidden: true, text: "⚠ unstable" }));
      }
      root.replaceChildren(...barNodes);
      document.documentElement.appendChild(root);
      bar = root.querySelector("#zs-bar");
      stateEl = root.querySelector("#zs-state");
      actionBtn = root.querySelector("#zs-action");
      stopBtn = root.querySelector("#zs-stop");
      targetSelect = root.querySelector("#zs-target");
      targetWrap = root.querySelector(".zs-target-wrap");
      targetBtn = root.querySelector("#zs-target-btn");
      targetMenuEl = root.querySelector("#zs-target-menu");
      switchBtn = root.querySelector("#zs-switch");
      const swName = root.querySelector("#zs-switch-name");
      if (swName) swName.textContent = P.displayName || P.id;
      setTarget(getSelectedTargetId());
      targetSelect.addEventListener("change", () => {
        // Switching is always allowed (even while a session is running).
        // After the new target is persisted, reload the page so the whole
        // extension restarts cleanly against the newly selected MCP server.
        setSelectedTargetId(targetSelect.value || "vscode");
        const reloadPage = () => { try { location.reload(); } catch {} };
        try {
          chrome.storage.local.set({ [TARGET_STORAGE_KEY]: getSelectedTargetId() }, reloadPage);
        } catch (error) {
          console.error("[snapgentV3] Could not save selected MCP target:", error);
          reloadPage();
        }
      });
      menuEl = root.querySelector("#zs-menu");
      // Custom MCP target dropdown (same look as the Switch AI menu). The hidden
      // <select> stays the data source so the existing change handler is reused.
      const targetTick = () => {
        if (targetMenuEl.hidden) return;
        positionTargetMenu();
        requestAnimationFrame(targetTick);
      };
      targetBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (menuEl) menuEl.hidden = true;
        targetMenuEl.hidden = !targetMenuEl.hidden;
        if (!targetMenuEl.hidden) {
          renderTargetMenu();
          positionTargetMenu();
          requestAnimationFrame(targetTick);
        }
      });
      document.addEventListener("click", (e) => {
        if (targetMenuEl.hidden) return;
        if (!targetMenuEl.contains(e.target) && !targetBtn.contains(e.target)) targetMenuEl.hidden = true;
      }, true);
      bar.classList.add(`zs-prov-${P.id}`); // lets CSS tune per-site (e.g. font)
      // Provider hook on <html> so overlay.css can tune site-specific CHIP layout
      // (not just the bar). Meta's turn root is full-width with the reply in a
      // nested centered column, so whole-turn chips (result/sys) need re-centering.
      document.documentElement.classList.add(`zs-site-${P.id}`);

      actionBtn.addEventListener("click", onActionClick);
      stopBtn.addEventListener("click", stopLoop);
      unstableEl = root.querySelector("#zs-unstable");
      if (unstableEl) {
        // Set the native tooltip via PROPERTY, not the HTML template: the warning
        // text may contain double quotes (e.g. GLM's "No response…"), which would
        // terminate a title="..." attribute early and truncate the tooltip.
        unstableEl.title = P.unstableWarning;
        unstableEl.addEventListener("click", (e) => { e.stopPropagation(); toast(P.unstableWarning); });
      }
      buildMenu();
      // Both bar controls open the same panel; the heart lands on the Support
      // section (last), the model button opens at the top with Switch AI.
      const toggleMenu = (toSupport) => {
        menuEl.hidden = !menuEl.hidden;
        if (!menuEl.hidden) {
          // Rebuild on every open, not just once at page load: the initial
          // buildMenu() call runs before the bridge status (server list/health)
          // has arrived, so the very first render always shows an empty/stale
          // target selector otherwise - nothing ever refreshed it after.
          buildMenu();
          // On a FRESH open, menuEl has no max-height yet - that's only applied by
          // placeBar()'s positioning pass, which runs on the next rAF tick (it's a
          // separate loop, not synchronous with this click). Without it the panel
          // has no overflow yet, so scrollHeight === clientHeight and setting
          // scrollTop here is a no-op - the "jump to Support" silently failed on
          // the very first open (reported live on Arena). Deferring one frame lets
          // placeBar's already-queued tick clip the box first, so there's real
          // scroll room by the time we set scrollTop.
          requestAnimationFrame(() => {
            if (!menuEl.hidden) menuEl.scrollTop = toSupport ? menuEl.scrollHeight : 0;
          });
        }
      };
      switchBtn.addEventListener("click", (e) => { e.stopPropagation(); if (targetMenuEl) targetMenuEl.hidden = true; toggleMenu(false); });
      openMenuFn = (toSupport) => { if (menuEl.hidden) toggleMenu(toSupport); };
      document.addEventListener("click", (e) => {
        if (menuEl.hidden) return;
        if (!menuEl.contains(e.target) && !switchBtn.contains(e.target))
          menuEl.hidden = true;
      }, true);

      applyTheme();
      // Event-driven theme tracking (replaces 2s setInterval polling).
      if (typeof MutationObserver === "function") {
        let themeTimer = null;
        const scheduleTheme = () => {
          if (themeTimer) return;
          themeTimer = setTimeout(() => { themeTimer = null; applyTheme(); }, 150);
        };
        const themeObs = new MutationObserver(scheduleTheme);
        const attrOpts = { attributes: true, attributeFilter: ["class", "style", "data-theme", "data-color-scheme", "data-mode"] };
        try { themeObs.observe(document.documentElement, attrOpts); } catch {}
        if (document.body) { try { themeObs.observe(document.body, attrOpts); } catch {} }
      }
      try {
        const mq = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)");
        if (mq && mq.addEventListener) mq.addEventListener("change", applyTheme);
      } catch {}
      renderBar();
      placeBar(); // start the per-frame anchoring loop
    }

    // The primary button does different things depending on the current state
    // (set by renderBar via actionBtn.dataset.kind).
    function onActionClick() {
      const kind = actionBtn.dataset.kind;
      if (kind === "start" || kind === "start-degraded") startSession();
    }

    // ── Custom prompt (persisted) ───────────────────────────────────────────
    // The user's extra instructions, persisted in chrome.storage.local and
    // appended UNDER the system prompt at session start. Cached here so
    // startSession can read it synchronously.
    let customPrompt = "";
    try {
      chrome.storage.local.get("zsCustomPrompt", (r) => {
        if (r && typeof r.zsCustomPrompt === "string") {
          customPrompt = r.zsCustomPrompt;
        }
      });
    } catch {}
    function getCustomPrompt() { return customPrompt; }

    // ── Custom MCP servers (addons) ─────────────────────────────────────────
    // Cached names for user-added MCP servers. The bridge remains the source of
    // truth; this cache keeps addon names available in the target selector.
    let customMcpServers = [];
    try {
      chrome.storage.local.get("zsCustomMcpServers", (r) => {
        if (r && Array.isArray(r.zsCustomMcpServers)) {
          customMcpServers = r.zsCustomMcpServers;
        }
      });
    } catch {}
    function saveCustomMcpServers() {
      try { chrome.storage.local.set({ zsCustomMcpServers: customMcpServers }); } catch {}
    }
    // The bridge (config.json + live health) is the SOURCE OF TRUTH for which
    // addon servers actually exist. Self-heal the local display-name cache when
    // a configured server isn't already known.
    function mergedMcpServers() {
      const live = ((A.bridge && A.bridge.servers) || []).filter((sv) => sv.id !== "roblox");
      const byId = new Map(customMcpServers.map((s) => [s.id, s]));
      const merged = live.map((sv) => {
        const cached = byId.get(sv.id);
        return {
          id: sv.id, name: (cached && cached.name) || sv.id, command: cached && cached.command,
          alive: sv.alive, tools: sv.tools,
        };
      });
      // Self-heal: cache didn't know about a server the bridge actually has.
      let healed = false;
      for (const sv of live) {
        if (!byId.has(sv.id)) { customMcpServers.push({ id: sv.id, name: sv.id }); healed = true; }
      }
      if (healed) saveCustomMcpServers();
      // A server we just added/removed but the bridge hasn't reported back on
      // yet (mid-restart) - still show it, health unknown, so it doesn't blink
      // out of the list during the few seconds the bridge is restarting.
      for (const s of customMcpServers) {
        if (!merged.some((m) => m.id === s.id)) merged.push({ ...s, alive: undefined, tools: undefined });
      }
      return merged;
    }

    function getTargetName(id = getSelectedTargetId()) {
      if (id === "roblox") return "Roblox Studio";
      if (id === "vscode") return "VS Code";
      if (id === "effectcraft") return "EffectCraft";
      const server = mergedMcpServers().find((item) => item.id === id);
      return server ? server.name : id;
    }
    const targetNameHtml = () =>
      getTargetName().replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));

    function setTarget(id = getSelectedTargetId()) {
      if (!targetSelect) return;
      const options = allMcpOptions().filter((option) => isMcpEnabled(option.id));
      if (!options.some((option) => option.id === id)) {
        // The saved/previous target no longer exists (for example the bridge
        // stopped reporting VS Code). Follow the bridge instead of keeping a
        // label that cannot run anything.
        const fallback = options[0];
        if (fallback) {
          id = fallback.id;
          if (getSelectedTargetId() !== id) {
            setSelectedTargetId(id);
            try { chrome.storage.local.set({ [TARGET_STORAGE_KEY]: id }); } catch {}
            refreshActiveToolNames();
          }
        } else {
          options.push({ id, name: id });
        }
      }
      // A one-target bridge has nothing to choose: hide the redundant `repo`
      // pill and keep the bar quiet. It reappears when another server is added.
      if (targetWrap) targetWrap.hidden = options.length <= 1;
      const optionsKey = options.map((option) => `${option.id}:${option.name}`).join("|");
      if (targetSelect.dataset.optionsKey !== optionsKey) {
        targetSelect.replaceChildren(
          ...options.map((option) => domEl("option", { value: option.id, text: option.name }))
        );
        targetSelect.dataset.optionsKey = optionsKey;
      }
      targetSelect.value = id;
      targetSelect.disabled = false; // never locked: the user may switch MCP target at any time
      // Read the label back from the select so the pill can never drift from
      // the option list (a stale "VS Code" pill over a `repo`-only bridge was
      // the visible symptom).
      const nameEl = (root && root.querySelector("#zs-target-name")) || document.getElementById("zs-target-name");
      const selectedOption = targetSelect.options[targetSelect.selectedIndex];
      const label = selectedOption
        ? selectedOption.textContent
        : (options.find((option) => option.id === id) || { name: id }).name;
      if (nameEl && nameEl.textContent !== label) nameEl.textContent = label;
      if (targetMenuEl && !targetMenuEl.hidden) renderTargetMenu();
    }

    function renderTargetMenu() {
      if (!targetMenuEl || !targetSelect) return;
      // Skip the rewrite when nothing changed: periodic status updates call
      // setTarget() -> renderTargetMenu() and would otherwise destroy the buttons
      // between mouse-down and mouse-up, so the click never fires.
      const menuKey = getSelectedTargetId() + "|" + [...targetSelect.options].map((o) => `${o.value}:${o.textContent}`).join("|");
      if (targetMenuEl.dataset.menuKey === menuKey && targetMenuEl.childElementCount) return;
      targetMenuEl.dataset.menuKey = menuKey;
      const sec = domEl(
        "section",
        { className: "zs-menu-sec" },
        domEl("div", { className: "zs-sec-label" }, domEl("span", { text: "MCP target" }))
      );
      for (const o of targetSelect.options) {
        const cur = o.value === getSelectedTargetId();
        const btn = domEl(
          "button",
          {
            type: "button",
            className: `zs-site-opt zs-target-opt${cur ? " zs-target-cur" : ""}`,
            dataset: { id: o.value },
          },
          domEl("span", { className: "zs-site-name" }, domEl("span", { text: o.textContent })),
          cur ? domEl("span", { className: "zs-site-badge", text: "active" }) : null
        );
        btn.addEventListener("click", () => {
          targetMenuEl.hidden = true;
          if (btn.dataset.id === getSelectedTargetId()) return;
          targetSelect.value = btn.dataset.id;
          targetSelect.dispatchEvent(new Event("change"));
        });
        sec.appendChild(btn);
      }
      targetMenuEl.replaceChildren(sec);
    }

    function positionTargetMenu() {
      if (!targetMenuEl || targetMenuEl.hidden || !targetBtn) return;
      const a = targetBtn.getBoundingClientRect();
      const vw = document.documentElement.clientWidth || window.innerWidth;
      const vh = document.documentElement.clientHeight || window.innerHeight;
      const w = Math.min(targetMenuEl.offsetWidth || 220, vw - 16);
      const left = Math.max(8, Math.min(a.left, vw - w - 8));
      const spaceAbove = a.top - 16;
      targetMenuEl.style.left = `${Math.round(left)}px`;
      targetMenuEl.style.right = "auto";
      if (spaceAbove >= 160 || spaceAbove >= vh - a.bottom - 16) {
        targetMenuEl.style.top = "auto";
        targetMenuEl.style.bottom = `${Math.round(vh - a.top + 6)}px`;
        targetMenuEl.style.maxHeight = `${Math.max(100, Math.min(spaceAbove, vh - 16))}px`;
      } else {
        const top = Math.min(vh - 108, a.bottom + 6);
        targetMenuEl.style.top = `${Math.round(top)}px`;
        targetMenuEl.style.bottom = "auto";
        targetMenuEl.style.maxHeight = `${Math.max(100, vh - top - 8)}px`;
      }
    }
    // ── The "more" menu (⋯) ─────────────────────────────────────────────────
    // One popover holding every secondary control. Opens above the bar.
    // ── MCP settings popup (toggle which servers are enabled) ───────────────
    function allMcpOptions() {
      const live = mergedMcpServers();
      const known = new Set(live.map((server) => server.id));
      // The bridge is the source of truth. The legacy defaults only stand in
      // before the first status arrives (or while the bridge is unreachable),
      // so a Linux `repo`-only bridge never shows VS Code/Roblox/EffectCraft
      // targets that cannot receive a command.
      const base = [
        { id: "vscode", name: "VS Code" },
        { id: "roblox", name: "Roblox Studio" },
        { id: "effectcraft", name: "EffectCraft" },
      ].filter((option) => known.has(option.id) || live.length === 0);
      const extra = live
        .filter((s) => !base.some((b) => b.id === s.id))
        .map((s) => ({ id: s.id, name: getTargetName(s.id) }));
      return [...base, ...extra];
    }

    function openMcpSettings() {
      const old = document.getElementById("zs-mcp-pop");
      if (old) old.remove();
      const servers = mergedMcpServers();
      const listEl = domEl("div", { className: "zs-mcp-pop-list" });
      for (const o of allMcpOptions()) {
        const sv = servers.find((s) => s.id === o.id);
        const toolCount = (sv && sv.tools) || (o.id === "roblox" && A.bridge && A.bridge.tools) || 0;
        const meta = toolCount ? `${toolCount} tools` : "";
        listEl.appendChild(
          domEl(
            "label",
            { className: "zs-mcp-row" },
            domEl(
              "span",
              { className: "zs-mcp-row-info" },
              domEl("span", { className: "zs-mcp-row-name", text: o.name }),
              domEl("span", { className: "zs-mcp-row-meta", text: meta })
            ),
            domEl("input", {
              type: "checkbox",
              className: "zs-mcp-check",
              dataset: { id: o.id },
              checked: isMcpEnabled(o.id),
            }),
            domEl("span", { className: "zs-mcp-toggle" })
          )
        );
      }
      const pop = domEl(
        "div",
        { id: "zs-mcp-pop" },
        domEl(
          "div",
          { className: "zs-mcp-pop-card", role: "dialog", "aria-label": "MCP settings" },
          domEl(
            "div",
            { className: "zs-mcp-pop-head" },
            domEl("span", { text: "MCP servers" }),
            domEl("button", { className: "zs-mcp-pop-close", "aria-label": "Close", text: "✕" })
          ),
          domEl("div", {
            className: "zs-mcp-pop-note",
            text: "Only enabled servers appear in the dropdown and are read by the AI. Disabled servers cost no tokens.",
          }),
          listEl,
          domEl(
            "div",
            { className: "zs-mcp-pop-head", style: "border-top:1px solid rgba(128,128,128,.25);margin-top:4px" },
            domEl("span", { text: "Sessions" })
          ),
          domEl(
            "label",
            { className: "zs-mcp-row", title: "Let a hidden tab keep its session running instead of parking it" },
            domEl(
              "span",
              { className: "zs-mcp-row-info" },
              domEl("span", { className: "zs-mcp-row-name", text: "Background sessions" }),
              domEl("span", { className: "zs-mcp-row-meta", text: "Keep working while this tab is in the background" })
            ),
            domEl("input", { type: "checkbox", id: "zs-bg-sessions", checked: !!getBackgroundSessions() })
          )
        )
      );
      document.documentElement.appendChild(pop);

      const close = () => {
        pop.remove();
        // If the active target was just disabled, move to the first enabled one
        // and reload so the whole extension restarts against it.
        if (!isMcpEnabled(getSelectedTargetId())) {
          const next = allMcpOptions().find((o) => isMcpEnabled(o.id));
          if (next) {
            setSelectedTargetId(next.id);
            const reloadPage = () => { try { location.reload(); } catch {} };
            try { chrome.storage.local.set({ [TARGET_STORAGE_KEY]: getSelectedTargetId() }, reloadPage); } catch { reloadPage(); }
            return;
          }
        }
        setTarget(getSelectedTargetId());
      };
      pop.addEventListener("click", (e) => { if (e.target === pop) close(); });
      pop.querySelector(".zs-mcp-pop-close").addEventListener("click", close);
      const bgBox = pop.querySelector("#zs-bg-sessions");
      if (bgBox) bgBox.addEventListener("change", () => setBackgroundSessions(bgBox.checked));
      pop.querySelectorAll(".zs-mcp-check").forEach((box) =>
        box.addEventListener("change", () => {
          setMcpEnabled(box.dataset.id, box.checked);
          // Refresh the dropdown right away so a re-enabled server is selectable
          // without waiting for the popup to close.
          setTarget(getSelectedTargetId());
        }));
    }

    // ── Skills settings popup (toggle which workspace skills are listed) ────
    function openSkillsSettings() {
      const old = document.getElementById("zs-mcp-pop");
      if (old) old.remove();
      const pop = document.createElement("div");
      pop.id = "zs-mcp-pop";
      let mode = "list"; // "list" | "paste" | "review"
      let draft = "";
      let importMsg = "";
      const renderImport = () => {
        const v = mode === "review" ? validateSkillText(draft) : null;
        const bodyNodes = mode === "paste"
          ? [
              domEl("input", {
                type: "file",
                id: "zs-skill-file",
                accept: ".md,.txt,text/markdown,text/plain",
                style: "margin-bottom:6px;font-size:11px;max-width:100%",
              }),
              domEl("textarea", {
                id: "zs-skill-text",
                rows: 10,
                style: "width:100%;box-sizing:border-box;font:11px ui-monospace,Consolas,monospace;background:transparent;color:inherit;border:1px solid rgba(128,128,128,.4);border-radius:6px;padding:6px",
                placeholder: "Paste the full SKILL.md here (with --- name / description --- frontmatter)",
                value: draft,
              }),
              domEl("div", { className: "zs-mcp-pop-note", style: "color:#ff6b6b", text: importMsg }),
              domEl(
                "div",
                { style: "display:flex;gap:8px;margin-top:8px" },
                domEl("button", { id: "zs-skill-cancel", className: "zs-gear", style: "flex:1", text: "Cancel" }),
                domEl("button", { id: "zs-skill-review", className: "zs-gear", style: "flex:1", text: "Review" })
              ),
            ]
          : [
              domEl("div", {
                className: "zs-mcp-pop-note",
                style: "color:#ffb454",
                text: "Review carefully. Third-party skills can contain instructions that make the AI run commands or change files. It will be saved DISABLED until you turn it on.",
              }),
              domEl(
                "div",
                { className: "zs-mcp-pop-note" },
                domEl("b", { text: v.name || "" }),
                ` - ${v.description || ""}`
              ),
              domEl("pre", {
                style: "max-height:220px;overflow:auto;white-space:pre-wrap;font:11px ui-monospace,Consolas,monospace;border:1px solid rgba(128,128,128,.4);border-radius:6px;padding:6px;margin:6px 0",
                text: draft,
              }),
              domEl("div", { className: "zs-mcp-pop-note", style: "color:#ff6b6b", text: importMsg }),
              domEl(
                "div",
                { style: "display:flex;gap:8px;margin-top:8px" },
                domEl("button", { id: "zs-skill-back", className: "zs-gear", style: "flex:1", text: "Back" }),
                domEl("button", { id: "zs-skill-global", className: "zs-gear", style: "flex:1", text: "Save to global" }),
                domEl("button", { id: "zs-skill-confirm", className: "zs-gear", style: "flex:1", text: "Confirm import" })
              ),
            ];
        pop.replaceChildren(
          domEl(
            "div",
            { className: "zs-mcp-pop-card", role: "dialog", "aria-label": "Import skill" },
            domEl(
              "div",
              { className: "zs-mcp-pop-head" },
              domEl("span", { text: "Import skill" }),
              domEl("button", { className: "zs-mcp-pop-close", "aria-label": "Close", text: "✕" })
            ),
            ...bodyNodes
          )
        );
        pop.querySelector(".zs-mcp-pop-close").addEventListener("click", () => pop.remove());
        const fileInput = pop.querySelector("#zs-skill-file");
        if (fileInput) fileInput.addEventListener("change", () => {
          const f = fileInput.files && fileInput.files[0];
          if (!f) return;
          if (f.size > SKILL_MAX_BYTES) { importMsg = "File too large (max 20 KB)."; renderImport(); return; }
          const reader = new FileReader();
          reader.onload = () => {
            draft = String(reader.result || "");
            importMsg = "";
            renderImport();
          };
          reader.onerror = () => { importMsg = "Could not read the file."; renderImport(); };
          reader.readAsText(f);
        });
        const on = (id, fn) => { const el = pop.querySelector(id); if (el) el.addEventListener("click", fn); };
        on("#zs-skill-cancel", () => { mode = "list"; importMsg = ""; draft = ""; render(); });
        on("#zs-skill-review", () => {
          draft = pop.querySelector("#zs-skill-text").value;
          const chk = validateSkillText(draft);
          if (!chk.ok) { importMsg = chk.error; renderImport(); return; }
          if (getAllSkills().some((s) => s.name === chk.name)) { importMsg = `A skill named "${chk.name}" already exists.`; renderImport(); return; }
          importMsg = ""; mode = "review"; renderImport();
        });
        on("#zs-skill-back", () => { mode = "paste"; importMsg = ""; renderImport(); });
        on("#zs-skill-global", () => {
          const res = saveGlobalSkill(draft);
          if (!res.ok) { importMsg = res.error; renderImport(); return; }
          mode = "list"; draft = ""; importMsg = "";
          render();
        });
        on("#zs-skill-confirm", async () => {
          const res = await importSkillText(draft);
          if (!res.ok) { importMsg = res.error; renderImport(); return; }
          mode = "list"; draft = ""; importMsg = "";
          await loadWorkspaceSkills();
          if (pop.isConnected) render();
        });
      };
      const render = () => {
        if (mode !== "list") { renderImport(); return; }
        const skills = getAllSkills();
        const skillNodes = skills.length
          ? skills.map((s) =>
              domEl(
                "label",
                { className: "zs-mcp-row" },
                domEl(
                  "span",
                  { className: "zs-mcp-row-info" },
                  domEl("span", { className: "zs-mcp-row-name", text: s.name }),
                  domEl("span", { className: "zs-mcp-row-meta", text: s.description })
                ),
                domEl("input", {
                  type: "checkbox",
                  className: "zs-mcp-check",
                  dataset: { name: s.name },
                  checked: isSkillEnabled(s.name),
                }),
                domEl("span", { className: "zs-mcp-toggle" })
              )
            )
          : [domEl("div", { className: "zs-mcp-pop-note", text: "No skills found in .snapgent/skills/ (VS Code workspace only)." })];
        const globals = getGlobalSkills();
        const globalKeys = Object.keys(globals);
        const globalNodes = globalKeys.length
          ? globalKeys.map((n) =>
              domEl(
                "div",
                { className: "zs-mcp-row" },
                domEl(
                  "span",
                  { className: "zs-mcp-row-info" },
                  domEl("span", { className: "zs-mcp-row-name", text: n }),
                  domEl("span", { className: "zs-mcp-row-meta", text: globals[n].description })
                ),
                domEl("button", { className: "zs-gear zs-gskill-install", dataset: { name: n }, text: "Install" }),
                domEl("button", { className: "zs-gear zs-gskill-del", dataset: { name: n }, text: "Delete" })
              )
            )
          : [domEl("div", { className: "zs-mcp-pop-note", text: "Empty. Use \"Save to global\" while reviewing an import." })];
        pop.replaceChildren(
          domEl(
            "div",
            { className: "zs-mcp-pop-card", role: "dialog", "aria-label": "Skills settings" },
            domEl(
              "div",
              { className: "zs-mcp-pop-head" },
              domEl("span", { text: "Skills" }),
              domEl("button", { className: "zs-mcp-pop-close", "aria-label": "Close", text: "✕" })
            ),
            domEl("div", {
              className: "zs-mcp-pop-note",
              text: "Only enabled skills are listed in the prompt. Changes apply to the next chat session.",
            }),
            domEl("div", { className: "zs-mcp-pop-list" }, ...skillNodes),
            domEl(
              "div",
              { className: "zs-mcp-pop-note", style: "margin-top:10px" },
              domEl("b", { text: "Global library" }),
              " (stored in this browser; install into a workspace to use)"
            ),
            ...globalNodes,
            domEl(
              "div",
              { style: "margin-top:8px" },
              domEl("button", { id: "zs-skill-import", className: "zs-gear", style: "width:100%", text: "+ Import skill" })
            )
          )
        );
        pop.querySelector(".zs-mcp-pop-close").addEventListener("click", () => pop.remove());
        pop.querySelectorAll(".zs-gskill-install").forEach((b) => b.addEventListener("click", () => {
          const g = getGlobalSkills()[b.dataset.name];
          if (!g) return;
          draft = g.text; importMsg = "";
          if (getAllSkills().some((s) => s.name === b.dataset.name)) { importMsg = `A skill named "${b.dataset.name}" already exists in this workspace.`; }
          mode = "review"; render();
        }));
        pop.querySelectorAll(".zs-gskill-del").forEach((b) => b.addEventListener("click", () => {
          removeGlobalSkill(b.dataset.name); render();
        }));
        const impBtn = pop.querySelector("#zs-skill-import");
        if (impBtn) impBtn.addEventListener("click", () => { mode = "paste"; draft = ""; importMsg = ""; render(); });
        pop.querySelectorAll(".zs-mcp-check").forEach((box) =>
          box.addEventListener("change", () => setSkillEnabled(box.dataset.name, box.checked)));
      };
      pop.addEventListener("click", (e) => { if (e.target === pop) pop.remove(); });
      document.documentElement.appendChild(pop);
      render();
      if (getSelectedTargetId() === "vscode") loadWorkspaceSkills().then(() => { if (pop.isConnected) render(); });
    }

    function buildMenu() {
      const here = (P.displayName || "").toLowerCase();
      const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
      const siteGrid = domEl("div", { className: "zs-site-grid" });
      for (const s of AI_SITES) {
        const current = s.name.toLowerCase() === here;
        const labelEl = domEl(
          "span",
          { className: "zs-site-name" },
          domEl("span", { text: s.name }),
          domEl("span", { className: "zs-site-host", text: hostOf(s.url) })
        );
        siteGrid.appendChild(
          current
            ? domEl("div", { className: "zs-site-opt zs-site-here" }, labelEl, domEl("span", { className: "zs-site-badge", text: "active" }))
            : domEl("button", { className: "zs-site-opt", dataset: { u: s.url } }, labelEl, domEl("span", { className: "zs-site-go", text: "→" }))
        );
      }
      menuEl.replaceChildren(
        domEl("div", { className: "zs-menu-head" }, domEl("span", { className: "zs-menu-logo", text: "snapgentV3" })),
        domEl(
          "section",
          { className: "zs-menu-sec" },
          domEl(
            "div",
            { className: "zs-sec-label zs-sec-label-row" },
            domEl("span", { text: "Switch AI" }),
            domEl(
              "span",
              null,
              domEl("button", { id: "zs-skills-settings", className: "zs-gear", title: "Skills", "aria-label": "Skills", text: "★" }),
              domEl("button", { id: "zs-mcp-settings", className: "zs-gear", title: "MCP settings", "aria-label": "MCP settings", text: "⚙" })
            )
          ),
          siteGrid
        )
      );
      const open = (url) => { try { window.open(url, "_blank", "noopener"); } catch {} menuEl.hidden = true; };
      menuEl.querySelectorAll("button.zs-site-opt, .zs-tip-opt").forEach((b) =>
        b.addEventListener("click", () => open(b.dataset.u)));
      const gear = menuEl.querySelector("#zs-mcp-settings");
      if (gear) gear.addEventListener("click", (e) => { e.stopPropagation(); menuEl.hidden = true; openMcpSettings(); });
      const starBtn = menuEl.querySelector("#zs-skills-settings");
      if (starBtn) starBtn.addEventListener("click", (e) => { e.stopPropagation(); menuEl.hidden = true; openSkillsSettings(); });
    }

    // ── First-time onboarding card (bridge missing) ─────────────────────────
    let setupCard = null, setupSeen = false, setupRaf = null;
    try {
      chrome.storage.local.get("zsSetupSeen", (r) => {
        if (r && r.zsSetupSeen) setupSeen = true;
      });
    } catch {}

    function buildSetup() {
      setupCard = document.createElement("div");
      setupCard.id = "zs-setup";
      setupCard.hidden = true;
      setupCard.replaceChildren(
        domEl(
          "div",
          { id: "zs-setup-head" },
          domEl("span", { id: "zs-setup-logo", text: "snapgentV3" }),
          domEl("span", { id: "zs-setup-tag", text: "Setup" })
        ),
        domEl("div", { id: "zs-setup-sub", text: "3 quick steps." }),
        domEl(
          "ol",
          { id: "zs-setup-steps" },
          domEl("li", null, "Open ", domEl("b", { text: "Settings" })),
          domEl("li", null, "Run ", domEl("code", { text: "start.bat" })),
          domEl("li", null, "Press ", domEl("b", { text: "Start" }))
        ),
        domEl(
          "div",
          { className: "zs-setup-copy-row" },
          domEl("input", { type: "text", id: "zs-setup-link", readOnly: true, value: GITHUB_URL }),
          domEl("button", { id: "zs-setup-copy", text: "Copy" })
        ),
        domEl("button", { id: "zs-setup-dismiss", text: "OK" })
      );
      document.documentElement.appendChild(setupCard);

      setupCard.querySelector("#zs-setup-copy").addEventListener("click", () => {
        try { navigator.clipboard.writeText(GITHUB_URL); } catch {
          const inp = setupCard.querySelector("#zs-setup-link");
          inp.select(); try { document.execCommand("copy"); } catch {}
        }
        const btn = setupCard.querySelector("#zs-setup-copy");
        btn.textContent = "Copied!";
        setTimeout(() => { btn.textContent = "Copy"; }, 1600);
      });

      setupCard.querySelector("#zs-setup-dismiss").addEventListener("click", () => {
        setupSeen = true;
        try { chrome.storage.local.set({ zsSetupSeen: true }); } catch {}
        hideSetup();
      });
    }

    // The onboarding card is pinned to the top-right corner (via CSS), out of the
    // way of the composer; nothing to reposition per frame.
    function placeSetup() {}

    function showSetup() {
      if (!setupCard) buildSetup();
      if (setupCard.hidden) {
        setupCard.hidden = false;
        cancelAnimationFrame(setupRaf);
        placeSetup();
      }
    }

    function hideSetup() {
      if (setupCard) setupCard.hidden = true;
      cancelAnimationFrame(setupRaf);
    }

    function refreshSetup(bridgeConnected) {
      if (setupSeen || bridgeConnected) { hideSetup(); return; }
      // Bridge is down, but if the user is just READING an existing
      // conversation with no snapgentV3 session (the "No agent here" state),
      // a "bridge down" onboarding popup is pure noise - they may not want an
      // agent here at all (user request). Keep it for the states where the
      // bridge actually matters: a fresh/empty chat (the Start affordance is
      // showing) or a conversation with a live/starting session.
      if (!A.started && !A.starting && !P.chatIsEmpty()) { hideSetup(); return; }
      showSetup();
    }

    // The single source of truth for the bar's content. Decides the status tone,
    // the state line and the primary action from the live state:
    //  • starting        → spinner, "Starting the Roblox agent…"
    //  • session active   → "Agent active · N tools" (no action)
    //  • fresh blank chat → "Standby…" (or a bridge/Studio warning), action = Start
    //  • existing chat    → "No agent in this chat" (informs only, no action)
    function renderBar() {
      if (!bar) return;
      setTarget(getSelectedTargetId());
      // showSpinner = optional leading spinner; msg = the wrappable text.
      let toneClass = "standby", showSpinner = false, msg = "", label = "", kind = "", disabled = false, warn = false;
      // Orphaned page: check FIRST and return. Nothing below can be true any
      // more - the status poll is stopped, so every value it would render (the
      // connected state, "Agent active", and the tool count) is a frozen snapshot of a
      // build this page no longer talks to. Leaving those up contradicted the
      // "reload this page" banner sitting right next to them, which is exactly
      // the confusing state Seb caught on 2026-08-14.
      // No action button here: the banner already carries the Reload one.
      if (A.staleExtension) {
        toneClass = "warn"; warn = true;
        msg = `<b>Disconnected</b> · reload page`;
      }
      // Show "Starting…" for the whole bootstrap. If the user actually leaves for
      // a new (empty) chat, syncSessionState clears A.starting, so this naturally
      // falls back to that chat's own state - no fragile per-key check here (fresh
      // chats share a key, and the conversation id only appears mid-bootstrap).
      else if (A.starting) {
        toneClass = "starting";
        showSpinner = true;
        msg = `Starting…`;
        label = "Starting…"; kind = "starting"; disabled = true;
      } else if (A.started && getSelectedTargetId() !== "roblox") {
        const server = (A.bridge.servers || []).find((item) => item.id === getSelectedTargetId());
        const tools = activeTools().length || (server && server.tools) || 0;
        if (!A.bridge.connected) {
          toneClass = "warn"; warn = true;
          msg = `<b>Active</b> · run start.bat`;
        } else if (!bridgeOk) {
          toneClass = "warn"; warn = true;
          msg = `<b>Active</b> · ${getTargetName()} offline`;
        } else {
          toneClass = "active";
          msg = `<b>Active</b>${tools ? ` · ${tools} tools` : ""} · ${getTargetName()}`;
        }
      } else if (A.started) {
        // Prefer the ADVERTISED list length (A.toolList - the AGGREGATE catalogue
        // across every connected MCP server, already filtered by the vision/blocked
        // gate so it matches what the model actually has: e.g. screen_capture is
        // absent on non-vision providers like Kimi). After a page reload A.toolList
        // is empty until the next list_tools, so fall back to the sum of every
        // server's per-server health count (Roblox + addons like Blender) - NOT the
        // Roblox-only count, which made the total drop to just 27 after a reload.
        const selectedServer = A.bridge &&
          (A.bridge.servers || []).find((item) => item.id === getSelectedTargetId());
        const tools = activeTools().length ||
          (selectedServer && selectedServer.tools) ||
          (getSelectedTargetId() === "roblox" && A.bridge && A.bridge.tools) || 0;
        // "N tools" only means StudioMCP itself is up - it advertises its full
        // catalogue even with no Studio/place attached (see probe_studio() in
        // bridge.py), so showing it while Studio/place isn't actually usable
        // reads as "everything's fine" when tool calls will just fail. Surface
        // the real blocker instead in that case.
        if (A.bridge && A.bridge.connected === false) {
          // placeDown/appDown/studioDown are all false in this case (they're
          // only computed when the bridge IS connected - see setStatus), so
          // without this check the bridge dropping fell through to the
          // stale "N tools" text below, reading as if nothing was wrong.
          toneClass = "warn"; warn = true;
          msg = `<b>Active</b> · run start.bat`;
        } else if ((placeDown || appDown || studioDown) && addonOk) {
          // DEGRADED session by CHOICE: the user started the agent with Roblox
          // down but other MCP server(s) alive (the "Start agent (Roblox
          // offline)" path) - they may only want the addon tools (e.g. Blender).
          // Keep the warning tone as the honest health signal, but do NOT keep the
          // red imperative "open Roblox Studio" nag on screen for the whole
          // session (warn=false → no zs-state-warn red text). The full nag
          // still shows when NO server is usable (the branches below).
          toneClass = "warn";
          msg = `<b>Active</b>${tools ? ` · ${tools} tools` : ""} · Roblox offline`;
        } else if (placeDown) {
          toneClass = "warn"; warn = true;
          msg = `<b>Active</b> · open a place in Studio`;
        } else if (appDown || studioDown) {
          toneClass = "warn"; warn = true;
          msg = studioProcUp
            ? `<b>Active</b> · Studio not connected`
            : `<b>Active</b> · open Studio`;
        } else {
          toneClass = "active";
          // The green "Agent active" text is the live status signal.
          msg = `<b>Active</b>${tools ? ` · ${tools} tools` : ""}`;
        }
      } else if (P.isFreshChat() || P.chatIsEmpty()) {
        // Treat ANY empty chat (no turns yet) as the standby/start case - not just
        // the strict fresh-chat match. isFreshChat() also requires an exact root
        // path AND the editor already mounted; on a cold load (e.g. arriving from a
        // search-engine link) the SPA can show pathname/editor before they settle,
        // which used to drop into the discouraging "No agent here" branch on a page
        // that is actually empty and startable. "No agent here" is only correct for
        // an EXISTING conversation (one that has turns) we did not start.
        const selectedServer = (A.bridge.servers || []).find((item) => item.id === getSelectedTargetId());
        const vscodeWorkspaceMissing = getSelectedTargetId() === "vscode" &&
          !!A.bridge.connected && !!selectedServer && !!selectedServer.alive &&
          !(selectedServer.tools > 0);
        if (getSelectedTargetId() !== "roblox" &&
            (!bridgeOk || (getSelectedTargetId() === "vscode" && !workspaceReady))) {
          toneClass = "warn"; warn = true;
          msg = !A.bridge.connected
            ? `Run <b>start.bat</b>`
            : getSelectedTargetId() === "vscode" && (bridgeOk || vscodeWorkspaceMissing)
              ? workspaceProbePending
                ? `Checking <b>VS Code workspace</b>…`
                : `Open a <b>folder in VS Code</b>`
              : `<b>${getTargetName()} unavailable</b>`;
          label = `▶︎ Start`; kind = "start"; disabled = true;
        } else if (bridgeOk && (getSelectedTargetId() !== "vscode" || workspaceReady)) {
          toneClass = "standby";
          msg = `Ready.`;
          label = `▶︎ Start`; kind = "start";
        } else if (addonOk) {
          // Roblox is down but another MCP server is live: allow a DEGRADED start
          // (yellow). The agent runs on the other server(s); Roblox tools stay
          // unavailable until Studio is back. Button enabled, but visibly warned.
          toneClass = "warn"; warn = true;
          msg = !A.bridge.connected
            ? `Run <b>start.bat</b>`
            : studioProcUp
              ? `<b>Studio not connected</b>`
              : `<b>Studio offline</b>`;
          label = "▶︎ Start (offline)"; kind = "start-degraded";
        } else {
          toneClass = "warn"; warn = true;
          msg = !A.bridge.connected
            ? `Run <b>start.bat</b>`
            : placeDown
              ? `Open a <b>place</b> in Studio`
              : (appDown || studioDown) && studioProcUp
                ? `Studio not connected`
                : appDown
                  ? `Open <b>Studio</b>`
                  : studioDown
                    ? `Open <b>Studio</b>`
                    : `Open <b>Studio</b>`;
          label = `▶︎ Start`; kind = "start";
        }
        if (getSelectedTargetId() === "roblox") disabled = !bridgeOk && !addonOk;
      } else {
        toneClass = "noagent";
        msg = `No agent. Open a new chat.`;
      }
      // Parked on visibility: the loop is alive but deliberately frozen because
      // this tab is not the foreground tab of its window. Say so explicitly -
      // otherwise the bar keeps claiming "Agent active" while nothing advances,
      // which reads as a hang (and is what users reported as "it died in the
      // background"). No red warn tone: this is a normal, recoverable pause.
      if (A.parked && (A.running || A.starting)) {
        toneClass = "warn"; warn = false;
        msg = `<b>Paused</b> · open this tab`;
      }
      // Provider mode guard: some sites (e.g. Arena) only work in one chat mode.
      // When the provider reports the current mode is unsupported, override the
      // bar into a visible warning and disable Start until the user switches back.
      // Skipped once a session is started/starting (the mode is fixed for the
      // conversation by then). Reactive: renderBar runs on every sweep, so the
      // warning appears/clears the instant the user changes the mode dropdown.
      if (!A.started && !A.starting && P.modeWarning) {
        const modeWarn = P.modeWarning();
        if (modeWarn) {
          toneClass = "warn"; warn = true; msg = modeWarn;
          if (kind === "start" || kind === "start-degraded") disabled = true;
        }
      }
      // Only touch the DOM when something actually changed. renderBar runs on
      // every sweep; rewriting stateEl.innerHTML each time recreated the spinner
      // <span> and RESTARTED its CSS animation, so "Starting…" appeared to stutter.
      const busy = !stopBtn.hidden;
      // Keep target and provider selectors available before startup so the user
      // can choose both sides of the connection before launching the agent.
      const showExtras = true;
      const sig = [toneClass, showSpinner ? 1 : 0, msg, label, kind, disabled, warn, busy, showExtras].join("|");
      if (sig === lastBarSig) return;
      lastBarSig = sig;
      // Set the tone WITHOUT clobbering other classes (e.g. zs-bar-inline, which
      // placeBar adds for the in-flow mount - overwriting className broke the
      // layout, making the bar fall back to fixed positioning and overlap).
      bar.classList.remove("tone-standby", "tone-active", "tone-warn", "tone-noagent", "tone-starting");
      bar.classList.add(`tone-${toneClass}`);
      const stateTxt = domEl("span", { className: "zs-state-txt", text: String(msg == null ? "" : msg) });
      const stateNodes = showSpinner ? [domEl("span", { className: "zs-spin" }), stateTxt] : [stateTxt];
      stateEl.replaceChildren(...stateNodes);
      stateEl.classList.toggle("zs-state-warn", warn);
      actionBtn.textContent = label;
      actionBtn.dataset.kind = kind;
      actionBtn.disabled = disabled;
      // The Stop button replaces the action button while the agent is busy.
      // With no kind (e.g. agent active, or an existing chat) there's no primary
      // action to offer, so the button is hidden entirely.
      actionBtn.style.display = (busy || !kind) ? "none" : "";
      // AI selector + tips/support: only once a session is live. Discord stays
      // visible in every state (it's the help link).
      if (switchBtn) switchBtn.style.display = showExtras ? "" : "none";
    }
    let lastBarSig = "";

    // Thin wrappers kept for the core's call sites; the decision lives in renderBar.
    function setStarted() { renderBar(); }
    function setStarting() { renderBar(); }

    function setStatus(s) {
      A.bridge = s;
      if (!bar) return;
      const servers = s.servers || [];
      if (getSelectedTargetId() !== "roblox") {
        const selected = servers.find((item) => item.id === getSelectedTargetId());
        const serverConnected = !!s.connected && !!selected && !!selected.alive;
        const ready = serverConnected &&
          ((selected.tools || 0) > 0 || activeTools().length > 0);
        bridgeOk = ready;
        studioDown = false;
        placeDown = false;
        appDown = false;
        studioProcUp = false;
        addonOk = false;
        setTarget(getSelectedTargetId());
        if (wasConnected && !s.connected) bridgeAlert(true);
        if (s.connected) bridgeAlert(false);
        wasConnected = s.connected;
        if (s.connected && !setupSeen) {
          setupSeen = true;
          try { chrome.storage.local.set({ zsSetupSeen: true }); } catch {}
        }
        // Workspace probe throttle. A 5 s floor was too tight: renderBar() is
        // re-entrant (status timer + DOM mutations + this block's own finally()),
        // so the probe could fire twice in a row and reach ~24 list_dir/min -
        // measured 29,280 probe calls in one day, which starved real tool calls
        // and made the bridge look unreachable. Backoff grows after a failure and
        // success resets it to the floor.
        const probeFloor = workspaceReady === false && workspaceProbeFails > 0
          ? Math.min(5000 * Math.pow(2, Math.min(workspaceProbeFails, 5)), 300000)
          : 30000;
        if (getSelectedTargetId() === "vscode" && serverConnected && !workspaceProbePending &&
            Date.now() - workspaceProbeAt >= probeFloor) {
          workspaceProbeAt = Date.now();
          workspaceProbePending = true;
          ensureTools(false).then(() => {
            const workspaceTool = activeTools().find((tool) => bareToolName(tool.name) === "list_dir");
            bridgeOk = serverConnected &&
              ((selected.tools || 0) > 0 || activeTools().length > 0);
            if (!workspaceTool) {
              workspaceReady = false;
              workspaceProbeFails += 1;
              return;
            }
            return bg({
              type: "call_tool",
              name: workspaceTool.name,
              arguments: { path: "." },
              timeout: 5000,
            }).then((result) => {
              workspaceReady = !!(result && result.ok);
              workspaceProbeFails = workspaceReady ? 0 : workspaceProbeFails + 1;
            });
          }).catch((error) => {
            workspaceReady = false;
            workspaceProbeFails += 1;
            console.warn("[snapgentV3] Could not verify VS Code workspace:", error);
          }).finally(() => {
            workspaceProbePending = false;
            // Do NOT call renderBar() here: this block runs *inside* renderBar(),
            // so it would recurse and re-arm the probe immediately - one of the
            // causes of the list_dir probe storm.
          });
        } else if (getSelectedTargetId() === "vscode" && !serverConnected) {
          workspaceReady = false;
        }
        renderBar();
        refreshSetup(s.connected);
        return;
      }
      // snapgentV3 status tracks ONLY the primary Roblox MCP server. Every other
      // server is an addon and must NEVER make the status/gate look connected while
      // Roblox itself is down. Old bridges don't send per-server health, so fall
      // back to the aggregate signals they do send (mcpAlive / total tools).
      const roblox = servers.find((x) => x.id === "roblox");
      const mcpUp = roblox ? !!roblox.alive : (!!s.mcpAlive || servers.some((x) => x.alive));
      // Roblox-only count drives the connectivity gate; an addon must never make
      // the Roblox target appear usable while Roblox itself is down...
      const robloxTools = roblox ? (roblox.tools || 0) : (s.tools || 0);
      const mcpOk = s.connected && (mcpUp || robloxTools > 0);
      // ...but the DISPLAYED count is the aggregate across every server (Roblox +
      // addons like Blender), so it stays consistent with the bar and doesn't
      // under-report when addon servers are loaded.
      const totalTools = servers.reduce((n, x) => n + (x.tools || 0), 0) || s.tools || robloxTools;
      // studio === false means the MCP server answered but the Studio is not USABLE
      // (no place loaded). studioApp tells the two sub-cases apart:
      //   studioApp === false → no Studio connected at all (app closed OR its MCP
      //                         server option is disabled - indistinguishable).
      //   studioApp === true  → Studio open but no place loaded (home screen / place
      //                         closed mid-session). THIS is the case that used to
      //                         wrongly read "Connected".
      // null/undefined = unknown (old bridge / probe busy) → don't degrade.
      const studioOff = mcpOk && s.studio === false;
      const noApp = studioOff && s.studioApp === false;
      const noPlace = studioOff && s.studioApp === true;
      const ok = mcpOk && !studioOff;
      // Studio PROCESS running on the machine (bridge-side tasklist check).
      // Splits noApp into its two truly different situations: Studio not
      // launched at all vs Studio OPEN but its MCP plugin never registered
      // with the bridge. The plugin only attempts to register ONCE (at Studio
      // boot or on a panel/toggle interaction) and never retries by itself,
      // so for the second case "open Roblox Studio" is dead-end advice - the
      // action that actually works (validated live 3x, 2026-07-11) is opening
      // Assistant Settings > MCP Servers inside the already-open Studio.
      const procUp = s.studioProc === true;
      let txt;
      // A 1012 close means the bridge rotated its token and is waiting for the
      // worker to dial back in, so don't tell the user to start the bridge.
      if (!s.connected) txt = s.rotatingToken
        ? "Bridge token rotated - reconnecting"
        : "Bridge offline, run start.bat";
      else if (!mcpOk) txt = "Bridge OK, open Roblox Studio";
      else if (noPlace) txt = "Roblox Studio is open but no place is loaded - open a place";
      else if (noApp) txt = procUp
        ? "Studio is open but not connected - in Studio, open Assistant Settings > MCP Servers (or toggle its MCP server off/on)"
        : "Roblox Studio not connected - open it and enable its MCP server";
      else if (studioOff) txt = "Studio not connected";
      else txt = `Connected · ${totalTools} tools ready`;
      stateEl.title = txt;
      bridgeOk = ok;
      studioDown = studioOff;
      placeDown = noPlace;
      appDown = noApp;
      studioProcUp = procUp;
      // A non-Roblox MCP (Blender, Sketchfab, ...) that is actually alive. When
      // Roblox itself is down but such a server is present, the session can still
      // start in a DEGRADED mode - the agent just can't touch Roblox until Studio
      // is back. Gated on s.connected so a dropped bridge never reads as usable.
      addonOk = !!s.connected && servers.some((x) => x.id !== "roblox" && x.alive && (x.tools || 0) > 0);
      // Bridge-drop alert: a clear, persistent red banner the moment a
      // previously-connected bridge goes offline. Clears on reconnect.
      if (wasConnected && !s.connected) bridgeAlert(true);
      if (s.connected) bridgeAlert(false);
      wasConnected = s.connected;
      // Once the bridge has connected at least once, onboarding is done: never
      // resurface the "download the bridge" setup card again (otherwise, if the
      // bridge later drops, it would reappear on top of the bridge-lost banner).
      if (s.connected && !setupSeen) {
        setupSeen = true;
        try { chrome.storage.local.set({ zsSetupSeen: true }); } catch {}
      }
      renderBar();
      refreshSetup(s.connected);
    }

    // The page outlived its extension build (reload / Chrome auto-update /
    // disable+enable). Distinct from bridgeAlert on purpose: opposite cause,
    // opposite fix, and this one NEVER self-heals, so the banner has no Close
    // button and offers the reload directly rather than telling the user to go
    // restart a bridge that was never down.
    function staleExtensionAlert() {
      // Latch it BEFORE painting, so the bar drops its frozen "Agent active ·
      // N tools" in the same pass and never contradicts the banner.
      A.staleExtension = true;
      renderBar();
      if (bridgeBannerEl) { bridgeBannerEl.remove(); bridgeBannerEl = null; }
      if (root.querySelector(".zs-banner.zs-stale")) return;
      const b = document.createElement("div");
      b.className = "zs-banner limit zs-stale";
      b.replaceChildren(
        domEl("div", { className: "zs-banner-t", text: "⚠ Reload page" }),
        domEl("div", { className: "zs-banner-m", text: "snapgentV3 was updated. Reload this page to continue." }),
        domEl("div", { className: "zs-banner-acts" }, domEl("button", { className: "zs-banner-reload", text: "Reload page" }))
      );
      b.querySelector(".zs-banner-reload").addEventListener("click", () => location.reload());
      root.appendChild(b);
      bridgeBannerEl = b;
    }

    // Show (on=true) / clear (on=false) the bridge-disconnected red banner.
    function bridgeAlert(on) {
      if (!on) {
        if (bridgeBannerEl) { bridgeBannerEl.remove(); bridgeBannerEl = null; }
        return;
      }
      if (bridgeBannerEl) return; // already shown
      const b = document.createElement("div");
      b.className = "zs-banner limit";
      b.replaceChildren(
        domEl("div", { className: "zs-banner-t", text: "⚠ snapgentV3 disconnected" }),
        domEl("div", { className: "zs-banner-m", text: "Bridge stopped. Run start.bat and keep the selected target app open." }),
        domEl("div", { className: "zs-banner-acts" }, domEl("button", { className: "zs-banner-x", text: "Close" }))
      );
      b.querySelector(".zs-banner-x").addEventListener("click", () => { b.remove(); if (bridgeBannerEl === b) bridgeBannerEl = null; });
      root.appendChild(b);
      bridgeBannerEl = b;
    }

    // Show (v=true) / hide the "■ Stop" button while the agent is busy. The
    // primary action button swaps out for it (handled in renderBar via busy).
    // Forced hidden during bootstrap (A.starting) so the bar stays on "Starting…"
    // (else it flickers Starting → Stop → Starting as generation toggles). The
    // caller decides the rest, including native-stop de-duplication.
    function showStop(v) {
      if (!stopBtn) return;
      // Stay visible while winding down (A.stopping), so the button doesn't blink
      // off when the live generation signal toggles as the loop drains.
      const allow = (v || A.stopping) && !A.starting;
      const was = stopBtn.hidden;
      stopBtn.hidden = !allow;
      // Restore the normal, clickable Stop look whenever we're shown for a fresh
      // active turn (not a stop-in-progress).
      if (allow && !A.stopping && stopBtn.dataset.state === "stopping") {
        stopBtn.disabled = false;
        stopBtn.textContent = "■ Stop";
        delete stopBtn.dataset.state;
      }
      if (was !== stopBtn.hidden) renderBar(); // reflect the action/stop swap
    }

    // Instant feedback the moment the user clicks Stop: lock the button into a
    // disabled "⏳ Stopping…" state so they see it registered, even though the
    // loop takes a beat to actually wind down (finish the in-flight tool/await).
    function markStopping() {
      if (!stopBtn) return;
      stopBtn.hidden = false;
      stopBtn.disabled = true;
      stopBtn.dataset.state = "stopping";
      stopBtn.textContent = "⏳ Stopping…";
      renderBar();
    }

    // A gentle, one-time nudge: the user typed on a fresh chat without starting
    // the agent. We do NOT block the send (plain chat is fine) - we just point at
    // the Start button so they discover how to enable Roblox control.
    let nudged = false;
    function nudgeStart() {
      if (A.started || !P.isFreshChat()) return;
      if (!nudged) {
        nudged = true;
        toast(`Click “▶︎ Start” to begin.`);
      }
      if (!actionBtn) return;
      actionBtn.classList.add("zs-flash");
      setTimeout(() => actionBtn.classList.remove("zs-flash"), 1200);
    }

    // ── Theme auto-detection (light / dark) ─────────────────────────────────
    // The panel and the in-conversation chips are dark-themed by default. On a
    // LIGHT host page the chips' light text on a near-transparent tint becomes
    // invisible, so we detect the page's effective background luminance and add
    // `.zs-light` to <html>; overlay.css then flips to readable light colours.
    // Most chat sites declare their theme EXPLICITLY (a `dark`/`light` class on
    // <html>/<body>, a data-theme attribute, or CSS color-scheme) - far more
    // reliable than luminance, since many (e.g. z.ai) leave <html>/<body> with a
    // transparent background and paint the theme on a deeper container. Returns
    // "light" | "dark" | null (no explicit signal).
    function pageThemeHint() {
      const de = document.documentElement, b = document.body;
      const cls = (de.className + " " + (b ? b.className : "")).toLowerCase();
      const hasDark = /\bdark\b/.test(cls);
      const hasLight = /\blight\b/.test(cls);
      // Tailwind-style theme variants list BOTH words ("scheme-light
      // dark:scheme-dark", measured live on Grok) without meaning dark mode, so
      // a tie falls through to the stronger signals below.
      if (hasDark && !hasLight) return "dark";
      if (hasLight && !hasDark) return "light";
      const attr = (de.getAttribute("data-theme") || de.getAttribute("data-color-mode") ||
                    de.getAttribute("data-color-scheme") || "").toLowerCase();
      if (/dark/.test(attr)) return "dark";
      if (/light/.test(attr)) return "light";
      const cs = (getComputedStyle(de).colorScheme || "").toLowerCase();
      if (/dark/.test(cs) && !/light/.test(cs)) return "dark";
      if (/light/.test(cs) && !/dark/.test(cs)) return "light";
      return null;
    }
    // Fallback only: luminance of the first opaque background up the tree.
    function effectiveBg() {
      let n = document.body;
      while (n && n !== document.documentElement) {
        const c = getComputedStyle(n).backgroundColor;
        if (c && !/(transparent)/.test(c) && !/,\s*0\s*\)$/.test(c)) return c;
        n = n.parentElement;
      }
      return getComputedStyle(document.documentElement).backgroundColor || "rgb(255,255,255)";
    }
    function applyTheme() {
      let light;
      const hint = pageThemeHint();
      if (hint) {
        light = hint === "light";
      } else {
        const m = (effectiveBg().match(/\d+(?:\.\d+)?/g) || []).map(Number);
        if (m.length < 3) return;
        light = 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2] > 140;
      }
      document.documentElement.classList.toggle("zs-light", light);
    }

    // Where the bar lives INSIDE the site's composer. We insert it as a real,
    // in-flow DOM node (between the model tabs and the input on DeepSeek), so it
    // takes the full composer width and never overlaps the site's own controls.
    // The mount point is derived from each provider's composerFrame()+getEditor(),
    // or a provider can override it via barMount(). Returns {parent, before}.
    // The provider decides the exact mount (it knows which element is the input
    // box and where a child reflows cleanly). If a provider doesn't supply one,
    // we fall back to the floating bar rather than risk overlapping its layout.
    function computeBarMount() {
      if (!P.barMount) return null;
      const m = P.barMount();
      return (m && m.parent && m.parent.isConnected) ? m : null;
    }

    // Floating fallback geometry (used only when no inline mount is available).
    const BAR_MAX_W = 560, BAR_GAP = 2; // flush against the composer on every site

    // Anchored mode bookkeeping: the composer element whose top padding we are
    // borrowing to seat the bar (see the anchored branch below). Cleared when we
    // leave anchored mode so the site's composer returns to its normal layout.
    let anchorPadEl = null;
    function clearAnchorPad() {
      if (anchorPadEl) { try { anchorPadEl.style.removeProperty("padding-top"); } catch {} anchorPadEl = null; }
      anchorLockedBh = 0;
    }

    // Position the floating "⚠ unstable" pill just above the bar's RIGHT edge.
    // Right, not left: on GLM the site's own "Choose project" chip sits directly
    // above the composer's left corner and the pill covered it (measured live).
    function placeUnstable() {
      const u = unstableEl;
      if (!u) return;
      if (!bar || bar.style.display === "none") { if (!u.hidden) u.hidden = true; return; }
      const br = bar.getBoundingClientRect();
      if (!br.width) { if (!u.hidden) u.hidden = true; return; }
      if (u.hidden) u.hidden = false;
      const uh = u.offsetHeight || 20;
      const uw = u.offsetWidth || 70;
      u.style.left = Math.round(Math.max(4, br.right - uw)) + "px";
      u.style.top = Math.round(Math.max(4, br.top - uh - 5)) + "px";
    }

    function placeBar() {
      barRaf = requestAnimationFrame(placeBar);
      // Composer halo: a soft ring that follows the site's input box, so the
      // Snapgent band reads as attached to the composer on every provider.
      // Purely decorative and click-through; colour comes from the theme CSS.
      const glow = root && root.querySelector("#zs-composer-glow");
      if (glow) {
        const gf = P.composerFrame && P.composerFrame();
        // Always ring the visible composer card, including the site's own
        // controls (DeepThink, Search). Those belong to the same input unit;
        // cutting them off made the band look incomplete.
        const gr = gf && gf.isConnected ? gf.getBoundingClientRect() : null;
        // Size the in-flow bar FIRST, then measure it. Otherwise a full-column
        // bar can fail the adjacency test and never be aligned to the composer.
        if (gr && bar.classList.contains("zs-bar-inline") && !bar.classList.contains("zs-bar-inside")) {
          const pr = bar.parentElement && bar.parentElement.getBoundingClientRect();
          bar.style.width = Math.round(gr.width) + "px";
          if (pr) bar.style.marginLeft = Math.round(gr.left - pr.left) + "px";
        }
        const br2 = bar.getBoundingClientRect();
        const isInside = bar.classList.contains("zs-bar-inside") && br2.width > 40 && br2.height > 8;
        const adjacent = gr && br2.width > 40 && br2.height > 8 &&
          Math.abs(br2.bottom - gr.top) < 32 &&
          br2.left < gr.right && br2.right > gr.left;
        if (gr && gr.width > 40 && gr.height > 8 && gr.height < 420) {
          // One unit: ring the UNION of the control bar and the composer, not
          // the input alone. The bar borrows the composer's own surface and
          // drops its bottom corners so the two read as one connected band.
          const left = adjacent ? Math.min(gr.left, br2.left) : gr.left;
          const right = adjacent ? Math.max(gr.right, br2.right) : gr.right;
          const top = adjacent
            ? Math.min(gr.top, br2.top)
            : (isInside ? Math.min(gr.top, br2.top) - 4 : gr.top);
          const bottom = adjacent ? Math.max(gr.bottom, br2.bottom) : gr.bottom;
          glow.style.display = "block";
          glow.style.left = Math.round(left) + "px";
          glow.style.top = Math.round(top) + "px";
          glow.style.width = Math.round(right - left) + "px";
          glow.style.height = Math.round(bottom - top) + "px";
          // Some composers report 0px (square inner node) even when the visible
          // card is rounded. Keep a soft minimum so the ring hugs the unit.
          const now = performance.now();
          if (gf !== glowNode || now - glowAt > 500) {
            const rawRadius = parseInt(getComputedStyle(gf).borderRadius, 10);
            glowRadius = (rawRadius > 0 ? Math.min(rawRadius, 24) : 18) + "px";
            glowBg = opaqueBg(gf);
            glowNode = gf;
            glowAt = now;
          }
          glow.style.borderRadius = glowRadius;
          if (adjacent) {
            bar.classList.add("zs-bar-unified");
            bar.style.background = glowBg;
          } else {
            bar.classList.remove("zs-bar-unified");
            bar.style.background = "";
            bar.style.width = "";
            bar.style.marginLeft = "";
          }
        } else {
          glow.style.display = "none";
          bar.classList.remove("zs-bar-unified");
          bar.style.background = "";
          bar.style.width = "";
          bar.style.marginLeft = "";
        }
      }
      if (!bar) return;

      // Self-heal: a SPA navigation or a full re-render on the host (seen on Arena
      // when the message frame jumps/teleports to the bottom) can detach our whole
      // #zs-root from <html>, taking the bar with it - and nothing re-adds it, so
      // the panel just vanishes. Re-append it whenever it's been detached; this
      // rAF loop is resilient (its next frame is scheduled before any body code),
      // so the panel reappears on the very next frame.
      if (root && !root.isConnected) {
        try { document.documentElement.appendChild(root); } catch {}
      }

      // The instability warning floats just ABOVE the bar (not inside it), so it
      // never crowds the row on narrow composers like Gemini. Positioned from the
      // bar's current rect every frame - works in all bar modes since it only
      // reads where the bar ended up. One frame of lag is imperceptible.
      placeUnstable();

      // While a bot-check challenge OR a blocking modal (login / consent) is on
      // screen, get fully out of the way: the (often transparent) anchored bar is
      // a real full-width element over the composer's top edge and would silently
      // intercept clicks on the challenge's / modal's buttons (e.g. "Continue with
      // Google" at sign-in). Hide the bar and drop the reserved padding strip; it
      // reappears on the next frame once the overlay clears.
      if (
        (P.captchaPresent && P.captchaPresent()) ||
        (P.overlayBlocking && P.overlayBlocking())
      ) {
        bar.style.display = "none";
        clearAnchorPad();
        if (menuEl) menuEl.hidden = true;
        return;
      }

      // Preferred: in-flow mount inside the composer (no overlap, full width).
      const mount = computeBarMount();
      if (mount) {
        clearAnchorPad();
        if (bar.parentElement !== mount.parent || bar.nextElementSibling !== mount.before) {
          try { mount.parent.insertBefore(bar, mount.before || null); } catch {}
        }
        if (!bar.classList.contains("zs-bar-inline")) {
          bar.classList.add("zs-bar-inline");
          bar.style.cssText = ""; // drop any leftover float positioning
        }
        // Transparent (blends in) when mounted INSIDE the input box; surface card
        // when mounted ABOVE it. The provider's barMount() signals which via .inside.
        bar.classList.toggle("zs-bar-inside", !!mount.inside);
        bar.style.display = "flex";
        if (menuEl && !menuEl.hidden) {
          const br = bar.getBoundingClientRect();
          positionMenu(br);
        }
        return;
      }

      // Anchored mode: the provider wants the integrated, in-composer LOOK but
      // its composer is a framework-reconciled subtree we must NOT insert our
      // node into (e.g. Kimi's Vue tree - inserting #zs-bar there makes Vue's
      // next diff reuse the bar node as a host and nest the editor inside it).
      // So we keep the bar in our own #zs-root, position it (position:fixed) to
      // hug the composer's top edge at full width, and RESERVE that strip with
      // padding-top on the composer so it reads as in-flow without ever becoming
      // a child of the framework's DOM. barAnchor() returns the element to hug.
      const anchorEl = (P.barAnchor && P.barAnchor()) || null;
      if (anchorEl && anchorEl.isConnected) {
        bar.classList.remove("zs-bar-inline", "zs-bar-inside");
        bar.classList.add("zs-bar-anchored");
        if (root && bar.parentElement !== root) root.appendChild(bar);
        const r = anchorEl.getBoundingClientRect();
        if (!r.width) { bar.style.display = "none"; clearAnchorPad(); if (menuEl) menuEl.hidden = true; return; }
        bar.style.display = "flex";
        const coverActive = !!(cover && cover.dataset.on === "1");
        const rawBh = bar.offsetHeight || 34;
        if (coverActive) {
          if (!anchorLockedBh) anchorLockedBh = rawBh;
        } else {
          anchorLockedBh = 0;
        }
        const bh = coverActive ? anchorLockedBh : rawBh;
        if (anchorPadEl && anchorPadEl !== anchorEl) clearAnchorPad();
        anchorPadEl = anchorEl;
        anchorEl.style.setProperty("padding-top", (bh + 2) + "px", "important"); // reserve the strip the bar sits in (+gap)
        bar.style.left = Math.round(r.left) + "px";
        bar.style.top = Math.round(r.top) + "px";
        bar.style.width = Math.round(r.width) + "px";
        if (menuEl && !menuEl.hidden) {
          bar.classList.remove("zs-bar-inline"); // ensure fixed geometry for menu math
          positionMenu({ left: r.left, right: r.left + r.width, top: r.top, bottom: r.top + (bar.offsetHeight || 34) });
        }
        return;
      }
      bar.classList.remove("zs-bar-anchored");
      clearAnchorPad();

      // Fallback: float just above the editor (fixed positioning), for sites
      // where no clean inline mount could be resolved.
      if (bar.classList.contains("zs-bar-inline")) {
        bar.classList.remove("zs-bar-inline");
        if (root && bar.parentElement !== root) root.appendChild(bar);
      }
      // Measure the composer CARD when the provider exposes one (Grok's rounded
      // pill, …): the bar then matches the input's width and edges instead of the
      // bare text line inside it.
      const f = (P.composerFrame && P.composerFrame()) || (P.getEditor && P.getEditor());
      if (!f) { bar.style.display = "none"; if (menuEl) menuEl.hidden = true; return; }
      bar.style.display = "flex";
      const r = f.getBoundingClientRect();
      if (!r.width) { bar.style.display = "none"; return; }
      const w = Math.min(r.width, BAR_MAX_W);
      const left = Math.round(r.left + (r.width - w) / 2);
      const bh = bar.offsetHeight || 40;
      // Side matters on a CENTERED composer (an empty landing page): the space
      // right above it is the site's own headline, and a floating panel there
      // covers it (measured live on Grok: the bar sat on "What's on the agenda
      // today?"). Bottom-docked composers have a conversation above and empty
      // space below, centered ones the reverse - so flip below in that case.
      const centered = r.bottom < window.innerHeight * 0.72;
      const top = centered
        ? Math.min(window.innerHeight - bh - 4, Math.round(r.bottom + BAR_GAP))
        : Math.max(4, Math.round(r.top - bh - BAR_GAP));
      bar.style.width = w + "px";
      bar.style.left = left + "px";
      bar.style.top = top + "px";
      // Keep the open "more" menu anchored to the bar, opening upward.
      if (menuEl && !menuEl.hidden) {
        const br = bar.getBoundingClientRect();
        positionMenu(br);
      }
    }

    // Called by the core's sweep + after state changes: refresh the bar content.
    // (Positioning runs continuously in placeBar; this only updates what's shown.)
    function updateStartGate() { renderBar(); }

    // Masks the input box while the extension types/sends, so the copied text
    // and the submit aren't visible to the user.
    // Returns a FULLY OPAQUE colour that matches what is VISUALLY behind the cover.
    // The cover must hide the typed text, so it can't be translucent - but simply
    // returning the first solid ancestor is wrong when the composer surface itself
    // is translucent: Meta's card is rgba(56,56,56,0.8) over a dark page, so its
    // real on-screen colour is a BLEND (~rgb(50,50,50)), lighter than the bare page
    // (rgb(24,24,25)). Filling the cover with the page colour made it visibly
    // darker than the composer. So collect the background layers from `el` up to
    // the first opaque ancestor and FLATTEN them (alpha compositing) into one solid
    // colour that reproduces the composer's actual appearance.
    function opaqueBg(el) {
      const layers = [];
      let n = el;
      while (n && n !== document.documentElement) {
        const c = parseColor(getComputedStyle(n).backgroundColor);
        if (c && c.a > 0) {
          layers.push(c);
          if (c.a >= 0.999) break; // opaque base reached - nothing behind matters
        }
        n = n.parentElement;
      }
      // Guarantee an opaque base at the bottom of the stack.
      if (!layers.length || layers[layers.length - 1].a < 0.999) {
        const base = parseColor(getComputedStyle(document.body).backgroundColor) ||
                     { r: 255, g: 255, b: 255, a: 1 };
        layers.push({ r: base.r, g: base.g, b: base.b, a: 1 });
      }
      // We collected top-most (el) first, so composite from the opaque base (last)
      // upward toward el (first).
      let out = layers[layers.length - 1];
      for (let i = layers.length - 2; i >= 0; i--) out = blendOver(layers[i], out);
      return `rgb(${Math.round(out.r)}, ${Math.round(out.g)}, ${Math.round(out.b)})`;
    }
    // Parse an rgb()/rgba() computed colour into {r,g,b,a}. Returns null for
    // "transparent"/unparseable. getComputedStyle always yields rgb/rgba form.
    function parseColor(c) {
      if (!c || c === "transparent") return null;
      const m = c.match(/rgba?\(([^)]+)\)/i);
      if (!m) return null;
      const p = m[1].split(",").map((x) => parseFloat(x));
      return { r: p[0], g: p[1], b: p[2], a: p.length >= 4 ? p[3] : 1 };
    }
    // Source-over compositing of a (possibly translucent) fg onto an opaque bg.
    function blendOver(fg, bg) {
      const a = fg.a;
      return {
        r: fg.r * a + bg.r * (1 - a),
        g: fg.g * a + bg.g * (1 - a),
        b: fg.b * a + bg.b * (1 - a),
        a: 1,
      };
    }

    function lockEditorHeight(el) {
      if (!el) return;
      if (coverLockedEl && coverLockedEl !== el) {
        try {
          coverLockedEl.classList.remove("zs-height-locked");
          coverLockedEl.style.removeProperty("--zs-lock-h");
        } catch {}
      }
      if (!coverLockedH) {
        const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
        const rawH = Math.round((rect && rect.height) || el.offsetHeight || 0);
        if (rawH >= 16) coverLockedH = Math.min(Math.max(rawH, 24), 140);
      }
      if (coverLockedH > 0) {
        if (!el.classList.contains("zs-height-locked")) el.classList.add("zs-height-locked");
        if (el.style) el.style.setProperty("--zs-lock-h", coverLockedH + "px");
        coverLockedEl = el;
      }
    }
    function unlockEditorHeight(el) {
      const targets = [el, coverLockedEl].filter(Boolean);
      for (const node of targets) {
        try {
          node.classList.remove("zs-height-locked");
          if (node.style) node.style.removeProperty("--zs-lock-h");
        } catch {}
      }
      coverLockedEl = null;
    }

    function inputCover(on) {
      const ed = P.getEditor();
      // Scrolling up through history hides the busy cover as well: the user is
      // browsing, not watching the agent. The INTENT flag stays untouched, so
      // the cover returns by itself once the scroll window expires and the loop
      // is still genuinely running.
      if (on && scrollSuppressed()) {
        if (cover) cover.style.display = "none";
        if (ed) ed.classList.remove("zs-typing");
        unlockEditorHeight(ed);
        cancelAnimationFrame(coverRaf);
        return;
      }
      if (!on) {
        if (cover) { cover.style.display = "none"; cover.dataset.on = ""; }
        if (ed) ed.classList.remove("zs-typing");
        unlockEditorHeight(ed);
        coverLockedH = 0;
        anchorLockedBh = 0;
        cancelAnimationFrame(coverRaf);
        return;
      }
      if (!ed) return;
      lockEditorHeight(ed);
      ed.classList.add("zs-typing"); // make the typed text itself invisible
      if (!cover) {
        cover = document.createElement("div");
        cover.id = "zs-input-cover";
        cover.appendChild(domEl("span", { text: "Agent is working…" }));
        document.documentElement.appendChild(cover);
      }
      cover.dataset.on = "1"; // intent flag: keep the place() loop alive while set
      cover.style.display = "flex";
      const place = () => {
        // Loop runs while the cover is INTENDED on (dataset.on), not while it's
        // visible - so we can hide it for an overlay and still restore it after.
        if (!cover || cover.dataset.on !== "1") return;
        const e = P.getEditor();
        if (!e) { coverRaf = requestAnimationFrame(place); return; }
        // Re-assert the typing mask on the CURRENT editor node: sites that
        // recreate the editor on each inject/clear (Kimi's Vue) drop the class,
        // which would un-hide the raw text and un-cap its height. Cheap idempotent
        // add every frame keeps the mask + height cap glued to the live node.
        if (!e.classList.contains("zs-typing")) e.classList.add("zs-typing");
        lockEditorHeight(e);
        // The cover is SIZED to coverTarget() when a provider supplies one, else
        // to the editor node itself. Some composers (Meta AI) make the editable a
        // tiny line inside a much larger rounded card - covering only the editor
        // left the rest of the card exposed and CLICKABLE (a careful click focused
        // the editor and let the user type behind the cover). Meta returns its
        // whole composer card so the cover blankets the entire input band and its
        // pointer-events:auto blocks every click. The typing mask above still lives
        // on the real editor node `e`.
        const covNode = (P.coverTarget && P.coverTarget()) || e;
        // While a blocking modal (login / consent) or bot-check is up, hide the
        // cover so it doesn't sit on top of the modal; it reappears once the
        // overlay clears (the loop keeps running).
        if (
          (P.overlayBlocking && P.overlayBlocking()) ||
          (P.captchaPresent && P.captchaPresent())
        ) {
          cover.style.display = "none";
          coverRaf = requestAnimationFrame(place);
          return;
        }
        cover.style.display = "flex";
        let r = covNode.getBoundingClientRect();
        // Clip the cover to the composer's VISIBLE band. Some composers grow the
        // inner editor node past a scrolling ancestor that clips it (Kimi's Vue
        // RECREATES .chat-input-editor on every inject/clear, dropping the
        // .zs-typing height cap, so the editor balloons to ~1500px while its
        // .chat-input-editor-container caps the visible box via overflow:auto).
        // Measuring the raw editor then centres the cover on the giant editor's
        // midpoint - far below the visible input - so it "vanishes" off the box.
        // Intersect with the nearest clipping ancestor to track what's on screen.
        // The SAME clipping applies horizontally, and for the same reason: a
        // composer whose editor is a flex item grows to its content width when a
        // long unbroken line is injected, while an ancestor with overflow-x:hidden
        // keeps the PAGE looking right. Seen on ChatGPT at Start, where the editor
        // is filled with the (large) system prompt: the inner
        // .prosemirror-parent widened past its `-my-2.5 flex overflow-x-hidden`
        // wrapper, so the cover - position:fixed and sized to the raw rect - stuck
        // out to the RIGHT of the composer card. Clip on each axis independently:
        // the ancestor that clips X is not always the one that clips Y.
        let clipY = false, clipX = false;
        for (let a = covNode.parentElement, i = 0; a && a !== document.body && i < 8 && !(clipX && clipY); a = a.parentElement, i++) {
          const st = getComputedStyle(a);
          const clips = (v) => v === "auto" || v === "scroll" || v === "hidden";
          const ar = a.getBoundingClientRect();
          if (!clipY && clips(st.overflowY)) {
            clipY = true;
            const top = Math.max(r.top, ar.top);
            const bottom = Math.min(r.bottom, ar.bottom);
            if (bottom > top) r = new DOMRect(r.left, top, r.width, bottom - top);
          }
          if (!clipX && clips(st.overflowX)) {
            clipX = true;
            const left = Math.max(r.left, ar.left);
            const right = Math.min(r.right, ar.right);
            if (right > left) r = new DOMRect(left, r.top, right - left, r.height);
          }
        }
        // Never paint outside the composer card. The cover is position:fixed and
        // re-placed every rAF from a freshly measured rect, which is correct while
        // the page is still - but a site that ANIMATES its composer updates layout
        // AFTER our callback, so for the whole animation the cover trails one frame
        // behind. Seen on ChatGPT at Start: injecting the system prompt grows the
        // composer 58px -> 156px, the page gains a scrollbar, the content column
        // narrows and the composer slides 29px left - while the cover kept the
        // previous coordinates and hung 28px past the card's right edge. It only
        // showed on the FIRST send, because afterwards the composer is already
        // docked at the bottom and stops moving. Clamping to the composer frame
        // makes a stale rect impossible to see: worst case the cover is briefly a
        // few px small, which reads as nothing.
        const frame = P.composerFrame && P.composerFrame();
        if (frame) {
          const fr = frame.getBoundingClientRect();
          // Only clamp to a frame that really wraps the cover target, so a provider
          // whose frame is narrower than its editor can never shrink the cover.
          const cx = r.left + r.width / 2;
          if (fr.width > 0 && fr.left <= cx && fr.right >= cx) {
            const left = Math.max(r.left, fr.left);
            const right = Math.min(r.right, fr.right);
            if (right - left > 40) r = new DOMRect(left, r.top, right - left, r.height);
          }
        }
        // Optionally overshoot the editor box by PAD px on every side. Some
        // composers (Gemini's Quill) keep typed text near rounded corners, so a
        // cover sized EXACTLY to the editor leaves slivers of text peeking; those
        // providers set coverPad to bleed past the edges. A native <textarea>
        // (DeepSeek) needs none - overshooting there just makes the cover overflow
        // the composer, so it defaults to 0.
        const PAD = P.coverPad || 0;
        // Optional vertical nudge: some composers (Gemini's Quill) report an
        // editor rect that sits a few px below the visual input box centre, so
        // the centred "Agent is working…" text looks low. A provider can shift it.
        const OFFY = P.coverOffsetY || 0;
        // Height is at least MIN_H so the label is readable even over a
        // single-line composer. CENTER the cover on the editor's vertical middle
        // rather than anchoring its TOP to the editor top: a short (e.g. 20px)
        // textarea bumped to 36px would otherwise grow only DOWNWARD, leaving the
        // "Agent is working…" label sitting high in the composer's input band
        // (seen on Cloudflare's 1-line textarea). For a composer already taller
        // than MIN_H the maths reduces to the old `r.top - PAD`, so DeepSeek/Gemini
        // are unchanged.
        // Hard ceiling: even though .zs-typing caps the editor's visual height
        // (see overlay.css), belt-and-suspenders clamp the cover so a composer
        // whose growing element escapes that CSS cap on some provider can never
        // turn the "Agent is working…" cover into a full-page white slab.
        const MAXH = P.coverMaxH || 200;
        const h = Math.min(Math.max(r.height + PAD * 2, 36), MAXH);
        const centerY = r.top + r.height / 2 + OFFY;
        cover.style.left = (r.left - PAD) + "px";
        cover.style.top = (centerY - h / 2) + "px";
        cover.style.width = (r.width + PAD * 2) + "px";
        cover.style.height = h + "px";
        // Composite the surface BEHIND the cover target so the fill matches what
        // the user sees (a translucent composer card blends over the page).
        cover.style.background = opaqueBg(covNode);
        // When the cover blankets a whole composer card (coverTarget), match its
        // corner radius so the cover's square corners don't poke past the card's
        // rounded ones. Editor-sized covers keep the CSS default.
        if (P.coverTarget) cover.style.borderRadius = getComputedStyle(covNode).borderRadius;
        coverRaf = requestAnimationFrame(place);
      };
      place();
    }

    function toast(msg) {
      const t = document.createElement("div");
      t.className = "zs-toast";
      t.textContent = msg;
      root.appendChild(t);
      setTimeout(() => t.classList.add("show"), 10);
      setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 300); }, 3500);
    }

    function banner(kind, title, msg) {
      const b = document.createElement("div");
      b.className = `zs-banner ${kind}`;
      b.replaceChildren(
        domEl("div", { className: "zs-banner-t", text: title }),
        domEl("div", { className: "zs-banner-m", text: msg }),
        domEl("div", { className: "zs-banner-acts" }, domEl("button", { className: "zs-banner-x", text: "Close" }))
      );
      b.querySelector(".zs-banner-x").addEventListener("click", () => b.remove());
      root.appendChild(b);
    }

    // Left-hand snapgentV3 popup showing the latest screen_capture. Fed from the
    // in-memory base64 (a data: URL always renders), so it works identically on
    // every provider and never touches the site's DOM. Only the most recent
    // capture is kept - a new one replaces the old.
    function showImages(images, toolName) {
      root.querySelectorAll(".zs-shot").forEach((e) => e.remove());
      const wrap = document.createElement("div");
      wrap.className = "zs-shot";
      const hdr = document.createElement("div");
      hdr.className = "zs-shot-hdr";
      const ttl = document.createElement("span");
      ttl.className = "zs-shot-ttl";
      ttl.textContent = `${toolName} · ${images.length} image${images.length > 1 ? "s" : ""}`;
      const close = document.createElement("button");
      close.className = "zs-shot-x";
      close.textContent = "✕";
      close.addEventListener("click", () => wrap.remove());
      hdr.appendChild(ttl);
      hdr.appendChild(close);
      wrap.appendChild(hdr);
      const body = document.createElement("div");
      body.className = "zs-shot-body";
      for (const img of images) {
        const el = document.createElement("img");
        el.className = "zs-shot-img";
        el.src = `data:${img.mimeType || "image/jpeg"};base64,${img.data}`;
        body.appendChild(el);
      }
      wrap.appendChild(body);
      root.appendChild(wrap);
      placeShot(wrap);
    }

    // Anchor the preview to the composer instead of the page corner: bottom-right
    // of the input bar when there is room above it, otherwise top-right. Width
    // and body height follow the composer/viewport, so the card stays compact on
    // a wide screen and never covers the input it belongs to.
    let shotNode = null;
    function placeShot(wrap) {
      shotNode = wrap;
      const bar = document.getElementById("zs-bar");
      const rect = bar && bar.getClientRects().length ? bar.getBoundingClientRect() : null;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const width = Math.round(Math.min(300, Math.max(200, (rect ? rect.width : vw) * 0.34)));
      wrap.style.width = `${width}px`;
      const above = rect && rect.top > 240;
      if (above) {
        wrap.style.right = `${Math.max(12, Math.round(vw - rect.right))}px`;
        wrap.style.left = "auto";
        wrap.style.bottom = `${Math.max(12, Math.round(vh - rect.top + 10))}px`;
        wrap.style.top = "auto";
      } else {
        wrap.style.right = "18px";
        wrap.style.left = "auto";
        wrap.style.top = "72px";
        wrap.style.bottom = "auto";
      }
      const room = above ? Math.round(rect.top - 80) : Math.round(vh * 0.5);
      const body = wrap.querySelector(".zs-shot-body");
      if (body) body.style.maxHeight = `${Math.max(120, Math.min(Math.round(vh * 0.42), room))}px`;
    }
    window.addEventListener("resize", () => { if (shotNode && shotNode.isConnected) placeShot(shotNode); });

    build();
    return { setStatus, setTarget, getTargetName, staleExtensionAlert, setStarted, setStarting, showStop, markStopping, inputCover, toast, banner, showImages, nudgeStart, updateStartGate, refreshSetup, getCustomPrompt, openMenu: (toSupport) => openMenuFn && openMenuFn(toSupport) };
  }

  return { createUiController };
})();
