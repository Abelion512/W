# Security hardening — 2026-11-22

Audit source: read-only review of `bridge.py`, `a2a_server.py`, `bridge_auth.py`,
`context_sandbox.py`, `workspace_mcp.py`, `snapgent-extension/background.js`.

## Fixed

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | Critical | Forged `chrome-extension://` Origin bypassed token check and could call `add_server` (arbitrary command). | `PRIVILEGED_REQUESTS` in `bridge.py` now requires a verified token for `add_server`, `remove_server`, `rotate_token`, `restart_mcp`, regardless of Origin. |
| 2 | High | PII guard only triggered on `webSearch` / narrow intent, so `needsWeb` tasks leaked emails. | `web_search_pii_violations()` honours `needsWeb`/`needs_web` and broader search intents. |
| 3 | Medium | `contextFiles` content appended after the PII check. | Guard re-runs on the final rendered prompt. |
| 4 | Medium | Task store grew without bound when all tasks stayed live. | `TaskStore.add()` evicts the oldest task when the cap is hit. |
| 5 | Medium | `_cancel_events` entries were never removed. | `_forget_cancel()` on terminal states and on late-reply cancellation paths. |
| 6 | Medium | Unbounded concurrent A2A submits / orchestration threads. | `MAX_CONCURRENT_SUBMITS = 8` semaphore in `_call_submit()`; fast failure when full. |
| 7 | Medium | WebSocket frame flood created unlimited tasks before the semaphore. | `MAX_PENDING_FRAMES = 128`; extra frames get an error instead of a task. |
| 8 | Medium | Arbitrary `metadata.provider` created a permanent lock per string. | Lock map keyed by an allowlist; unknown providers use the shared `default` lock. |

No path-containment or shell-injection bug was found: symlink-resolving path
checks and `shell=False` subprocess calls are intact.

## Trade-off

Privileged RPCs now need the bridge token. An extension that has never paired
can still run prompts and tools, but cannot add/remove MCP servers, rotate the
token, or restart MCP until a token is saved in the popup. This is deliberate:
those operations change bridge state and are not part of normal chat use.

## Verification

```
python3 -m pytest -q          # 180 passed
python3 -m pyflakes bridge.py a2a_server.py   # clean
```

Residual: HTTP thread creation on `SendMessage` is still one thread per
request; the semaphore bounds actual submit work, not the short-lived thread
objects. Add a request-rate limiter if a hostile local client is in scope.

## Phase 1 Follow-up — Security Audit & Scope Hardening

Active surfaces audited: `bridge.py`, `bridge_auth.py`, `workspace_mcp.py`,
`a2a_server.py`, `context_sandbox.py`, and `snapgent-extension/`.

| # | Severity | Surface | Finding | Fix |
|---|---|---|---|---|
| 9 | High | `snapgent-extension/core/main.js`, `snapgent-extension/core/ui-controller.js` | Raw `innerHTML` sinks across chip rendering, overlay bar, menus, settings popups, setup card, and banners. | Replaced all active `innerHTML` assignments with DOM API helpers (`createElement`/`createElementNS`/`textContent`/`replaceChildren`); zero active `innerHTML` remains (Trusted Types safe). |
| 10 | Medium | `a2a_server.py` | HTTP/SSE request-rate limiter needed burst regression coverage proving 429 blocks task/thread creation. | Verified `_guard_http()` + `allow_request()` sliding-window limiter (`MAX_REQUESTS_PER_MINUTE = 120`, `429` + `Retry-After`) runs before auth/dispatch/SSE; added burst tests for `SendMessage`, `SendStreamingMessage`, no new task/worker thread on 429, and window recovery in `tests/test_a2a_server.py`. |
| 11 | Low | `snapgent-extension/manifest.json` | Unused host permission `https://deepseek.com/*` (no content script or background match). | Removed unused `https://deepseek.com/*` so every HTTPS `host_permissions` entry maps 1:1 to `content_scripts`; validated MV3, minimal permissions (`storage`, `alarms`), and absence of wildcard hosts. |
| 12 | Info | `workspace_mcp.py`, `context_sandbox.py` | Verified `bwrap` namespace/capability/tmpfs isolation, fail-closed policy, and context sandbox `0700`/`0600` + NUL/TTL guards. | Added automated tests in `tests/test_manifest_and_sandbox.py` covering `manifest.json`, zero active `innerHTML`, `bwrap` argv flags/fail-closed behavior, and `context_sandbox` permissions/NUL/TTL. |

### Phase 1 Verification

- `grep -n innerHTML snapgent-extension/core/main.js snapgent-extension/core/ui-controller.js` -> comments only (0 active sinks).
- `node --check` on all extension JS + `node snapgent-extension/test-*.js` -> all 12 suites PASS.
- `python3 -m unittest -v tests/test_a2a_server.py tests/test_manifest_and_sandbox.py tests/test_context_sandbox.py` -> 44/44 OK.
- `python3 -m py_compile *.py tests/*.py e2e/*.py scripts/*.py` -> OK.
- `python3 scripts/version-sync.py --check` -> OK (`3.10.0`).
- Note: `pytest` and `pyflakes` are not available inside the `bwrap`-sandboxed `/usr/bin/python3` environment (user site-packages under `/home` are masked by `bwrap`). Run `python3 -m pytest -q` and `python3 -m pyflakes *.py tests/*.py e2e/*.py scripts/*.py` directly on the host to confirm host-level totals.
