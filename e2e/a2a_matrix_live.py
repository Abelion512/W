#!/usr/bin/env python3
"""Live A2A provider matrix: drive every provider through the real bridge.

Sends one probe prompt to each provider through the A2A HTTP facade
(bridge.py + the unpacked extension in a real browser), one provider at a
time. Round 1 is COLD: the provider's tab is navigated to a fresh chat first,
so the extension must bootstrap the session from a cold tab. Round 2 is WARM:
the same tab, session already running. Repeat rounds until every provider
passed its round twice in a row or --max-rounds is spent.

The tab must be the FOREGROUND tab of its window while its task runs (the
content script parks otherwise), so each task brings its tab to the front.
This drives a real logged-in browser - run it by hand, never in CI.

Usage:
    python3 e2e/a2a_matrix_live.py [--rounds 4] [--only glm,claude]

Needs: the bridge running (``python3 bridge.py``), the unpacked extension
loaded, one open tab per provider, and the CDP port of that browser
(--cdp, default 9222).
"""
import argparse
import asyncio
import json
import re
import secrets
import sys
import time
import urllib.request
from pathlib import Path

import websockets

A2A_URL = "http://127.0.0.1:17614/"
TOKEN_PATH = Path.home() / ".snapgent" / "a2a_token"
PROMPT = "Reply with exactly this single word and nothing else: PONG"

# Provider pin -> tab host + the URL a COLD tab is navigated to (a fresh chat
# on the site's own entry page, so the site must bootstrap its composer).
PROVIDERS = {
    "chatgpt": ("chatgpt.com", "https://chatgpt.com/"),
    "claude": ("claude.ai", "https://claude.ai/new"),
    "gemini": ("gemini.google.com", "https://gemini.google.com/app"),
    "glm": ("chat.z.ai", "https://chat.z.ai/"),
    "grok": ("grok.com", "https://grok.com/"),
    "deepseek": ("chat.deepseek.com", "https://chat.deepseek.com/a/chat"),
    "qwen": ("chat.qwen.ai", "https://chat.qwen.ai/"),
    "kimi": ("kimi.ai", "https://www.kimi.ai/"),
    "mistral": ("chat.mistral.ai", "https://chat.mistral.ai/"),
    "meta": ("meta.ai", "https://meta.ai/"),
    "arena": ("arena.ai", "https://arena.ai/chat"),
    "rudder": ("rudder.chat", "https://rudder.chat/"),
}

COLD_SETTLE_S = 10.0

# The site's own refusal, not a harness bug. Re-sending the (large) bootstrap
# prompt after one of these only burns the account further and teaches the run
# nothing - the same tab answers once the limit resets. A provider that reports
# one is marked BLOCKED for the rest of the run and skipped.
QUOTA_RE = (
    r"limit reached|reached (today's|your|the) .{0,24}limit|message[s]? limit|"
    r"quota|out of (messages|credits)|upgrade (your|for)|try again later"
)


def is_quota_block(text):
    return bool(re.search(QUOTA_RE, text or "", re.IGNORECASE))


def a2a_send(text, metadata, timeout=600.0):
    token = TOKEN_PATH.read_text(encoding="utf-8").strip()
    body = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "SendMessage",
        "params": {
            "message": {
                "messageId": f"msg-{secrets.token_hex(6)}",
                "role": "ROLE_USER",
                "parts": [{"text": text}],
            },
            "metadata": metadata,
        },
    }
    request = urllib.request.Request(
        A2A_URL,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
        method="POST",
    )
    started = time.time()
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except Exception as error:  # noqa: BLE001 - any transport error is a failure
        return {"ok": False, "error": str(error), "seconds": round(time.time() - started, 1)}
    task = payload.get("result") or {}
    state = (task.get("status") or {}).get("state")
    artifacts = task.get("artifacts") or []
    text_out = ""
    if artifacts:
        text_out = "".join(part.get("text", "") for part in artifacts[0].get("parts") or [])
    message = ((task.get("status") or {}).get("message") or {}).get("parts") or []
    error = "".join(part.get("text", "") for part in message)
    seconds = round(time.time() - started, 1)
    if state == "TASK_STATE_COMPLETED":
        return {"ok": True, "text": text_out.strip(), "seconds": seconds}
    return {"ok": False, "error": error or f"state={state}", "seconds": seconds}


def cdp_list(cdp):
    return json.load(urllib.request.urlopen(f"http://127.0.0.1:{cdp}/json/list"))


async def tab_for(cdp, host):
    """The provider's tab: connected for evaluate/navigate, front page target."""
    pages = [t for t in cdp_list(cdp) if t.get("type") == "page" and host in t.get("url", "")]
    return pages[0]["webSocketDebuggerUrl"] if pages else None


async def cdp_call(ws_url, method, params=None, timeout=30):
    async with websockets.connect(ws_url, max_size=None, open_timeout=10) as ws:
        await ws.send(json.dumps({"id": 1, "method": method, "params": params or {}}))
        deadline = time.time() + timeout
        while time.time() < deadline:
            message = json.loads(await asyncio.wait_for(ws.recv(), timeout))
            if message.get("id") == 1:
                return message.get("result")
    raise TimeoutError(method)


