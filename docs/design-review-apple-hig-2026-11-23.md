# Design review: snapgentV3 surfaces, Apple HIG base

Date: 2026-11-23
Base: `dickwu/apple-design-skill` HIG snapshot in
`.agents/skills/apple-design/references/`. Reviewed as source (HTML/CSS/JS),
not a live browser render; contrast and sizes are computed from declared values.

## Summary

**Good.** No Critical findings. The injected bar keeps one clear idea — a quiet
control band fused to the composer, with a hairline ring that appears only while
an agent turn runs — and its tokens, focus states, and reduced-motion answers
are in place. The popup now meets WCAG AA in both system appearances after the
earlier audit and this review. One Low platform gap remains: Unicode glyphs
standing in for a vector icon set. Overall rating: **Good**.

Platform and framework: desktop Chrome/Edge extension, plain DOM/CSS injected
into third-party chat sites, plus a static docs site. Per
`cross-platform.md › Vocabulary`, macOS maps to desktop web, semantic colors to
CSS custom properties, `NSVisualEffectView` to `backdrop-filter`, and VoiceOver
to ARIA. Native conventions (menu bar, window controls, sheets) do not apply.

## Critical

None.

## Improvements

### Medium — Popup used only a dark appearance — fixed

- **Location:** `snapgent-extension/popup.html`, `:root` token block.
- **Why:** `dark-mode.md › Best practices`: "Ensure that your app looks good in
  both appearance modes." The popup was a dark fixed palette, so people with a
  light system appearance still got a dark surface.
- **Fix:** added `@media (prefers-color-scheme: light)` overrides and
  `<meta name="color-scheme" content="dark light">`. Hardcoded fills moved to
  tokens (`--wrap-top`, `--accent-glow`, `--accent-soft-*`, `--code-bg`,
  `--highlight`, `--halo-*`). Verified in real Chrome with emulated light OS
  appearance: surface `#f2f3f7`, body text 14.47:1, secondary text 5.98:1.
  Dark appearance unchanged at 18.06:1. Guard: `e2e/ui_theme_e2e.py`.

### Low — Unicode glyphs stand in for icons

- **Location:** `popup.html` buttons `↻ Reconnect`, `⟳ Restart`, `⚙ Settings…`.
- **Why:** `icons.md › Best practices`: "Maintain visual consistency across all
  interface icons in your app" and use vector formats. These glyphs come from
  the system font and vary in weight across platforms.
- **Fix:** either drop them — `buttons.md › Content` allows text when a short
  label is clearer — or replace all three with one weight-matched SVG set.
  The coloured emoji were already removed in the earlier audit; text labels
  carry the meaning today, so the remaining glyphs are decorative.

### Low — Browser text scaling has no explicit contract

- **Why:** `typography.md › Desktop (macOS)` notes macOS has no Dynamic Type;
  on the web the equivalent is browser zoom and font-size settings.
  `layout.md › Adaptability` requires layouts to survive size changes.
- **Fix:** verify the fixed 460 px popup and the overlay bar at 200% zoom and
  largest text size; make the popup width `min(460px, 100vw)` if it clips.
  Cannot be proven from source; marked as manual verification, not a defect.

## Craft notes

- **Point of view:** the orbit is the signature. `motion.md › Best practices`
  says "Add motion purposefully" and "Make motion optional"; the ring is bound
  to `data-agent-active`, has a `prefers-reduced-motion` answer, and the Stop
  button carries the same meaning in text. Delight is earned, not decoration.
- **One color, one meaning:** accent is reserved for the primary action and
  focus; green/amber/red are status only. Matches `color.md › Best practices`.
- **Material:** `backdrop-filter` appears only on the floating bar.
  `materials.md › Liquid Glass` says "Don't use Liquid Glass in the content
  layer"; chips and content stay opaque.
- **Restraint:** one accessory could go — the version label in the header. It
  earns its place because it changes when the bridge and extension versions
  differ, which is the only time the number matters.

## What works

- Semantic tokens with dark/light and per-provider overrides; no raw hex in
  components (`color.md › Best practices`).
- All buttons keep text labels and a `:active` press state
  (`buttons.md › Best practices`: "Always include a press state for a custom
  button").
- Visible `:focus-visible` rings and `aria-pressed` on the workflow note
  buttons (`accessibility.md › Speech`).
- Prefers-reduced-motion, reduced-transparency, and increased-contrast answers
  in the overlay (`accessibility.md › Vision`).
- Verb-first button labels with a trailing ellipsis where a view opens
  (`writing.md › Best practices`, `buttons.md › Desktop (macOS)`).
- Workflow page heading order is h1 → h2 after the earlier fix
  (`accessibility.md › Vision` and document outline).

## Platform notes

- This is a desktop web layer, so the native menu bar and window conventions
  from `designing-for-macos.md` do not transfer. Pointer feedback, hover, and
  comfortable hit regions do.
- macOS type guidance is written in points; this project declares CSS px.
  Body 13 px, metadata 11–12 px follows the same default/minimum relationship
  as 13 pt / 10 pt at standard zoom.
- Popup is a browser-action panel, not a resizable window, so
  `layout.md › Desktop (macOS)` ("Avoid placing controls at the bottom of a
  window") applies only weakly: the bottom holds a hint, not a critical control.

## Decisions applied from this review

- `snapgent-extension/popup.html`: `Settings` → `Settings…` because it opens a
  panel on another tab (`buttons.md › Desktop (macOS)`).
- System-appearance token overrides added and verified with the TDD e2e slice
  (`e2e/ui_theme_e2e.py`: red 5/6 → green 6/6).
- Base-design table added to `snapgent-extension/DESIGN.md`.
- Earlier WCAG and workflow fixes remain recorded in
  `docs/ui-audit-2026-11-23.md`.
