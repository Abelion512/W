"""Security tests for manifest.json, innerHTML sinks, bwrap sandbox, and context_sandbox."""

import json
import os
import stat
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import context_sandbox
import workspace_mcp

REPO_ROOT = Path(__file__).resolve().parent.parent
EXT_ROOT = REPO_ROOT / "snapgent-extension"
MANIFEST_PATH = EXT_ROOT / "manifest.json"

FORBIDDEN_PERMISSIONS = {
    "tabs",
    "scripting",
    "cookies",
    "webRequest",
    "webRequestBlocking",
    "debugger",
    "nativeMessaging",
    "history",
    "downloads",
    "clipboardRead",
    "<all_urls>",
}
ALLOWED_PERMISSIONS = {"storage", "alarms"}
BROAD_HOST_PATTERNS = {
    "<all_urls>",
    "*://*/*",
    "http://*/*",
    "https://*/*",
    "ws://*/*",
    "wss://*/*",
}


class ManifestValidationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))

    def test_manifest_is_mv3_with_minimal_permissions(self):
        self.assertEqual(self.manifest.get("manifest_version"), 3)
        perms = set(self.manifest.get("permissions", []))
        self.assertTrue(perms.issubset(ALLOWED_PERMISSIONS), f"unexpected permissions: {perms}")
        self.assertEqual(perms & FORBIDDEN_PERMISSIONS, set())

    def test_host_permissions_have_no_wildcards_and_match_content_scripts(self):
        host_perms = self.manifest.get("host_permissions", [])
        self.assertTrue(host_perms, "host_permissions must not be empty")

        content_matches = set()
        for entry in self.manifest.get("content_scripts", []):
            for match in entry.get("matches", []):
                content_matches.add(match)

        for pattern in host_perms:
            self.assertNotIn(pattern, BROAD_HOST_PATTERNS, f"broad wildcard host: {pattern}")
            self.assertNotRegex(pattern, r"^https?://\*\.", f"wildcard subdomain host: {pattern}")
            if pattern.startswith(("http://", "ws://")):
                self.assertRegex(
                    pattern,
                    r"^(http|ws)://(127\.0\.0\.1|localhost)(:\d+)?/\*$",
                    f"non-loopback cleartext host permission: {pattern}",
                )
            else:
                self.assertTrue(pattern.startswith("https://"), f"unexpected scheme: {pattern}")
                self.assertIn(
                    pattern,
                    content_matches,
                    f"unused host permission not present in content_scripts: {pattern}",
                )

    def test_manifest_referenced_assets_exist(self):
        sw = self.manifest.get("background", {}).get("service_worker")
        self.assertTrue(sw and (EXT_ROOT / sw).is_file(), f"missing service_worker: {sw}")
        popup = self.manifest.get("action", {}).get("default_popup")
        self.assertTrue(popup and (EXT_ROOT / popup).is_file(), f"missing popup: {popup}")
        for icon in self.manifest.get("icons", {}).values():
            self.assertTrue((EXT_ROOT / icon).is_file(), f"missing icon: {icon}")
        for entry in self.manifest.get("content_scripts", []):
            for asset in list(entry.get("js", [])) + list(entry.get("css", [])):
                self.assertTrue((EXT_ROOT / asset).is_file(), f"missing content script asset: {asset}")

    def test_no_active_innerhtml_in_core_main_and_ui_controller(self):
        for rel in ("core/main.js", "core/ui-controller.js"):
            lines = (EXT_ROOT / rel).read_text(encoding="utf-8").splitlines()
            active = [
                (idx + 1, line.strip())
                for idx, line in enumerate(lines)
                if "innerHTML" in line and not line.lstrip().startswith(("//", "*"))
            ]
            self.assertEqual(active, [], f"active innerHTML found in {rel}: {active}")


class SandboxBwrapAndContextTests(unittest.TestCase):
    def test_bwrap_argv_enforces_namespaces_caps_and_masks(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            with (
                patch.object(workspace_mcp.shutil, "which", return_value="/usr/bin/bwrap"),
                patch.object(workspace_mcp, "_bwrap_usable", return_value=True),
                patch.object(workspace_mcp, "_bwrap_supports_unshare_net", return_value=True),
                patch.object(workspace_mcp, "_secure_devnull", return_value="/tmp/fake-devnull"),
                patch.dict(os.environ, {}, clear=False),
            ):
                os.environ.pop("ZS_SANDBOX_NETWORK", None)
                argv = workspace_mcp._sandboxed_argv(["echo", "hi"], root)

        self.assertEqual(argv[0], "/usr/bin/bwrap")
        for flag in (
            "--die-with-parent",
            "--unshare-user",
            "--unshare-ipc",
            "--unshare-pid",
            "--unshare-uts",
            "--unshare-cgroup",
            "--unshare-net",
            "--new-session",
            "--clearenv",
        ):
            self.assertIn(flag, argv, f"missing bwrap flag: {flag}")
        cap_idx = argv.index("--cap-drop")
        self.assertEqual(argv[cap_idx + 1], "ALL")
        pairs = [(argv[i], argv[i + 1]) for i in range(len(argv) - 1)]
        for masked in ("/home", "/root", "/mnt", "/media", "/run", "/var"):
            self.assertIn(("--tmpfs", masked), pairs, f"missing tmpfs mask for {masked}")
        self.assertEqual(argv[-3:], ["--", "echo", "hi"])

    def test_bwrap_fails_closed_when_unusable(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            with (
                patch.object(workspace_mcp.shutil, "which", return_value="/usr/bin/bwrap"),
                patch.object(workspace_mcp, "_bwrap_usable", return_value=False),
                patch.dict(os.environ, {"ZS_ALLOW_UNSANDBOXED": "0"}, clear=False),
            ):
                with self.assertRaisesRegex(RuntimeError, "ZS_ALLOW_UNSANDBOXED"):
                    workspace_mcp._sandboxed_argv(["true"], root)

    def test_context_sandbox_permissions_nul_and_ttl(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / "secret.txt").write_text("token=abc\n", encoding="utf-8")
            dest_root = root / ".snapgent" / "context"
            stale = dest_root / "stale-task"
            stale.mkdir(parents=True)
            (stale / "old.txt").write_text("old", encoding="utf-8")
            old_time = time.time() - 7200
            os.utime(stale, (old_time, old_time))

            result = context_sandbox.prepare(
                ["secret.txt", "bad\x00name.txt"],
                "fresh-task",
                root,
                dest_root=dest_root,
                ttl_seconds=60,
            )
            self.assertFalse(stale.exists(), "expired context dir should be removed")
            self.assertEqual(result["files"], ["secret.txt"])
            self.assertEqual(len(result["skipped"]), 1)
            task_dir = Path(result["root"])
            copied = task_dir / "secret.txt"
            self.assertEqual(stat.S_IMODE(task_dir.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(copied.stat().st_mode), 0o600)


if __name__ == "__main__":
    unittest.main()
