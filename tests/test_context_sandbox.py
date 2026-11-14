import os
import tempfile
import unittest
from pathlib import Path

import context_sandbox


class ContextSandboxTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / "README.md").write_text("hello world\n", encoding="utf-8")
        (self.root / "src").mkdir()
        (self.root / "src" / "app.py").write_text("print('x')\n", encoding="utf-8")

    def test_copies_only_the_requested_files(self):
        result = context_sandbox.prepare(
            ["README.md", "src/app.py"], "task-1", self.root
        )
        self.assertEqual(result["files"], ["README.md", "src/app.py"])
        self.assertEqual(result["bytes"], len("hello world\n") + len("print('x')\n"))
        self.assertTrue((Path(result["root"]) / "README.md").is_file())
        self.assertTrue((Path(result["root"]) / "src" / "app.py").is_file())
        # A file that was not requested must not be present.
        self.assertFalse((Path(result["root"]) / "other.txt").exists())
        self.assertIn("hello world", result["context"])
        self.assertIn("print('x')", result["context"])
        self.assertIn("[CONTEXT SANDBOX]", result["context"])
        self.assertIn("--- END README.md ---", result["context"])

    def test_rejects_traversal_and_absolute_paths(self):
        result = context_sandbox.prepare(
            ["../escape.txt", "/etc/passwd", "src/../../escape.txt"],
            "task-2",
            self.root,
        )
        self.assertEqual(result["files"], [])
        self.assertEqual(len(result["skipped"]), 3)
        self.assertFalse((Path(result["root"]).parent / "escape.txt").exists())

    def test_rejects_symlink_that_escapes_the_root(self):
        outside = tempfile.NamedTemporaryFile(delete=False)
        outside.write(b"secret")
        outside.close()
        self.addCleanup(os.unlink, outside.name)
        os.symlink(outside.name, self.root / "link.txt")
        result = context_sandbox.prepare(["link.txt"], "task-3", self.root)
        self.assertEqual(result["files"], [])
        self.assertTrue(result["skipped"])

    def test_missing_and_oversized_files_are_skipped(self):
        (self.root / "big.txt").write_text("x" * 100, encoding="utf-8")
        result = context_sandbox.prepare(
            ["missing.txt", "big.txt"], "task-4", self.root, max_file_bytes=10
        )
        self.assertEqual(result["files"], [])
        reasons = {item["path"]: item["reason"] for item in result["skipped"]}
        self.assertIn("missing.txt", reasons)
        self.assertIn("big.txt", reasons)

    def test_total_budget_is_enforced(self):
        (self.root / "one.txt").write_text("a" * 40, encoding="utf-8")
        (self.root / "two.txt").write_text("b" * 40, encoding="utf-8")
        result = context_sandbox.prepare(
            ["one.txt", "two.txt"], "task-5", self.root, max_bytes=50
        )
        self.assertEqual(result["files"], ["one.txt"])
        self.assertEqual(result["skipped"][0]["path"], "two.txt")

    def test_task_id_cannot_escape_the_destination(self):
        result = context_sandbox.prepare(["README.md"], "../../evil", self.root)
        root = Path(result["root"])
        self.assertEqual(root.parent.name, "context")
        self.assertNotIn("..", root.parts)


if __name__ == "__main__":
    unittest.main()
