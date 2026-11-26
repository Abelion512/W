#!/usr/bin/env python3
"""Real-browser e2e for the popup's system appearance support.

TDD slice: the popup declares only a dark palette, so an emulated light OS
appearance still renders a dark surface (HIG `dark-mode.md › Best practices`).
This test drives the rendered DOM through CDP and fails until the popup defines
light token variants.

Needs Google Chrome and the `websockets` package. Uses a throwaway CDP port and
profile; it does not touch a running bridge or browser.

    python3 e2e/ui_theme_e2e.py
"""
import asyncio
import json
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

import websockets

ROOT = Path(__file__).resolve().parent.parent
POPUP = ROOT / "snapgent-extension" / "popup.html"
STUB = """window.chrome = {
  runtime: { sendMessage: (m, cb) => cb && cb(null), getManifest: () => ({version: '3.9.9'}) },
  storage: { local: { set: (o, cb) => cb && cb(), remove: (k, cb) => cb && cb() } },
  tabs: {}
};"""
results = []


def check(name, cond, detail=""):
    results.append(bool(cond))
    print(f"{'PASS' if cond else 'FAIL'}  {name}  {detail}", flush=True)


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def http_json(port, path):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=2) as r:
            return json.loads(r.read().decode())
    except (urllib.error.URLError, OSError, json.JSONDecodeError):
        return None


def luminance(css_color):
    color = css_color.strip()
    if color.startswith("#"):
        color = color.lstrip("#")
        if len(color) == 3:
            color = "".join(c * 2 for c in color)
        parts = [int(color[i:i + 2], 16) for i in (0, 2, 4)]
    else:
        parts = [int(float(x)) for x in re.findall(r"[\d.]+", color)[:3]]
    channels = []
    for value in parts:
        c = value / 255
        channels.append(c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4)
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]


def contrast(a, b):
    high, low = sorted((luminance(a), luminance(b)), reverse=True)
    return (high + 0.05) / (low + 0.05)


async def send(ws, mid, method, params=None):
    await ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
    deadline = time.time() + 15
    while time.time() < deadline:
        msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=15))
        if msg.get("id") == mid:
            if "error" in msg:
                raise RuntimeError(f"{method}: {msg['error']}")
            return msg.get("result", {})
    raise TimeoutError(method)


async def evaluate(ws, mid, expression):
    result = await send(ws, mid, "Runtime.evaluate", {
        "expression": expression, "returnByValue": True, "awaitPromise": True,
    })
    return result["result"].get("value")


SNAPSHOT = """(() => {
  const cs = getComputedStyle(document.body);
  const root = getComputedStyle(document.documentElement);
  const token = (name) => root.getPropertyValue(name).trim();
  return {
    scheme: matchMedia('(prefers-color-scheme: light)').matches,
    bodyBg: cs.backgroundColor,
    bg: token('--bg'), surface: token('--surface'),
    text: token('--text'), muted2: token('--muted-2')
  };
})()"""


async def snapshot(ws, mid, scheme):
    await send(ws, mid, "Emulation.setEmulatedMedia", {
        "features": [{"name": "prefers-color-scheme", "value": scheme}],
    })
    await send(ws, mid + 1, "Runtime.evaluate", {"expression": "location.reload()"})
    for _ in range(40):
        if await evaluate(ws, mid + 2, "document.readyState") == "complete":
            break
        await asyncio.sleep(0.1)
    return await evaluate(ws, mid + 3, SNAPSHOT)


async def run():
    port = free_port()
    profile = tempfile.mkdtemp(prefix="zs-ui-e2e-")
    proc = subprocess.Popen([
        "google-chrome", "--headless=new", "--no-first-run", "--no-default-browser-check",
        "--disable-gpu", "--disable-dev-shm-usage", "--no-sandbox",
        f"--remote-debugging-port={port}", "--remote-allow-origins=*",
        f"--user-data-dir={profile}", "about:blank",
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(80):
            version = http_json(port, "/json/version")
            if version:
                break
            await asyncio.sleep(0.1)
        else:
            raise RuntimeError("Chrome CDP did not start")

        async with websockets.connect(version["webSocketDebuggerUrl"], max_size=None) as browser:
            target = await send(browser, 1, "Target.createTarget", {"url": "about:blank"})
            for _ in range(40):
                pages = [p for p in (http_json(port, "/json/list") or [])
                         if p.get("id") == target["targetId"] and p.get("type") == "page"]
                if pages and pages[0].get("webSocketDebuggerUrl"):
                    break
                await asyncio.sleep(0.1)
            else:
                raise RuntimeError("page target missing")

            async with websockets.connect(pages[0]["webSocketDebuggerUrl"], max_size=None) as ws:
                await send(ws, 10, "Page.enable")
                await send(ws, 11, "Page.addScriptToEvaluateOnNewDocument", {"source": STUB})
                await send(ws, 12, "Page.navigate", {"url": POPUP.as_uri()})
                for _ in range(40):
                    if await evaluate(ws, 13, "document.readyState") == "complete":
                        break
                    await asyncio.sleep(0.1)

                dark = await snapshot(ws, 20, "dark")
                check("dark appearance stays dark", luminance(dark["bodyBg"]) < 0.2,
                      dark["bodyBg"])
                check("dark text meets AA", contrast(dark["text"], dark["bg"]) >= 4.5,
                      f"{contrast(dark['text'], dark['bg']):.2f}:1")

                light = await snapshot(ws, 30, "light")
                check("light appearance emulation active", light["scheme"] is True)
                check("light appearance renders a light surface",
                      luminance(light["bodyBg"]) > 0.5, light["bodyBg"])
                check("light text meets AA",
                      contrast(light["text"], light["bg"]) >= 4.5,
                      f"{contrast(light['text'], light['bg']):.2f}:1")
                check("light secondary text meets AA",
                      contrast(light["muted2"], light["surface"]) >= 4.5,
                      f"{contrast(light['muted2'], light['surface']):.2f}:1")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        shutil.rmtree(profile, ignore_errors=True)

    failed = results.count(False)
    print(f"\n{len(results) - failed}/{len(results)} PASS")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(run()))
