"""Regression tests for the 2026-11-20 audit. Written before the fixes."""

import ast
import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import context_sandbox
import harness_loop
import workspace_mcp


class WorkspaceFileTests(unittest.TestCase):
    def test_read_file_lines_reaches_past_the_full_file_cap(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            # 60 lines x 6000 chars = 360 KB, well past MAX_FILE_CHARS.
            (root / "big.txt").write_text(("x" * 6000 + "\n") * 60, encoding="utf-8")
            with patch.dict(os.environ, {"ZS_WORKSPACE_ROOT": str(root)}):
                text = workspace_mcp.read_file_lines("big.txt", 58, 60)
        self.assertIn("58:", text)
        self.assertIn("60:", text)

    def test_run_process_error_keeps_stderr_alongside_stdout(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            with patch.dict(os.environ, {"ZS_WORKSPACE_ROOT": temp_dir}):
                with self.assertRaises(RuntimeError) as caught:
                    workspace_mcp._host_process(
                        ["/bin/sh", "-c", "echo PARTIAL; echo BOOM >&2; exit 3"]
                    )
        self.assertIn("PARTIAL", str(caught.exception))
        self.assertIn("BOOM", str(caught.exception))


class ContextSandboxTests(unittest.TestCase):
    def test_nul_byte_in_context_file_is_skipped(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            (root / "ok.txt").write_text("fine", encoding="utf-8")
            result = context_sandbox.prepare(["bad\u0000name.txt", "ok.txt"], "t1", root)
            self.assertEqual(result["files"], ["ok.txt"])
            self.assertTrue(any("bad" in item["path"] for item in result["skipped"]))

    def test_copied_context_files_are_private(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            (root / "secret.txt").write_text("secret", encoding="utf-8")
            result = context_sandbox.prepare(
                ["secret.txt"], "t2", root, root / "ctx"
            )
            copied = Path(result["root"]) / "secret.txt"
            self.assertEqual(copied.read_text(encoding="utf-8"), "secret")
            if os.name == "posix":
                self.assertEqual(stat.S_IMODE(copied.stat().st_mode), 0o600)
                self.assertEqual(
                    stat.S_IMODE(Path(result["root"]).stat().st_mode), 0o700
                )


    def test_expired_context_directories_are_removed(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            (root / "ok.txt").write_text("fine", encoding="utf-8")
            dest_root = root / "ctx"
            stale = dest_root / "old-task"
            stale.mkdir(parents=True)
            (stale / "secret.txt").write_text("old", encoding="utf-8")
            old = __import__("time").time() - 3 * 24 * 60 * 60
            __import__("os").utime(stale, (old, old))
            context_sandbox.prepare(["ok.txt"], "new-task", root, dest_root)
            self.assertFalse(stale.exists())
            self.assertTrue((dest_root / "new-task").exists())


class HarnessLoopTests(unittest.TestCase):
    def test_a2a_token_honours_env_overrides(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "token"
            path.write_text("file-token", encoding="utf-8")
            env = dict(os.environ)
            env["ZS_A2A_TOKEN_FILE"] = str(path)
            env.pop("ZS_A2A_TOKEN", None)
            with patch.dict(os.environ, env, clear=True):
                self.assertEqual(harness_loop._a2a_token(), "file-token")
            with patch.dict(os.environ, {"ZS_A2A_TOKEN": "env-token"}):
                self.assertEqual(harness_loop._a2a_token(), "env-token")

    def test_empty_check_is_reported_not_raised(self):
        results = harness_loop.run_checks([""])
        self.assertEqual(len(results), 1)
        self.assertNotEqual(results[0]["code"], 0)


class A2ASmokeTests(unittest.TestCase):
    def test_echo_smoke_callable_accepts_metadata(self):
        source = (Path(__file__).resolve().parent.parent / "a2a_server.py").read_text(
            encoding="utf-8"
        )
        tree = ast.parse(source)
        echo = next(
            node
            for node in ast.walk(tree)
            if isinstance(node, ast.FunctionDef) and node.name == "_echo"
        )
        self.assertEqual(len(echo.args.args), 3)


if __name__ == "__main__":
    unittest.main()
