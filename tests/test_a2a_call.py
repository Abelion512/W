"""Offline checks for scripts/a2a_call.py, the metadata-carrying A2A client."""

import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

REPO = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("a2a_call", REPO / "scripts" / "a2a_call.py")
a2a_call = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a2a_call)


class A2aCallTests(unittest.TestCase):
    def test_token_resolution_prefers_arg_then_env_then_file(self):
        self.assertEqual(a2a_call.token_from_args_or_env("arg"), "arg")
        with patch.dict(os.environ, {"ZS_A2A_TOKEN": "  envtok  "}):
            self.assertEqual(a2a_call.token_from_args_or_env(None), "envtok")
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            (home / ".snapgent").mkdir()
            (home / ".snapgent" / "a2a_token").write_text("filetok\n", encoding="utf-8")
            with patch.dict(os.environ, {}, clear=True), patch.object(Path, "home", return_value=home):
                self.assertEqual(a2a_call.token_from_args_or_env(None), "filetok")

    def test_every_call_carries_metadata(self):
        captured = {}

        def fake_rpc(url, token, method, params, rpc_id=1):
            captured.update(method=method, params=params)
            return {"result": {"status": {"state": "TASK_STATE_COMPLETED"}}}

        argv = [
            "a2a_call.py", "Review this", "--token", "t",
            "--provider", "deepseek", "--tier", "balanced",
        ]
        with patch.object(sys, "argv", argv), patch.object(a2a_call, "rpc", fake_rpc):
            self.assertEqual(a2a_call.main(), 0)
        self.assertEqual(captured["method"], "SendMessage")
        meta = captured["params"]["metadata"]
        self.assertEqual(meta["provider"], "deepseek")
        self.assertEqual(meta["modelTier"], "balanced")
        self.assertIn("timeoutMs", meta)

    def test_orchestrate_helper_sends_provider_list(self):
        captured = {}

        def fake_rpc(url, token, method, params, rpc_id=1):
            captured.update(method=method, params=params)
            return {"result": {"status": {"state": "TASK_STATE_COMPLETED"}}}

        argv = [
            "a2a_call.py", "Review this", "--token", "t",
            "--orchestrate", "gemini,deepseek",
        ]
        with patch.object(sys, "argv", argv), patch.object(a2a_call, "rpc", fake_rpc):
            a2a_call.main()
        self.assertEqual(captured["method"], "tasks/orchestrate")
        self.assertEqual(captured["params"]["providers"], ["gemini", "deepseek"])


if __name__ == "__main__":
    unittest.main()
