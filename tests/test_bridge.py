import asyncio
import inspect
import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import bridge


class WebSearchPiiGuardTests(unittest.TestCase):
    def test_blocks_pii_when_web_search_is_intended(self):
        violations = bridge.web_search_pii_violations(
            "Search the web for jane.doe@example.com and report what you find."
        )
        self.assertIn("email address", violations)

    def test_allows_same_pii_without_search_intent(self):
        self.assertEqual(
            bridge.web_search_pii_violations("Summarize jane.doe@example.com in the file."),
            [],
        )

    def test_metadata_flag_forces_guard(self):
        violations = bridge.web_search_pii_violations(
            "Look up this account: sk-abcdefghijklmnopqrst", {"webSearch": True}
        )
        self.assertIn("API token or key", violations)

    def test_submit_prompt_refuses_pii_web_search_without_connecting(self):
        async def run():
            manager = bridge.Bridge()
            result = await manager.submit_prompt(
                "Please search online for john.doe@example.com", 5
            )
            self.assertFalse(result["ok"])
            self.assertIn("HARD STOP", result["error"])
        asyncio.run(run())


def _close_code(error):
    """Close code of a ConnectionClosed, without the deprecated .code accessor.

    websockets 13.1 deprecated ConnectionClosed.code in favour of rcvd.code, and
    reading the old attribute emits a DeprecationWarning on every rotation test.
    """
    received = getattr(error, "rcvd", None)
    return received.code if received is not None else error.code


def _header_kwargs(headers):
    """websockets renamed extra_headers to additional_headers in 14."""
    if not headers or bridge.websockets is None:
        return {}
    if "additional_headers" in inspect.signature(bridge.websockets.connect).parameters:
        return {"additional_headers": headers}
    return {"extra_headers": headers}


MOCK_MCP = r"""
import json
import sys

for line in sys.stdin:
    request = json.loads(line)
    if "id" not in request:
        continue
    method = request.get("method")
    if method == "initialize":
        result = {
            "protocolVersion": request["params"]["protocolVersion"],
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "mock", "version": "1"},
        }
    elif method == "tools/list":
        result = {
            "tools": [{
                "name": "echo",
                "description": "Echo a message",
                "inputSchema": {"type": "object", "properties": {"message": {"type": "string"}}},
            }]
        }
    elif method == "tools/call":
        result = {"content": [{"type": "text", "text": request["params"]["arguments"]["message"]}]}
    else:
        print(json.dumps({
            "jsonrpc": "2.0",
            "id": request["id"],
            "error": {"code": -32601, "message": "Method not found"},
        }), flush=True)
        continue
    print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}), flush=True)
"""


