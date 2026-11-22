#!/usr/bin/env python3
"""Resilient, self-healing A2A end-to-end verification runner for snapgentV3.

Runs a real multi-step MCP workspace verification task over the A2A HTTP facade
using free/preferred providers (deepseek or gemini by default), with:
  1. Bridge health check and self-heal via `systemctl --user restart snapgent-bridge.service`.
  2. Unpacked extension reload over CDP (`Extensions.loadUnpacked`) before running.
  3. Heavy MCP tool-using prompt (never a one-word PONG probe).
  4. Retry loop (up to 3 attempts) appending prior failure output and running cleanup.
  5. Persistent JSON ledger written under `.snapgent/loops/`.
"""

import argparse
import asyncio
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
EXT_DIR = REPO / "snapgent-extension"
LOOPS_DIR = REPO / ".snapgent" / "loops"
TOKEN_PATH = Path.home() / ".snapgent" / "a2a_token"
DEFAULT_A2A_URL = "http://127.0.0.1:17614/"
DEFAULT_CDP_PORT = 9222
ALLOWED_FREE_PROVIDERS = ("deepseek", "gemini", "glm", "qwen", "rudder")

DEFAULT_HEAVY_PROMPT = (
    "Use the repo MCP tools (list_commands, get_project_info, and read_file on "
    "pyproject.toml) to inspect the project configuration and configured test/script "
    "runners. Return a concise technical summary citing the exact package name, "
    "Python requirement, and configured scripts from pyproject.toml."
)


def ensure_bridge_service(service_name: str = "snapgent-bridge.service") -> dict:
    """Check systemd user unit status and restart it if inactive or unhealthy."""
    status_proc = subprocess.run(
        ["systemctl", "--user", "is-active", service_name],
        capture_output=True,
        text=True,
        check=False,
    )
    initial_state = (status_proc.stdout or status_proc.stderr).strip()
    restarted = False
    if status_proc.returncode != 0 or initial_state != "active":
        restart_proc = subprocess.run(
            ["systemctl", "--user", "restart", service_name],
            capture_output=True,
            text=True,
            check=False,
        )
        restarted = True
        if restart_proc.returncode != 0:
            return {
                "ok": False,
                "initial_state": initial_state,
                "restarted": restarted,
                "error": (restart_proc.stderr or restart_proc.stdout).strip(),
            }
        time.sleep(1.5)
    return {"ok": True, "initial_state": initial_state, "restarted": restarted}


def validate_loopback_url(url: str) -> str:
    """Restrict network targets to the local bridge; args may come from an LLM."""
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "http" or parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
        raise SystemExit(f"refusing non-loopback URL: {url!r}")
    if parsed.username or parsed.password or parsed.fragment:
        raise SystemExit(f"refusing credentialed URL: {url!r}")
    return url


def validate_cdp_port(port: int) -> int:
    if not isinstance(port, int) or not 1 <= port <= 65535:
        raise SystemExit(f"invalid CDP port: {port!r}")
    return port


def cdp_http(cdp_port: int, path: str, method: str = "GET"):
    url = f"http://127.0.0.1:{validate_cdp_port(cdp_port)}{path}"
    req = urllib.request.Request(url, method=method)
    with urllib.request.urlopen(req, timeout=10) as resp:
        raw = resp.read().decode("utf-8")
    return json.loads(raw) if raw.strip() else {}


async def reload_unpacked_extension(cdp_port: int, ext_path: Path = EXT_DIR) -> dict:
    """Reload the unpacked extension via CDP Extensions.loadUnpacked."""
    try:
        import websockets  # type: ignore
    except ImportError as exc:
        return {"ok": False, "error": f"websockets missing: {exc}"}

    try:
        version = cdp_http(cdp_port, "/json/version")
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"CDP /json/version unreachable: {exc}"}

    ws_url = version.get("webSocketDebuggerUrl")
    if not ws_url:
        return {"ok": False, "error": "missing webSocketDebuggerUrl"}

    async with websockets.connect(ws_url, max_size=None, open_timeout=10) as ws:
        await ws.send(
            json.dumps(
                {
                    "id": 1,
                    "method": "Extensions.loadUnpacked",
                    "params": {"path": str(ext_path)},
                }
            )
        )
        deadline = time.time() + 20
        while time.time() < deadline:
            msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))
            if msg.get("id") == 1:
                if "error" in msg:
                    return {"ok": False, "error": str(msg["error"])}
                return {"ok": True, "result": msg.get("result")}
    return {"ok": False, "error": "timeout waiting for Extensions.loadUnpacked"}


