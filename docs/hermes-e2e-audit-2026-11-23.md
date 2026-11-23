# Hermes ↔ webmcp A2A live E2E audit — 2026-11-23

- **Target:** `http://127.0.0.1:17614/` (`bridge.py`, pid 909724, snapgent bridge v3.10.0)
- **Hermes session:** `local-029282bb473cc87a94d0049b4f1d41142c24ca436130bc3f54c1e55790a5a3bb`
- **Session URL:** `https://hermes.abelion.my.id/#/local-029282bb473cc87a94d0049b4f1d41142c24ca436130bc3f54c1e55790a5a3bb` (read from the live Hermes tab via CDP `/json/list`; equals the supplied fallback)
- **Auth:** bearer token read from `~/.snapgent/a2a_token` in memory only. Scanned `logs/activity_audit.jsonl`, `logs/bridge_debug.log` and all captured artifacts afterwards: **0 occurrences** of the A2A or bridge token values. **TERVERIFIKASI**
- **Evidence labels:** `TERVERIFIKASI` (command output / HTTP status / live DOM), `PERKIRAAN` (inference), `GAGAL` (could not obtain).

---

## 1. Test results

| Test | Channel | Provider | Final status | Latency | task_id | context_id | Reply |
|---|---|---|---|---|---|---|---|
| **A** (attempt 1) | Python `urllib.request` POST `SendMessage` | `gemini` | Client `TimeoutError`; server task `TASK_STATE_FAILED` | client **420.106 s**; server **945.738 s** | `task-2a653778aa364450ad5af2e48fcc95b8` | `ctx-a7abe22cc720422594d66741178f0ab0` | 0 chars; error `The task was cancelled: the caller stopped waiting.` |
| **A** (attempt 2, tight budget) | same | `gemini` | Client `TimeoutError`; server `TASK_STATE_FAILED` | client **560.110 s**; server **946.139 s** | `task-0d03a3d0373447788745b2e1e735affe` | `ctx-ae3843e512f8416a91456d0fd588665c` | 0 chars; same error |
| **B** (attempt 1) | same | `deepseek` | HTTP **200**, `TASK_STATE_FAILED` | **344.558 s** | `task-f019a744959649088f4682df8146ba7d` | `ctx-3f8075d4ce3c461cb3f8e64d2e1c3e47` | 105 chars = error text, no artifact |
| **B** (attempt 2, tight budget) | same | `deepseek` | HTTP **200**, `TASK_STATE_FAILED` | **384.762 s** | `task-35e65233fbac45ac80c8e419fb5fd794` | `ctx-c352c87a174d40fdbe69a5b9a8181145` | 105 chars = error text, no artifact |
| **C** | native Hermes `a2a_call(agent="webmcp")` | `default` → routed `gemini` (`route_tier: auto`) | Tool timed out after **420 s**; server `TASK_STATE_FAILED` | tool **420 s**; server **926.220 s** | `task-1c0ef038b81e4f34b8c38d6078e8f947` | `ctx-e818055c82c44e3d986d1ef62bcd0ab7` (requested `ctx-6ea48723ac384343` was ignored) | 51 chars = error text |

Notes:

- For failed tasks the “reply” is the failure string copied into `status.message`, not a model answer; `artifacts` is empty. **TERVERIFIKASI**
- No test produced a successful model answer. **TERVERIFIKASI**
- Test A attempt 1 did complete **one** MCP round-trip: `bridge.tool_call tool_name=list_dir ok=true` at **+106.0 s**. Attempt 2 logged no tool call. **TERVERIFIKASI**
- Test C logged one `list_dir` tool call at **+806.0 s** (09:36:02 → 09:49:28), i.e. a single Gemini tool round-trip took ~13.4 min. **TERVERIFIKASI**
- Every Gemini task ended at ~926–946 s with `The task was cancelled: the caller stopped waiting.` **TERVERIFIKASI**

---

## 2. Log inspection

### 2.1 `logs/activity_audit.jsonl` (249 lines at audit time)

Direct `urllib` calls (Tests A/B) are logged **accurately and completely**: `task_id`, `context_id`, `prompt_id`, `provider_requested`, `lock_key`, `harness=hermes`, `agent_id=hermes-webapp`, `session_id`, `session_url`, `rpc_id`, `user_agent`, `client_ip`, `tab_id`, `tab_url`, `route_tier`, `duration_ms`. **TERVERIFIKASI**

Verbatim (Test A attempt 1 routing):