async def prepare_tab(cdp, provider, cold):
    host, fresh_url = PROVIDERS[provider]
    ws_url = await tab_for(cdp, host)
    if not ws_url:
        return None, "no tab open"
    if cold:
        await cdp_call(ws_url, "Page.navigate", {"url": fresh_url})
        # Front it BEFORE the settle wait: a background tab is throttled by the
        # browser, so its composer hydrates seconds later than a foreground one
        # (measured 2026-11-15 - a cold tab failed 24 write attempts, the same
        # tab passed as soon as it was fronted). The settle only means anything
        # if the page is loading at full speed.
        await cdp_call(ws_url, "Page.bringToFront", {})
        await asyncio.sleep(COLD_SETTLE_S)
    else:
        # A background tab parks the loop; bring it to the front before sending.
        await cdp_call(ws_url, "Page.bringToFront", {})
    return ws_url, None


async def run_round(cdp, providers, round_name, cold, timeout, results, blocked=None):
    blocked = blocked if blocked is not None else {}
    print(f"\n=== {round_name} round ({'cold' if cold else 'warm'}) ===", flush=True)
    for provider in providers:
        if provider in blocked:
            print(f"SKIP  {provider:8s} blocked: {blocked[provider][:70]}", flush=True)
            continue
        ws_url, err = await prepare_tab(cdp, provider, cold)
        if not ws_url:
            results.append({"round": round_name, "provider": provider, "ok": False, "error": err, "seconds": 0})
            print(f"FAIL  {provider:8s} {err}", flush=True)
            continue
        await cdp_call(ws_url, "Page.bringToFront", {})
        reply = a2a_send(PROMPT, {"provider": provider}, timeout=timeout)
        passed = reply.get("ok") and reply.get("text", "").upper().startswith("PONG")
        results.append({
            "round": round_name, "provider": provider, "ok": bool(passed),
            "text": reply.get("text", "")[:40], "error": reply.get("error", ""),
            "seconds": reply.get("seconds"),
        })
        error = reply.get("error", "") or ""
        refusal = error or reply.get("text", "")
        if not passed and is_quota_block(refusal):
            # The account, not the code: stop spending turns on it for this run.
            blocked[provider] = refusal.strip()[:160]
            results[-1]["blocked"] = blocked[provider]
            print(f"BLOCKED  {provider:8s} {reply.get('seconds')}s  {blocked[provider][:70]}", flush=True)
            continue
        mark = "PASS" if passed else "FAIL"
        print(f"{mark}  {provider:8s} {reply.get('seconds')}s"
              + ("" if passed else f"  err={error[:80]} text={reply.get('text', '')[:40]!r}"),
              flush=True)


def main():
    parser = argparse.ArgumentParser(description="Run the live A2A provider matrix.")
    parser.add_argument("--rounds", type=int, default=4, help="max cold+warm rounds")
    parser.add_argument("--only", default="", help="comma-separated provider subset")
    parser.add_argument("--timeout", type=float, default=600.0)
    parser.add_argument("--cdp", type=int, default=9222)
    args = parser.parse_args()
    providers = [p.strip() for p in args.only.split(",") if p.strip()] or list(PROVIDERS)
    unknown = [p for p in providers if p not in PROVIDERS]
    if unknown:
        print("unknown providers: " + ", ".join(unknown))
        return 2
    results = []
    blocked = {}
    try:
        for index in range(1, args.rounds + 1):
            asyncio.run(run_round(args.cdp, providers, f"cold-{index}", True, args.timeout, results, blocked))
            asyncio.run(run_round(args.cdp, providers, f"warm-{index}", False, args.timeout, results, blocked))
            if blocked:
                # Every remaining round would just re-ask a site that said no.
                print("\nstopping: " + ", ".join(f"{p} blocked" for p in blocked), flush=True)
                break
            last_two = results[-2 * len(providers):]
            if all(r["ok"] for r in last_two):
                break
    except KeyboardInterrupt:
        print("\ninterrupted")
    passed_last = {r["provider"]: r["ok"] for r in results[-2 * len(providers):]}
    print("\n--- summary ---")
    for provider in providers:
        if provider in blocked:
            # Not a failure of the harness, and not something a retry can fix.
            print(f"BLOCKED  {provider:8s} {blocked[provider][:90]}")
            continue
        state = "PASS" if passed_last.get(provider) else "FAIL"
        rows = [r for r in results if r["provider"] == provider]
        detail = "; ".join(f"{r['round']}:{'ok' if r['ok'] else (r.get('error') or 'fail')[:40]}" for r in rows)
        print(f"{state}  {provider:8s} {detail}")
    stable = bool(results) and all(passed_last.get(p) for p in providers if p not in blocked)
    print("STABLE" if stable else "NOT STABLE")
    return 0 if stable else 1


if __name__ == "__main__":
    sys.exit(main())
