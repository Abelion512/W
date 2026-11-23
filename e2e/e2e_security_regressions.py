#!/usr/bin/env python3
"""TDD e2e security regressions for the bridge auth boundary and secret hygiene.

Written red first against source ref c73864c: each check below currently FAILS
because the pre-fix bridge accepts a forged extension Origin, serves with a
broken token file, and lets A2A context files reach bridge internals.

The auth checks boot a REAL bridge on an ephemeral port over a REAL WebSocket.
No deployed endpoint, real credential, or user token is touched. All state is
created in a temp dir and cleaned up.

Usage: python3 e2e/e2e_security_regressions.py
Exit 0 = all checks pass, 1 = at least one failed.
"""
import asyncio
import json
import os
import secrets
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

try:
    import websockets
except ImportError:
    print("FAIL  websockets package is required")
    sys.exit(1)

results = []


def check(name, cond, detail=""):
    results.append((name, bool(cond)))
    print(f"{'PASS' if cond else 'FAIL'}  {name}  {str(detail)[:160]}", flush=True)
    return cond


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def boot(config_path, port, extra_env):
    env = dict(os.environ)
    for key in ("ZS_BRIDGE_AUTH", "ZS_BRIDGE_TOKEN", "ZS_BRIDGE_TOKEN_FILE"):
        env.pop(key, None)
    env["ZS_BRIDGE_CONFIG"] = str(config_path)
    env["ZS_BRIDGE_PORT"] = str(port)
    env.update(extra_env)
    return subprocess.Popen(
        [sys.executable, str(ROOT / "bridge.py")],
        cwd=str(ROOT), env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )


def stop(proc):
    if proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)


async def wait_listening(port, proc, timeout=6.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f"bridge exited early ({proc.returncode})")
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.3):
                return True
        except OSError:
            await asyncio.sleep(0.15)
    raise RuntimeError("bridge did not listen in time")


async def rpc(ws, mid, payload):
    await ws.send(json.dumps({"id": mid, **payload}))
    while True:
        message = json.loads(await asyncio.wait_for(ws.recv(), timeout=15))
        if message.get("id") == mid:
            return message


async def call(ws, mid, name, args=None):
    return await rpc(ws, mid, {"type": "call_tool", "name": name,
                               "arguments": args or {}, "timeout": 5})


