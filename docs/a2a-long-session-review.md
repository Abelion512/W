# A2A long-session review — 2026-11-23

Scope: failure modes that surface specifically on **long** A2A sessions (many
MCP round-trips, fan-out, tasks that run for tens of minutes) in `bridge.py`,
`a2a_server.py` and the extension's A2A runner.

Sources:

- `artifacts/hermes-gemini-audit.json` — Gemini 4 Hydrogen (thinking High), 5
  failure modes. Captured from the live tab; the raw reply is unchanged.
- `artifacts/hermes-deepseek-audit.json` — DeepSeek (DeepThink + Search ON):
  **FAIL**, no findings (see "Provider status").
- Local re-verification of every claim against the current tree
  (`fix/a2a-long-session`, base `origin/main` = `44d3a24`). Several Gemini
  claims were **wrong**; they are corrected below rather than repeated.

## Provider status

| Provider | Status | Evidence |
|---|---|---|
| Gemini 4 Hydrogen / High | PARTIAL | 5 failure modes delivered; round 1 reply read out of the DOM after the A2A task stopped returning. Round 2 (after the MCP workspace root was repaired) returned only an interim line. |
| DeepSeek / DeepThink + Search | FAIL | Round 2: `Could not start a Snapgent session in this chat. reply was never read (0 chars) - message DOM not matched`. Round 3 (fresh tab): the prompt was never delivered; the run was killed. |
| Cross-critique (Gemini↔DeepSeek) | BLOCKED | DeepSeek produced no findings, so neither critique round could run. `artifacts/a2a-feature-matrix.json` records this. |

Environment defect found while running the audit (not a code finding): the
bridge's `config.json` still pointed the `repo` MCP server at
`/media/abelion/Isaf/ican/project/webmcp-agent`, which does not exist, so every
`read_file` returned `Configured workspace root does not exist`. Repaired to the
real repo root and `snapgent-bridge.service` restarted. `config.json` is
git-ignored, so this is a local fix, not part of the PR.

## Ranked findings

Severities: **Critical** = loses a live task or corrupts the protocol;
**High** = a long session fails or is silently wrong; **Medium** = degrades
robustness; **Low** = docs/observability.

### 1. PII web-search guard false-positives on pasted source code — HIGH (chosen fix)

Evidence: `bridge.py:429-434` (`_WEB_SEARCH_INTENT`), `bridge.py:435-444`
(`_PII_PATTERNS["private file path"]`), `bridge.py:447-459`
(`web_search_pii_violations`).

Mechanism: the guard scans the **whole** prompt. A long audit/review prompt that
pastes source therefore trips on code, not on the caller's intent. Reproduced
live: the audit prompt was rejected with
`HARD STOP: web search blocked - the prompt contains private file path`, because
`bridge.py`'s own regex literal `/home/|/Users/...` matches the private-path
pattern and the pasted code contains the words "web search". No web search was
requested.

Proposed patch: judge **intent** on the prose only (fenced code blocks
stripped), keep the **PII scan on the full prompt**. A caller who writes
"search the web" in prose and pastes an email in a fence is still blocked; a
caller who pastes code that merely mentions "web search" is not.

### 2. `docs/a2a.md` contradicts itself on the timeout and on cancel — MEDIUM (docs)

