"""Stability regressions for the WebSocket bridge runtime."""

import asyncio
import json
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import bridge


class _RecordingClient:
    def __init__(self):
        self.sent = []

    async def send(self, payload):
        self.sent.append(json.loads(payload))


class _StallServer:
    server_id = "stall"
    alive = True
    ready = True
    error = None
    process = None
    restart_attempts = 0
    next_restart_at = 0.0
    tools = [{"name": "slow"}]

    def __init__(self):
        self.entered = asyncio.Event()
        self.canceled = asyncio.Event()

    async def call_tool(self, tool_name, arguments, timeout):
        self.entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            self.canceled.set()


STALL_MCP = r"""
import json
import sys
import time

for line in sys.stdin:
    request = json.loads(line)
    if "id" not in request:
        continue
    method = request.get("method")
    if method == "initialize":
        result = {"protocolVersion": "2024-11-05", "capabilities": {},
                  "serverInfo": {"name": "stall", "version": "1"}}
    elif method == "tools/list":
        result = {"tools": [{"name": "slow", "inputSchema": {"type": "object"}}]}
    elif method == "tools/call":
        time.sleep(30)
        result = {}
    else:
        continue
    print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}), flush=True)
"""


@unittest.skipIf(bridge.websockets is None, "websockets package is not installed")
class BridgeStabilityTests(unittest.IsolatedAsyncioTestCase):
    async def _connect(self, port):
        client = await bridge.websockets.connect(f"ws://127.0.0.1:{port}")
        hello = json.loads(await client.recv())
        self.assertEqual(hello["type"], "connected")
        return client

    async def _wait_until(self, predicate):
        for _ in range(300):
            if predicate():
                return
            await asyncio.sleep(0.01)
        self.fail("condition was not met")

    def assert_clean(self, manager):
        self.assertFalse(manager.clients)
        self.assertFalse(manager._client_token_auth)
        self.assertFalse(manager._pending_prompts)
        self.assertFalse(manager._prompt_owners)
        self.assertFalse(manager._prompt_audit)
        self.assertFalse(manager._disconnect_timers)
        self.assertFalse(manager._context_only_prompts)

    async def test_abrupt_disconnect_mid_flight_cancels_handler_and_clears_state(self):
        manager = bridge.Bridge()
        stall = _StallServer()
        manager.servers = {"stall": stall}
        errors = []
        asyncio.get_running_loop().set_exception_handler(lambda loop, ctx: errors.append(ctx))
        async with bridge.websockets.serve(manager.handle_client, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            client = await self._connect(port)
            await client.send(json.dumps({
                "id": 1, "type": "call_tool", "name": "slow", "arguments": {}, "timeout": 1000,
            }))
            await asyncio.wait_for(stall.entered.wait(), 2)
            client.transport.abort()
            await self._wait_until(lambda: not manager.clients)
            self.assert_clean(manager)
            self.assertTrue(stall.canceled.is_set())
            self.assertFalse(errors, errors)

    async def test_rapid_reconnect_churn_leaves_no_state_and_recovers(self):
        manager = bridge.Bridge()
        async with bridge.websockets.serve(manager.handle_client, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            for mid in range(12):
                client = await self._connect(port)
                await client.send(json.dumps({"id": mid, "type": "ping"}))
                pong = json.loads(await client.recv())
                self.assertEqual((pong["type"], pong["id"]), ("pong", mid))
                await client.close()
            await self._wait_until(lambda: not manager.clients)
            self.assert_clean(manager)
            recovered = await self._connect(port)
            await recovered.send(json.dumps({"id": 99, "type": "ping"}))
            self.assertEqual(json.loads(await recovered.recv())["type"], "pong")
            await recovered.close()
            await self._wait_until(lambda: not manager.clients)
            self.assert_clean(manager)

    async def test_inline_restart_honors_backoff_window(self):
        manager = bridge.Bridge()
        starts = []

        class Flapping:
            server_id = "flap"
            alive = False
            ready = False
            process = None
            error = None
            restart_attempts = 3
            tools = [{"name": "echo"}]
            next_restart_at = time.monotonic() + 60

            async def start(self):
                starts.append(1)
                return False

            def record_restart_failure(self):
                return 60.0

        manager.servers = {"flap": Flapping()}
        client = _RecordingClient()
        await manager._call_tool(client, {
            "id": 1, "type": "call_tool", "name": "echo", "arguments": {},
        })
        self.assertFalse(starts)
        reply = [msg for msg in client.sent if msg.get("type") == "tool_result"][-1]
        self.assertFalse(reply["ok"])
        self.assertEqual(reply["kind"], "unknown_tool")

    async def test_large_valid_payload_succeeds_and_bad_frames_fail_closed(self):
        manager = bridge.Bridge()
        kwargs = {"max_size": bridge.MAX_REQUEST_FRAME_BYTES}
        serve = bridge.websockets.serve(manager.handle_client, "127.0.0.1", 0, **kwargs)
        async with serve as server:
            port = server.sockets[0].getsockname()[1]
            client = await self._connect(port)
            padding = "x" * (512 * 1024)
            await client.send(json.dumps({"id": 1, "type": "ping", "pad": padding}))
            self.assertEqual(json.loads(await client.recv())["type"], "pong")

            for malformed in ("{not json", b"\xff\xfe\x00"):
                await client.send(malformed)
                reply = json.loads(await client.recv())
                self.assertEqual(reply["error"], "Invalid JSON request.")

            with patch.object(bridge, "MAX_REQUEST_FRAME_BYTES", 64):
                await client.send(json.dumps({"id": 2, "type": "ping", "pad": "y" * 256}))
                reply = json.loads(await client.recv())
            self.assertEqual(reply["error"], "Request payload too large.")

            await client.send(json.dumps({"id": 3, "type": "ping"}))
            self.assertEqual(json.loads(await client.recv())["id"], 3)
            await client.close()
            await self._wait_until(lambda: not manager.clients)
            self.assert_clean(manager)

    async def test_stalled_tool_call_returns_structured_timeout_and_clears_pending(self):
        manager = bridge.Bridge()
        with tempfile.TemporaryDirectory() as temp_dir:
            script = Path(temp_dir) / "stall_mcp.py"
            script.write_text(STALL_MCP, encoding="utf-8")
            server = bridge.MCPServer(
                "stall", {"command": sys.executable, "args": [str(script)], "env": {}}
            )
            self.assertTrue(await server.start())
            manager.servers = {"stall": server}
            async with bridge.websockets.serve(manager.handle_client, "127.0.0.1", 0) as ws_server:
                port = ws_server.sockets[0].getsockname()[1]
                client = await self._connect(port)
                try:
                    await client.send(json.dumps({
                        "id": 7, "type": "call_tool", "name": "slow",
                        "arguments": {}, "timeout": 1000,
                    }))
                    reply = json.loads(await asyncio.wait_for(client.recv(), 5))
                    self.assertFalse(reply["ok"])
                    self.assertEqual(reply["kind"], "timeout")
                    self.assertFalse(server._pending)
                    await client.send(json.dumps({"id": 8, "type": "ping"}))
                    self.assertEqual(json.loads(await client.recv())["id"], 8)
                finally:
                    await client.close()
            await server.stop()
        self.assert_clean(manager)

    async def test_request_timeout_removes_its_pending_entry(self):
        server = bridge.MCPServer("m", {"command": "x", "args": [], "env": {}})

        async def drain():
            return None

        server.process = SimpleNamespace(
            returncode=None, stdin=SimpleNamespace(write=lambda data: None, drain=drain)
        )
        with self.assertRaises(asyncio.TimeoutError):
            await server._request("tools/call", {}, timeout=0.01)
        self.assertFalse(server._pending)


if __name__ == "__main__":
    unittest.main()
