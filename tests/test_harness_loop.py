import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import harness_loop


class HarnessLoopTests(unittest.TestCase):
    def test_envelope_states_scope_acceptance_and_output(self):
        prompt = harness_loop.build_envelope(
            "Fix the retry path.",
            files=["core/main.js"],
            checks=["pytest tests/test_bridge.py -q"],
            attempt=2,
            feedback="`pytest` exited 1: boom",
        )
        self.assertIn("Fix the retry path.", prompt)
        self.assertIn("core/main.js", prompt)
        self.assertIn("pytest tests/test_bridge.py -q", prompt)
        self.assertIn("cannot declare success", prompt)
        self.assertIn("SUMMARY:", prompt)
        self.assertIn("Previous attempt", prompt)
        self.assertIn("boom", prompt)
        self.assertIn("Attempt 2", prompt)

    def test_context_only_envelope_says_tools_are_rejected(self):
        prompt = harness_loop.build_envelope("Summarize.", context_only=True)
        self.assertIn("Every tool call is rejected", prompt)

    def test_run_checks_reports_exit_code_and_output(self):
        results = harness_loop.run_checks(["true", "false"])
        self.assertEqual([r["code"] for r in results], [0, 1])

    def test_run_checks_does_not_interpret_shell_metacharacters(self):
        # No shell: the `;` is an argument, not a command separator.
        results = harness_loop.run_checks(["printf %s 'one; two'"])
        self.assertEqual(results[0]["code"], 0)
        self.assertEqual(results[0]["output"].strip(), "one; two")

    def test_loop_retries_with_failure_feedback_until_checks_pass(self):
        verifications = []

        def verify(_checks):
            verifications.append(1)
            code = 0 if len(verifications) == 2 else 1
            return [{"command": "pytest", "code": code, "output": "boom" if code else ""}]

        prompts = []

        def submit(prompt, metadata):
            prompts.append((prompt, metadata))
            return {"ok": True, "text": "done"}

        with tempfile.TemporaryDirectory() as tmp, patch.object(
            harness_loop, "LEDGER_DIR", Path(tmp) / "loops"
        ):
            result = harness_loop.run_loop(
                submit,
                "Fix it.",
                files=["a.py"],
                checks=["pytest"],
                max_iterations=3,
                verify=verify,
            )
            self.assertTrue(Path(result["ledger_path"]).is_file())
        self.assertTrue(result["ok"])
        self.assertEqual(len(result["attempts"]), 2)
        self.assertEqual(result["attempts"][0]["prompt"], prompts[0][0])
        self.assertIn("boom", prompts[1][0])
        self.assertEqual(prompts[0][1]["contextFiles"], ["a.py"])

    def test_loop_stops_at_the_iteration_budget(self):
        def verify(_checks):
            return [{"command": "pytest", "code": 1, "output": "still broken"}]

        def submit(prompt, metadata):
            return {"ok": True, "text": "done"}

        with tempfile.TemporaryDirectory() as tmp, patch.object(
            harness_loop, "LEDGER_DIR", Path(tmp) / "loops"
        ):
            result = harness_loop.run_loop(
                submit, "Fix it.", checks=["pytest"], max_iterations=2, verify=verify
            )
        self.assertFalse(result["ok"])
        self.assertEqual(len(result["attempts"]), 2)

    def test_transport_failure_is_fed_back(self):
        def submit(prompt, metadata):
            return {"ok": False, "error": "bridge offline"}

        with tempfile.TemporaryDirectory() as tmp, patch.object(
            harness_loop, "LEDGER_DIR", Path(tmp) / "loops"
        ):
            result = harness_loop.run_loop(
                submit, "Fix it.", checks=[], max_iterations=1
            )
        self.assertFalse(result["ok"])
        self.assertIn("bridge offline", result["attempts"][0]["error"])


if __name__ == "__main__":
    unittest.main()
