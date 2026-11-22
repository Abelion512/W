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

- **High — light-appearance link colour fails contrast.** `.zs-site-go` is set
  to `#9ca3af` on the light surface `#fffef0`, which computes to **2.50:1**.
  HIG guidance requires 4.5:1 for text up to 17 pt
  (`accessibility.md › Vision`, "Strive to meet color contrast minimum
  standards"; `typography.md › Ensuring legibility`). Nearby light-theme values
  already clear the bar: `#6b7280` = 4.76:1, `#1d4ed8` = 6.60:1. **Fix:** set
  `html.zs-light .zs-site-go { color: #1d4ed8; }` (6.60:1), matching the
  adjacent `#1d4ed8` gear and badge colours so one colour keeps one meaning.
- **Medium — reduced-motion fallback freezes the orbit at a bright angle.**
  The `@media (prefers-reduced-motion: reduce)` block sets
  `#zs-composer-glow::before { animation: none; opacity: .55; }`, leaving a
  static bright arc. HIG says motion must be optional and never the only
  carrier of meaning (`motion.md › Best practices`, "Make motion optional"),
  which the Stop button satisfies; however a static arc still reads as a
  permanent decoration. **Fix:** set `opacity: 0` under reduced motion and rely
  on the Stop button and status text alone for state.
- **Medium — strong blur on a small, frequently visible bar.** The bar uses
  `backdrop-filter: blur(24px) saturate(1.3)`. HIG permits translucency on the
  functional layer (`color.md › Liquid Glass color`, "Apply color sparingly to
  the Liquid Glass material") but warns against overpowering nearby content.
  24 px blur plus saturation is heavier than the restrained hairline used
  elsewhere. **Fix:** reduce to `blur(12px) saturate(1.15)` and keep the 1 px
  hairline as the edge cue; verify legibility over the lightest provider themes.
- **Low — the amber warning pill keeps a warm border on the new blue face.**
  `#zs-unstable` now uses blue text (`#60a5fa`) but retains
  `border: 1px solid rgba(251, 191, 36, 0.4)` and a warm hover background.
  `color.md › Best practices` says "Avoid using the same color to mean
  different things"; a half-converted pill muddies the meaning. **Fix:** switch
  border and hover to the blue-family values already used by the menu.

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
- The Electron mirror shares the same stylesheet, so any fix here must be
  copied to `snapgent-app/extension/overlay.css`; the repository test
  `test_overlay_copies_are_identical` enforces this.
- Visual verification on all four providers (Rudder, Ptero, Gemini, DeepSeek)
  and the post-reload appearance still require a live browser; this review
  cannot substitute for that check.
