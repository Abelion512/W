import json
import threading
import time
import unittest
import urllib.error
import urllib.request

import a2a_server


class A2AServerTests(unittest.TestCase):
    def setUp(self):
        self.token = "test-token"
        self.submit_calls = []
        self.submit_delay = 0.0
        self.submit_result = {"ok": True, "text": "the reply"}

        def submit(prompt, timeout, metadata=None):
            self.submit_calls.append((prompt, timeout, metadata))
            if self.submit_delay:
                time.sleep(self.submit_delay)
            return self.submit_result

        self.server = a2a_server.A2AServer(
            submit, port=0, token=self.token, base_url="http://127.0.0.1:0"
        )
        self.server.start()
        self.assertTrue(isinstance(self.server.port, int))
        self.assertNotEqual(self.server.port, 0)
        self.base = f"http://127.0.0.1:{self.server.port}"
        self.addCleanup(self.server.stop)

    # -- helpers ---------------------------------------------------------

    def _request(self, method, params=None, token=None, rpc_id=1, path="/"):
        payload = {"jsonrpc": "2.0", "id": rpc_id, "method": method}
        if params is not None:
            payload["params"] = params
        data = json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(self.base + path, data=data, method="POST")
        request.add_header("Content-Type", "application/json")
        if token:
            request.add_header("Authorization", "Bearer " + token)
        return request

    def rpc(self, method, params=None, token="__default__", rpc_id=1):
        if token == "__default__":
            token = self.token
        request = self._request(method, params, token, rpc_id)
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.loads(response.read().decode("utf-8"))

    @staticmethod
    def message(text="hello"):
        return {
            "messageId": "m1",
            "role": "ROLE_USER",
            "parts": [{"text": text}],
        }

    # -- tests -----------------------------------------------------------

    def test_agent_card_is_served_without_auth(self):
        for path in ("/.well-known/agent-card.json", "/.well-known/agent.json"):
            with urllib.request.urlopen(self.base + path, timeout=10) as response:
                self.assertEqual(response.status, 200)
                card = json.loads(response.read().decode("utf-8"))
            self.assertEqual(card["supportedInterfaces"][0]["protocolVersion"], "1.0")
            self.assertEqual(card["supportedInterfaces"][0]["protocolBinding"], "JSONRPC")
            self.assertTrue(card["skills"])
            self.assertEqual(card["skills"][0]["id"], "web-chat-delegation")

    def test_post_without_token_is_unauthorized(self):
        request = self._request("SendMessage", {"message": self.message()}, token=None)
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(request, timeout=10)
        self.assertEqual(caught.exception.code, 401)
        self.assertIn("Bearer", caught.exception.headers.get("WWW-Authenticate", ""))

    def test_unknown_method_is_method_not_found(self):
        response = self.rpc("NoSuchMethod", {})
        self.assertEqual(response["error"]["code"], -32601)

    def test_message_without_text_part_is_invalid_params(self):
        response = self.rpc(
            "SendMessage",
            {"message": {"messageId": "m1", "role": "ROLE_USER", "parts": [{"data": {}}]}},
        )
        self.assertEqual(response["error"]["code"], -32602)

    def test_send_message_completes_with_artifact(self):
        response = self.rpc("SendMessage", {"message": self.message("ping")})
        task = response["result"]
        self.assertEqual(task["status"]["state"], "TASK_STATE_COMPLETED")
        self.assertEqual(task["artifacts"][0]["parts"][0]["text"], "the reply")
        self.assertEqual(task["artifacts"][0]["name"], "reply")
        self.assertEqual(self.submit_calls[0][0], "ping")

    def test_send_message_passes_metadata_to_submit(self):
        metadata = {"taskCategory": "debug", "modelTier": "balanced"}
        response = self.rpc(
            "SendMessage", {"message": self.message("routed"), "metadata": metadata}
        )
        task = response["result"]
        self.assertEqual(task["status"]["state"], "TASK_STATE_COMPLETED")
        self.assertEqual(task["metadata"], metadata)
        self.assertEqual(self.submit_calls[-1][0], "routed")
        self.assertEqual(self.submit_calls[-1][2], metadata)

    def test_send_message_failure_sets_failed(self):
        self.submit_result = {"ok": False, "error": "extension not connected"}
        response = self.rpc("SendMessage", {"message": self.message()})
        task = response["result"]
        self.assertEqual(task["status"]["state"], "TASK_STATE_FAILED")
        self.assertIn("extension not connected", task["status"]["message"]["parts"][0]["text"])

    def test_return_immediately_returns_working_task(self):
        self.submit_delay = 0.3
        response = self.rpc(
            "SendMessage",
            {"message": self.message(), "configuration": {"returnImmediately": True}},
        )
        task = response["result"]
        self.assertNotEqual(task["status"]["state"], "TASK_STATE_COMPLETED")
        task_id = task["id"]

        deadline = time.time() + 10
        state = ""
        while time.time() < deadline:
            polled = self.rpc("GetTask", {"id": task_id})["result"]
            state = polled["status"]["state"]
            if state in ("TASK_STATE_COMPLETED", "TASK_STATE_FAILED"):
                break
            time.sleep(0.05)
        self.assertEqual(state, "TASK_STATE_COMPLETED")

    def test_get_task_unknown_id(self):
        response = self.rpc("GetTask", {"id": "does-not-exist"})
        self.assertEqual(response["error"]["code"], -32001)

    def test_get_task_history_length_zero(self):
        task = self.rpc("SendMessage", {"message": self.message()})["result"]
        response = self.rpc("GetTask", {"id": task["id"], "historyLength": 0})
        self.assertEqual(response["result"]["history"], [])

    def test_non_ascii_auth_header_is_unauthorized(self):
        # A latin-1 header that compares equal to no str token must 401, not 500.
        request = self._request("SendMessage", {"message": self.message()}, token="caf\u00e9")
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(request, timeout=10)
        self.assertEqual(caught.exception.code, 401)

    def test_missing_jsonrpc_envelope_is_invalid_request(self):
        payload = {"id": 1, "method": "SendMessage", "params": {"message": self.message()}}
        request = urllib.request.Request(
            self.base + "/", data=json.dumps(payload).encode("utf-8"), method="POST"
        )
        request.add_header("Authorization", "Bearer " + self.token)
        with urllib.request.urlopen(request, timeout=10) as response:
            body = json.loads(response.read().decode("utf-8"))
        self.assertEqual(body["error"]["code"], -32600)

    def test_unhashable_method_is_invalid_request(self):
        payload = {"jsonrpc": "2.0", "id": 1, "method": ["SendMessage"], "params": {}}
        request = urllib.request.Request(
            self.base + "/", data=json.dumps(payload).encode("utf-8"), method="POST"
        )
        request.add_header("Authorization", "Bearer " + self.token)
        with urllib.request.urlopen(request, timeout=10) as response:
            body = json.loads(response.read().decode("utf-8"))
        self.assertEqual(body["error"]["code"], -32600)

    def test_malformed_content_length_is_invalid_request(self):
        import http.client

        conn = http.client.HTTPConnection("127.0.0.1", self.server.port, timeout=10)
        conn.putrequest("POST", "/")
        conn.putheader("Authorization", "Bearer " + self.token)
        conn.putheader("Content-Length", "abc")
        conn.endheaders()
        response = conn.getresponse()
        body = json.loads(response.read().decode("utf-8"))
        conn.close()
        self.assertEqual(response.status, 200)
        self.assertEqual(body["error"]["code"], -32600)

    def test_stream_emits_task_then_artifact_then_status(self):
        request = self._request(
            "SendStreamingMessage", {"message": self.message("streamed")}, token=self.token
        )
        with urllib.request.urlopen(request, timeout=10) as response:
            self.assertEqual(response.headers.get_content_type(), "text/event-stream")
            body = response.read().decode("utf-8")
        payloads = [
            json.loads(line[len("data: ") :])
            for line in body.splitlines()
            if line.startswith("data: ")
        ]
        self.assertEqual(len(payloads), 3)
        self.assertEqual(
            payloads[0]["task"]["status"]["state"], "TASK_STATE_WORKING"
        )
        self.assertEqual(
            payloads[1]["artifactUpdate"]["artifact"]["parts"][0]["text"], "the reply"
        )
        self.assertEqual(payloads[1]["artifactUpdate"]["index"], 0)
        self.assertEqual(
            payloads[2]["statusUpdate"]["status"]["state"], "TASK_STATE_COMPLETED"
        )

    def test_cancel_marks_task_and_late_reply_does_not_resurrect_it(self):
        self.submit_delay = 0.4
        task = self.rpc(
            "SendMessage",
            {"message": self.message(), "configuration": {"returnImmediately": True}},
        )["result"]
        task_id = task["id"]
        canceled = self.rpc("tasks/cancel", {"id": task_id})["result"]
        self.assertEqual(canceled["status"]["state"], "TASK_STATE_CANCELED")
        # Wait past the worker's late result; state must stay canceled.
        time.sleep(0.6)
        polled = self.rpc("GetTask", {"id": task_id})["result"]
        self.assertEqual(polled["status"]["state"], "TASK_STATE_CANCELED")

    def test_cancel_unknown_task_is_not_found(self):
        response = self.rpc("tasks/cancel", {"id": "nope"})
        self.assertEqual(response["error"]["code"], -32001)

    def test_cancel_completed_task_is_rejected(self):
        task = self.rpc("SendMessage", {"message": self.message()})["result"]
        response = self.rpc("CancelTask", {"id": task["id"]})
        self.assertEqual(response["error"]["code"], -32002)

    def test_default_timeout_exceeds_seven_minutes(self):
        self.assertGreaterEqual(a2a_server.DEFAULT_TIMEOUT_MS, 420_000)

    def test_per_task_timeout_override_is_forwarded(self):
        self.rpc(
            "SendMessage",
            {"message": self.message(), "metadata": {"timeoutMs": 900_000}},
        )
        self.assertEqual(self.submit_calls[-1][1], 900.0)

    def test_orchestrate_fans_out_and_returns_first_success(self):
        def submit(text, timeout, metadata=None):
            self.submit_calls.append((text, timeout, metadata))
            provider = (metadata or {}).get("provider")
            if provider == "grok":
                return {"ok": False, "error": "quota exhausted"}
            return {"ok": True, "text": f"reply from {provider}"}

        self.server.submit = submit
        response = self.rpc(
            "tasks/orchestrate",
            {"message": self.message(), "providers": ["grok", "gemini", "deepseek"]},
        )
        task = response["result"]
        self.assertEqual(task["status"]["state"], "TASK_STATE_COMPLETED")
        self.assertIn("reply from", task["artifacts"][0]["parts"][0]["text"])
        called = {call[2].get("provider") for call in self.submit_calls}
        self.assertTrue({"grok", "gemini", "deepseek"}.issubset(called))
        self.assertEqual(task["metadata"]["orchestratedProviders"], ["grok", "gemini", "deepseek"])

    def test_orchestrate_all_fail_reports_detail(self):
        self.server.submit = lambda text, timeout, metadata=None: {"ok": False, "error": "offline"}
        task = self.rpc(
            "tasks/orchestrate",
            {"message": self.message(), "providers": ["gemini", "deepseek"]},
        )["result"]
        self.assertEqual(task["status"]["state"], "TASK_STATE_FAILED")
        self.assertIn("offline", task["status"]["message"]["parts"][0]["text"])

    def test_working_task_exposes_liveness_progress(self):
        self.submit_delay = 0.2
        task = self.rpc(
            "SendMessage",
            {"message": self.message(), "configuration": {"returnImmediately": True}},
        )["result"]
        self.assertIn("progress", task["status"])
        self.assertIn("elapsedSeconds", task["status"]["progress"])

    def test_submit_slot_queues_briefly_then_succeeds_and_fails_on_timeout(self):
        srv = a2a_server.A2AServer(
            lambda prompt, timeout, metadata: {"ok": True, "text": f"ok:{prompt}"},
            port=0,
            token=self.token,
            base_url="http://127.0.0.1:0",
            slot_wait_seconds=0.4,
        )
        for _ in range(a2a_server.MAX_CONCURRENT_SUBMITS):
            srv._submit_slots.acquire()
        released = False

        def release_one():
            nonlocal released
            time.sleep(0.12)
            released = True
            srv._submit_slots.release()

        t = threading.Thread(target=release_one, daemon=True)
        t.start()
        res = srv._call_submit("queued", metadata={})
        t.join(timeout=2)
        self.assertTrue(released)
        self.assertEqual(res, {"ok": True, "text": "ok:queued"})

        # Exhaust slots longer than slot_wait_seconds -> explicit concurrency rejection
        srv.slot_wait_seconds = 0.05
        # The one slot released above was re-acquired and released by _call_submit, so acquire it back:
        srv._submit_slots.acquire()
        try:
            fail_res = srv._call_submit("starved", metadata={})
            self.assertFalse(fail_res["ok"])
            self.assertIn("Too many concurrent", fail_res["error"])
        finally:
            for _ in range(a2a_server.MAX_CONCURRENT_SUBMITS):
                srv._submit_slots.release()


class TaskStoreTests(unittest.TestCase):
    def test_full_store_refuses_live_work_instead_of_evicting_it(self):
        original = a2a_server.MAX_TASKS
        a2a_server.MAX_TASKS = 1
        try:
            store = a2a_server.TaskStore()
            live = {"id": "live", "status": {"state": "TASK_STATE_WORKING"}}
            self.assertTrue(store.add(live))
            incoming = {"id": "new", "status": {"state": "TASK_STATE_WORKING"}}
            self.assertFalse(store.add(incoming))
            self.assertIsNone(store.get("new"))
            self.assertIsNotNone(store.get("live"))
        finally:
            a2a_server.MAX_TASKS = original


if __name__ == "__main__":
    unittest.main()
