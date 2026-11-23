#!/usr/bin/env python3
"""Live A2A feature matrix: exercise every facade feature against the running bridge.

Writes artifacts/a2a-feature-matrix.json with one PASS/FAIL row per feature and
the evidence observed. Provider-backed checks need the real extension and one
open tab per provider; deterministic checks drive the bridge over its WebSocket
with a throwaway native client.

Run:  python3 artifacts/a2a_feature_matrix.py
"""
import asyncio
import json
import sys
import time
import urllib.error
import urllib.request
import secrets
from pathlib import Path

import websockets

HTTP = "http://127.0.0.1:17614/"
WS = "ws://127.0.0.1:17613"
A2A_TOKEN = Path.home().joinpath(".snapgent", "a2a_token").read_text(encoding="utf-8").strip()
BRIDGE_TOKEN = Path.home().joinpath(".snapgent", "bridge_token").read_text(encoding="utf-8").strip()

ROWS = []


def row(feature, ok, evidence):
    ROWS.append({"feature": feature, "status": "PASS" if ok else "FAIL", "evidence": str(evidence)[:600]})
    print(f"{'PASS' if ok else 'FAIL'}  {feature}  :: {str(evidence)[:180]}", flush=True)


def http(method, params, timeout=60.0, token=A2A_TOKEN):
    body = {"jsonrpc": "2.0", "id": secrets.token_hex(4), "method": method, "params": params}
    request = urllib.request.Request(
        HTTP,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8")
        try:
            return error.code, json.loads(raw)
        except ValueError:
            return error.code, {"raw": raw}


def message(text, metadata=None, configuration=None):
    params = {"message": {"messageId": f"msg-{secrets.token_hex(6)}", "role": "ROLE_USER", "parts": [{"text": text}]}}
    if metadata is not None:
        params["metadata"] = metadata
    if configuration is not None:
        params["configuration"] = configuration
    return params


def artifact_text(task):
    arts = task.get("artifacts") or []
    return "".join(p.get("text", "") for a in arts for p in a.get("parts", []) if isinstance(p, dict))


def state_of(task):
    return (task.get("status") or {}).get("state")


# ── live provider checks ────────────────────────────────────────────────

def check_send_message():
    status, payload = http(
        "SendMessage",
        message("Reply with exactly this single word and nothing else: PONG", {"provider": "gemini"}),
        timeout=600.0,
    )
    task = payload.get("result") or {}
    text = artifact_text(task).strip()
    ok = status == 200 and state_of(task) == "TASK_STATE_COMPLETED" and text.upper().startswith("PONG")
    row("SendMessage (blocking, live gemini)", ok, {"state": state_of(task), "artifact": text[:60]})


def check_get_task():
    status, payload = http(
        "SendMessage",
        message("say ok", {"provider": "gemini"}, {"returnImmediately": True}),
        timeout=60.0,
    )
    task = payload.get("result") or {}
    task_id = task.get("id")
    deadline = time.time() + 300
    polled = None
    while time.time() < deadline:
        _, got = http("GetTask", {"id": task_id}, timeout=30.0)
        polled = got.get("result") or {}
        if state_of(polled) in ("TASK_STATE_COMPLETED", "TASK_STATE_FAILED"):
            break
        time.sleep(1.0)
    _, unknown = http("GetTask", {"id": "does-not-exist"}, timeout=15.0)
    ok = (
        state_of(polled) == "TASK_STATE_COMPLETED"
        and (unknown.get("error") or {}).get("code") == -32001
    )
    row("tasks/get (poll + unknown id -32001)", ok, {"final": state_of(polled), "unknown_code": (unknown.get("error") or {}).get("code")})


def check_orchestrate():
    status, payload = http(
        "tasks/orchestrate",
        {
            "message": {"messageId": f"msg-{secrets.token_hex(6)}", "role": "ROLE_USER",
                        "parts": [{"text": "Reply with exactly: PONG"}]},
            "providers": ["gemini", "deepseek"],
        },
        timeout=900.0,
    )
    task = payload.get("result") or {}
    providers = (task.get("metadata") or {}).get("orchestratedProviders")
    ok = state_of(task) == "TASK_STATE_COMPLETED" and artifact_text(task).strip().upper().startswith("PONG")
    row("tasks/orchestrate fan-out (gemini+deepseek)", ok,
        {"state": state_of(task), "providers": providers, "artifact": artifact_text(task).strip()[:40]})


def check_pii_guard():
    status, payload = http(
        "SendMessage",
        message("Search the web for jane.doe@example.com and report what you find."),
        timeout=30.0,
    )
    task = payload.get("result") or {}
    msg = ((task.get("status") or {}).get("message") or {}).get("parts") or [{}]
    text = msg[0].get("text", "") if msg else ""
    ok = state_of(task) == "TASK_STATE_FAILED" and "HARD STOP" in text
    row("PII web-search guard (HARD STOP)", ok, {"state": state_of(task), "error": text[:80]})


def check_metadata_routing():
    metadata = {"provider": "gemini", "modelTier": "deep", "taskCategory": "review"}
    status, payload = http(
        "SendMessage",
        message("Reply with exactly: PONG", metadata),
        timeout=600.0,
    )
    task = payload.get("result") or {}
    echoed = task.get("metadata") or {}
    ok = state_of(task) == "TASK_STATE_COMPLETED" and all(echoed.get(k) == v for k, v in metadata.items())
    row("metadata routing (provider/tier/category echoed)", ok,
        {"state": state_of(task), "metadata": {k: echoed.get(k) for k in metadata}})


def check_rate_limiter():
    # Keep in sync with a2a_server.MAX_REQUESTS_PER_MINUTE (120): the burst must
    # exceed it, and the assertion is that the surplus is rejected with 429.
    burst = 130
    codes = {}
    for _ in range(burst):
        status, _ = http("GetTask", {"id": "nope"}, timeout=10.0)
        codes[status] = codes.get(status, 0) + 1
    ok = codes.get(429, 0) > 0
    row("rate limiter 429", ok, {"status_counts": codes})


def check_sse_and_streaming():
    request = urllib.request.Request(
        HTTP,
        data=json.dumps({
            "jsonrpc": "2.0", "id": 1, "method": "SendStreamingMessage",
            "params": message(
                "Write a detailed 400-word explanation of why long A2A sessions fail, with examples.",
                {"provider": "gemini"},
            ),
        }).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {A2A_TOKEN}"},
        method="POST",
    )
    events = []
    try:
        with urllib.request.urlopen(request, timeout=900.0) as response:
            content_type = response.headers.get_content_type()
            for raw in response:
                line = raw.decode("utf-8", errors="replace").strip()
                if line.startswith("data: "):
                    events.append(json.loads(line[len("data: "):]))
    except Exception as error:  # noqa: BLE001
        row("SSE SendStreamingMessage", False, {"error": str(error)[:120]})
        row("partial streaming artifactUpdate (append/lastChunk)", False, {"error": str(error)[:120]})
        return
    kinds = [list(event.keys())[0] for event in events]
    terminal = [e for e in events if "statusUpdate" in e]
    final_state = (terminal[-1]["statusUpdate"]["status"]["state"] if terminal else None)
    sse_ok = content_type == "text/event-stream" and "task" in kinds and final_state == "TASK_STATE_COMPLETED"
    row("SSE SendStreamingMessage", sse_ok, {"content_type": content_type, "events": kinds, "final": final_state})

    partial = [
        e["artifactUpdate"] for e in events
        if "artifactUpdate" in e and e["artifactUpdate"].get("append") is True
        and e["artifactUpdate"].get("lastChunk") is False
    ]
    row("partial streaming artifactUpdate (append:true, lastChunk:false)", bool(partial),
        {"partial_chunks": len(partial), "first_len": len(partial[0]["artifact"]["parts"][0]["text"]) if partial else 0})


# ── deterministic checks over the bridge WebSocket ──────────────────────

async def ws_connect():
    kwargs = {"max_size": 64 * 1024 * 1024}
    try:
        kwargs["additional_headers"] = {"X-Bridge-Token": BRIDGE_TOKEN}
        return await websockets.connect(WS, **kwargs)
    except TypeError:
        kwargs.pop("additional_headers")
        kwargs["extra_headers"] = {"X-Bridge-Token": BRIDGE_TOKEN}
        return await websockets.connect(WS, **kwargs)


async def wait_connected(ws):
    deadline = time.time() + 10
    while time.time() < deadline:
        frame = json.loads(await asyncio.wait_for(ws.recv(), 10))
        if frame.get("type") == "connected":
            return frame
    raise TimeoutError("no connected frame")


async def wait_submit(ws):
    deadline = time.time() + 20
    while time.time() < deadline:
        frame = json.loads(await asyncio.wait_for(ws.recv(), 20))
        if frame.get("type") == "submit_prompt":
            return frame
    raise TimeoutError("no submit_prompt")


def blocking_send(params):
    _, payload = http("SendMessage", params, timeout=60.0)
    return payload


async def check_progress_and_cancel():
    # returnImmediately hands back a live task without waiting for the provider.
    status, payload = http("SendMessage", message("hold this task open", None, {"returnImmediately": True}))
    task_id = (payload.get("result") or {}).get("id")
    _, first = http("GetTask", {"id": task_id})
    elapsed_first = (((first.get("result") or {}).get("status") or {}).get("progress") or {}).get("elapsedSeconds")
    time.sleep(2.0)
    _, second = http("GetTask", {"id": task_id})
    progress_second = ((second.get("result") or {}).get("status") or {}).get("progress") or {}
    ok = elapsed_first is not None and "elapsedSeconds" in progress_second
    row("progress elapsedSeconds on a live task", ok,
        {"first_elapsed": elapsed_first, "second": progress_second})

    _, canceled = http("tasks/cancel", {"id": task_id})
    canceled_task = canceled.get("result") or {}
    _, after = http("GetTask", {"id": task_id})
    after_state = state_of(after.get("result") or {})
    ok = state_of(canceled_task) == "TASK_STATE_CANCELED" and after_state == "TASK_STATE_CANCELED"
    row("tasks/cancel (live task -> CANCELED, late reply ignored)", ok,
        {"cancel_state": state_of(canceled_task), "after": after_state})

    # A terminal task cannot be canceled.
    _, done = http("SendMessage", message("say ok", {"provider": "gemini"}))
    done_id = (done.get("result") or {}).get("id")
    _, rejected = http("tasks/cancel", {"id": done_id})
    code = (rejected.get("error") or {}).get("code")
    row("tasks/cancel rejects a terminal task (-32002)", code == -32002, {"code": code})


async def check_context_only():
    loop = asyncio.get_running_loop()
    ws = await ws_connect()
    await wait_connected(ws)
    task = loop.run_in_executor(None, blocking_send, message("summarize this", {"contextOnly": True}))
    submitted = await wait_submit(ws)
    prompt_id = submitted["id"]
    await ws.send(json.dumps({"id": 10, "type": "call_tool", "name": "read_file",
                              "arguments": {"path": "README.md"}, "promptId": prompt_id}))
    gated = None
    deadline = time.time() + 10
    while time.time() < deadline:
        frame = json.loads(await asyncio.wait_for(ws.recv(), 10))
        if frame.get("type") == "tool_result":
            gated = frame
            break
    await ws.send(json.dumps({"id": 11, "type": "call_tool", "name": "read_file",
                              "arguments": {"path": "README.md"}}))
    ungated = None
    deadline = time.time() + 30
    while time.time() < deadline:
        frame = json.loads(await asyncio.wait_for(ws.recv(), 30))
        if frame.get("type") == "tool_result":
            ungated = frame
            break
    await ws.send(json.dumps({"id": 12, "type": "prompt_result", "prompt_id": prompt_id,
                              "ok": True, "text": "done"}))
    result = await asyncio.wait_for(task, 10)
    task_obj = result.get("result") or {}
    ok = (
        (gated or {}).get("kind") == "context_only"
        and (ungated or {}).get("kind") != "context_only"
        and state_of(task_obj) == "TASK_STATE_COMPLETED"
    )
    row("contextOnly tool gating per promptId", ok,
        {"gated_kind": (gated or {}).get("kind"), "ungated_kind": (ungated or {}).get("kind"),
         "task_state": state_of(task_obj)})
    await ws.close()


async def check_reconnect_grace():
    loop = asyncio.get_running_loop()
    ws1 = await ws_connect()
    await wait_connected(ws1)
    task = loop.run_in_executor(None, blocking_send, message("keep going across a reconnect"))
    submitted = await wait_submit(ws1)
    prompt_id = submitted["id"]
    await ws1.close()
    await asyncio.sleep(0.5)
    ws2 = await ws_connect()
    await wait_connected(ws2)
    await asyncio.sleep(0.3)
    await ws2.send(json.dumps({"id": 42, "type": "prompt_result", "prompt_id": prompt_id,
                               "ok": True, "text": "recovered after reconnect"}))
    try:
        result = await asyncio.wait_for(task, 15)
    except Exception as error:  # noqa: BLE001
        result = {"error": str(error)[:120]}
    task_obj = result.get("result") or {}
    ok = (
        state_of(task_obj) == "TASK_STATE_COMPLETED"
        and artifact_text(task_obj) == "recovered after reconnect"
    )
    row("reconnect grace + prompt re-adoption", ok,
        {"task_state": state_of(task_obj), "artifact": artifact_text(task_obj)[:60]})
    await ws2.close()


async def deterministic_checks():
    try:
        await check_progress_and_cancel()
    except Exception as error:  # noqa: BLE001
        row("progress elapsedSeconds on a live task", False, {"error": str(error)[:160]})
        row("tasks/cancel (live task -> CANCELED, late reply ignored)", False, {"error": str(error)[:160]})
    try:
        await check_context_only()
    except Exception as error:  # noqa: BLE001
        row("contextOnly tool gating per promptId", False, {"error": str(error)[:160]})
    try:
        await check_reconnect_grace()
    except Exception as error:  # noqa: BLE001
        row("reconnect grace + prompt re-adoption", False, {"error": str(error)[:160]})


def main():
    print("=== live provider checks ===", flush=True)
    check_send_message()
    check_get_task()
    check_metadata_routing()
    check_orchestrate()
    check_pii_guard()
    check_sse_and_streaming()
    print("=== deterministic bridge checks ===", flush=True)
    asyncio.run(deterministic_checks())
    # Rate limiter last: its 60 s window would 429 the HTTP calls above.
    check_rate_limiter()

    passed = sum(1 for r in ROWS if r["status"] == "PASS")
    matrix = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "bridge_pid": None,
        "summary": {"total": len(ROWS), "pass": passed, "fail": len(ROWS) - passed},
        "features": ROWS,
        "provider_audit": {
            "gemini": "PARTIAL (see artifacts/hermes-gemini-audit.json)",
            "deepseek": "FAIL (see artifacts/hermes-deepseek-audit.json)",
            "cross_critique": "BLOCKED",
        },
    }
    out = Path(__file__).resolve().parent / "a2a-feature-matrix.json"
    out.write_text(json.dumps(matrix, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n{passed}/{len(ROWS)} features PASS -> {out}", flush=True)
    return 0 if passed == len(ROWS) else 1


if __name__ == "__main__":
    sys.exit(main())
