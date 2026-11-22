#!/usr/bin/env python3
"""Minimal A2A client that always sends routing metadata.

The Hermes ``a2a_call`` plugin has been observed calling this server with no
``metadata``, which drops provider/tier routing and makes a task look broken.
This helper is the reference implementation: every call carries metadata, and
the caller can pin a provider or a tier explicitly.

Usage:
  python3 scripts/a2a_call.py "Summarize docs/a2a.md" --provider deepseek
  python3 scripts/a2a_call.py "Review this" --tier deep --orchestrate gemini,deepseek
  python3 scripts/a2a_call.py --cancel TASK_ID
  python3 scripts/a2a_call.py --get TASK_ID

Token resolution: --token, ZS_A2A_TOKEN, then ~/.snapgent/a2a_token.
"""
import argparse
import json
import os
import urllib.request
from pathlib import Path
from typing import Any, Dict, Optional

DEFAULT_URL = "http://127.0.0.1:17614"
DEFAULT_TIMEOUT_MS = 1_800_000


def token_from_args_or_env(arg: Optional[str]) -> str:
    if arg:
        return arg
    env = os.environ.get("ZS_A2A_TOKEN")
    if env:
        return env.strip()
    path = Path.home() / ".snapgent" / "a2a_token"
    try:
        return path.read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def rpc(url: str, token: str, method: str, params: Dict[str, Any], rpc_id: int = 1) -> Dict[str, Any]:
    payload = {"jsonrpc": "2.0", "id": rpc_id, "method": method, "params": params}
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=DEFAULT_TIMEOUT_MS / 1000 + 30) as response:
        return json.loads(response.read().decode("utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("prompt", nargs="?", default="")
    parser.add_argument("--url", default=os.environ.get("ZS_A2A_URL", DEFAULT_URL))
    parser.add_argument("--token")
    parser.add_argument("--provider", help="pin one provider (gemini, deepseek, ...)")
    parser.add_argument("--tier", help="model tier: light, balanced, deep")
    parser.add_argument("--category", help="task category (debug, orchestrate, ...)")
    parser.add_argument("--timeout-ms", type=int, default=DEFAULT_TIMEOUT_MS)
    parser.add_argument("--orchestrate", help="comma-separated providers; first success wins")
    parser.add_argument("--cancel", metavar="TASK_ID")
    parser.add_argument("--get", metavar="TASK_ID")
    parser.add_argument("--create", action="store_true", help="return immediately, poll with --get")
    args = parser.parse_args()

    token = token_from_args_or_env(args.token)
    if not token:
        parser.error("no A2A token: set ZS_A2A_TOKEN or create ~/.snapgent/a2a_token")

    if args.cancel:
        result = rpc(args.url, token, "tasks/cancel", {"id": args.cancel})
    elif args.get:
        result = rpc(args.url, token, "tasks/get", {"id": args.get})
    elif args.prompt:
        metadata: Dict[str, Any] = {"timeoutMs": args.timeout_ms}
        catalog_path = Path(__file__).resolve().parent.parent / "docs" / "model-catalog.json"
        if not args.provider and not args.tier and catalog_path.exists():
            try:
                catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
                policy = catalog.get("policy", {})
                tiers = set(policy.get("autoTiers", ["light", "balanced"]))
                preferred = policy.get("preferred", [])
                by_name = {m.get("provider"): m for m in catalog.get("models", [])}
                pick = next(
                    (p for p in preferred
                     if by_name.get(p, {}).get("tier") in tiers
                     and by_name.get(p, {}).get("cost") != "paid"),
                    None,
                )
                if pick:
                    metadata["provider"] = pick
                    metadata["modelTier"] = by_name[pick]["tier"]
            except (OSError, ValueError):
                pass
        if args.provider:
            metadata["provider"] = args.provider
        if args.tier:
            metadata["modelTier"] = args.tier
        if args.category:
            metadata["taskCategory"] = args.category
        message = {
            "messageId": "msg-cli-1",
            "role": "ROLE_USER",
            "parts": [{"text": args.prompt}],
        }
        if args.orchestrate:
            params = {
                "message": message,
                "metadata": metadata,
                "providers": [p.strip() for p in args.orchestrate.split(",") if p.strip()],
                "configuration": {"returnImmediately": args.create},
            }
            result = rpc(args.url, token, "tasks/orchestrate", params)
        else:
            params = {
                "message": message,
                "metadata": metadata,
                "configuration": {"returnImmediately": args.create},
            }
            result = rpc(args.url, token, "SendMessage", params)
    else:
        parser.error("provide a prompt, --get TASK_ID or --cancel TASK_ID")

    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if "result" in result else 1


if __name__ == "__main__":
    raise SystemExit(main())
