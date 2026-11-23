#!/usr/bin/env python3
"""Harness-owned loop around a web AI used as an A2A subagent.

The web model is treated as a text producer, not as the authority on whether
the work is done. The harness owns:

  * the prompt envelope (goal, scope, acceptance, output format),
  * the context manifest handed to the bridge's context sandbox,
  * the acceptance commands, run locally after every attempt,
  * the retry decision and the feedback fed into the next attempt.

A run stops when every acceptance command exits 0, when the model fails and no
retry is possible, or when ``max_iterations`` is reached. Nothing the model says
can mark the task successful on its own.

stdlib only.
"""

import json
import os
import shlex
import subprocess
import sys
import time
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional

A2A_URL = "http://127.0.0.1:17614/"
TOKEN_PATH = Path.home() / ".snapgent" / "a2a_token"
LEDGER_DIR = Path(os.environ.get("ZS_LOOP_DIR", str(Path(__file__).resolve().parent / ".snapgent" / "loops")))
MAX_OUTPUT_CHARS = 3000
# Must not be shorter than the A2A server deadline: a client-side 600s cap
# killed tasks while the web model was still working (>7 min runs are normal).
DEFAULT_TIMEOUT = 1800


def _tail(text: str, limit: int = MAX_OUTPUT_CHARS) -> str:
    text = str(text or "")
    return text if len(text) <= limit else "…" + text[-limit:]


def build_envelope(
    goal: str,
    files: Iterable[str] = (),
    checks: Iterable[str] = (),
    attempt: int = 1,
    feedback: str = "",
    context_only: bool = False,
) -> str:
    """A prompt that states the contract instead of hoping the model infers it."""
    files = list(files)
    checks = list(checks)
    scope = "\n".join(f"- {path}" for path in files) if files else "- (no files named)"
    acceptance = "\n".join(f"- `{command}`" for command in checks) if checks else "- (no automatic checks)"
    lines = [
        "# Task",
        goal.strip(),
        "",
        "# Scope",
        "Work only on the files below. The harness provides their contents; do not",
        "invent files, APIs or results. If something outside this scope is required,",
        "say exactly what is missing instead of guessing.",
        scope,
        "",
        "# Acceptance",
        "The harness runs these commands after your reply. You cannot declare success:",
        acceptance,
        "",
        "# Output",
        "Be concrete and short. If you change code, make the change through the",
        "available tools. End with one line:",
        "SUMMARY: <what changed and why>",
    ]
    if context_only:
        lines += [
            "",
            "# Tool policy",
            "This task is context-only. Every tool call is rejected by the harness.",
            "Work from the provided context and reply with text only.",
        ]
    if feedback:
        lines += ["", f"# Previous attempt (attempt {attempt - 1}) failed", feedback.strip()]
    lines += ["", f"# Attempt {attempt}"]
    return "\n".join(lines)


def run_checks(
    commands: Iterable[str],
    cwd: Optional[str] = None,
    timeout: float = DEFAULT_TIMEOUT,
) -> List[Dict[str, Any]]:
    """Run acceptance commands locally and return command, exit code and output.

    Commands are executed WITHOUT a shell: the string is split with
    ``shlex.split`` and run directly, so a check cannot smuggle a pipe, redirect
    or ``&&`` chain in by accident. A check that genuinely needs shell syntax
    should say so explicitly, e.g. ``sh -c 'npm test 2>&1 | tail -20'``.
    """
    results: List[Dict[str, Any]] = []
    for command in commands:
        started = time.time()
        try:
            completed = subprocess.run(
                shlex.split(command),
                cwd=cwd,
                capture_output=True,
                text=True,
                timeout=timeout,
            )
            output = (completed.stdout or "") + (completed.stderr or "")
            results.append(
                {
                    "command": command,
                    "code": completed.returncode,
                    "output": _tail(output),
                    "seconds": round(time.time() - started, 2),
                }
            )
        except subprocess.TimeoutExpired:
            results.append(
                {
                    "command": command,
                    "code": 124,
                    "output": f"timed out after {timeout}s",
                    "seconds": round(time.time() - started, 2),
                }
            )
        except (ValueError, IndexError) as error:  # unbalanced quotes, empty command
            results.append(
                {
                    "command": command,
                    "code": 2,
                    "output": f"cannot parse command: {error}",
                    "seconds": round(time.time() - started, 2),
                }
            )
        except OSError as error:
            results.append(
                {
                    "command": command,
                    "code": 127,
                    "output": str(error),
                    "seconds": round(time.time() - started, 2),
                }
            )
    return results


def failure_feedback(reply: Dict[str, Any], checks: List[Dict[str, Any]]) -> str:
    lines: List[str] = []
    if not reply.get("ok"):
        lines.append(f"The web AI failed: {reply.get('error') or 'unknown error'}")
    for check in checks:
        if check["code"] != 0:
            lines.append(
                f"`{check['command']}` exited {check['code']}:\n{check['output']}"
            )
    return "\n\n".join(lines)


