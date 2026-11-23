# snapgentV3 overlay design: the control bar and lighting effect

## Thesis

A quiet control rail fused to the host site's composer — one band that says
"this chat is wired to your workspace" without taking over the page. Each host
site gets its own colour, border, radius, and font tokens so the overlay blends
into the page rather than sitting on top as a foreign widget.

## Base design: Apple Human Interface Guidelines

The design base is the `dickwu/apple-design-skill` HIG snapshot in
`.agents/skills/apple-design/references/`. Desktop vocabulary is translated with
`cross-platform.md`: macOS → desktop web, semantic `NSColor` roles → CSS custom
properties, `NSVisualEffectView` → `backdrop-filter`, VoiceOver → ARIA.

Only HIG foundations and the desktop lens apply to an injected web layer.
Native navigation patterns (menu bar, window controls, sheets) do not.

| HIG page | Rule used here |
|---|---|
| `accessibility.md › Vision` | 4.5:1 body contrast; desktop type floor; state never by color alone |
| `typography.md › Ensuring legibility` | macOS default 13 pt, minimum 10 pt; weights 500–700 |
| `color.md › Best practices` | one meaning per color; light and dark variants from tokens |
| `layout.md › Visual hierarchy` | one band fused to the composer; alignment and grouping carry hierarchy |
| `materials.md › Liquid Glass` | blur only on the floating functional layer, never in content |
| `buttons.md › Style` | one prominent action; a press state on every custom button |
| `icons.md › Best practices` | one weight-matched icon language; text labels remain |
| `motion.md › Best practices` | purposeful, brief, cancellable; reduced-motion answer |
| `writing.md › Best practices` | verb-first labels; ellipsis when a button opens another view |
| `dark-mode.md › Best practices` | both appearances specified; no app-specific appearance switch |

Full review with citations: `docs/design-review-apple-hig-2026-11-23.md`.

## Scope

Desktop Chrome/Edge extension, injected as plain DOM/CSS into third-party AI
chat sites. HIG foundations govern the artifact; iOS/macOS navigation
conventions are translated, not copied.

The artifact: `#zs-bar` (status + Start/Stop + MCP target + site switch),
`#zs-composer-glow` (the ring), `#zs-menu`, `#zs-target-menu`, `#zs-mcp-pop`,
`#zs-setup`, `#zs-unstable`, and `.zs-chip`. Source: `core/ui-controller.js`
(`placeBar`, `showStop`, `build`, `applyTheme`), `providers/*.js` (`barMount`,
`barAnchor`, `composerFrame`), `overlay.css`.

## Base color tokens

One meaning per color. Accent is reserved for the primary action and focus;
state colors never double as decoration. Base defaults live on `:root, #zs-root,
#zs-input-cover` (dark) and `html.zs-light` (light).

| Token | Dark default | Light default | Used for |
|---|---|---|---|
| `--zs-surface` | `#0b1220` | `#f5f8ff` | opaque bar / chip / warning fill |
| `--zs-bar-bg` | `rgba(11, 18, 32, 0.82)` | `rgba(245, 248, 255, 0.93)` | floating bar fill |
| `--zs-menu-bg` | `#0b1220` | `#f5f8ff` | Switch AI & MCP popovers |
| `--zs-content` | `#e8eef8` | `#14213a` | primary text |
| `--zs-content-muted` | `#93a5bd` | `#475569` | secondary labels & hostnames |
| `--zs-accent` | `#2563eb` | `#1d4ed8` | Start, Stop, active focus, light links |
| `--zs-accent-soft` | `#60a5fa` | `#1d4ed8` | badges, icons, hover arrows |
| `--zs-pill-bg` | `rgba(96, 165, 250, 0.08)` | `rgba(29, 78, 216, 0.07)` | target & switch pill fill |
| `--zs-pill-border` | `rgba(96, 165, 250, 0.55)` | `rgba(37, 99, 235, 0.45)` | pill, menu, and warning borders |
| `--zs-signal-done` | `#34d399` | `#047857` | completed chip / active status |
| `--zs-signal-error` | `#f87171` | `#b91c1c` | failed chip / warning status |
| `--zs-signal-neutral` | `#94a3b8` | `#475569` | neutral / idle chip |
| `--zs-hairline` | `rgba(255, 255, 255, 0.14)` | `rgba(15, 23, 42, 0.14)` | outer bar / card border |
| `--zs-divider` | `rgba(255, 255, 255, 0.08)` | `rgba(15, 23, 42, 0.09)` | inline/anchored bottom seam & menu dividers |

