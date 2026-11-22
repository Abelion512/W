# UI overlay: implementation notes

Design decisions and tokens live in `snapgent-extension/DESIGN.md`. This page
is the implementation and maintenance reference.

## Files

| File | Responsibility |
|---|---|
| `snapgent-extension/core/main.js` | builds `#zs-bar` / `#zs-composer-glow`; `placeBar()` positions both each frame; `showStop()` sets `data-agent-active` |
| `snapgent-extension/overlay.css` | tokens, surfaces, ring, chips, accessibility media queries |
| `snapgent-extension/providers/base.js` | shared thin base helper (`ZSProviderBase`): stream tracking, WeakMap turn IDs, `MutationObserver` DOM/stop watchers, and default provider adapters |
| `snapgent-extension/providers/*.js` | site-specific selectors, `barMount`, `barAnchor`, `composerFrame`, `getEditor` overriding `ZSProviderBase` |

## Event-driven architecture

DOM observation and lifecycle scheduling no longer use `setInterval` polling:

- **Content scripts (`core/main.js`, `core/dom-engine.js`, `core/ui-controller.js`)**: DOM camouflage sweeps, live generation/token-meter ticks, auto-resume checks, loop stall watchdog, and host theme tracking are driven by `MutationObserver`, `visibilitychange`, `matchMedia`, `PerformanceObserver` (`longtask`), and an `onStop` event bus (with one-shot `setTimeout` debouncing only while active).
- **Providers (`providers/base.js`, `providers/*.js`)**: shared boilerplate lives in `ZSProviderBase` (`providers/base.js`, loaded before each provider in `manifest.json`). Dynamic stop-button waits (`arena.js`, `rudder.js`), locked placeholder re-assertion (`kimi.js`), and CodeMirror syncing (`chatgpt-cm.js`) use `MutationObserver`.
- **Service worker (`background.js`)**: `waitForConnection` resolves via socket `onopen` waiters, and heartbeat/stale-socket checks (`ZSGuard.heartbeatDecision`) run on the 30-second MV3 `chrome.alarms` (`zs-keepalive`) alarm.

## Positioning loop

`placeBar()` runs on `requestAnimationFrame`. For the ring it:

1. Reads `composerFrame()` for the visible composer card and its radius.
2. Uses `composerFrame()` in every mode; DeepSeek DeepThink/Search controls
   stay inside the ring because they belong to the same input unit.
3. Computes the union of bar rect and target rect when they are adjacent
   (gap < 24 px and horizontal overlap).
4. Sets the ring's left/top/width/height and clamped radius (18–24 px).
5. Marks the bar `zs-bar-unified`, copies `opaqueBg(target)` into its
   background, and zeroes its bottom seam.
6. For in-flow bars, sets `width` and `marginLeft` from the composer rect so
   the bar and input share the same left edge and width.

## Motion

None. The ring is a static `box-shadow`. Earlier conic-gradient/mask rotation
was removed to keep the overlay as light as possible; `prefers-reduced-motion`
still disables remaining transitions.

## Verification checklist

```
node --check snapgent-extension/core/main.js
python3 -m unittest discover -s tests
```

Live, in a CDP browser with the extension loaded, evaluate `#zs-bar` and
`#zs-composer-glow` rects:

- Gemini: bar and composer share `left` and `width`; ring wraps both.
- DeepSeek: ring bottom stops at the editor, not below the mode buttons.
- Rudder / Ptero: ring follows the anchored composer.
- Bar top radius present, bottom seam absent.

## Known limits

- `zsBackgroundSessions` is read at content-script load; toggling storage needs
  a page reload to take effect.
- Hidden tabs throttle timers; deep A2A tasks can stall even with the flag on.
- The snapshot of the composer colour comes from computed `backgroundColor`;
  gradient or image-backed composers fall back to an approximate solid.