Evidence: `docs/a2a.md:218` (`ZS_A2A_TIMEOUT_MS` default `600000`),
`docs/a2a.md:259` ("Default task timeout 600 s"), `docs/a2a.md:312` ("at least
600 seconds") versus `a2a_server.py:33` (`DEFAULT_TIMEOUT_MS = 1_800_000`) and
`docs/a2a.md:292`, `docs/a2a.md:367` ("1800000 ms / 30 min"). Also
`docs/a2a.md:261` still says "No task cancel" while `docs/a2a.md:370` documents
`tasks/cancel`.

Impact: an operator who trusts the Configuration table sets a 600 s timeout and
kills legitimate 10–30 min deep-reasoning tasks.

Proposed patch: correct the three stale numbers and the stale "No task cancel"
line. Zero code risk.

### 3. MCP stdout overflow drain discards bytes after the first `\n` — HIGH (rare)

Evidence: `bridge.py:218` (`limit=128 * 1024 * 1024`), `bridge.py:348-406`
(`_read_stdout`), drain loop at `bridge.py:364-367`.

Mechanism: when a response line exceeds 128 MB, `readline()` raises `ValueError`
and the drain loop does `chunk = await process.stdout.read(1024 * 1024)` then
breaks on the first `b"\n"` in the chunk, **dropping every byte after it**. If
the next JSON-RPC response has already started in that chunk, its head is lost
and its request hangs until timeout. The FIFO assumption at `bridge.py:369`
(`next(iter(self._pending))`) can also fail the wrong request when MCP answers
out of order.

Proposed patch: carry the bytes after the first `\n` into a buffer and process
them before the next read; when the id cannot be recovered and more than one
request is pending, fail the whole pending set with a clear desync error instead
of guessing FIFO.

### 4. A2A submit slot fails after 5 s instead of queueing — MEDIUM

Evidence: `a2a_server.py:203` (`BoundedSemaphore(MAX_CONCURRENT_SUBMITS = 8)`),
`a2a_server.py:600` (`acquire(timeout=5)`).

Mechanism: `tasks/orchestrate` fans out to 2–8 providers and the bridge runs
them in parallel. A 9th concurrent task — or an orchestrate launched while
another task runs — fails after 5 s with `Too many concurrent A2A tasks; retry
shortly`, even though the task would have been able to start a minute later.

Proposed patch: bound the acquire by the task timeout (queue for a slot) rather
than a flat 5 s, or return a retry-after the caller can honour.

### 5. TaskStore is memory-only: a bridge restart turns live tasks into `-32001` — MEDIUM

Evidence: `a2a_server.py:115-174` (`TaskStore`), `a2a_server.py:327-335`
(`GetTask`).

Mechanism: a 20-minute task whose bridge restarts (supervisor, token rotation,
manual restart) leaves the client polling an id that now returns
`Task not found`, with no indication the task was running. Not low-risk to fix
(persistence + startup reconciliation).

### 6. Gemini adapter can silently keep the wrong model — MEDIUM

Evidence: `snapgent-extension/providers/gemini.js:542-571` (`ensureFocusMode`
returns silently when the model button or menu never appears),
`snapgent-extension/providers/gemini.js:575-580` (`ensureComposerReady` reports
`model: "4 Hydrogen", thinking: "High"` unconditionally).

Mechanism: the A2A card promises 4 Hydrogen / High. If the picker cannot be
driven (signed out, first-run consent, DOM change), the session still starts and
the diagnostics claim the mode was applied. Observed live: the tab showed
`Neon` while the run proceeded.

Proposed patch: report the observed button text and fail the ready gate when the
restore did not land, so the task fails loudly instead of silently using the
wrong model.

### 7. DeepSeek reply DOM mismatch ends a session with an empty reply — HIGH (observed)

Evidence: `snapgent-extension/core/main.js:1918` (empty-reply branch), observed
task status `Could not start a Snapgent session in this chat. reply was never
read (0 chars) - message DOM not matched`.

Mechanism: not root-caused in this session. The provider produced no readable
assistant item, so the runner reported an empty reply. Needs a live DeepSeek
session with the reply selectors instrumented; recorded here as an open risk,
not a patch.

## Corrections to the Gemini audit

Gemini's reply was based on a truncated paste (it said the middle ~1,700 lines
of `bridge.py` were cut). Three of its five findings do not survive contact with
the current tree:

| Gemini claim | Verdict | Current evidence |
|---|---|---|
| #3 `tasks/cancel` does not stop the browser tab | **Wrong** | `bridge.py:794-807` `cancel_task` sends `{"type":"cancel_prompt"}` to the owner socket and resolves the pending future; `a2a_server.py:352-354` invokes it through `on_cancel`. |
| #4 no partial streaming is implemented | **Wrong** | `a2a_server.py:615-625` `emit_chunk` + `bridge.py:1141-1147` forward `prompt_chunk` to the SSE sink; `docs/audit-followup-2026-11-22.md:25` is stale. |
| #5 `disconnect_grace = 0.0` | **Incomplete** | `build_a2a_server` raises it to 15 s at `bridge.py:1444-1449`; `_adopt_orphaned_prompts` (`bridge.py:783-792`) re-binds orphaned prompts when the extension reconnects. |

## Chosen fix

Finding #1 — the PII web-search guard. It is the only finding reproduced
end-to-end in this session (it blocked the audit itself), the patch is a
few lines, and it does not weaken the security check: intent is read from the
caller's prose, PII is still scanned in the full prompt.

Patch: `bridge.py` — strip fenced code blocks before the intent match.
Tests: `tests/test_bridge.py` — a fenced block that contains "web search" and a
private path no longer blocks; prose "search the web" plus a fenced email still
blocks.
