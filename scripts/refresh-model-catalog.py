#!/usr/bin/env python3
"""Build the daily model/cost catalog used to keep A2A routing cheap.

Sources: docs/WEB_AI_CAPABILITIES.md (observed behaviour) plus the currently
open provider tabs over CDP (model labels only). Never sends prompts to a chat
site; it reads rendered text. Output: docs/model-catalog.json.
"""
import json
import os
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "model-catalog.json"
CDP_PORT = int(os.environ.get("ZS_CDP_PORT", "9222"))

# Seed: cost tier is the guardrail. 'deep' is never chosen automatically.
SEED = [
    ("deepseek", "DeepThink", "balanced", "free", ["web", "largeInput"]),
    ("gemini", "Hydrogen High", "balanced", "free", ["vision", "web"]),
    ("glm", "GLM Max", "balanced", "free", ["vision"]),
    ("qwen", "Qwen3", "balanced", "free", ["largeInput"]),
    ("mistral", "Think", "balanced", "free", ["web"]),
    ("rudder", "plain chat", "light", "free", []),
    ("grok", "Fast / Research", "balanced", "free", ["web"]),
    ("claude", "Sonnet", "deep", "paid", []),
    ("chatgpt", "Think", "deep", "paid", ["web"]),
    ("kimi", "K3 Pro", "deep", "paid", ["vision"]),
    ("arena", "Chat / Direct", "balanced", "free", ["vision", "largeInput"]),
    ("meta", "Thinking", "light", "free", ["vision"]),
    ("ptero", "non-text", "light", "free", []),
]

HOSTS = {
    "gemini": "gemini.google.com", "deepseek": "chat.deepseek.com",
    "claude": "claude.ai", "chatgpt": "chatgpt.com", "glm": "chat.z.ai",
    "grok": "grok.com", "qwen": "chat.qwen.ai", "kimi": "kimi.ai",
    "mistral": "chat.mistral.ai", "rudder": "rudder.chat",
    "arena": "arena.ai", "meta": "meta.ai", "ptero": "ptero.pro",
}


def live_labels() -> Dict[str, str]:
    """Read model labels from open tabs. Best-effort; failures are ignored."""
    out: Dict[str, str] = {}
    try:
        targets = json.load(urllib.request.urlopen(
            f"http://127.0.0.1:{CDP_PORT}/json/list", timeout=3))
    except Exception:
        return out
    for provider, host in HOSTS.items():
        page = next((t for t in targets
                     if t.get("type") == "page" and host in t.get("url", "")), None)
        if not page:
            continue
        try:
            # CDP evaluate over the page target via HTTP is unavailable; the
            # tab title usually carries the chat/model name, which is enough
            # to notice a renamed high-tier model without any prompt traffic.
            title = page.get("title") or ""
            if title:
                out[provider] = title[:80]
        except Exception:
            continue
    return out


def main() -> int:
    labels = live_labels()
    external: list[str] = []
    try:
        with urllib.request.urlopen("https://openrouter.ai/api/v1/models", timeout=5) as response:
            registry = json.load(response)
        external = [m.get("id", "") for m in registry.get("data", [])[:50] if m.get("id")]
    except Exception:
        pass
    models = []
    for provider, model, tier, cost, caps in SEED:
        entry: Dict[str, Any] = {
            "provider": provider,
            "model": model,
            "tier": tier,
            "cost": cost,
            "capabilities": caps,
            "observedTitle": labels.get(provider),
        }
        models.append(entry)
    catalog = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "source": "docs/WEB_AI_CAPABILITIES.md + open-tab titles (no prompts sent)",
        "policy": {
            "defaultTier": "balanced",
            "autoTiers": ["light", "balanced"],
            "neverAuto": ["deep"],
            "preferred": ["deepseek", "rudder", "gemini", "chatgpt", "ptero",
                          "glm", "qwen", "mistral", "meta", "arena", "grok"],
            "effortLevels": ["low", "medium", "high", "xhigh", "ultra"],
            "note": "usage-friendly order first; Claude/Kimi/Grok use 5h/day/server-busy windows - explicit pin only",
        },
        "sources": {
            "local": "docs/WEB_AI_CAPABILITIES.md + open-tab titles",
            "intelligenceIndex": "https://artificialanalysis.ai/models",
            "modelRegistry": "https://openrouter.ai/api/v1/models",
            "opencode": "https://opencode.ai/docs/models/",
            "webSearch": "Google search 'new model release <provider>'",
        },
        "models": models,
        "externalModels": external,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(catalog, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"catalog written: {OUT} ({len(models)} providers, {len(labels)} live titles)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