async def main():
    with tempfile.TemporaryDirectory(prefix="sec-e2e-") as tmp:
        work = Path(tmp)
        config = work / "config.json"
        config.write_text(json.dumps({"mcpServers": {}}), encoding="utf-8")
        token = secrets.token_urlsafe(24)

        # 1. A raw local client cannot forge an extension Origin to skip the token.
        port = free_port()
        proc = boot(config, port, {"ZS_BRIDGE_TOKEN": token})
        try:
            await wait_listening(port, proc)
            try:
                async with websockets.connect(
                    f"ws://127.0.0.1:{port}",
                    additional_headers={"Origin": "chrome-extension://evil"},
                ) as ws:
                    await asyncio.wait_for(ws.recv(), timeout=3)
                check("forged_origin_rejected_without_token", False,
                      "forged extension Origin accepted a tokenless client")
            except websockets.exceptions.ConnectionClosed as error:
                code = error.rcvd.code if error.rcvd else None
                check("forged_origin_rejected_without_token", code == 1008,
                      f"close code {code}")
            except (OSError, asyncio.TimeoutError) as error:
                check("forged_origin_rejected_without_token", False, repr(error))
        except RuntimeError as error:
            check("forged_origin_rejected_without_token", False, str(error))
        finally:
            stop(proc)

        # 2. A tokenless non-browser client is still rejected (control case).
        port = free_port()
        proc = boot(config, port, {"ZS_BRIDGE_TOKEN": token})
        try:
            await wait_listening(port, proc)
            try:
                async with websockets.connect(f"ws://127.0.0.1:{port}") as ws:
                    await asyncio.wait_for(ws.recv(), timeout=3)
                check("tokenless_native_rejected", False, "tokenless native client accepted")
            except websockets.exceptions.ConnectionClosed as error:
                code = error.rcvd.code if error.rcvd else None
                check("tokenless_native_rejected", code == 1008, f"close code {code}")
        except RuntimeError as error:
            check("tokenless_native_rejected", False, str(error))
        finally:
            stop(proc)

        # 3. An unreadable token file must fail closed, not open an RPC server.
        broken_token = work / "token_is_a_directory"
        broken_token.mkdir()
        port = free_port()
        proc = boot(config, port, {"ZS_BRIDGE_TOKEN_FILE": str(broken_token)})
        try:
            listening = False
            try:
                await wait_listening(port, proc, timeout=5)
                listening = True
            except RuntimeError:
                pass
            code = proc.poll()
            if code is None:
                stop(proc)
                code = proc.poll()
            check("unreadable_token_fails_closed", (not listening) and code not in (0, None),
                  f"listening={listening} exit={code}")
        finally:
            stop(proc)

        # 4. A2A contextFiles must not expose bridge internals (config, logs).
        import context_sandbox
        ctx_root = work / "workspace"
        ctx_root.mkdir()
        (ctx_root / "config.json").write_text("TOPSECRET_CONFIG\n", encoding="utf-8")
        logs = ctx_root / "logs"
        logs.mkdir()
        (logs / "bridge_debug.log").write_text("TOPSECRET_LOG\n", encoding="utf-8")
        out = context_sandbox.prepare(["config.json", "logs/bridge_debug.log"],
                                       "e2e-context", ctx_root)
        check("context_excludes_bridge_internals", out["files"] == [],
              f"copied={out['files']}")

        # 5. Loop ledgers must not be world-readable.
        import harness_loop
        old_dir = harness_loop.LEDGER_DIR
        try:
            ledger_dir = work / "loops"
            harness_loop.LEDGER_DIR = ledger_dir
            harness_loop._write_ledger({"loop_id": "e2e-ledger", "attempts": []})
            ledger = ledger_dir / "e2e-ledger.json"
            mode = ledger.stat().st_mode & 0o777
            dmode = ledger_dir.stat().st_mode & 0o777
            check("ledger_private", mode == 0o600 and dmode == 0o700,
                  f"dir={oct(dmode)} file={oct(mode)}")
        finally:
            harness_loop.LEDGER_DIR = old_dir

        # 6-7. Real bridge + real workspace MCP: tool output is not logged,
        # and a blocked binary cannot be reached through a symlink alias.
        ws_root = work / "workspace-tools"
        ws_root.mkdir()
        sentinel = f"E2E_SENTINEL_{secrets.token_hex(6)}"
        (ws_root / "secret.txt").write_text(sentinel, encoding="utf-8")
        try:
            (ws_root / "alias").symlink_to("/usr/bin/sudo")
        except OSError:
            pass
        tool_config = work / "tool-config.json"
        tool_config.write_text(json.dumps({"mcpServers": {"repo": {
            "command": sys.executable,
            "args": [str(ROOT / "workspace_mcp.py")],
            "env": {"ZS_WORKSPACE_ROOT": str(ws_root)},
        }}}), encoding="utf-8")
        log = ROOT / "logs" / "bridge_debug.log"
        log_size = log.stat().st_size if log.exists() else 0
        port = free_port()
        proc = boot(tool_config, port, {"ZS_BRIDGE_TOKEN": token})
        try:
            await wait_listening(port, proc, timeout=15)
            async with websockets.connect(f"ws://127.0.0.1:{port}/?token={token}") as ws:
                await asyncio.wait_for(ws.recv(), timeout=10)  # connected
                read = None
                for _ in range(30):
                    read = await call(ws, 10, "read_file", {"path": "secret.txt"})
                    if read.get("ok") or "unknown_tool" not in str(read.get("error", "")):
                        break
                    await asyncio.sleep(0.3)
                appended = log.read_bytes()[log_size:] if log.exists() else b""
                check("tool_output_not_logged",
                      sentinel.encode() not in appended
                      and (log.stat().st_mode & 0o777) == 0o600,
                      f"leaked={sentinel.encode() in appended}")
                alias = await call(ws, 11, "run_command",
                                   {"command": "./alias", "args": [], "timeout": 5})
                reply = json.dumps(alias).lower()
                check("blocked_binary_alias_rejected",
                      not alias.get("ok") and ("blocked" in reply or "escapes" in reply),
                      str(alias)[:160])
        except (RuntimeError, OSError, asyncio.TimeoutError) as error:
            check("tool_output_not_logged", False, repr(error))
            check("blocked_binary_alias_rejected", False, repr(error))
        finally:
            stop(proc)

    failed = [name for name, ok in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