def run_loop(
    submit: Callable[[str, Dict[str, Any]], Dict[str, Any]],
    goal: str,
    files: Iterable[str] = (),
    checks: Iterable[str] = (),
    category: str = "code-edit",
    tier: str = "balanced",
    provider: str = "",
    max_iterations: int = 3,
    context_only: bool = False,
    verify: Optional[Callable[[Iterable[str]], List[Dict[str, Any]]]] = None,
) -> Dict[str, Any]:
    """Attempt the task until the checks pass or the budget is spent."""
    files = list(files)
    checks = list(checks)
    verify = verify or run_checks
    loop_id = f"loop-{uuid.uuid4().hex[:12]}"
    attempts: List[Dict[str, Any]] = []
    feedback = ""

    for attempt in range(1, max_iterations + 1):
        prompt = build_envelope(
            goal, files, checks, attempt, feedback, context_only=context_only
        )
        metadata: Dict[str, Any] = {
            "taskCategory": category,
            "modelTier": tier,
            "contextFiles": files,
        }
        if provider:
            metadata["provider"] = provider
        if context_only:
            metadata["contextOnly"] = True
        reply = submit(prompt, metadata)
        check_results = verify(checks) if checks else []
        ok = bool(reply.get("ok")) and all(
            result.get("code") == 0 for result in check_results
        )
        attempts.append(
            {
                "attempt": attempt,
                "ok": ok,
                "prompt": prompt,
                "reply": str(reply.get("text") or ""),
                "error": str(reply.get("error") or ""),
                "checks": check_results,
            }
        )
        if ok:
            break
        feedback = failure_feedback(reply, check_results)

    result = {
        "ok": bool(attempts and attempts[-1]["ok"]),
        "loop_id": loop_id,
        "attempts": attempts,
        "context_only": context_only,
        "max_iterations": max_iterations,
    }
    _write_ledger(result)
    return result


def _write_ledger(result: Dict[str, Any]) -> None:
    try:
        LEDGER_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
        LEDGER_DIR.chmod(0o700)
        path = LEDGER_DIR / f"{result['loop_id']}.json"
        # Ledgers hold prompts, replies and acceptance-command output.
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(json.dumps(result, indent=2))
        result["ledger_path"] = str(path)
    except OSError:
        result["ledger_path"] = None


def _a2a_token() -> str:
    """Resolve the A2A token the same way the bridge does."""
    env_token = (os.environ.get("ZS_A2A_TOKEN") or "").strip()
    if env_token:
        return env_token
    override = (os.environ.get("ZS_A2A_TOKEN_FILE") or "").strip()
    path = Path(override).expanduser() if override else TOKEN_PATH
    try:
        return path.read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def a2a_submit(prompt: str, metadata: Dict[str, Any], timeout: float = DEFAULT_TIMEOUT) -> Dict[str, Any]:
    """Send one prompt to the local A2A facade and return its reply."""
    token = _a2a_token()
    if not token:
        return {"ok": False, "error": "could not read the A2A token"}
    body = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "SendMessage",
        "params": {
            "message": {
                "messageId": f"msg-{uuid.uuid4().hex[:12]}",
                "role": "ROLE_USER",
                "parts": [{"text": prompt}],
            },
            "metadata": metadata,
        },
    }
    request = urllib.request.Request(
        A2A_URL,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except Exception as error:  # noqa: BLE001 - surface transport failures
        return {"ok": False, "error": str(error)}
    if payload.get("error"):
        error = payload["error"]
        detail = error.get("message") if isinstance(error, dict) else str(error)
        code = error.get("code", "") if isinstance(error, dict) else ""
        return {"ok": False, "error": f"JSON-RPC {code}: {detail}".strip()}
    task = payload.get("result") or {}
    state = (task.get("status") or {}).get("state")
    artifacts = task.get("artifacts") or []
    text = ""
    if artifacts:
        text = "".join(part.get("text", "") for part in artifacts[0].get("parts") or [])
    if state == "TASK_STATE_COMPLETED":
        return {"ok": True, "text": text}
    message = ((task.get("status") or {}).get("message") or {}).get("parts") or []
    error = "".join(part.get("text", "") for part in message) or "the web AI failed"
    return {"ok": False, "error": error}


def main(argv: Optional[List[str]] = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description="Run a verified A2A task loop.")
    parser.add_argument("--goal", required=True)
    parser.add_argument("--file", action="append", default=[])
    parser.add_argument("--check", action="append", default=[])
    parser.add_argument("--category", default="code-edit")
    parser.add_argument("--tier", default="balanced")
    parser.add_argument("--provider", default="", help="pin one A2A provider (e.g. gemini)")
    parser.add_argument("--iterations", type=int, default=3)
    parser.add_argument("--context-only", action="store_true")
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT)
    args = parser.parse_args(argv)

    result = run_loop(
        lambda prompt, metadata: a2a_submit(prompt, metadata, timeout=args.timeout),
        goal=args.goal,
        files=args.file,
        checks=args.check,
        category=args.category,
        tier=args.tier,
        provider=args.provider,
        max_iterations=max(1, args.iterations),
        context_only=args.context_only,
        verify=lambda commands: run_checks(commands, timeout=args.timeout),
    )
    print(json.dumps(result, indent=2)[:4000])
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