def a2a_send_task(
    prompt: str,
    provider: str,
    a2a_url: str = DEFAULT_A2A_URL,
    token_path: Path = TOKEN_PATH,
    timeout: float = 600.0,
) -> dict:
    """Send a SendMessage JSON-RPC request over the A2A HTTP facade."""
    a2a_url = validate_loopback_url(a2a_url)
    if not token_path.exists():
        return {"ok": False, "error": f"token file not found: {token_path}", "seconds": 0.0}

    token = token_path.read_text(encoding="utf-8").strip()
    task_id = f"e2e-{secrets.token_hex(6)}"
    body = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "SendMessage",
        "params": {
            "message": {
                "messageId": f"msg-{secrets.token_hex(6)}",
                "role": "ROLE_USER",
                "parts": [{"text": prompt}],
            },
            "metadata": {
                "provider": provider,
                "modelTier": "balanced",
                "taskCategory": "verify",
                "timeoutMs": int(timeout * 1000),
            },
        },
    }
    req = urllib.request.Request(
        validate_loopback_url(a2a_url),
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        },
        method="POST",
    )
    started = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout + 15) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        return {
            "ok": False,
            "task_id": task_id,
            "error": f"transport error: {exc}",
            "seconds": round(time.time() - started, 2),
        }

    elapsed = round(time.time() - started, 2)
    if "error" in payload:
        return {
            "ok": False,
            "task_id": task_id,
            "error": json.dumps(payload["error"]),
            "seconds": elapsed,
        }

    result = payload.get("result") or {}
    resolved_id = result.get("id") or task_id
    status = result.get("status") or {}
    state = status.get("state")
    artifacts = result.get("artifacts") or []
    text_out = ""
    if artifacts:
        text_out = "".join(p.get("text", "") for p in (artifacts[0].get("parts") or []))
    err_parts = (status.get("message") or {}).get("parts") or []
    err_text = "".join(p.get("text", "") for p in err_parts)

    if state == "TASK_STATE_COMPLETED" and text_out.strip():
        return {
            "ok": True,
            "task_id": resolved_id,
            "text": text_out.strip(),
            "seconds": elapsed,
        }
    return {
        "ok": False,
        "task_id": resolved_id,
        "text": text_out.strip(),
        "error": err_text or f"unexpected state={state}",
        "seconds": elapsed,
    }


def a2a_cancel_task(
    task_id: str,
    a2a_url: str = DEFAULT_A2A_URL,
    token_path: Path = TOKEN_PATH,
) -> None:
    """Best-effort cleanup via tasks/cancel if an attempt timed out or failed."""
    a2a_url = validate_loopback_url(a2a_url)
    if not task_id or not token_path.exists():
        return
    token = token_path.read_text(encoding="utf-8").strip()
    body = {
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tasks/cancel",
        "params": {"id": task_id},
    }
    req = urllib.request.Request(
        validate_loopback_url(a2a_url),
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10):
            pass
    except Exception:  # noqa: BLE001
        pass


def cleanup_attempt(task_id: str | None, temp_dir: Path | None) -> None:
    """Clean up temporary artifacts and cancel lingering A2A tasks between retries."""
    if task_id:
        a2a_cancel_task(task_id)
    if temp_dir and temp_dir.exists():
        shutil.rmtree(temp_dir, ignore_errors=True)


SAFE_CHECK_RE = re.compile(
    r'^printf "%s" "\$E2E_LAST_REPLY" \| grep -qi "[A-Za-z0-9_ .-]+"$'
)


