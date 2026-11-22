#!/usr/bin/env python3
"""A2A 1.0 HTTP facade over the Snapgent browser bridge.

The server never touches the browser. It calls an injected ``submit(prompt,
timeout, metadata)`` callable that blocks until the bridge reports the reply.
The A2A request's ``metadata`` is passed through unchanged so the bridge and
extension can route the task (for example, model tier by task category). See
``docs/a2a-design.md`` for the architecture.

stdlib only.
"""

import collections
import concurrent.futures
import copy
import json
import secrets
import threading
import time
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Deque, Dict, Optional
from urllib.parse import urlsplit

import bridge_auth

A2A_VERSION = "1.0"
DEFAULT_PORT = 17614
# A web model can stay productive well past seven minutes. The old 600s cap
# killed live tasks with no way for a caller to tell "still working" from
# "stuck", so default to 30 min and let a caller override per task.
DEFAULT_TIMEOUT_MS = 1_800_000
MAX_TIMEOUT_MS = 3_600_000
MAX_BODY_BYTES = 2 * 1024 * 1024
MAX_TASKS = 200
MAX_CONCURRENT_SUBMITS = 8
MAX_REQUESTS_PER_MINUTE = 120
RATE_WINDOW_SECONDS = 60.0
SOCKET_READ_TIMEOUT = 30.0

CARD_PATHS = ("/.well-known/agent-card.json", "/.well-known/agent.json")

_METHOD_ALIASES = {
    "SendMessage": "SendMessage",
    "message/send": "SendMessage",
    "SendStreamingMessage": "SendStreamingMessage",
    "message/stream": "SendStreamingMessage",
    "GetTask": "GetTask",
    "tasks/get": "GetTask",
    "CancelTask": "CancelTask",
    "tasks/cancel": "CancelTask",
    "Orchestrate": "Orchestrate",
    "tasks/orchestrate": "Orchestrate",
}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def agent_card(base_url: str) -> Dict[str, Any]:
    """Return the A2A 1.0 Agent Card, plus the legacy top-level fields."""
    return {
        "name": "Snapgent Web Chat",
        "description": (
            "Delegates a prompt to a free web AI chat tab driven by the "
            "Snapgent browser extension."
        ),
        "version": "1.0.0",
        "supportedInterfaces": [
            {"url": base_url, "protocolBinding": "JSONRPC", "protocolVersion": "1.0"}
        ],
        "capabilities": {"streaming": True, "pushNotifications": False},
        "securitySchemes": {"bearer": {"type": "http", "scheme": "bearer"}},
        "securityRequirements": [{"bearer": []}],
        "defaultInputModes": ["text/plain"],
        "defaultOutputModes": ["text/plain"],
        "skills": [
            {
                "id": "web-chat-delegation",
                "name": "Delegate a prompt to a web AI chat",
                "description": (
                    "Send a prompt to a signed-in web AI chat tab and return its "
                    "reply. The model may read files through its Snapgent MCP "
                    "tools while it works."
                ),
                "tags": ["web-chat", "browser", "delegation"],
                "examples": ["Summarize docs/a2a-design.md"],
            }
        ],
        "url": base_url,
        "protocolVersion": "1.0",
        "preferredTransport": "JSONRPC",
    }


def _concat_text(message: Any) -> Optional[str]:
    """Prompt text = concatenation of every Part with a string ``text`` member."""
    if not isinstance(message, dict):
        return None
    parts = message.get("parts")
    if not isinstance(parts, list):
        return None
    texts = [
        part["text"]
        for part in parts
        if isinstance(part, dict) and isinstance(part.get("text"), str)
    ]
    if not texts:
        return None
    return "".join(texts)


