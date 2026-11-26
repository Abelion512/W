"""Unit and correlation tests for activity_audit, A2AServer, and Bridge audit trail."""

import asyncio
import json
import os
import stat
import sys
import tempfile
import unittest
import urllib.request
from pathlib import Path
from unittest.mock import patch

import a2a_server
import activity_audit
import bridge


class ActivityAuditUnitTests(unittest.TestCase):
    def test_extract_session_context_reads_headers_metadata_and_hermes_link(self):
        ctx = activity_audit.extract_session_context(
            headers={
                "X-Session-Url": "https://hermes.abelion.my.id/#/local-abc123?token=secret-xyz",
                "User-Agent": "hermes-agent/1.0",
                "A2A-Version": "1.0",
                "_client_ip": "127.0.0.1",
            },
            params={
                "message": {
                    "contextId": "ctx-caller-9",
                    "metadata": {"agentId": "hermes-primary"},
                },
            },
            rpc_id="rpc-42",
        )
        self.assertEqual(ctx["harness"], "hermes")
        self.assertEqual(ctx["session_id"], "local-abc123")
        self.assertEqual(ctx["agent_id"], "hermes-primary")
        self.assertEqual(ctx["requested_context_id"], "ctx-caller-9")
        self.assertEqual(ctx["rpc_id"], "rpc-42")
        self.assertIn("token=REDACTED", ctx["session_url"])
        self.assertNotIn("secret-xyz", ctx["session_url"])

    def test_audit_log_writes_0600_jsonl_and_filters_tail(self):
        with tempfile.TemporaryDirectory() as td:
            log_path = Path(td) / "logs" / "activity_audit.jsonl"
            audit = activity_audit.ActivityAuditLog(log_path)
            audit.record("a2a.task_submitted", session_id="s1", task_id="t1")
            audit.record("bridge.tool_call", session_id="s2", task_id="t2", tool_name="read_file")
            audit.record("a2a.task_completed", session_id="s1", task_id="t1", duration_ms=12)

            self.assertTrue(log_path.is_file())
            self.assertEqual(stat.S_IMODE(log_path.stat().st_mode), 0o600)
            s1_events = audit.tail(limit=10, session_id="s1")
            self.assertEqual([e["event"] for e in s1_events], ["a2a.task_submitted", "a2a.task_completed"])
            t2_events = audit.tail(limit=10, task_id="t2")
            self.assertEqual(len(t2_events), 1)
            self.assertEqual(t2_events[0]["tool_name"], "read_file")

    def test_disabled_env_suppresses_writes(self):
        with tempfile.TemporaryDirectory() as td:
            sentinel = Path(td) / "should_not_exist.jsonl"
            with patch.dict(os.environ, {activity_audit.AUDIT_PATH_ENV: "0"}):
                audit = activity_audit.ActivityAuditLog()
                self.assertIsNone(audit.path)
                self.assertIsNone(audit.record("a2a.task_submitted", task_id="t1"))
            self.assertFalse(sentinel.exists())


