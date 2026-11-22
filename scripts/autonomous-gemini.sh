#!/usr/bin/env bash
# Autonomous verified task loop against the Gemini web chat via A2A.
# Self-heal: bridge service + extension reload, then retry with acceptance checks.
set -euo pipefail
cd -- "$(dirname "$0")/.."

if ! systemctl --user is-active --quiet snapgent-bridge.service; then
    echo "bridge inactive; restarting" >&2
    systemctl --user restart snapgent-bridge.service
    sleep 4
fi

# Reload the unpacked extension so its content scripts pick up latest CSS/JS.
python3 - <<'PY' >/dev/null 2>&1 || true
import asyncio, json, urllib.request, websockets
ver = json.load(urllib.request.urlopen("http://127.0.0.1:9222/json/version", timeout=3))
async def main():
    async with websockets.connect(ver["webSocketDebuggerUrl"], max_size=None) as ws:
        await ws.send(json.dumps({"id": 1, "method": "Extensions.loadUnpacked",
            "params": {"path": "/media/abelion/Isaf/ican/project/webmcp/snapgent-extension"}}))
        while True:
            m = json.loads(await ws.recv())
            if m.get("id") == 1:
                break
    # Reload the provider tab too: a reloaded extension alone leaves the old
    # content-script channel stale and prompts fail with "No Snapgent content script".
    pages = json.load(urllib.request.urlopen("http://127.0.0.1:9222/json/list", timeout=3))
    tab = next((p for p in pages if p.get("type") == "page"
                and "gemini.google.com" in p.get("url", "")), None)
    if tab:
        async with websockets.connect(tab["webSocketDebuggerUrl"], max_size=None) as ws:
            await ws.send(json.dumps({"id": 2, "method": "Page.reload", "params": {}}))
            await ws.recv()
asyncio.run(main())
PY

GOAL='Create scripts/e2e-resilient.py: a self-healing verified e2e runner for webmcp. Requirements: (1) ensure bridge via systemctl --user is-active/restart, but DO NOT execute systemctl from MCP tools - only write code that calls it; (2) reload the unpacked extension over CDP before a run; (3) send one heavy task over A2A with provider pinned to deepseek or gemini and a real MCP tool step, never a one-word PONG; (4) accept a shell check command and retry with the previous failure appended, max 3 attempts; (5) write a JSON ledger under .snapgent/loops/; (6) no commit/push/PR. Do not touch ~/.hermes. Write only scripts/e2e-resilient.py.'

CHECK="sh -c 'python3 -m py_compile scripts/e2e-resilient.py && grep -q retry scripts/e2e-resilient.py && grep -q systemctl scripts/e2e-resilient.py'"

exec python3 harness_loop.py \
  --goal "$GOAL" \
  --file docs/audit-followup-2026-11-22.md \
  --file docs/model-catalog.md \
  --file docs/ui-overlay.md \
  --check "$CHECK" \
  --provider gemini \
  --category code-edit \
  --tier balanced \
  --iterations 2 \
  --timeout 1800
