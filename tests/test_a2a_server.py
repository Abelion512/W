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

    def test_forged_host_header_rejected_403(self):
        import http.client
        conn = http.client.HTTPConnection("127.0.0.1", self.server.port, timeout=5)
        try:
            conn.request("GET", "/.well-known/agent-card.json", headers={"Host": "evil.example"})
            resp = conn.getresponse()
            resp.read()
            self.assertEqual(resp.status, 403)
        finally:
            conn.close()

    def test_nosniff_header_present(self):
        with urllib.request.urlopen(f"{self.server.base_url}/.well-known/agent-card.json", timeout=5) as resp:
            self.assertEqual(resp.headers.get("X-Content-Type-Options"), "nosniff")

    def test_rate_limit_returns_429(self):
        import http.client
        srv = a2a_server.A2AServer(lambda p, t, m: {"ok": True, "text": "ok"}, port=0, token="tok", rate_limit=2)
        srv.start()
        try:
            for expected in (200, 200, 429):
                conn = http.client.HTTPConnection("127.0.0.1", srv.port, timeout=5)
                try:
                    conn.request("GET", "/.well-known/agent-card.json", headers={"Host": f"127.0.0.1:{srv.port}"})
                    resp = conn.getresponse()
                    resp.read()
                    self.assertEqual(resp.status, expected)
                finally:
                    conn.close()
        finally:
            srv.stop()

    def test_rate_limit_burst_post_returns_429_without_new_task_or_thread(self):
        import http.client
        import threading
        from unittest.mock import patch

        calls = []
        srv = a2a_server.A2AServer(
            lambda p, t, m: (calls.append(p), {"ok": True, "text": "ok"})[1],
            port=0,
            token="tok",
            rate_limit=3,
        )
        srv.start()
        worker_threads = 0
        real_thread = threading.Thread

        def counting_thread(*args, **kwargs):
            nonlocal worker_threads
            if kwargs.get("target") == srv._run_submit:
                worker_threads += 1
            return real_thread(*args, **kwargs)

        payload = json.dumps({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "SendMessage",
            "params": {
                "message": self.message("burst"),
                "configuration": {"returnImmediately": True},
            },
        }).encode("utf-8")
        headers = {
            "Host": f"127.0.0.1:{srv.port}",
            "Authorization": "Bearer tok",
            "Content-Type": "application/json",
        }
        try:
            with patch.object(a2a_server.threading, "Thread", side_effect=counting_thread):
                statuses = []
                retry_afters = []
                for _ in range(6):
                    conn = http.client.HTTPConnection("127.0.0.1", srv.port, timeout=5)
                    try:
                        conn.request("POST", "/", body=payload, headers=headers)
                        resp = conn.getresponse()
                        resp.read()
                        statuses.append(resp.status)
                        if resp.status == 429:
                            retry_afters.append(resp.getheader("Retry-After"))
                    finally:
                        conn.close()
            self.assertEqual(statuses, [200, 200, 200, 429, 429, 429])
            self.assertEqual(len(retry_afters), 3)
            self.assertTrue(all(val and int(val) > 0 for val in retry_afters))
            self.assertEqual(worker_threads, 3)
            self.assertEqual(len(srv.store._tasks), 3)
        finally:
            srv.stop()

    def test_rate_limit_burst_sse_returns_429_without_streaming(self):
        import http.client

        calls = []
        srv = a2a_server.A2AServer(
            lambda p, t, m: (calls.append(p), {"ok": True, "text": "ok"})[1],
            port=0,
            token="tok",
            rate_limit=2,
        )
        srv.start()
        payload = json.dumps({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "SendStreamingMessage",
            "params": {"message": self.message("stream-burst")},
        }).encode("utf-8")
        headers = {
            "Host": f"127.0.0.1:{srv.port}",
            "Authorization": "Bearer tok",
            "Content-Type": "application/json",
        }
        try:
            results = []
            for _ in range(4):
                conn = http.client.HTTPConnection("127.0.0.1", srv.port, timeout=5)
                try:
                    conn.request("POST", "/", body=payload, headers=headers)
                    resp = conn.getresponse()
                    resp.read()
                    results.append((resp.status, resp.getheader("Content-Type")))
                finally:
                    conn.close()
            self.assertEqual([s for s, _ in results], [200, 200, 429, 429])
            self.assertEqual(results[0][1], "text/event-stream")
            self.assertEqual(results[2][1], "application/json")
            self.assertEqual(len(calls), 2)
            self.assertEqual(len(srv.store._tasks), 2)
        finally:
            srv.stop()

    def test_rate_limit_recovers_after_window(self):
        from unittest.mock import patch

        srv = a2a_server.A2AServer(
            lambda p, t, m: {"ok": True, "text": "ok"},
            port=0,
            token="tok",
            rate_limit=2,
        )
        now = [100.0]
        with patch.object(a2a_server.time, "monotonic", side_effect=lambda: now[0]):
            self.assertTrue(srv.allow_request("127.0.0.1"))
            self.assertTrue(srv.allow_request("127.0.0.1"))
            self.assertFalse(srv.allow_request("127.0.0.1"))
            now[0] += a2a_server.RATE_WINDOW_SECONDS + 1.0
            self.assertTrue(srv.allow_request("127.0.0.1"))

    def test_stream_emits_partial_chunks_with_append_and_last_chunk_false(self):
        seen = []

        def streaming_submit(prompt, timeout, metadata=None):
            task_id = self.server.current_task_id()
            seen.append((task_id, dict(metadata or {})))
            self.server.emit_chunk(task_id, "hel")
            self.server.emit_chunk(task_id, "lo")
            return {"ok": True, "text": "hello"}

        self.server.submit = streaming_submit
        request = self._request(
            "SendStreamingMessage",
            {"message": self.message("stream chunks"), "metadata": {"provider": "gemini"}},
            token=self.token,
        )
        with urllib.request.urlopen(request, timeout=10) as response:
            self.assertEqual(response.headers.get_content_type(), "text/event-stream")
            body = response.read().decode("utf-8")
        payloads = [
            json.loads(line[len("data: ") :])
            for line in body.splitlines()
            if line.startswith("data: ")
        ]
        self.assertEqual(len(payloads), 5)
        self.assertEqual(payloads[0]["task"]["status"]["state"], "TASK_STATE_WORKING")
        chunk1 = payloads[1]["artifactUpdate"]
        chunk2 = payloads[2]["artifactUpdate"]
        self.assertEqual(chunk1["artifact"]["parts"][0]["text"], "hel")
        self.assertTrue(chunk1["append"])
        self.assertFalse(chunk1["lastChunk"])
        self.assertEqual(chunk1["index"], 0)
        self.assertEqual(chunk2["artifact"]["parts"][0]["text"], "lo")
        self.assertTrue(chunk2["append"])
        self.assertFalse(chunk2["lastChunk"])
        self.assertEqual(chunk2["artifact"]["artifactId"], chunk1["artifact"]["artifactId"])
        self.assertEqual(payloads[3]["artifactUpdate"]["artifact"]["parts"][0]["text"], "hello")
        self.assertEqual(payloads[4]["statusUpdate"]["status"]["state"], "TASK_STATE_COMPLETED")
        self.assertEqual(len(seen), 1)
        self.assertEqual(seen[0][0], payloads[0]["task"]["id"])
        self.assertEqual(seen[0][1], {"provider": "gemini"})
        self.assertIsNone(self.server.current_task_id())

    def test_cancel_invokes_on_cancel_callback_and_preserves_metadata(self):
        started = threading.Event()
        release = threading.Event()
        canceled_ids = []
        observed = []

        def blocking_submit(prompt, timeout, metadata=None):
            observed.append((srv.current_task_id(), dict(metadata or {})))
            started.set()
            release.wait(timeout=5)
            return {"ok": False, "error": "canceled"}

        srv = a2a_server.A2AServer(
            blocking_submit,
            port=0,
            token="tok",
            on_cancel=lambda tid: (canceled_ids.append(tid), release.set()),
        )
        srv.start()
        try:
            def _rpc(method, params):
                payload = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
                req = urllib.request.Request(
                    f"http://127.0.0.1:{srv.port}/",
                    data=json.dumps(payload).encode("utf-8"),
                    headers={"Content-Type": "application/json", "Authorization": "Bearer tok"},
                    method="POST",
                )
                with urllib.request.urlopen(req, timeout=10) as resp:
                    return json.loads(resp.read().decode("utf-8"))

            task = _rpc(
                "SendMessage",
                {
                    "message": self.message("cancel me"),
                    "metadata": {"provider": "deepseek"},
                    "configuration": {"returnImmediately": True},
                },
            )["result"]
            self.assertTrue(started.wait(timeout=5))
            canceled = _rpc("tasks/cancel", {"id": task["id"]})["result"]
            self.assertEqual(canceled["status"]["state"], "TASK_STATE_CANCELED")
            self.assertEqual(canceled_ids, [task["id"]])
            self.assertEqual(observed, [(task["id"], {"provider": "deepseek"})])
            self.assertEqual(canceled["metadata"], {"provider": "deepseek"})
            self.assertIsNone(srv.current_task_id())
        finally:
            release.set()
            srv.stop()


if __name__ == "__main__":
    unittest.main()