class ActivityAuditCorrelationTests(unittest.IsolatedAsyncioTestCase):
    async def test_a2a_bridge_mcp_correlation_and_no_secret_leak(self):
        secret_value = "SUPER_SECRET_WORKSPACE_DATA_9988"
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            audit_path = root / "activity_audit.jsonl"
            cfg_path = root / "config.json"
            ws_root = root / "ws"
            ws_root.mkdir()
            (ws_root / "secret.txt").write_text(secret_value, encoding="utf-8")
            cfg_path.write_text(
                json.dumps({
                    "mcpServers": {
                        "repo": {
                            "command": sys.executable,
                            "args": [str(Path(bridge.__file__).resolve().parent / "workspace_mcp.py")],
                            "env": {"ZS_WORKSPACE_ROOT": str(ws_root)},
                        }
                    }
                }),
                encoding="utf-8",
            )
            audit = activity_audit.ActivityAuditLog(audit_path)
            mgr = bridge.Bridge("bridge-tok", audit_log=audit)
            with patch.object(bridge, "CONFIG_PATH", cfg_path):
                await mgr.start_servers()
                loop = asyncio.get_running_loop()

                def submit(prompt, timeout, metadata=None):
                    ctx = server.current_audit_context()
                    tid = server.current_task_id()
                    fut = asyncio.run_coroutine_threadsafe(
                        mgr.submit_prompt(prompt, timeout, metadata, task_id=tid, audit_context=ctx),
                        loop,
                    )
                    return fut.result(timeout + 5)

                server = a2a_server.A2AServer(
                    submit, port=0, token="a2a-tok", base_url="http://127.0.0.1:0", audit_log=audit
                )
                server.start()
                try:
                    class FakeWs:
                        def __init__(self):
                            self.sent = []

                        async def send(self, payload):
                            self.sent.append(json.loads(payload))

                    ws = FakeWs()
                    mgr.clients.add(ws)
                    mgr._last_client = ws

                    rpc_payload = {
                        "jsonrpc": "2.0",
                        "id": "rpc-77",
                        "method": "SendMessage",
                        "params": {
                            "message": {
                                "messageId": "m-1",
                                "role": "ROLE_USER",
                                "contextId": "ctx-hermes-prev",
                                "parts": [{"text": "inspect secret.txt"}],
                            },
                            "metadata": {"provider": "gemini"},
                        },
                    }
                    req = urllib.request.Request(
                        f"http://127.0.0.1:{server.port}/",
                        data=json.dumps(rpc_payload).encode("utf-8"),
                        headers={
                            "Content-Type": "application/json",
                            "Authorization": "Bearer a2a-tok",
                            "X-Harness": "hermes",
                            "X-Agent-Id": "hermes-webapp",
                            "X-Session-Id": "local-sess-42",
                            "X-Session-Url": "https://hermes.abelion.my.id/#/local-sess-42",
                        },
                        method="POST",
                    )

                    def do_http():
                        with urllib.request.urlopen(req, timeout=10) as resp:
                            return json.loads(resp.read().decode("utf-8"))

                    http_task = asyncio.create_task(asyncio.to_thread(do_http))
                    while not ws.sent:
                        await asyncio.sleep(0.02)
                    prompt_msg = ws.sent[0]
                    prompt_id = prompt_msg["id"]

                    await mgr._handle_request(
                        ws,
                        {
                            "type": "prompt_routed",
                            "prompt_id": prompt_id,
                            "provider": "gemini",
                            "tab_id": 12,
                            "tab_url": "https://gemini.google.com/u/5/app/xyz?token=leak123",
                            "route": "pinned",
                        },
                    )
                    await mgr._handle_request(
                        ws,
                        {
                            "type": "call_tool",
                            "id": 9,
                            "name": "read_file",
                            "arguments": {"path": "secret.txt"},
                            "promptId": prompt_id,
                        },
                    )
                    await mgr._handle_request(
                        ws,
                        {
                            "type": "prompt_result",
                            "id": 10,
                            "prompt_id": prompt_id,
                            "ok": True,
                            "text": "done reading",
                            "provider": "gemini",
                            "tab_id": 12,
                            "tab_url": "https://gemini.google.com/u/5/app/xyz",
                        },
                    )

                    resp = await http_task
                    self.assertEqual(resp["result"]["status"]["state"], "TASK_STATE_COMPLETED")
                finally:
                    server.stop()
                    await mgr.stop_servers()

            raw_log = audit_path.read_text(encoding="utf-8")
            self.assertNotIn(secret_value, raw_log)
            self.assertNotIn("leak123", raw_log)
            self.assertNotIn("a2a-tok", raw_log)
            self.assertNotIn("bridge-tok", raw_log)

            events = audit.tail(limit=50, session_id="local-sess-42")
            names = [e["event"] for e in events]
            for expected in (
                "a2a.task_submitted",
                "bridge.prompt_dispatched",
                "bridge.prompt_routed",
                "bridge.tool_call",
                "bridge.prompt_resolved",
                "a2a.task_completed",
            ):
                self.assertIn(expected, names, names)

            tool_ev = next(e for e in events if e["event"] == "bridge.tool_call")
            self.assertEqual(tool_ev["tool_name"], "read_file")
            self.assertEqual(tool_ev["arg_keys"], ["path"])
            self.assertEqual(tool_ev["provider"], "gemini")
            self.assertEqual(tool_ev["session_url"], "https://hermes.abelion.my.id/#/local-sess-42")
            self.assertEqual(tool_ev["requested_context_id"], "ctx-hermes-prev")
            self.assertEqual(tool_ev["rpc_id"], "rpc-77")
            self.assertTrue(tool_ev["ok"])


if __name__ == "__main__":
    unittest.main()