Base contrast against surface (computed, WCAG AA >= 4.5:1):

| Pair | Ratio |
|---|---|
| `#e8eef8` on `#0b1220` | 16.06:1 |
| `#bfdbfe` on `#0b1220` | 13.18:1 |
| `#94a3b8` on `#0b1220` | 7.30:1 |
| `#34d399` on `#0b1220` | 9.74:1 |
| `#f87171` on `#0b1220` | 6.77:1 |
| `#ffffff` on `#2563eb` | 5.17:1 |
| `#14213a` on `#f5f8ff` | 15.10:1 |
| `#1d4ed8` on `#f5f8ff` | 6.30:1 |

## Per-provider tokens

`ui-controller.js` attaches `html.zs-site-<id>` on `<html>` and `.zs-prov-<id>`
on `#zs-bar`. Each primary site overrides **only tokens** (colors, borders,
radius, font stack, weight) in `overlay.css` — never ad-hoc per-element rules.

| Site (`id`) | Host | Font stack (`--zs-font-ui`) | Radius (`--zs-bar-radius`) | Dark surface / accent / hairline | Light surface / accent / hairline |
|---|---|---|---|---|---|
| **Gemini** (`gemini`) | `gemini.google.com` | `"Google Sans Text", "Google Sans", Roboto, ...` (strong weight `500`) | `--zs-r-2xl` (14 px) | `#1e1f20` / `#1a73e8` (`#a8c7fa` soft) / `rgba(255,255,255,0.12)` | `#f0f4f9` / `#1a73e8` / `rgba(68,71,70,0.18)` |
| **DeepSeek** (`deepseek`) | `chat.deepseek.com` | `Inter, -apple-system, ...` | `--zs-r-2xl` (14 px) | `#212327` / `#3b5bdb` (`#8ea4ff` soft) / `rgba(255,255,255,0.11)` | `#f5f7fb` / `#3b5bdb` / `rgba(28,32,41,0.14)` |
| **Rudder** (`rudder`) | `rudder.chat` | `"Geist", Inter, -apple-system, ...` | `--zs-r-lg` (12 px) | `#18181b` / `#2563eb` (`#60a5fa` soft) / `rgba(255,255,255,0.12)` | `#f8fafc` / `#1d4ed8` / `rgba(15,23,42,0.13)` |
| **Ptero** (`ptero`) | `ptero.pro` | `"Plus Jakarta Sans", Inter, -apple-system, ...` | `--zs-r-lg` (12 px) | `#14161b` / `#4f46e5` (`#818cf8` soft) / `rgba(255,255,255,0.12)` | `#f6f7fb` / `#4338ca` / `rgba(24,28,38,0.13)` |
| **Claude** (`claude`) | `claude.ai` | `"Anthropic Sans", "Styrene B", ui-sans-serif, ...` (strong weight `600`) | `--zs-r-2xl` (14 px) | `#2b2a27` / `#b55436` (`#e89275` soft) / `rgba(238,236,226,0.13)` | `#faf9f5` / `#a84a2d` / `rgba(28,27,24,0.14)` |
| **chat.z.ai / GLM** (`glm`) | `chat.z.ai` | `Inter, "HarmonyOS Sans", -apple-system, ...` | `--zs-r-2xl` (14 px) | `#1b1c1f` / `#0369a1` (`#7dd3fc` soft) / `rgba(255,255,255,0.11)` | `#f7f8fa` / `#0369a1` / `rgba(24,26,31,0.13)` |