```
{"ts":"2026-11-23T08:53:42.437461+00:00","event":"bridge.prompt_routed",...,"prompt_id":"pcf367827b46f42298a55b4895c70305b","provider_requested":"gemini","lock_key":"gemini",...,"provider":"gemini","tab_id":1094811528,"tab_url":"https://gemini.google.com/u/5/app/62da7b658846fbda","route_tier":"pinned"}
```

Native Hermes call (Test C) is logged **without** `harness`, `agent_id`, `session_id`, `session_url`, and with `provider_requested=default`: **TERVERIFIKASI**

```
{"ts":"2026-11-23T09:36:02.243075+00:00","event":"a2a.task_submitted","method":"SendMessage","prompt_chars":470,"return_immediately":false,"requested_context_id":"ctx-6ea48723ac384343","rpc_id":"task-3843b30134594a7b","user_agent":"Python-urllib/3.14","a2a_version":"1.0","client_ip":"127.0.0.1","task_id":"task-1c0ef038b81e4f34b8c38d6078e8f947","context_id":"ctx-e818055c82c44e3d986d1ef62bcd0ab7"}
```

Anomalies observed:

1. **Misleading failure reason.** Both Gemini attempts and Test C are recorded as `The task was cancelled: the caller stopped waiting.` at ~926–946 s, but no caller cancellation was issued and the HTTP client had disconnected at 420/560 s while the server task kept running. Timing matches the extension’s 15-minute hard cap (see Bug 1). **TERVERIFIKASI** for the message and duration; **PERKIRAAN** that the internal trigger is `hard-cap` (the message is shared by every abort path, so the log alone cannot distinguish them).
2. **`requested_context_id` ignored.** Hermes sent `ctx-6ea48723ac384343`; the server created `ctx-e818055c82c44e3d986d1ef62bcd0ab7`. Expected per `a2a_server.py:716-720` (only server-issued contexts are reusable), but Hermes’ context continuity silently does not work. **TERVERIFIKASI**
3. **No secret leakage** in either log (token-value scan returned false for both files). **TERVERIFIKASI**

### 2.2 `logs/bridge_debug.log` (31,323 lines at audit time)

- Startup at 15:41:52: `snapgent bridge v3.10.0`, WS `127.0.0.1:17613`, A2A card `17614`, `[repo] MCP server up (30 tools advertised)`, `ready 30 tools available`. **TERVERIFIKASI**
- Extension connected 15:41:53 (origin `chrome-extension://jodknheioffcjclgkpgfcbdojphomboo`, token auth). **TERVERIFIKASI**
- Only one MCP call is visible after restart: `<- list_dir (ok)` at 15:55:28. **TERVERIFIKASI**
- Noise / hygiene: a repeated `websockets.exceptions.InvalidMessage: did not receive a valid HTTP request` traceback, and an older `A2A server disabled: [Errno 98] Address already in use` from 15:15:26. The log is append-only (2.2 MB) and does **not** record A2A prompt lifecycle (that lives in `activity_audit.jsonl`). **TERVERIFIKASI**

---

## 3. Ranked, verified bugs

### B1 — P1 · Extension 15-min hard cap silently kills tasks the server advertises as 30 min, and mislabels the cause
- **Code:** `snapgent-extension/core/a2a-runner.js:12` (`A2A_HARD_CAP_MS = 15 * 60 * 1000`), `:57` (default applied because `core/main.js:288-296` does not pass `hardCapMs`), `:136` (`setTimeout(() => abort("hard-cap"), hardCapMs)`), `:170-172` (single generic reply for *every* abort: `The task was cancelled: the caller stopped waiting.`).
- **Contract:** `a2a_server.py:35` `DEFAULT_TIMEOUT_MS = 1_800_000` (30 min); `bridge.py:906` uses the same timeout; `docs/a2a.md:292` tells clients 30 min.
- **Repro (live):** Tests A and C all reached `TASK_STATE_FAILED` at 926–946 s with that message despite no cancel RPC. A client that disconnects at 420 s does **not** stop the server task.
- **Impact:** any audit/task needing > ~15 min is truncated; the error blames the caller. **TERVERIFIKASI**

