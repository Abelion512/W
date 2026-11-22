# Model catalog and cost guardrail

`docs/model-catalog.json` is rebuilt daily by
`scripts/refresh-model-catalog.py` and consumed by `scripts/a2a_call.py`.

## Policy

- `autoTiers`: `light`, `balanced`. `deep` is **never** chosen automatically.
- `preferred`: DeepSeek, Gemini, GLM, Qwen, Rudder.
- Paid-tier providers (Claude, ChatGPT, Kimi) require an explicit
  `--tier deep` or `metadata.modelTier: "deep"`.

`scripts/a2a_call.py` with no `--provider`/`--tier` now reads the catalog and
pins the first free preferred provider (`deepseek` by default). A broken or
missing catalog falls back to no pin, so the extension's own routing applies.

## Refresh

Manual:

```
python3 scripts/refresh-model-catalog.py
```

Automatic: the systemd user timer `snapgent-model-catalog.timer` runs the
refresh at 03:17 local time. Install with
`bash scripts/install-model-catalog-timer.sh`.

The refresh only reads rendered tab titles over CDP; it sends no prompts and
spends no model quota. New model names show up in `observedTitle`.

## Hermes

The local Hermes plugin
`~/.hermes/hermes-agent/plugins/platforms/a2a/tools.py` now accepts a
`metadata` object on `a2a_call` and `a2a_orchestrate` and forwards it into the
A2A `SendMessage` params. This means Hermes can pin provider/tier directly:

```
a2a_call(agent="webmcp", message="...",
         metadata={"provider":"gemini","taskCategory":"extract"})
```

113 plugin tests pass, including a new metadata pass-through test.