## CSS isolation

Because inline mode mounts `#zs-bar` directly inside host composer trees (and
`.zs-chip` inside conversation turns), `overlay.css` enforces consistent
`#zs-*` / `.zs-*` prefix scoping plus an explicit isolation barrier on every
overlay root (`#zs-root`, `#zs-bar`, `#zs-menu`, `#zs-target-menu`,
`#zs-mcp-pop`, `#zs-setup`, `#zs-input-cover`, `#zs-unstable`, `.zs-chip`,
`.zs-toast`, `.zs-banner`, `.zs-shot`):

- `isolation: isolate` creates an independent stacking context per overlay root.
- `box-sizing: border-box` is enforced on every root and descendant (`*`,
  `*::before`, `*::after`).
- Inherited typography (`font-family`, `font-style`, `font-variant`,
  `font-weight`, `line-height`, `letter-spacing`, `word-spacing`,
  `text-transform`, `text-indent`, `text-shadow`, `text-align`,
  `text-decoration`) is reset on every root so host global rules (Tailwind
  Preflight, Angular Material, Ant Design, Svelte prose) cannot bleed in.
- Buttons and SVGs inside overlay roots reset `appearance`, `margin`, and
  `display` explicitly.

## Type scale

Desktop floor 10 pt, default 13 pt (HIG `accessibility.md › Vision`):

```
3xs 10.5   2xs 11    xs 11.5    sm 12.5    md 13    lg 13.5    xl 15
font: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif
num:  ui-monospace, "SF Mono", "Cascadia Code", monospace
weights: 500 / 600 / 700
```

## Layout: one unit, three mount modes

| Mode | Providers | Bar placement | Ring target |
|---|---|---|---|
| `inline` + `inside` | DeepSeek | first child inside the composer card | bar + full composer card |
| `inline` | Gemini, Claude | in-flow sibling above composer in flex column | bar + composer frame |
| `anchored` | Rudder, Ptero, GLM (`chat.z.ai`), Kimi, Qwen, Meta, Mistral | fixed, hugging composer top edge | bar + composer frame |
| fallback | any without anchors | fixed above composer | composer frame |

Rules enforced in `placeBar()`:

- `BAR_GAP = 2` — the bar sits flush to the composer.
- When in-flow, bar width and left edge are set from the composer rect so the
  two align exactly.
- When unified, the bar borrows `opaqueBg(composerFrame)`, drops bottom radius
  with a subtle `--zs-divider` seam, and keeps top corners at `--zs-bar-radius`.
- Ring radius comes from the composer, clamped: `max(18px, min(radius,24px))`.

## Material and motion

- Bar: `blur(12px) saturate(1.15)` (`--zs-bar-backdrop`), translucent neutral
  fill (`--zs-bar-bg`), one hairline (`--zs-hairline`). Glass belongs only to
  this functional layer, never to chips or content.
- `#zs-composer-glow`: pointer-events none, positioned around the union of bar
  and composer. Single 1 px `box-shadow` ring (`--zs-ring-shadow`). No
  animation, no mask, no conic gradient.

## Accessibility

- `@media (prefers-reduced-motion: reduce)` stops all animations and
  transitions and hides `#zs-composer-glow::before` (`opacity: 0`).
- `@media (prefers-reduced-transparency: reduce)` makes the bar opaque
  (`var(--zs-surface)` with `backdrop-filter: none`).
- `@media (prefers-contrast: more)` strengthens bar border and ring to 2 px.
- All controls keep text labels; icons are supplementary.

## Maintenance

Never set a fixed input height. `.zs-typing` only caps runaway growth at 140 px
during injection; the visible size comes from the host site.

Verify with:

```
node --check snapgent-extension/core/ui-controller.js snapgent-extension/core/main.js
python3 -m pytest -q
python3 -m unittest discover -s tests
```