### B2 — P1 · DeepSeek provider selectors are stale against the live `chat.deepseek.com` DOM → provider unusable
- **Code:** `snapgent-extension/providers/deepseek.js:32` `chatItem: ".ds-message"`, `:33-34` hashed user markers, `:35`/`:42` `.ds-markdown`; `core/main.js:1918` maps an empty read to `reply was never read (0 chars) - message DOM not matched`.
- **Live evidence (CDP, Brave 157, tab `2CF54C1984787023EAC0F6806F643266`):** `document.querySelectorAll('.ds-message').length === 0`, `.ds-markdown === 0`, `[data-virtual-list-item-key] === 0`; the actual turn containers are hashed (`div._81e7b5e` > `div._72b6158`) inside `ds-virtual-list-items`; the site composer `textarea` exists. **TERVERIFIKASI**
- **Repro:** Test B twice, pinned `deepseek`, failed at 344.558 s and 384.762 s with exactly that message. **TERVERIFIKASI**
- **Impact:** every DeepSeek-pinned A2A task fails before any tool call.

### B3 — P2 · Native Hermes `a2a_call` omits metadata + harness/session headers
- **Observed:** Test C audit event has no `harness`/`agent_id`/`session_id`/`session_url`, `provider_requested=default`, routed to `provider=gemini`, `route_tier=auto` — provider pinning and tier metadata were lost.
- **Documented:** `docs/a2a.md:296-298` (“Hermes a2a_call plugin … calling the server with no metadata, which drops provider and tier routing”).
- **Impact:** non-deterministic provider choice and unattributed audit trail for the primary Hermes client. **TERVERIFIKASI**

### B4 — P2 · `docs/a2a.md` timeout / cancel / concurrency / method contract contradicts the code (and itself)
- Timeout: `docs/a2a.md:218` and `:259` say `ZS_A2A_TIMEOUT_MS` default `600000` / 600 s, `:292` says `1800000`, code is `1_800_000` (`a2a_server.py:35`, read at `bridge.py:1638`).
- Cancel: `docs/a2a.md:261-262` “No task cancel … `tasks/cancel` is not implemented”, but `_cancel_task` (`a2a_server.py:373-404`), `TaskStore.cancel` (`:162-183`, sets `TASK_STATE_CANCELED`), and `tests/test_bridge.py:1123-1124` implement/assert it; `docs/a2a.md:370-373` documents it.
- Concurrency: `docs/a2a.md:255-256` “Concurrency 1 … serialises on an `asyncio.Lock`”, vs `a2a_server.py:42` `MAX_CONCURRENT_SUBMITS = 8` plus per-provider locks (`docs/a2a.md:355`).
- Methods: the table at `docs/a2a.md:229-233` omits `CancelTask`/`Orchestrate`, both implemented at `a2a_server.py:308-311`.
- **TERVERIFIKASI** (line-level).

### B5 — P3 · Gemini tool round-trip latency makes multi-tool audits infeasible
- One `list_dir` round-trip took **+106 s** (Test A1) and **+806 s** (Test C). With the 15-min cap (B1) a 3-file audit cannot finish even with a 6-command budget (Test A2 produced zero tool calls). **TERVERIFIKASI** for the timings; root cause (provider-side vs local queueing) **PERKIRAAN**.

### B6 — P3 · Client disconnect does not cancel the server task
- HTTP client timeouts at 420 s (A1) and 560 s (A2) left the server task alive until the extension cap (~946 s), consuming a submit slot and the chat tab. No socket-close→cancel path was observed. **TERVERIFIKASI** (behaviour); whether this is intended **PERKIRAAN**.

---

## 4. Unverified / limitations

- DeepSeek root cause was confirmed by live DOM counts + selector definitions; no patch/reload was applied, so a fixed-selector build was **not** re-verified. **GAGAL** (deliberately read-only).
- The exact internal abort trigger for the Gemini failures is inferred from timing/message; the code emits one shared string for `hard-cap`, `bridge-cancel`, and disconnect, so it cannot be isolated from logs alone. **PERKIRAAN**.
- Only Gemini and DeepSeek were exercised live; ChatGPT/Claude/etc. were not part of this run.
- Tests ran against a working tree that already had unrelated uncommitted modifications (`git status`); no commits/pushes were made.

## 5. Evidence artifacts

- Helper/results (created this session, removed after the report was written): `artifacts/e2e_ab_runner.py`, `artifacts/e2e_prompt_{a,b,a2,b2}.txt`, `artifacts/e2e_test_{a,b,a_retry,b_retry}.json`.
- Raw logs inspected: `logs/activity_audit.jsonl`, `logs/bridge_debug.log`.

**Final status:** `COMPLETED` (audit executed; all three tests failed live — findings above).
