# Harness loop

Date: 2026-11-14
Status: implemented in `harness_loop.py`; verified by `tests/test_harness_loop.py`

## Why

A web chat is a text producer, not an engineer. Asking it to also decide what
context matters, when it is done, and whether its own answer is correct is how a
weak model turns into a confident wrong answer.

The harness keeps those four decisions:

| Decision | Owner | Mechanism |
|---|---|---|
| What is asked | harness | prompt envelope |
| What is visible | harness | `contextFiles` → context sandbox |
| What counts as done | harness | acceptance commands run locally |
| Whether to try again | harness | bounded loop with the exact failure |

The model supplies the text. It cannot mark its own work successful.

## The envelope

`build_envelope()` writes a fixed contract instead of hoping the model infers it:

```
# Task
Fix the retry path.

# Scope
Work only on the files below. ...
- snapgent-extension/core/main.js

# Acceptance
The harness runs these commands after your reply. You cannot declare success:
- pytest tests/test_bridge.py -q

# Output
... End with one line:
SUMMARY: <what changed and why>

# Attempt 2
```

Scope, acceptance and output shape are explicit. A model that does not know
something has to name the gap instead of inventing a file or an API.

## The loop

```
attempt = 1
while attempt <= max_attempts:
    prompt = envelope(goal, files, checks, attempt, feedback)
    reply  = submit(prompt, metadata={contextFiles, contextOnly?})
    checks = run_locally(acceptance_commands)
    if reply.ok and every check.code == 0:
        return success(evidence=checks)
    feedback = exact_check_output + transport_error
    attempt += 1
return failure(last_evidence)
```

Each attempt is written to `.snapgent/loops/<loop-id>.json`: prompt, reply,
every command, its exit code and its output. A run is reproducible from the
ledger without trusting the transcript.

## What it prevents

- **Hallucinated success** — only local exit codes end the loop.
- **Scope creep** — the sandbox holds only the named files; `contextOnly`
  additionally rejects every tool call at the bridge.
- **Unbounded retries** — `max_iterations` (default 3) is a hard stop.
- **Context drift** — every attempt rebuilds the envelope from the same goal and
  the same file list, with the previous failure appended, not the whole history.
- **Silent failure** — a transport error is fed back like a failed check, and the
  final result is `ok: false` with the last evidence.

## Usage

```bash
python3 harness_loop.py \
  --goal "Explain why the retry loop can exit empty." \
  --file snapgent-extension/core/main.js \
  --file docs/a2a.md \
  --check "true" \
  --category review --tier deep \
  --context-only --iterations 2
```

For a task that edits the repository, drop `--context-only` and use a real
acceptance command, for example `--check "pytest tests/test_bridge.py -q"`. The
web chat edits through its tools; the harness runs the check afterwards.

## Honest limits

A passing check is evidence, not proof. The loop only knows what the acceptance
commands cover; a task with no checks is a task with no evidence. Write the
smallest command that would fail if the answer were wrong.
