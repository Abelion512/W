# Design review: Snapgent injected control bar + composer halo

Date: 2026-11-21
Artifact: `snapgent-extension/overlay.css` and `snapgent-extension/core/main.js`
(mirrored in `snapgent-app/extension/`). Reviewed as CSS/JS source, not a live
browser render; contrast figures below are computed from the literal hex values,
layout and animation behaviour are inferred from the rules and therefore marked
where they could not be observed.

Platform and framework: desktop browser extension injecting a fixed bar into
third-party web AI chat pages. Electron desktop mirror shares the same CSS.
The platform conventions that transfer are macOS/desktop equivalents of the
HIG foundations; Apple's native navigation patterns do not apply to an injected
web layer. Translation follows `references/cross-platform.md › Vocabulary`
(CSS custom properties = semantic colours, `backdrop-filter` = vibrancy).

Thesis: one restrained control band fused to the site's composer, with a single
signature moment — a hairline of light orbiting the band while an agent turn
runs. The design has a point of view and earns it: the orbit means "working",
and the Stop button carries the same meaning, so motion is never the only
signal.

User goal: formal review of the latest implementation, per audit item 23.

## Summary

**Good.** No Critical findings. The type scale now meets the HIG desktop floor,
colour is organised into named semantic roles, and the one decorative flourish
is purposeful and cancellable. One High contrast failure remains in the light
appearance, plus a few Medium craft items. The signature orbit gives the
interface a memorable identity without turning it into a template.

## Critical

None.

## Improvements

All four findings below were implemented in Fase 2D and re-verified / consolidated into the semantic & per-provider token system in Fase 4 (2026-11-22):

- [x] **High — light-appearance link colour fails contrast.** **Resolved.**
  `snapgent-extension/overlay.css` sets `html.zs-light .zs-site-go { color: var(--zs-accent); }`
  where the light default `--zs-accent` is `#1d4ed8` (6.60:1 on `#fffef0`, 6.30:1
  on `#f5f8ff`), and every per-provider light `--zs-accent` clears WCAG AA (>= 4.5:1).
  Also fixed light-mode `.zs-site-host` from `#9ca3af` to `var(--zs-content-muted)`
  (`#475569` default, >= 7:1). Verified by `tests/test_overlay_responsive.py`.
- [x] **Medium — reduced-motion fallback freezes the orbit at a bright angle.** **Resolved.**
  `snapgent-extension/overlay.css` `@media (prefers-reduced-motion: reduce)` sets
  `#zs-composer-glow::before { animation: none; opacity: 0; }` and disables animations
  and transitions on `.zs-chip.run`, `.zs-spin`, `#zs-bar`, `.zs-chip`, and
  `#zs-composer-glow`. Verified by `tests/test_overlay_responsive.py`.
- [x] **Medium — strong blur on a small, frequently visible bar.** **Resolved.**
  `snapgent-extension/overlay.css` `#zs-bar` uses
  `backdrop-filter: blur(12px) saturate(1.15)` (and `-webkit-backdrop-filter` + `--zs-bar-backdrop`)
  instead of `blur(24px) saturate(1.3)`. Verified by `tests/test_overlay_responsive.py`.
- [x] **Low — the amber warning pill keeps a warm border on the new blue face.** **Resolved.**
  `snapgent-extension/overlay.css` `#zs-unstable` now uses token-driven accent-family
  colours (`color: var(--zs-accent-soft)`, `border: 1px solid var(--zs-pill-border)`,
  `background: var(--zs-surface)`, hover `var(--zs-pill-hover-bg)`), removing all
  amber (`rgba(251, 191, 36, ...)`) border and warm hover values. Verified by
  `tests/test_overlay_responsive.py`.

## Craft notes

- **Point of view:** the orbiting hairline is the one thing this design will be
  remembered by. It belongs to the product — the bar exists to show an agent
  working on the user's behalf, so light circling the composer is a literal
  picture of that job. This is not a generic "AI glow": it is tied to
  `data-agent-active`, a real state.
- **Type:** the scale moves from a 9.5 px floor to 10.5 px and a 13 px body,
  matching macOS's 10 pt minimum / 13 pt default
  (`typography.md › Ensuring legibility`, table in `accessibility.md › Vision`).
  The system font stack (`-apple-system, BlinkMacSystemFont, "SF Pro Text", …`)
  is the right call for controls; no display face is needed here.
- **Colour:** four to six named roles (`--zs-surface`, `--zs-content`,
  `--zs-accent`, `--zs-accent-soft`, signal colours) replace scattered literals.
  This is a real token system, not a palette applied after the fact. Measured
  dark ratios are strong: content 16.06:1, accent-soft 7.36:1, muted text
  7.26:1, white-on-blue button 5.17:1.
- **Restraint:** the accent blue is spent on the primary action, the Stop
  control, the focus ring and state signals — not on every surface. The
  degraded-start state moves from amber to teal, preserving a single blue
  family for "ready" while keeping a distinguishable "startable but partial"
  signal. One accessory to remove: the warm border on `#zs-unstable` (above).

## What works

- Type scale raised to the accessibility floor with weights 500/600/700, never
  thin or light — directly satisfies the "avoid light font weights" rule in
  `typography.md › Ensuring legibility`.
- Semantic colour roles with separate light overrides, so dark and light
  appearances are both specified rather than one being an afterthought.
- `prefers-reduced-motion` and `prefers-reduced-transparency` blocks exist;
  the orbit is cancellable and never the sole meaning of "busy".
- The bar borrows the composer's own background (`opaqueBg`) and drops its
  bottom corners when adjacent (`zs-bar-unified`), so bar and composer read as
  one band without a seam — a layout decision that encodes a real relationship.
- Contrast on the dark surface is comfortably above WCAG AA for every token
  that carries text.

## Platform notes

- This is a web layer, so Apple's native tab bars, sheets and menu bar do not
  apply. The applicable rules are the foundations (accessibility, typography,
  colour, layout, motion) plus the desktop guidance that interactive elements
  keep comfortable hit regions and pointer feedback.
- Control height uses `--zs-control-h` rather than a fixed pixel target; the
  macOS default control size is 28 pt with a 20 pt minimum
  (`accessibility.md › Mobility`). Confirm the rendered value with a browser
  measurement — source review cannot prove the final hit region.
- `tests/test_overlay_responsive.py::test_overlay_copies_are_identical` enforces
  that every `overlay.css` copy in the repository stays byte-identical to
  `snapgent-extension/overlay.css` (in `webmcp`, `snapgent-extension/overlay.css`
  is the single canonical copy; if `snapgent-app/extension/overlay.css` is present,
  it is checked automatically).
- Fase 4 (2026-11-22) added per-provider CSS token sets (dark + light) for
  Gemini, DeepSeek, Rudder, Ptero, Claude, and chat.z.ai (`glm`), documented in
  `snapgent-extension/DESIGN.md`, plus a `#zs-*` / `.zs-*` CSS isolation barrier
  in `snapgent-extension/overlay.css`.
- **Pending manual verification:** Live visual verification on all six sites
  (Gemini, DeepSeek, Rudder, Ptero, Claude, chat.z.ai) after reloading the
  extension still requires a real browser session.
