# snapgentV3 overlay design: the control bar and lighting effect

## Thesis

A quiet control rail fused to the host site's composer — one band that says
"this chat is wired to your workspace" without taking over the page. The single remembered element is the **quiet hairline** that circles that band.

## Scope

Desktop Chrome/Edge extension, injected as plain DOM/CSS into third-party AI
chat sites. Apple HIG applies as principles and foundations (accessibility,
color, typography, layout, writing), not as iOS/macOS platform conventions.
See `references/cross-platform.md` in the apple-design skill for vocabulary.

The artifact: `#zs-bar` (status + Start/Stop + MCP target + site switch) and
`#zs-composer-glow` (the ring). Source: `core/main.js` (`placeBar`,
`showStop`, `build`), `providers/*.js` (`barMount`, `barAnchor`,
`composerFrame`), `overlay.css`.

## Color tokens

One meaning per color. Accent is reserved for the primary action and focus;
state colors never double as decoration.

| Role | Dark | Light | Used for |
|---|---|---|---|
| surface | `#0b1220` | `#f5f8ff` | bar / menu fill |
| content | `#e8eef8` | `#14213a` | primary text |
| accent | `#2563eb` | `#1d4ed8` | Start, focus ring |
| accent-soft | `#60a5fa` | `#60a5fa` | labels on dark surface |
| signal-done | `#34d399` | `#047857` | completed chip |
| signal-error | `#f87171` | `#b91c1c` | failed chip |
| signal-neutral | `#94a3b8` | `#475569` | result / sys chip |
| hairline | `rgba(255,255,255,.14)` | `rgba(15,23,42,.14)` | separators |

Contrast against surface (computed, WCAG):

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
| `anchored` | Rudder, Ptero, Kimi, Qwen, Meta, Mistral | fixed, hugging composer top edge | bar + composer frame |
| fallback | any without anchors | fixed above composer | composer frame |

Rules enforced in `placeBar()`:

- `BAR_GAP = 2` — the bar sits flush to the composer.
- When in-flow, bar width and left edge are set from the composer rect so the
  two align exactly (Gemini: both `left:16`, `width:698`).
- When unified, the bar borrows `opaqueBg(composerFrame)`, drops bottom radius
  and bottom border, and keeps top corners at `--zs-r-xl`.
- In `inside` mode the ring uses the editor rect, not the full composer card —
  otherwise DeepSeek's mode buttons widen the ring beyond bar + input.
- Ring radius comes from the composer, clamped: `max(18px, min(radius,24px))`.

## Material and motion

- Bar: `blur(24px) saturate(1.3)`, translucent neutral fill, one hairline.
  Glass belongs only to this functional layer, never to chips or content.
- `#zs-composer-glow`: pointer-events none, positioned around the union of bar
  and composer. It is a single 1 px `box-shadow` ring — white in dark, blue in
  light. No animation, no mask, no conic gradient. The design target is the
  lightest possible runtime cost; motion was deliberately removed.

## Accessibility

- `@media (prefers-reduced-motion: reduce)` stops the orbit and shimmer; a
  static highlight stays at opacity `.85`.
- `@media (prefers-reduced-transparency: reduce)` makes the bar opaque.
- `@media (prefers-contrast: more)` strengthens ring and border to 2 px.
- The host page may force these. `--force-prefers-reduced-motion` in the
  browser command line makes `matchMedia` report reduce even with no visible
  settings toggle.
- All controls keep text labels; icons are supplementary.

## Maintenance

Never set a fixed input height. `.zs-typing` only caps runaway growth at 140 px
during injection; the visible size comes from the host site.

When a provider looks wrong, check in order:

1. Does its adapter export `barMount`, `barAnchor`, `composerFrame`?
2. Are bar and composer rects aligned (same left/width, gap < 24 px)?
3. Is the ring sizing to the right target (editor for `inside` mode)?
4. Is `prefers-reduced-motion` suppressing the orbit?

Verify with:

```
node --check snapgent-extension/core/main.js
python3 -m unittest discover -s tests
```