def run_shell_check(check_cmd: str, reply_text: str) -> dict:
    """Run a fixed-shape reply check; arbitrary shell from CLI args is refused."""
    if not SAFE_CHECK_RE.fullmatch(check_cmd):
        raise SystemExit(f"refusing unsafe check command: {check_cmd!r}")
    env = os.environ.copy()
    env["E2E_LAST_REPLY"] = reply_text
    proc = subprocess.run(
        ["bash", "-lc", check_cmd],
        cwd=REPO,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    output = ((proc.stdout or "") + "\n" + (proc.stderr or "")).strip()
    return {
        "ok": proc.returncode == 0,
        "returncode": proc.returncode,
        "output": output[-2000:],
    }


def write_ledger(ledger: dict) -> Path:
    """Persist run telemetry under .snapgent/loops/."""
    LOOPS_DIR.mkdir(parents=True, exist_ok=True)
    ledger_path = LOOPS_DIR / f"{ledger['run_id']}.json"
    ledger_path.write_text(json.dumps(ledger, indent=2) + "\n", encoding="utf-8")
    return ledger_path


def run_resilient_e2e(
    provider: str,
    prompt: str,
    check_cmd: str,
    max_retries: int = 3,
    cdp_port: int = DEFAULT_CDP_PORT,
    a2a_url: str = DEFAULT_A2A_URL,
    timeout: float = 600.0,
) -> int:
    if provider not in ALLOWED_FREE_PROVIDERS:
        raise ValueError(
            f"Provider {provider!r} is not in preferred free set {ALLOWED_FREE_PROVIDERS}"
        )
    if re.fullmatch(r"\s*pong\s*", prompt, re.IGNORECASE):
        raise ValueError("One-word PONG prompts are disallowed; use a heavy MCP task.")

    run_id = f"loop-e2e-{secrets.token_hex(6)}"
    ledger: dict = {
        "run_id": run_id,
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "provider": provider,
        "check_cmd": check_cmd,
        "max_retries": max_retries,
        "attempts": [],
        "status": "running",
    }

    service_state = ensure_bridge_service()
    ledger["bridge_service"] = service_state
    if not service_state.get("ok"):
        ledger["status"] = "failed_bridge_service"
        path = write_ledger(ledger)
        print(f"FAIL: bridge service unhealthy ({service_state}); ledger={path}", file=sys.stderr)
        return 1

    reload_state = asyncio.run(reload_unpacked_extension(cdp_port))
    ledger["extension_reload"] = reload_state
    if not reload_state.get("ok"):
        ledger["status"] = "failed_extension_reload"
        path = write_ledger(ledger)
        print(f"FAIL: extension reload failed ({reload_state}); ledger={path}", file=sys.stderr)
        return 1

    last_failure = ""
    for attempt in range(1, max_retries + 1):
        attempt_prompt = prompt
        if last_failure:
            attempt_prompt = (
                f"{prompt}\n\n"
                f"Previous attempt ({attempt - 1}/{max_retries}) failed verification:\n"
                f"{last_failure}\n"
                "Correct the issue and complete the task using the repo MCP tools."
            )

        tmp_dir = LOOPS_DIR / f"{run_id}-attempt-{attempt}"
        tmp_dir.mkdir(parents=True, exist_ok=True)

        send_res = a2a_send_task(
            prompt=attempt_prompt,
            provider=provider,
            a2a_url=a2a_url,
            timeout=timeout,
        )
        task_id = send_res.get("task_id")

        if not send_res.get("ok"):
            last_failure = send_res.get("error") or "A2A task failed without output"
            ledger["attempts"].append(
                {
                    "attempt": attempt,
                    "task_id": task_id,
                    "a2a_ok": False,
                    "check_ok": False,
                    "seconds": send_res.get("seconds"),
                    "error": last_failure,
                }
            )
            cleanup_attempt(task_id, tmp_dir)
            ensure_bridge_service()
            write_ledger(ledger)
            continue

        reply_text = send_res.get("text", "")
        check_res = run_shell_check(check_cmd, reply_text)
        ledger["attempts"].append(
            {
                "attempt": attempt,
                "task_id": task_id,
                "a2a_ok": True,
                "check_ok": check_res["ok"],
                "seconds": send_res.get("seconds"),
                "reply_excerpt": reply_text[:500],
                "check_output": check_res["output"],
            }
        )

        if check_res["ok"]:
            cleanup_attempt(None, tmp_dir)
            ledger["status"] = "passed"
            ledger["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            path = write_ledger(ledger)
            print(f"PASS (attempt {attempt}/{max_retries}) ledger={path}")
            return 0

        last_failure = (
            f"Shell check `{check_cmd}` exited {check_res['returncode']}: "
            f"{check_res['output']}"
        )
        cleanup_attempt(task_id, tmp_dir)
        write_ledger(ledger)

    ledger["status"] = "failed"
    ledger["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    path = write_ledger(ledger)
    print(f"FAIL after {max_retries} attempts; ledger={path}", file=sys.stderr)
    return 1


def main() -> int:
    parser = argparse.ArgumentParser(description="Self-healing resilient A2A E2E runner.")
    parser.add_argument(
        "--provider",
        default="deepseek",
        choices=ALLOWED_FREE_PROVIDERS,
        help="Preferred free provider to pin (default: deepseek).",
    )
    parser.add_argument(
        "--prompt",
        default=DEFAULT_HEAVY_PROMPT,
        help="Heavy MCP-backed prompt to execute over A2A.",
    )
    parser.add_argument(
        "--check",
        default='printf "%s" "$E2E_LAST_REPLY" | grep -qi "snapgent"',
        help="Shell check command validated after each attempt.",
    )
    parser.add_argument(
        "--max-retries",
        type=int,
        default=3,
        help="Maximum retry attempts (default: 3).",
    )
    parser.add_argument("--cdp", type=int, default=DEFAULT_CDP_PORT)
    parser.add_argument("--a2a-url", default=DEFAULT_A2A_URL)
    parser.add_argument("--timeout", type=float, default=600.0)
    args = parser.parse_args()

    return run_resilient_e2e(
        provider=args.provider,
        prompt=args.prompt,
        check_cmd=args.check,
        max_retries=min(max(1, args.max_retries), 3),
        cdp_port=args.cdp,
        a2a_url=args.a2a_url,
        timeout=args.timeout,
    )


if __name__ == "__main__":
    sys.exit(main())