class TaskStore:
    """Thread-safe task store: id -> task dict."""

    def __init__(self) -> None:
        self._tasks: Dict[str, Dict[str, Any]] = {}
        self._lock = threading.Lock()

    def add(self, task: Dict[str, Any]) -> None:
        with self._lock:
            self._tasks[task["id"]] = task
            # ponytail: cap the store; add TTL eviction if tasks ever outlive a session.
            while len(self._tasks) > MAX_TASKS:
                # Never evict a task whose submit is still waiting for its
                # reply: the caller would poll a vanished id and hang out the
                # full timeout. Evict finished tasks first; if none exist the
                # cap is exceeded momentarily rather than dropping live work.
                def _pending(task_value: Dict[str, Any]) -> bool:
                    state = (task_value.get("status") or {}).get("state")
                    return state in ("TASK_STATE_SUBMITTED", "TASK_STATE_WORKING")

                finished = [task_id for task_id, task_value in self._tasks.items() if not _pending(task_value)]
                if not finished:
                    # All tasks are live: drop the oldest rather than grow
                    # without bound. A poller gets "Task not found" instead of
                    # waiting out a full 30-minute timeout on a vanished id.
                    oldest = next(iter(self._tasks))
                    self._tasks.pop(oldest, None)
                    continue
                oldest_finished = next(
                    task_id for task_id in self._tasks if task_id in finished
                )
                self._tasks.pop(oldest_finished)

    def get(self, task_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            task = self._tasks.get(task_id)
            return copy.deepcopy(task) if task is not None else None

    def update(self, task_id: str, **fields: Any) -> Optional[Dict[str, Any]]:
        with self._lock:
            task = self._tasks.get(task_id)
            if task is None:
                return None
            task.update(fields)
            return copy.deepcopy(task)

    def cancel(self, task_id: str) -> Optional[Dict[str, Any]]:
        """Flip a live task to CANCELED. Terminal tasks cannot be canceled."""
        with self._lock:
            task = self._tasks.get(task_id)
            if task is None:
                return None
            state = (task.get("status") or {}).get("state")
            if state not in ("TASK_STATE_SUBMITTED", "TASK_STATE_WORKING"):
                return None
            reply = {
                "messageId": f"msg-{uuid.uuid4().hex}",
                "role": "ROLE_AGENT",
                "parts": [{"text": "Task canceled by the caller."}],
                "taskId": task_id,
                "contextId": task.get("contextId", ""),
            }
            task["status"] = {
                "state": "TASK_STATE_CANCELED",
                "timestamp": _now_iso(),
                "message": reply,
            }
            task["history"] = list(task.get("history", [])) + [reply]
            return copy.deepcopy(task)


class A2AServer:
    """ThreadingHTTPServer wrapping a blocking ``submit`` callable."""

    def __init__(
        self,
        submit: Callable[[str, float, Dict[str, Any]], Dict[str, Any]],
        host: str = "127.0.0.1",
        port: int = DEFAULT_PORT,
        token: str = "",
        base_url: str = "",
        timeout_ms: int = DEFAULT_TIMEOUT_MS,
        rate_limit: int = MAX_REQUESTS_PER_MINUTE,
        on_cancel: Optional[Callable[[str], None]] = None,
    ) -> None:
        self.submit = submit
        self.host = host
        self.port = port
        self.token = token
        self.base_url = base_url
        self.timeout_ms = timeout_ms
        self.on_cancel = on_cancel
        self.store = TaskStore()
        self._cancel_events: Dict[str, threading.Event] = {}
        self._chunk_sinks: Dict[str, Callable[[str], None]] = {}
        self._cancel_lock = threading.Lock()
        self._task_local = threading.local()
        self._submit_slots = threading.BoundedSemaphore(MAX_CONCURRENT_SUBMITS)
        self._rate_limit = rate_limit
        self._rate_lock = threading.Lock()
        self._rate_hits: Dict[str, Deque[float]] = {}
        self._httpd: Optional[ThreadingHTTPServer] = None
        self._thread: Optional[threading.Thread] = None

    # -- lifecycle -------------------------------------------------------

    def start(self) -> None:
        self._httpd = ThreadingHTTPServer((self.host, self.port), _Handler)
        self._httpd.daemon_threads = True
        self._httpd.a2a = self  # type: ignore[attr-defined]
        self.port = self._httpd.server_address[1]
        if not self.base_url or self.base_url.endswith(":0"):
            self.base_url = f"http://{self.host}:{self.port}"
        self._thread = threading.Thread(target=self._httpd.serve_forever, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        if self._httpd is not None:
            self._httpd.shutdown()
            self._httpd.server_close()
            self._httpd = None
        if self._thread is not None:
            self._thread.join(timeout=5)
            self._thread = None

    # -- HTTP surface ----------------------------------------------------

    def card(self) -> Dict[str, Any]:
        return agent_card(self.base_url)

    def authorized(self, header: Optional[str]) -> bool:
        if not self.token or not isinstance(header, str):
            return False
        # Bytes: a non-ASCII Authorization header must be rejected, not raise.
        return secrets.compare_digest(
            header.encode("utf-8"), f"Bearer {self.token}".encode("utf-8")
        )

    @staticmethod
    def host_ok(host_header: Optional[str]) -> bool:
        return bridge_auth.host_allowed(host_header)

    def allow_request(self, client_ip: str) -> bool:
        if self._rate_limit <= 0:
            return True
        now = time.monotonic()
        cutoff = now - RATE_WINDOW_SECONDS
        with self._rate_lock:
            hits = self._rate_hits.get(client_ip)
            if hits is None:
                hits = collections.deque()
                self._rate_hits[client_ip] = hits
            while hits and hits[0] <= cutoff:
                hits.popleft()
            if len(hits) >= self._rate_limit:
                return False
            hits.append(now)
            return True

    # -- JSON-RPC --------------------------------------------------------

    @staticmethod
    def error(rpc_id: Any, code: int, message: str, data: Any = None) -> Dict[str, Any]:
        error: Dict[str, Any] = {"code": code, "message": message}
        if data is not None:
            error["data"] = data
        return {"jsonrpc": "2.0", "id": rpc_id, "error": error}

    @staticmethod
    def _result(rpc_id: Any, result: Any) -> Dict[str, Any]:
        return {"jsonrpc": "2.0", "id": rpc_id, "result": result}

    def dispatch(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        rpc_id = payload.get("id")
        method = payload.get("method")
        if payload.get("jsonrpc") != "2.0" or not isinstance(method, str):
            return self.error(rpc_id, -32600, "Invalid Request")
        name = _METHOD_ALIASES.get(method)
        if name == "SendMessage":
            return self._send_message(payload)
        if name == "GetTask":
            return self._get_task(payload)
        if name == "CancelTask":
            return self._cancel_task(payload)
        if name == "Orchestrate":
            return self._orchestrate(payload)
        return self.error(rpc_id, -32601, "Method not found")

    def _send_message(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        rpc_id = payload.get("id")
        params = payload.get("params")
        params = params if isinstance(params, dict) else {}
        message = params.get("message")
        text = _concat_text(message)
        if text is None:
            return self.error(rpc_id, -32602, "Message must contain a text part.")

        configuration = params.get("configuration")
        configuration = configuration if isinstance(configuration, dict) else {}
        history_length = configuration.get("historyLength")

        task = self._new_task(message, params)
        self._track_task(task["id"])
        self.store.add(task)
        if configuration.get("returnImmediately"):
            # Snapshot before the worker can flip the task to WORKING/COMPLETED.
            view = self._view(self.store.get(task["id"]), history_length)
            threading.Thread(
                target=self._run_submit,
                args=(task["id"], text, task.get("metadata")),
                daemon=True,
            ).start()
            return self._result(rpc_id, view)

        self.store.update(
            task["id"], status={"state": "TASK_STATE_WORKING", "timestamp": _now_iso()}
        )
        self._run_submit(task["id"], text, task.get("metadata"))
        return self._result(rpc_id, self._view(self.store.get(task["id"]), history_length))

    def _get_task(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        rpc_id = payload.get("id")
        params = payload.get("params")
        params = params if isinstance(params, dict) else {}
        task_id = params.get("id")
        task = self.store.get(task_id) if isinstance(task_id, str) else None
        if task is None:
            return self.error(rpc_id, -32001, "Task not found")
        return self._result(rpc_id, self._view(task, params.get("historyLength")))

    def _cancel_task(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        rpc_id = payload.get("id")
        params = payload.get("params")
        params = params if isinstance(params, dict) else {}
        task_id = params.get("id")
        canceled = self.store.cancel(task_id) if isinstance(task_id, str) else None
        if canceled is None:
            task = self.store.get(task_id) if isinstance(task_id, str) else None
            code = -32001 if task is None else -32002
            message = "Task not found" if task is None else "Task cannot be canceled in its current state"
            return self.error(rpc_id, code, message)
        with self._cancel_lock:
            event = self._cancel_events.get(task_id)
        if event is not None:
            event.set()
        if self.on_cancel is not None:
            try:
                self.on_cancel(task_id)
            except Exception:  # noqa: BLE001 - cancel RPC already succeeded
                pass
        # Keep the event until the in-flight submit observes the cancellation.
        return self._result(rpc_id, self._view(canceled, None))

    def _forget_cancel(self, task_id: str) -> None:
        with self._cancel_lock:
            self._cancel_events.pop(task_id, None)

    def _track_task(self, task_id: str) -> threading.Event:
        with self._cancel_lock:
            return self._cancel_events.setdefault(task_id, threading.Event())

    def _is_canceled(self, task_id: str) -> bool:
        with self._cancel_lock:
            event = self._cancel_events.get(task_id)
        return bool(event is not None and event.is_set())

    # -- orchestration ---------------------------------------------------

    def _orchestrate(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """Run one prompt on several pinned providers; first success wins.

        This is the high-level ``a2a_orchestrate`` primitive. It relies on the
        bridge's per-provider fan-out: calls pinned to different providers run
        in parallel in their own chat tabs, so a slow or limited provider does
        not hold back the others.
        """
        rpc_id = payload.get("id")
        params = payload.get("params")
        params = params if isinstance(params, dict) else {}
        message = params.get("message")
        text = _concat_text(message)
        if text is None:
            return self.error(rpc_id, -32602, "Message must contain a text part.")
        providers = params.get("providers")
        if not isinstance(providers, list) or not providers:
            providers = ["gemini", "deepseek", "chatgpt"]
        providers = list(dict.fromkeys(str(p) for p in providers if isinstance(p, str)))[:8]
        if not providers:
            return self.error(rpc_id, -32602, "providers must name at least one provider.")
        configuration = params.get("configuration")
        configuration = configuration if isinstance(configuration, dict) else {}
        history_length = configuration.get("historyLength")

        task = self._new_task(message, params)
        self._track_task(task["id"])
        task["status"] = {"state": "TASK_STATE_WORKING", "timestamp": _now_iso()}
        task["metadata"]["orchestratedProviders"] = providers
        self.store.add(task)
        if configuration.get("returnImmediately"):
            view = self._view(self.store.get(task["id"]), history_length)
            threading.Thread(
                target=self._run_orchestrate,
                args=(task["id"], text, providers, task.get("metadata")),
                daemon=True,
            ).start()
            return self._result(rpc_id, view)
        self._run_orchestrate(task["id"], text, providers, task.get("metadata"))
        return self._result(rpc_id, self._view(self.store.get(task["id"]), history_length))

    def _run_orchestrate(
        self,
        task_id: str,
        text: str,
        providers: list,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> None:
        winner: Optional[Dict[str, Any]] = None
        errors: list = []
        deadline = self.timeout_ms / 1000.0 + 60
        try:
            with concurrent.futures.ThreadPoolExecutor(max_workers=len(providers)) as pool:
                futures = {
                    pool.submit(
                        self._call_submit,
                        text,
                        {**(metadata or {}), "provider": provider},
                    ): provider
                    for provider in providers
                }
                for future in concurrent.futures.as_completed(futures, timeout=deadline):
                    result = future.result()
                    if result.get("ok") and winner is None:
                        winner = result
                        break
                    if not result.get("ok"):
                        errors.append(str(result.get("error") or "The web AI failed."))
        except concurrent.futures.TimeoutError:
            errors.append("Orchestration timed out waiting for a provider.")
        if self._is_canceled(task_id):
            self._forget_cancel(task_id)
            return
        if winner is not None:
            self._complete(task_id, str(winner.get("text") or ""))
        else:
            detail = "; ".join(errors[:3]) or "every provider failed"
            self._fail(task_id, f"a2a_orchestrate: {detail}")

    # -- streaming -------------------------------------------------------

    def stream(self, handler: "_Handler", payload: Dict[str, Any]) -> None:
        rpc_id = payload.get("id")
        params = payload.get("params")
        params = params if isinstance(params, dict) else {}
        message = params.get("message")
        text = _concat_text(message)
        if text is None:
            handler.send_json(self.error(rpc_id, -32602, "Message must contain a text part."))
            return

        task = self._new_task(message, params)
        self._track_task(task["id"])
        task["status"] = {"state": "TASK_STATE_WORKING", "timestamp": _now_iso()}
        self.store.add(task)

        handler.start_sse()
        handler.send_sse({"task": self._view(task, None)})
        stream_artifact_id = f"artifact-{uuid.uuid4().hex}"
        sse_lock = threading.Lock()

        def _send_chunk(chunk_text: str) -> None:
            with sse_lock:
                handler.send_sse(
                    {
                        "artifactUpdate": {
                            "taskId": task["id"],
                            "contextId": task["contextId"],
                            "artifact": {
                                "artifactId": stream_artifact_id,
                                "name": "reply",
                                "parts": [{"text": chunk_text}],
                            },
                            "append": True,
                            "lastChunk": False,
                            "index": 0,
                        }
                    }
                )

        with self._cancel_lock:
            self._chunk_sinks[task["id"]] = _send_chunk
        try:
            result = self._call_submit(text, task.get("metadata"), task_id=task["id"])
        finally:
            with self._cancel_lock:
                self._chunk_sinks.pop(task["id"], None)
        if self._is_canceled(task["id"]):
            self._forget_cancel(task["id"])
            return  # client canceled; store already holds the canceled state
        if result.get("ok"):
            text_out = str(result.get("text") or "")
            artifact = self._artifact(text_out)
            completed = self._complete(task["id"], text_out, artifact=artifact)
            with sse_lock:
                handler.send_sse(
                    {
                        "artifactUpdate": {
                            "taskId": task["id"],
                            "contextId": task["contextId"],
                            "artifact": artifact,
                            "index": 0,
                        }
                    }
                )
                handler.send_sse(
                    {
                        "statusUpdate": {
                            "taskId": task["id"],
                            "contextId": task["contextId"],
                            "status": completed["status"],
                        }
                    }
                )
        else:
            failed = self._fail(
                task["id"], str(result.get("error") or "The web AI failed.")
            )
            with sse_lock:
                handler.send_sse(
                    {
                        "statusUpdate": {
                            "taskId": task["id"],
                            "contextId": task["contextId"],
                            "status": failed["status"],
                        }
                    }
                )

    # -- task helpers ----------------------------------------------------

    def _new_task(self, message: Any, params: Dict[str, Any]) -> Dict[str, Any]:
        context_id = f"ctx-{uuid.uuid4().hex}"
        if isinstance(message, dict) and isinstance(message.get("contextId"), str):
            context_id = message["contextId"] or context_id
        metadata = params.get("metadata")
        if not isinstance(metadata, dict):
            metadata = {}
        return {
            "id": f"task-{uuid.uuid4().hex}",
            "contextId": context_id,
            "submittedAt": _now_iso(),
            "status": {"state": "TASK_STATE_SUBMITTED", "timestamp": _now_iso()},
            "artifacts": [],
            "history": [message],
            "metadata": metadata,
        }

    @staticmethod
    def _artifact(text: str) -> Dict[str, Any]:
        return {
            "artifactId": f"artifact-{uuid.uuid4().hex}",
            "name": "reply",
            "parts": [{"text": text}],
        }

    @staticmethod
    def _agent_message(task: Dict[str, Any], text: str) -> Dict[str, Any]:
        return {
            "messageId": f"msg-{uuid.uuid4().hex}",
            "role": "ROLE_AGENT",
            "parts": [{"text": text}],
            "taskId": task.get("id", ""),
            "contextId": task.get("contextId", ""),
        }

    def current_task_id(self) -> Optional[str]:
        return getattr(self._task_local, "task_id", None)

    def _call_submit(
        self,
        text: str,
        metadata: Optional[Dict[str, Any]] = None,
        task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        timeout = self.timeout_ms / 1000.0
        requested = (metadata or {}).get("timeoutMs")
        if isinstance(requested, int) and not isinstance(requested, bool):
            if 1_000 <= requested <= MAX_TIMEOUT_MS:
                timeout = requested / 1000.0
        if not self._submit_slots.acquire(timeout=5):
            return {"ok": False, "error": "Too many concurrent A2A tasks; retry shortly."}
        prev_task_id = getattr(self._task_local, "task_id", None)
        self._task_local.task_id = task_id
        try:
            result = self.submit(text, timeout, metadata or {})
        except Exception as error:  # noqa: BLE001 - report any submit failure
            return {"ok": False, "error": str(error)}
        finally:
            self._task_local.task_id = prev_task_id
            self._submit_slots.release()
        if not isinstance(result, dict):
            return {"ok": False, "error": "submit returned an invalid result"}
        return result

    def emit_chunk(self, task_id: str, text: str) -> None:
        """Forward a partial text chunk to an active SSE stream for task_id."""
        if not text:
            return
        with self._cancel_lock:
            sink = self._chunk_sinks.get(task_id)
        if sink is not None:
            try:
                sink(text)
            except Exception:  # noqa: BLE001 - client may have disconnected
                pass

    def _run_submit(
        self, task_id: str, text: str, metadata: Optional[Dict[str, Any]] = None
    ) -> None:
        result = self._call_submit(text, metadata, task_id=task_id)
        if self._is_canceled(task_id):
            self._forget_cancel(task_id)
            return  # a late reply must not resurrect a canceled task
        if result.get("ok"):
            self._complete(task_id, str(result.get("text") or ""))
        else:
            self._fail(task_id, str(result.get("error") or "The web AI failed."))

    def _complete(
        self, task_id: str, text: str, artifact: Optional[Dict[str, Any]] = None
    ) -> Optional[Dict[str, Any]]:
        task = self.store.get(task_id) or {}
        reply = self._agent_message(task, text)
        status = {
            "state": "TASK_STATE_COMPLETED",
            "timestamp": _now_iso(),
            "message": reply,
        }
        history = list(task.get("history", [])) + [reply]
        self._forget_cancel(task_id)
        return self.store.update(
            task_id,
            status=status,
            artifacts=[artifact or self._artifact(text)],
            history=history,
        )

    def _fail(self, task_id: str, error: str) -> Optional[Dict[str, Any]]:
        task = self.store.get(task_id) or {}
        reply = self._agent_message(task, error)
        status = {"state": "TASK_STATE_FAILED", "timestamp": _now_iso(), "message": reply}
        history = list(task.get("history", [])) + [reply]
        self._forget_cancel(task_id)
        return self.store.update(task_id, status=status, history=history)

    @staticmethod
    def _view(task: Optional[Dict[str, Any]], history_length: Any) -> Optional[Dict[str, Any]]:
        if task is None:
            return None
        view = copy.deepcopy(task)
        # Liveness signal for long tasks: a poller can tell a still-working
        # model from a dead worker without waiting for a final artifact.
        state = (view.get("status") or {}).get("state")
        if state in ("TASK_STATE_SUBMITTED", "TASK_STATE_WORKING"):
            started = view.get("submittedAt")
            try:
                elapsed = max(0, int((datetime.now(timezone.utc) - datetime.fromisoformat(started)).total_seconds()))
                view["status"]["progress"] = {"elapsedSeconds": elapsed}
            except (TypeError, ValueError):
                pass
        # History semantics: the most recent messages, not the oldest.
        if (
            isinstance(history_length, int)
            and not isinstance(history_length, bool)
            and history_length >= 0
        ):
            # [-0:] is the whole list (negative zero), so 0 needs its own arm.
            history = view.get("history", [])
            view["history"] = [] if history_length == 0 else history[-history_length:]
        return view


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

    def setup(self) -> None:
        super().setup()
        self.connection.settimeout(SOCKET_READ_TIMEOUT)

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        pass

    # -- response writers -------------------------------------------------

    def send_json(
        self,
        payload: Dict[str, Any],
        status: int = 200,
        headers: Optional[Dict[str, str]] = None,
    ) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Length", str(len(body)))
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def start_sse(self) -> None:
        self.connection.settimeout(None)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()

    def send_sse(self, payload: Dict[str, Any]) -> None:
        line = f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
        self.wfile.write(line.encode("utf-8"))
        self.wfile.flush()

    # -- routing ----------------------------------------------------------

    def _guard_http(self, a2a: A2AServer) -> bool:
        if not a2a.host_ok(self.headers.get("Host")):
            self.send_json({"error": "forbidden host"}, status=403)
            return False
        client_ip = self.client_address[0] if self.client_address else ""
        if not a2a.allow_request(client_ip):
            self.send_json(
                {"error": "rate limit exceeded"},
                status=429,
                headers={"Retry-After": str(int(RATE_WINDOW_SECONDS))},
            )
            return False
        return True

    def do_GET(self) -> None:  # noqa: N802
        a2a: A2AServer = self.server.a2a  # type: ignore[attr-defined]
        if not self._guard_http(a2a):
            return
        path = urlsplit(self.path).path
        if path in CARD_PATHS:
            self.send_json(a2a.card())
        else:
            self.send_json({"error": "not found"}, status=404)

    def do_POST(self) -> None:  # noqa: N802
        a2a: A2AServer = self.server.a2a  # type: ignore[attr-defined]
        if not self._guard_http(a2a):
            return
        if urlsplit(self.path).path != "/":
            self.send_json({"error": "not found"}, status=404)
            return
        if not a2a.authorized(self.headers.get("Authorization")):
            self.send_json(
                {"error": "unauthorized"},
                status=401,
                headers={"WWW-Authenticate": "Bearer"},
            )
            return

        raw = self._read_body()
        if raw is None:
            self.send_json(a2a.error(None, -32600, "Invalid Request"))
            return
        try:
            payload = json.loads(raw.decode("utf-8")) if raw else None
        except ValueError:
            self.send_json(a2a.error(None, -32700, "Parse error"))
            return
        if (
            not isinstance(payload, dict)
            or payload.get("jsonrpc") != "2.0"
            or not isinstance(payload.get("method"), str)
        ):
            self.send_json(a2a.error(None, -32600, "Invalid Request"))
            return

        if _METHOD_ALIASES.get(payload["method"]) == "SendStreamingMessage":
            a2a.stream(self, payload)
            return
        self.send_json(a2a.dispatch(payload))

    def _read_body(self) -> Optional[bytes]:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except (TypeError, ValueError):
            return None
        if length < 0 or length > MAX_BODY_BYTES:
            return None
        return self.rfile.read(length) if length else b""


if __name__ == "__main__":  # pragma: no cover - manual smoke entry point
    import os

    _port = int(os.environ.get("ZS_A2A_PORT", str(DEFAULT_PORT)))
    _token = os.environ.get("ZS_A2A_TOKEN") or secrets.token_urlsafe(32)
    _base = f"http://127.0.0.1:{_port}"

    def _echo(prompt: str, timeout: float, metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        return {"ok": True, "text": f"echo: {prompt}"}

    server = A2AServer(_echo, port=_port, token=_token, base_url=_base)
    server.start()
    print(f"A2A endpoint: {_base}  token: {_token}", flush=True)
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        pass
    finally:
        server.stop()