class BridgeTests(unittest.IsolatedAsyncioTestCase):
    async def test_stdio_mcp_start_list_call_and_stop(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            mock_path = Path(temp_dir) / "mock_mcp.py"
            mock_path.write_text(MOCK_MCP, encoding="utf-8")
            server = bridge.MCPServer(
                "mock",
                {"command": sys.executable, "args": [str(mock_path)], "env": {}},
            )
            try:
                self.assertTrue(await server.start())
                self.assertTrue(server.alive)
                self.assertEqual([tool["name"] for tool in server.tools], ["echo"])
                result = await server.call_tool("echo", {"message": "hello"}, 2)
                self.assertEqual(result["content"][0]["text"], "hello")
            finally:
                await server.stop()
            self.assertFalse(server.alive)

    async def test_large_response_line_is_received(self):
        # Regression: a single JSON line larger than asyncio's default 64 KB
        # stream limit used to kill the stdout reader while the process stayed
        # alive, so every later request timed out.
        with tempfile.TemporaryDirectory() as temp_dir:
            mock_path = Path(temp_dir) / "mock_mcp.py"
            mock_path.write_text(MOCK_MCP, encoding="utf-8")
            server = bridge.MCPServer(
                "mock",
                {"command": sys.executable, "args": [str(mock_path)], "env": {}},
            )
            try:
                self.assertTrue(await server.start())
                big_message = "x" * 200_000
                result = await server.call_tool("echo", {"message": big_message}, 10)
                self.assertEqual(result["content"][0]["text"], big_message)
                self.assertTrue(server.alive)
                follow_up = await server.call_tool("echo", {"message": "still works"}, 10)
                self.assertEqual(follow_up["content"][0]["text"], "still works")
            finally:
                await server.stop()

    @unittest.skipIf(bridge.websockets is None, "websockets package is not installed")
    async def test_websocket_extension_protocol(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            mock_path = root / "mock_mcp.py"
            mock_path.write_text(MOCK_MCP, encoding="utf-8")
            config_path = root / "config.json"
            config_path.write_text(
                json.dumps(
                    {
                        "mcpServers": {
                            "mock": {
                                "command": sys.executable,
                                "args": [str(mock_path)],
                                "env": {},
                            }
                        }
                    }
                ),
                encoding="utf-8",
            )
            manager = bridge.Bridge()
            with patch.object(bridge, "CONFIG_PATH", config_path):
                await manager.start_servers()
                try:
                    async with bridge.websockets.serve(
                        manager.handle_client, "127.0.0.1", 0
                    ) as server:
                        port = server.sockets[0].getsockname()[1]
                        async with bridge.websockets.connect(f"ws://127.0.0.1:{port}") as client:
                            connected = json.loads(await client.recv())
                            self.assertEqual(connected["type"], "connected")
                            self.assertEqual(connected["servers"][0]["id"], "mock")

                            await client.send(json.dumps({"id": 1, "type": "list_tools"}))
                            tools = json.loads(await client.recv())
                            self.assertEqual(tools["type"], "tools")
                            self.assertEqual(tools["tools"][0]["server"], "mock")

                            await client.send(
                                json.dumps(
                                    {
                                        "id": 2,
                                        "type": "call_tool",
                                        "name": "echo",
                                        "arguments": {"message": "round trip"},
                                        "timeout": 2000,
                                    }
                                )
                            )
                            result = json.loads(await client.recv())
                            self.assertTrue(result["ok"])
                            self.assertEqual(result["text"], "round trip")
                finally:
                    await manager.stop_servers()

    def test_duplicate_tool_names_are_server_qualified(self):
        first = bridge.MCPServer("alpha", {})
        second = bridge.MCPServer("beta", {})
        first.process = SimpleNamespace(returncode=None)
        second.process = SimpleNamespace(returncode=None)
        first.ready = second.ready = True
        first.tools = [{"name": "get_state"}]
        second.tools = [{"name": "get_state"}]

        manager = bridge.Bridge()
        manager.servers = {"alpha": first, "beta": second}
        manager._rebuild_catalog()

        self.assertEqual(
            [tool["name"] for tool in manager._catalog],
            ["alpha/get_state", "beta/get_state"],
        )
        self.assertIs(manager._resolve_tool("beta/get_state")[0], second)
        self.assertIsNone(manager._resolve_tool("get_state")[0])

    def test_restart_backoff_is_exponential_and_capped(self):
        server = bridge.MCPServer("mock", {})
        delays = [server.record_restart_failure() for _ in range(12)]
        self.assertEqual(delays[:4], [5.0, 10.0, 20.0, 40.0])
        self.assertTrue(all(d <= bridge.RESTART_MAX_DELAY_SECONDS for d in delays))
        self.assertEqual(server.restart_attempts, 12)
        self.assertGreater(server.next_restart_at, 0.0)
        server.record_restart_success()
        self.assertEqual(server.restart_attempts, 0)
        self.assertEqual(server.next_restart_at, 0.0)

    def test_get_bridge_status_shape(self):
        manager = bridge.Bridge()
        status = manager.get_bridge_status(log_tail=["line one", "line two"])
        self.assertEqual(status["bridge_version"], bridge.BRIDGE_VERSION)
        self.assertEqual(status["host"], bridge.HOST)
        self.assertEqual(status["port"], bridge.PORT)
        self.assertEqual(status["clients_connected"], 0)
        self.assertEqual(status["servers"], [])
        self.assertEqual(status["log_tail"], ["line one", "line two"])
        self.assertGreaterEqual(status["uptime_seconds"], 0.0)

    def test_json_log_formatter_emits_parseable_json(self):
        import logging

        formatter = bridge._JsonLogFormatter()
        record = logging.LogRecord(
            "test", logging.INFO, __file__, 1, "hello %s", ("world",), None
        )
        parsed = json.loads(formatter.format(record))
        self.assertEqual(parsed["level"], "INFO")
        self.assertEqual(parsed["message"], "hello world")
        self.assertIn("ts", parsed)

    @unittest.skipIf(bridge.websockets is None, "websockets package is not installed")
    async def test_websocket_get_bridge_status_request(self):
        manager = bridge.Bridge()
        async with bridge.websockets.serve(manager.handle_client, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            async with bridge.websockets.connect(f"ws://127.0.0.1:{port}") as client:
                connected = json.loads(await client.recv())
                self.assertEqual(connected["type"], "connected")
                await client.send(json.dumps({"id": 9, "type": "get_bridge_status"}))
                reply = json.loads(await client.recv())
                self.assertEqual(reply["type"], "bridge_status")
                self.assertEqual(reply["id"], 9)
                self.assertEqual(reply["status"]["clients_connected"], 1)
                self.assertIn("log_tail", reply["status"])


class BridgeAuthTests(unittest.IsolatedAsyncioTestCase):
    def test_origin_policy_allows_extensions_and_native_clients(self):
        self.assertTrue(bridge.origin_allowed(None))
        self.assertTrue(bridge.origin_allowed("chrome-extension://abcdefghijklmnop"))
        for rejected in ("https://evil.example", "http://127.0.0.1:8080", "null", "file://"):
            self.assertFalse(bridge.origin_allowed(rejected), rejected)

    def test_extensions_pair_without_a_token_but_native_clients_do_not(self):
        """An extension Origin needs no copy-paste; a native client still does."""
        with patch.dict(os.environ, {bridge.AUTH_DISABLE_ENV: ""}):
            for origin in (
                "chrome-extension://abcdefghijklmnop",
                "moz-extension://abcdefgh",
                "safari-web-extension://abcdefgh",
            ):
                self.assertFalse(bridge.token_required_for(origin), origin)
            # No Origin at all: the bridge cannot tell this from any other
            # local process, so it has to prove it holds the token.
            self.assertTrue(bridge.token_required_for(None))
            self.assertTrue(bridge.token_required_for(""))
            self.assertTrue(bridge.token_required_for("https://evil.example"))

    def test_strict_mode_requires_the_token_from_extensions_too(self):
        with patch.dict(os.environ, {bridge.AUTH_DISABLE_ENV: "strict"}):
            self.assertTrue(bridge.strict_auth())
            self.assertTrue(bridge.token_required_for("chrome-extension://abcdefghijklmnop"))
            self.assertTrue(bridge.token_required_for(None))

    def test_a2a_token_file_is_reused_and_private(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "nested" / "a2a_token"
            with patch.dict(os.environ, {"ZS_A2A_TOKEN_FILE": str(path)}):
                self.assertEqual(bridge.a2a_token_path(), path)
            first, created = bridge.load_or_create_token(path, "A2A token")
            self.assertTrue(created)
            self.assertTrue(first)
            second, created_again = bridge.load_or_create_token(path, "A2A token")
            self.assertEqual(first, second)
            self.assertFalse(created_again)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode), 0o700)

    def test_token_is_generated_once_with_private_permissions(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "nested" / "bridge_token"
            with patch.dict(os.environ, {bridge.TOKEN_PATH_ENV: str(path)}, clear=False):
                os.environ.pop(bridge.TOKEN_ENV, None)
                os.environ.pop(bridge.AUTH_DISABLE_ENV, None)
                first, created = bridge.load_auth_token()
                self.assertTrue(created)
                second, created_again = bridge.load_auth_token()
            self.assertFalse(created_again)
            self.assertEqual(first, second)
            self.assertGreaterEqual(len(first or ""), 32)
            if os.name == "posix":
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_repeated_rejections_are_logged_once_per_interval(self):
        manager = bridge.Bridge("t")
        with patch.object(bridge, "log") as logged:
            for _ in range(3):
                manager._log_rejection("token", "rejected client")
            self.assertEqual(logged.call_count, 1)
            # Pretend the reporting interval has elapsed.
            last, suppressed = manager._reject_log["token"]
            manager._reject_log["token"] = (last - bridge.REJECT_LOG_INTERVAL - 1, suppressed)
            manager._log_rejection("token", "rejected client")
        self.assertEqual(logged.call_count, 2)
        self.assertIn("2 more since the last report", logged.call_args[0][0])

    def test_token_env_overrides_file_and_disable_switch_turns_auth_off(self):
        with patch.dict(os.environ, {bridge.TOKEN_ENV: "env-token", bridge.AUTH_DISABLE_ENV: ""}):
            self.assertEqual(bridge.load_auth_token(), ("env-token", False))
        with patch.dict(os.environ, {bridge.AUTH_DISABLE_ENV: "0"}):
            self.assertEqual(bridge.load_auth_token(), (None, False))

    def test_token_matches_is_constant_time_and_tolerates_any_input(self):
        self.assertTrue(bridge.token_matches("secret", "secret"))
        self.assertFalse(bridge.token_matches("secret", "secrets"))
        self.assertFalse(bridge.token_matches("", "secret"))
        self.assertFalse(bridge.token_matches(None, "secret"))
        self.assertFalse(bridge.token_matches("secret", None))
        # Non-ASCII must be a plain mismatch: hmac.compare_digest raises
        # TypeError on non-ASCII str, which used to crash the connection handler.
        self.assertFalse(bridge.token_matches("\u00e9", "secret"))
        # Non-ASCII still compares correctly against itself; only the crash goes away.
        self.assertTrue(bridge.token_matches("\u00e9", "\u00e9"))
        self.assertFalse(bridge.token_matches("\ud800", "secret"))  # lone surrogate

    def test_empty_token_file_is_regenerated_not_disabled(self):
        """An empty token file must not silently turn token auth off."""
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "bridge_token"
            path.write_text("\n", encoding="utf-8")
            token, _ = bridge.load_or_create_token(path, "bridge token")
            self.assertIsInstance(token, str)
            self.assertTrue(token)
            self.assertEqual(path.read_text(encoding="utf-8").strip(), token)

    def test_stale_token_temp_file_does_not_block_rotation(self):
        """A leftover .tmp-<pid> file must not make every rotation fail."""
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "bridge_token"
            stale = path.with_name(f"{path.name}.tmp-{os.getpid()}")
            stale.write_text("stale", encoding="utf-8")
            bridge.write_token_file(path, "new-secret")
            self.assertEqual(path.read_text(encoding="utf-8").strip(), "new-secret")

    def test_unbracketed_ipv6_loopback_host_is_allowed(self):
        self.assertTrue(bridge.host_allowed("[::1]:17613"))
        self.assertTrue(bridge.host_allowed("::1"))

    def test_extension_origin_pattern_covers_all_browsers_and_needs_an_id(self):
        pattern = bridge.EXTENSION_ORIGIN_PATTERN
        for origin in (
            "chrome-extension://abcdefghijklmnop",
            "moz-extension://abcdefgh",
            "safari-web-extension://abcdefgh",
        ):
            self.assertIsNotNone(pattern.match(origin), origin)
        self.assertIsNone(pattern.match("chrome-extension://"))
        # websockets matches allowed_origins with re.search, so the whole Origin
        # must match or a hostile page can smuggle an extension Origin inside it.
        self.assertIsNone(
            pattern.search("https://evil.example/?x=chrome-extension://abcdefghijklmnop")
        )

    def test_rotate_token_refuses_when_pinned_or_disabled(self):
        with patch.dict(os.environ, {bridge.TOKEN_ENV: "pinned", bridge.AUTH_DISABLE_ENV: ""}):
            result = bridge.Bridge("pinned").rotate_token("r1")
        self.assertFalse(result["ok"])
        self.assertIn(bridge.TOKEN_ENV, result["error"])
        self.assertFalse(bridge.Bridge(None).rotate_token("r1")["ok"])

    def test_rotate_token_persists_and_updates_the_instance(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "bridge_token"
            with patch.dict(os.environ, {bridge.TOKEN_PATH_ENV: str(path)}, clear=False):
                os.environ.pop(bridge.TOKEN_ENV, None)
                os.environ.pop(bridge.AUTH_DISABLE_ENV, None)
                manager = bridge.Bridge("old-token")
                result = manager.rotate_token(7)
            self.assertTrue(result["ok"])
            self.assertEqual(result["id"], 7)
            self.assertNotEqual(result["token"], "old-token")
            self.assertEqual(manager.token, result["token"])
            self.assertEqual(path.read_text(encoding="utf-8").strip(), result["token"])
            if os.name == "posix":
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual([entry.name for entry in Path(temp_dir).iterdir()], ["bridge_token"])

    @unittest.skipIf(bridge.websockets is None, "websockets package is not installed")
    async def test_privileged_request_needs_token_despite_allowed_origin(self):
        manager = bridge.Bridge("secret-token")
        async with bridge.websockets.serve(manager.handle_client, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            base = f"ws://127.0.0.1:{port}"
            async with bridge.websockets.connect(
                base, additional_headers={"Origin": "chrome-extension://evil"}
            ) as client:
                self.assertEqual(json.loads(await client.recv())["type"], "connected")
                await client.send(json.dumps({"type": "add_server", "id": 9,
                                              "server_id": "x", "command": "echo"}))
                reply = json.loads(await client.recv())
                self.assertFalse(reply["ok"])
                self.assertIn("token", reply["error"].lower())

    @unittest.skipIf(bridge.websockets is None, "websockets package is not installed")
    async def test_rotated_token_replaces_the_old_one_for_new_connections(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "bridge_token"
            with patch.dict(os.environ, {bridge.TOKEN_PATH_ENV: str(path)}, clear=False):
                os.environ.pop(bridge.TOKEN_ENV, None)
                os.environ.pop(bridge.AUTH_DISABLE_ENV, None)
                manager = bridge.Bridge("old-token")
                async with bridge.websockets.serve(manager.handle_client, "127.0.0.1", 0) as server:
                    port = server.sockets[0].getsockname()[1]
                    base = f"ws://127.0.0.1:{port}"
                    async with bridge.websockets.connect(f"{base}/?token=old-token") as client:
                        self.assertEqual(json.loads(await client.recv())["type"], "connected")
                        await client.send(json.dumps({"type": "rotate_token", "id": 7}))
                        reply = json.loads(await client.recv())
                        # The reply arrives first, then the rotation revokes the
                        # session that asked for it.
                        with self.assertRaises(bridge.websockets.exceptions.ConnectionClosed) as closed:
                            await client.recv()
                        self.assertEqual(_close_code(closed.exception), bridge.ROTATE_CLOSE_CODE)
                    self.assertTrue(reply["ok"], reply)
                    new_token = reply["token"]
                    self.assertEqual(path.read_text(encoding="utf-8").strip(), new_token)

                    async with bridge.websockets.connect(f"{base}/?token=old-token") as stale:
                        with self.assertRaises(bridge.websockets.exceptions.ConnectionClosed) as ctx:
                            await stale.recv()
                        self.assertEqual(_close_code(ctx.exception), 1008)
                    async with bridge.websockets.connect(f"{base}/?token={new_token}") as fresh:
                        self.assertEqual(json.loads(await fresh.recv())["type"], "connected")

    @unittest.skipIf(bridge.websockets is None, "websockets package is not installed")
    async def test_rotation_refuses_the_old_token_even_for_the_client_that_rotated(self):
        # The session that rotates is closed too (1012), so a token leaked to that
        # client must not survive: dialing back in with the old value is a 1008.
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "bridge_token"
            with patch.dict(os.environ, {bridge.TOKEN_PATH_ENV: str(path)}, clear=False):
                os.environ.pop(bridge.TOKEN_ENV, None)
                os.environ.pop(bridge.AUTH_DISABLE_ENV, None)
                manager = bridge.Bridge("leaked-token")
                async with bridge.websockets.serve(manager.handle_client, "127.0.0.1", 0) as server:
                    port = server.sockets[0].getsockname()[1]
                    base = f"ws://127.0.0.1:{port}"
                    async with bridge.websockets.connect(f"{base}/?token=leaked-token") as client:
                        self.assertEqual(json.loads(await client.recv())["type"], "connected")
                        await client.send(json.dumps({"type": "rotate_token", "id": 4}))
                        reply = json.loads(await client.recv())
                        self.assertTrue(reply["ok"], reply)
                        with self.assertRaises(bridge.websockets.exceptions.ConnectionClosed) as closed:
                            await client.recv()
                        self.assertEqual(_close_code(closed.exception), bridge.ROTATE_CLOSE_CODE)
                    new_token = reply["token"]
                    self.assertNotEqual(new_token, "leaked-token")
                    self.assertEqual(path.read_text(encoding="utf-8").strip(), new_token)

                    async with bridge.websockets.connect(f"{base}/?token=leaked-token") as stale:
                        with self.assertRaises(bridge.websockets.exceptions.ConnectionClosed) as ctx:
                            await stale.recv()
                        self.assertEqual(_close_code(ctx.exception), 1008)
                    async with bridge.websockets.connect(f"{base}/?token={new_token}") as fresh:
                        self.assertEqual(json.loads(await fresh.recv())["type"], "connected")

    @unittest.skipIf(bridge.websockets is None, "websockets package is not installed")
    async def test_rotation_revokes_every_authenticated_connection(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "bridge_token"
            with patch.dict(os.environ, {bridge.TOKEN_PATH_ENV: str(path)}, clear=False):
                os.environ.pop(bridge.TOKEN_ENV, None)
                os.environ.pop(bridge.AUTH_DISABLE_ENV, None)
                manager = bridge.Bridge("old-token")
                async with bridge.websockets.serve(manager.handle_client, "127.0.0.1", 0) as server:
                    port = server.sockets[0].getsockname()[1]
                    base = f"ws://127.0.0.1:{port}"
                    async with bridge.websockets.connect(f"{base}/?token=old-token") as owner:
                        async with bridge.websockets.connect(f"{base}/?token=old-token") as bystander:
                            self.assertEqual(json.loads(await owner.recv())["type"], "connected")
                            self.assertEqual(json.loads(await bystander.recv())["type"], "connected")
                            await owner.send(json.dumps({"type": "rotate_token", "id": 1}))
                            reply = json.loads(await owner.recv())
                            self.assertTrue(reply["ok"], reply)
                            # Both the caller and the idle session lose their socket:
                            # a leaked token must not keep any connection alive.
                            for client in (owner, bystander):
                                with self.assertRaises(bridge.websockets.exceptions.ConnectionClosed) as closed:
                                    await client.recv()
                                self.assertEqual(_close_code(closed.exception), bridge.ROTATE_CLOSE_CODE)

                    new_token = reply["token"]
                    async with bridge.websockets.connect(f"{base}/?token=old-token") as stale:
                        with self.assertRaises(bridge.websockets.exceptions.ConnectionClosed) as closed:
                            await stale.recv()
                        self.assertEqual(_close_code(closed.exception), 1008)
                    async with bridge.websockets.connect(f"{base}/?token={new_token}") as fresh:
                        self.assertEqual(json.loads(await fresh.recv())["type"], "connected")

    @unittest.skipIf(bridge.websockets is None, "websockets package is not installed")
    async def test_non_ascii_token_is_refused_with_1008(self):
        manager = bridge.Bridge("secret-token")
        async with bridge.websockets.serve(manager.handle_client, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            base = f"ws://127.0.0.1:{port}"

            async def close_code(uri):
                async with bridge.websockets.connect(uri) as client:
                    try:
                        await client.recv()
                    except bridge.websockets.exceptions.ConnectionClosed as error:
                        return _close_code(error)
                return None

            # hmac.compare_digest() raised TypeError on non-ASCII input, so this
            # closed with 1011 and printed a traceback instead of rejecting.
            self.assertEqual(await close_code(f"{base}/?token=%C3%A9"), 1008)
            self.assertEqual(await close_code(base + "/?token=%FF%E0"), 1008)
            # The handler survived, so a valid client still gets in.
            async with bridge.websockets.connect(f"{base}/?token=secret-token") as client:
                self.assertEqual(json.loads(await client.recv())["type"], "connected")

    @unittest.skipIf(bridge.websockets is None, "websockets package is not installed")
    async def test_handshake_requires_origin_and_token(self):
        manager = bridge.Bridge("secret-token")
        async with bridge.websockets.serve(manager.handle_client, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            base = f"ws://127.0.0.1:{port}"

            async def close_code(uri, headers=None):
                async with bridge.websockets.connect(uri, **_header_kwargs(headers or {})) as client:
                    try:
                        await client.recv()
                    except bridge.websockets.exceptions.ConnectionClosed as error:
                        return _close_code(error)
                return None

            self.assertEqual(await close_code(base), 1008, "missing token must be refused")
            self.assertEqual(await close_code(f"{base}/?token=wrong"), 1008, "wrong token must be refused")
            self.assertEqual(
                await close_code(f"{base}/?token=secret-token", {"Origin": "https://evil.example"}),
                1008,
                "a website origin must be refused even with a valid token",
            )
            async with bridge.websockets.connect(
                f"{base}/?token=secret-token",
                **_header_kwargs({"Origin": "chrome-extension://abcdefghijklmnop"}),
            ) as client:
                self.assertEqual(json.loads(await client.recv())["type"], "connected")

            # Native clients may authenticate with a header instead of the URL.
            async with bridge.websockets.connect(
                base, **_header_kwargs({"X-Bridge-Token": "secret-token"})
            ) as client:
                self.assertEqual(json.loads(await client.recv())["type"], "connected")


class FakeClient:
    def __init__(self):
        self.sent = []

    async def send(self, payload):
        self.sent.append(json.loads(payload))


class PromptDelegationTests(unittest.IsolatedAsyncioTestCase):
    async def _await_send(self, client):
        for _ in range(200):
            if client.sent:
                return
            await asyncio.sleep(0.01)
        self.fail("the bridge never sent the prompt")

    async def test_submit_prompt_resolves_on_prompt_result(self):
        manager = bridge.Bridge()
        client = FakeClient()
        manager.clients.add(client)
        task = asyncio.create_task(manager.submit_prompt("hello", 5))
        await self._await_send(client)
        self.assertEqual(client.sent[0]["type"], "submit_prompt")
        self.assertEqual(client.sent[0]["prompt"], "hello")
        self.assertEqual(client.sent[0]["metadata"], {})
        await manager._handle_request(
            client,
            {
                "id": 7,
                "type": "prompt_result",
                "prompt_id": client.sent[0]["id"],
                "ok": True,
                "text": "world",
            },
        )
        self.assertEqual(await asyncio.wait_for(task, 2), {"ok": True, "text": "world"})

    async def test_submit_prompt_timeout_asks_the_tab_to_stop(self):
        # A caller that gave up must not leave the web tab generating: the bridge
        # cancels, so the tab can accept the next prompt without a page reload.
        manager = bridge.Bridge()
        client = FakeClient()
        manager.clients.add(client)
        result = await manager.submit_prompt("hello", 0.05)
        self.assertFalse(result["ok"])
        self.assertIn("did not answer", result["error"])
        for _ in range(100):
            if any(m["type"] == "cancel_prompt" for m in client.sent):
                break
            await asyncio.sleep(0.01)
        cancel = [m for m in client.sent if m["type"] == "cancel_prompt"]
        self.assertEqual(len(cancel), 1)
        self.assertEqual(cancel[0]["id"], client.sent[0]["id"])

    async def test_submit_prompt_carries_metadata(self):
        manager = bridge.Bridge()
        client = FakeClient()
        manager.clients.add(client)
        metadata = {"taskCategory": "debug", "modelTier": "balanced"}
        task = asyncio.create_task(manager.submit_prompt("hello", 5, metadata))
        await self._await_send(client)
        self.assertEqual(client.sent[0]["metadata"], metadata)
        await manager._handle_request(
            client,
            {
                "id": 8,
                "type": "prompt_result",
                "prompt_id": client.sent[0]["id"],
                "ok": True,
                "text": "world",
            },
        )
        self.assertEqual(await asyncio.wait_for(task, 2), {"ok": True, "text": "world"})

    async def test_fanout_pins_different_providers_in_parallel(self):
        manager = bridge.Bridge()
        client = FakeClient()
        manager.clients.add(client)
        first = asyncio.create_task(
            manager.submit_prompt("research", 5, {"provider": "gemini"})
        )
        await self._await_send(client)
        second = asyncio.create_task(
            manager.submit_prompt("critic", 5, {"provider": "deepseek"})
        )
        # The second prompt must go out while the first is still unanswered.
        for _ in range(200):
            if len(client.sent) == 2:
                break
            await asyncio.sleep(0.01)
        self.assertEqual(len(client.sent), 2)
        self.assertEqual(client.sent[0]["metadata"]["provider"], "gemini")
        self.assertEqual(client.sent[1]["metadata"]["provider"], "deepseek")
        for sent, text in zip(client.sent, ("RESEARCH", "CRITIC")):
            await manager._handle_request(
                client,
                {"id": 1, "type": "prompt_result", "prompt_id": sent["id"],
                 "ok": True, "text": text},
            )
        self.assertEqual(await asyncio.wait_for(first, 2), {"ok": True, "text": "RESEARCH"})
        self.assertEqual(await asyncio.wait_for(second, 2), {"ok": True, "text": "CRITIC"})

    async def test_context_only_flag_does_not_leak_after_a_sandbox_failure(self):
        # The flag tells the next tool call to be rejected while a context-only
        # prompt is in flight. A prompt that fails BEFORE it is sent must not
        # leave it set, or the following normal task would lose its tools.
        manager = bridge.Bridge()
        client = FakeClient()
        manager.clients.add(client)
        with patch.object(bridge, "ROOT", Path(tempfile.gettempdir())):
            result = await manager.submit_prompt(
                "hello", 5, {"contextOnly": True, "contextFiles": ["definitely-missing.txt"]}
            )
        self.assertFalse(result["ok"])
        self.assertFalse(manager._context_only_prompts)
        self.assertEqual(client.sent, [])

    async def test_submit_prompt_prepends_context_sandbox(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "note.txt").write_text("sandboxed text", encoding="utf-8")
            manager = bridge.Bridge()
            client = FakeClient()
            manager.clients.add(client)
            with patch.object(bridge, "ROOT", root):
                task = asyncio.create_task(
                    manager.submit_prompt(
                        "use the context", 5, {"contextFiles": ["note.txt"]}
                    )
                )
                await self._await_send(client)
        sent = client.sent[0]
        self.assertIn("[CONTEXT SANDBOX]", sent["prompt"])
        self.assertIn("sandboxed text", sent["prompt"])
        self.assertEqual(sent["metadata"]["context"]["files"], ["note.txt"])
        await manager._handle_request(
            client,
            {
                "id": 9,
                "type": "prompt_result",
                "prompt_id": sent["id"],
                "ok": True,
                "text": "world",
            },
        )
        self.assertEqual(await asyncio.wait_for(task, 2), {"ok": True, "text": "world"})

    async def test_context_only_rejects_tool_calls(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "note.txt").write_text("sandboxed text", encoding="utf-8")
            manager = bridge.Bridge()
            client = FakeClient()
            manager.clients.add(client)
            with patch.object(bridge, "ROOT", root):
                task = asyncio.create_task(
                    manager.submit_prompt(
                        "summarize",
                        5,
                        {"contextFiles": ["note.txt"], "contextOnly": True},
                    )
                )
                await self._await_send(client)
        sent = client.sent[0]
        self.assertIn("[TOOLS DISABLED]", sent["prompt"])
        await manager._handle_request(
            client,
            {
                "id": 10,
                "type": "call_tool",
                "name": "read_file",
                "arguments": {"path": "README.md"},
            },
        )
        rejection = [m for m in client.sent if m.get("type") == "tool_result"][-1]
        self.assertFalse(rejection["ok"])
        self.assertEqual(rejection["kind"], "context_only")
        await manager._handle_request(
            client,
            {
                "id": 11,
                "type": "prompt_result",
                "prompt_id": sent["id"],
                "ok": True,
                "text": "ok",
            },
        )
        self.assertEqual(await asyncio.wait_for(task, 2), {"ok": True, "text": "ok"})
        self.assertFalse(manager._context_only_prompts)

    async def test_context_only_does_not_block_other_clients(self):
        """A context-only task must not take tools away from unrelated tabs."""
        manager = bridge.Bridge()
        owner = FakeClient()
        other = FakeClient()
        manager.clients.update({owner, other})
        manager._last_client = owner
        task = asyncio.create_task(
            manager.submit_prompt("summarize", 5, {"contextOnly": True})
        )
        await self._await_send(owner)
        await manager._handle_request(
            other,
            {
                "id": 12,
                "type": "call_tool",
                "name": "read_file",
                "arguments": {"path": "README.md"},
            },
        )
        replies = [m for m in other.sent if m.get("type") == "tool_result"]
        self.assertEqual(len(replies), 1)
        self.assertNotEqual(replies[0].get("kind"), "context_only")
        await manager._handle_request(
            owner,
            {
                "id": 13,
                "type": "prompt_result",
                "prompt_id": owner.sent[0]["id"],
                "ok": True,
                "text": "ok",
            },
        )
        self.assertEqual(await asyncio.wait_for(task, 2), {"ok": True, "text": "ok"})

    async def test_submit_prompt_requires_extension(self):
        result = await bridge.Bridge().submit_prompt("hello", 1)
        self.assertFalse(result["ok"])
        self.assertIn("extension", result["error"])

    async def test_submit_prompt_fails_when_extension_disconnects(self):
        manager = bridge.Bridge()
        client = FakeClient()
        manager.clients.add(client)
        task = asyncio.create_task(manager.submit_prompt("hello", 5))
        await self._await_send(client)
        manager.clients.discard(client)
        manager._fail_pending_prompts("The extension disconnected.")
        result = await asyncio.wait_for(task, 2)
        self.assertFalse(result["ok"])
        self.assertIn("disconnected", result["error"])

    async def test_submit_prompt_ignores_a_foreign_socket(self):
        manager = bridge.Bridge()
        owner = FakeClient()
        rogue = FakeClient()
        manager.clients.update({owner, rogue})
        manager._last_client = owner
        task = asyncio.create_task(manager.submit_prompt("hello", 5))
        await self._await_send(owner)
        # The rogue must not be able to resolve someone else's task.
        await manager._handle_request(
            rogue,
            {
                "id": 9,
                "type": "prompt_result",
                "prompt_id": owner.sent[0]["id"],
                "ok": True,
                "text": "spoofed",
            },
        )
        self.assertFalse(task.done())
        await manager._handle_request(
            owner,
            {
                "id": 10,
                "type": "prompt_result",
                "prompt_id": owner.sent[0]["id"],
                "ok": True,
                "text": "real",
            },
        )
        self.assertEqual(await asyncio.wait_for(task, 2), {"ok": True, "text": "real"})

    def test_build_a2a_server_takes_token_from_env(self):
        with patch.dict("os.environ", {"ZS_A2A_TOKEN": "tok", "ZS_A2A_PORT": "0"}):
            server = bridge.build_a2a_server(bridge.Bridge(), asyncio.new_event_loop())
        self.assertEqual(server.token, "tok")


class AuditRegressionTests(unittest.IsolatedAsyncioTestCase):
    async def test_oversized_response_fails_only_oldest_pending(self):
        """An oversized frame must not fail unrelated concurrent requests."""
        server = bridge.MCPServer("mock", {"command": "x", "args": [], "env": {}})
        reads = 0

        async def readline():
            nonlocal reads
            reads += 1
            if reads == 1:
                raise ValueError("Separator is not found, and chunk exceed the limit")
            return b""

        async def read(_size):
            return b"tail\n"

        server.process = SimpleNamespace(
            stdout=SimpleNamespace(readline=readline, read=read), returncode=0
        )
        loop = asyncio.get_running_loop()
        first, second = loop.create_future(), loop.create_future()
        server._pending[1] = first
        server._pending[2] = second
        await server._read_stdout()
        self.assertTrue(first.done())
        self.assertIn("too large", str(first.exception()))
        self.assertFalse(second.done())
        self.assertNotIn(1, server._pending)
        self.assertIn(2, server._pending)

    async def test_stdout_reader_ignores_non_object_json(self):
        """A JSON array/string line must not kill the stdout reader task."""
        server = bridge.MCPServer("mock", {"command": "x", "args": [], "env": {}})
        lines = [
            b'"just a string"\n',
            b'[1, 2, 3]\n',
            b'{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n',
            b'',
        ]

        async def readline():
            return lines.pop(0)

        server.process = SimpleNamespace(
            stdout=SimpleNamespace(readline=readline), returncode=None
        )
        future = asyncio.get_running_loop().create_future()
        server._pending[1] = future
        await server._read_stdout()
        self.assertTrue(future.done())
        self.assertEqual(future.result()["result"], {"ok": True})

    async def test_tool_result_tolerates_malformed_mcp_content(self):
        """A malformed MCP result must still produce a tool_result frame."""
        manager = bridge.Bridge()
        client = FakeClient()
        server = SimpleNamespace(
            alive=True,
            tools=[{"name": "echo"}],
            call_tool=AsyncMock(return_value={"content": 123}),
        )
        manager.servers = {"mock": server}
        await manager._call_tool(
            client, {"id": 1, "type": "call_tool", "name": "echo", "arguments": {}}
        )
        replies = [m for m in client.sent if m.get("type") == "tool_result"]
        self.assertEqual(len(replies), 1)

    async def test_monitor_keeps_running_when_server_map_changes(self):
        """Concurrent add/remove must not kill the recovery monitor."""
        manager = bridge.Bridge()

        class MutatingServer:
            server_id = "mut"
            alive = False
            next_restart_at = 0.0
            error = None
            restart_attempts = 0

            async def start(self):
                manager.servers.clear()
                return True

            def record_restart_failure(self):
                return 5.0

        manager.servers = {"mut": MutatingServer()}
        restarted = asyncio.Event()

        async def broadcast(message):
            restarted.set()

        manager.broadcast = broadcast
        manager._rebuild_catalog = lambda: None
        manager._log_health = lambda: None
        original_sleep = bridge.asyncio.sleep

        async def instant_sleep(seconds):
            await original_sleep(0)

        with patch.object(bridge.asyncio, "sleep", new=instant_sleep):
            task = asyncio.create_task(bridge._monitor_servers(manager))
            await asyncio.wait_for(restarted.wait(), 2)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task


if __name__ == "__main__":
    unittest.main()
