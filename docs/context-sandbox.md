# Context sandbox

Date: 2026-11-14
Status: implemented in `context_sandbox.py` + `Bridge.submit_prompt`

## Problem

A web chat driven through the bridge can read the whole repository through its
MCP file tools. For a small task that is wasted context, and for a sensitive task
it is the wrong default: the model sees files the caller never meant to share.

## What it does

When an A2A request names the files it needs, the bridge:

1. validates each path against the repository root;
2. copies only those files into `.snapgent/context/<task>/`;
3. prepends a bounded `[CONTEXT SANDBOX]` block with their contents to the prompt.

The web chat starts from exactly those files. Nothing else is copied or rendered.

```json
{
  "method": "SendMessage",
  "params": {
    "message": { "parts": [{ "text": "Explain the retry path." }] },
    "metadata": {
      "taskCategory": "review",
      "modelTier": "deep",
      "contextFiles": ["snapgent-extension/core/main.js", "docs/a2a.md"]
    }
  }
}
```

The prompt then carries:

```
[CONTEXT SANDBOX]
Only the files below are provided for this task.
Do not read other repository files; work from this context.
--- snapgent-extension/core/main.js (12345 bytes) ---
...
--- END snapgent-extension/core/main.js ---
[END CONTEXT SANDBOX]
```

`metadata.context` in the task echoes the sandbox root, the copied files, the
byte count and any skipped entries, so the caller can audit what was shared.

## Safety rules

- Absolute paths, `..` segments and drive letters are rejected.
- A symlink that resolves outside the repository root is rejected.
- Missing files, files over 64 KiB and a total over 256 KiB are skipped and
  reported; they are never silently truncated.
- If every requested file is skipped, the task fails with a clear error instead
  of sending an empty context.
- The task id is sanitized before it becomes a directory name, so it cannot
  escape the destination.
- Task directories are mode `0700` and copied files `0600`, so other local users
  cannot read context handed to the web model.
- On each `prepare()` call, task directories older than `ZS_CONTEXT_TTL_SECONDS`
  (default 86400, i.e. 24 hours) are removed. Set it to `0` to keep them forever.

`ZS_CONTEXT_DIR` overrides where copies are written (default
`<repo>/.snapgent/context`).

## Tool-level enforcement

Set `"contextOnly": true` next to `contextFiles` and the bridge rejects tool
calls from the socket that owns that task while it runs:

```json
"metadata": {
  "contextFiles": ["README.md"],
  "contextOnly": true
}
```

The rejection is returned to the extension as
`{ok: false, kind: "context_only"}`, and the prompt gains a `[TOOLS DISABLED]`
note. The flag is cleared in the same `finally` that releases the prompt lock, so
a later task is not affected. Because the check lives in the bridge, a model
cannot bypass it by ignoring the prompt.

`contextOnly` is for read-only tasks: with every tool rejected, the model cannot
edit files. Use `contextFiles` without `contextOnly` when the task must change
the repository, and let `harness_loop.py` verify the result afterwards.

## Testing

`tests/test_context_sandbox.py` covers copying only named files, traversal,
absolute paths, escaping symlinks, missing/oversized files, the total budget and
task-id sanitisation. `tests/test_bridge.py` covers the prompt block and the
`metadata.context` echo.
