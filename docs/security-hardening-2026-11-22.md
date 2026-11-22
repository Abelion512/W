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
