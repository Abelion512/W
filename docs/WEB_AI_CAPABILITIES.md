# Web AI capability and behavior notes

Sources: the provider adapters in `snapgent-extension/providers/` and live DOM
reads of the signed-in tabs on 2026-11-21. Adapter values are code facts. Model
labels, quota messages and reset times are **observations of these accounts at
that moment**, not universal limits of the services. Recheck before relying on
them. The A2A routing targets are Hermes (primary), OpenCode, Freebuff, Claude
Code and Antigravity; see `docs/a2a.md` for the wire contract.

## Active A2A providers

| Provider | Model / mode observed | Reasoning surface | Search control | Vision | Send cap | Warm-up | Limit signal observed |
|---|---|---|---|---|---|---|---|
| `gemini` | Hydrogen High (adapter restores at startup) | `model-thoughts` | site search | yes | - | 45 s | none at observation |
| `deepseek` | DeepThink ON, Search ON (user-controlled) | `.ds-think-content` | Search toggle | getter: Vision tab only | 163,840 | 45 s | none at observation |
| `chatgpt` | Think pill (observed OFF after a run), Search button | stop-button gated | Search button | no | - | 45 s | quota/pause regexes in adapter |
| `claude` | Sonnet 5.5 Low | thinking selector | site search | no | - | 60 s | "You've hit your limit for Claude messages. Resets at 4:20 AM" |
| `glm` | GLM-5.2 Max | `.thinking-chain-container` | site search | yes | - | 45 s | none; cold start sometimes answers in prose |
| `grok` | Fast, Research tab | stop-button gated | Search button | no | - | 150 s | `[data-testid="usage-limit-notice"]` "Free tier limit reached" |
| `qwen` | Auto / Qwen3, Upgrade control | stop-button gated | site search | per-model getter | 131,072 | 45 s | daily usage regex ("please wait N hours"); cold start sometimes prose |
| `kimi` | K3.1 Pro | `.thinking-container` | site search | yes | - | 45 s | not logged in: `Log in to sync chat history`, reply never read |
| `mistral` | Vibe app, model Think | side panel | Search button | no | - | 60 s | "Messages limit reached ... reset in 4 hours" |
| `meta` | Thinking pill | - | site search | yes | - | 45 s | captcha/overlay guards in adapter |
| `arena` | Mode Chat, Modality Auto, Model picker | - | site search | yes | 120,000 | 45 s | A/B "too many requests" cooldown; tiptap composer on `/chat` |
| `rudder` | plain chat | - | site search | no | 4,000 | 60 s | sign-in modal guard in adapter |

A composer `Search` toggle (ChatGPT, DeepSeek, Grok, Mistral) enables web
search on that turn. The other entries are site/chat-history search or an
unconfirmed control; they are not treated as web access.

These columns feed the optional A2A capability metadata flags documented in
`docs/model-routing.md`: `Vision` maps to `needsVision`, the composer `Search`
toggle maps to `needsWeb`, and `Send cap` marks the `largeInput` providers
(DeepSeek, Qwen, Arena). A flag asks routing to keep only providers that carry
that capability. The mapping in `background.js` is static, so DeepSeek and Qwen
— whose vision is a per-model getter in the content script — are treated as
`vision: false` and dropped by `needsVision` even if their selected model
supports images.

All adapters use `RESPONSE_TIMEOUT_MS = 300000` (5 min). `warm-up` is the
empty-turn grace; `idle` is the reasoning-phase growth window. Most providers
use 12 s idle / 9 s stable; Claude, Grok, Mistral, Ptero and Rudder use 15 s /
10 s. Grok's 150 s warm-up is the outlier.

Not in the A2A list: `ptero` (non-text/chat work only, `supportsVision: false`,
60 s warm-up). `chatgpt-cm.js` and `qwen-net.js` are main-world helper scripts,
not providers.

## What the system should do with this

- **Focus path.** Gemini 4 Hydrogen High, DeepSeek (DeepThink + Search on) and
  ChatGPT (Think on) are the primary targets. Gemini's mode is restored by its
  adapter at session startup. DeepSeek's adapter no longer turns Search off, so
  the operator must set DeepThink and Search before starting the bridge.
- **Longer waits need larger client timeouts.** A cold ChatGPT or Rudder task
  took 44.9 s / 75.4 s in the live matrix; Grok has a 150 s warm-up. Hermes peer
  `timeout` is 600 s for this reason.
- **Vision is not uniform.** Gemini, GLM, Kimi, Meta and Arena report vision;
  ChatGPT, Claude, Grok, Mistral, Ptero and Rudder do not. DeepSeek and Qwen are
  per-model getters, so a text-only model must not receive image tools.
- **Input caps differ.** Rudder 4,000, Qwen 131,072, DeepSeek 163,840 and Arena
  120,000 characters; the adapters truncate head and tail with a marker.
- **Quota is a provider state, not a bridge bug.** Recorded hard limits:
  Claude reset 04:20, Mistral reset in 4 h, Grok free tier exhausted, Kimi needs
  login. The adapter's error surfaces already map these to task failures. Do
  not retry them inside one task.
- **Cold-start prose replies** were seen on GLM and Qwen: the model answers the
  bootstrap prompt in prose without the command, then the warm round passes.
  Treat as a model behavior, not a selector defect.
- **Arena's composer changed** from `form textarea` on `/text/*` to a tiptap
  `[contenteditable]` node on `/chat`. Both shapes are now accepted.

## Maintenance

When a provider fails, read the tab's own text before changing an adapter: the
site usually prints the real reason (`Free tier limit reached`, `Messages limit
reached`, `Log in to sync chat history`). Keep this table next to
`docs/a2a.md`; update it when a model label, reset window or composer shape
changes.
