"""Responsive, design-review, per-provider token, and isolation contracts for overlay.css.

Every fixed surface anchored to a viewport edge must be capped by the viewport
width. A bare pixel width hangs off the opposite edge on a narrow window —
measured live, the setup card (``width: 288px`` with ``right: 18px``) reached
x = -26 at vw = 280.

Also verifies Fase 2D / Fase 4 overlay requirements:
- all overlay.css copies in the repository remain byte-identical;
- all four findings from docs/design-review-overlay-2026-11-21.md stay closed;
- per-provider CSS tokens exist (dark + light) and are documented in DESIGN.md
  for Gemini, DeepSeek, Rudder, Ptero, Claude, and chat.z.ai (glm);
- the #zs-* / .zs-* CSS isolation barrier protects overlay typography and box sizing.
"""

import re
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
CANONICAL_OVERLAY = REPO / "snapgent-extension" / "overlay.css"
DESIGN_DOC = REPO / "snapgent-extension" / "DESIGN.md"
REVIEW_DOC = REPO / "docs" / "design-review-overlay-2026-11-21.md"
REQUIRED_PROVIDERS = ("gemini", "deepseek", "rudder", "ptero", "claude", "glm")


def _overlay_copies():
    copies = [p for p in REPO.rglob("overlay.css") if ".git" not in p.parts]
    return sorted(copies) if copies else [CANONICAL_OVERLAY]


def _rules(css):
    """Yield (selector, body) for plain rules, skipping @media preludes."""
    for match in re.finditer(r"([^{}]+)\{([^{}]*)\}", css):
        selector = match.group(1).strip()
        if selector.startswith("@"):
            continue
        yield selector, match.group(2)


class OverlayResponsiveTests(unittest.TestCase):
    def test_overlay_copies_are_identical(self):
        self.assertTrue(CANONICAL_OVERLAY.is_file(), "canonical overlay.css missing")
        canonical = CANONICAL_OVERLAY.read_text(encoding="utf-8")
        self.assertTrue(canonical.strip(), "canonical overlay.css must not be empty")
        copies = _overlay_copies()
        self.assertIn(CANONICAL_OVERLAY, copies)
        for path in copies:
            self.assertEqual(
                path.read_text(encoding="utf-8"),
                canonical,
                f"{path.relative_to(REPO)} drifted from snapgent-extension/overlay.css",
            )

    def test_edge_anchored_fixed_surfaces_are_viewport_capped(self):
        for path in _overlay_copies():
            css = path.read_text(encoding="utf-8")
            offenders = []
            for selector, body in _rules(css):
                if "position: fixed" not in body:
                    continue
                if "right:" not in body and "left:" not in body:
                    continue
                widths = re.findall(r"(?:max-)?width:\s*([^;]+);", body)
                if not widths:
                    continue
                if not any("vw" in width or "min(" in width for width in widths):
                    offenders.append((selector, widths))
            self.assertEqual(
                offenders,
                [],
                f"{path.name}: uncapped edge-anchored fixed widths: {offenders}",
            )

    def test_setup_card_and_toast_use_viewport_caps(self):
        """The two surfaces that actually overflowed, named explicitly."""
        for path in _overlay_copies():
            css = path.read_text(encoding="utf-8")
            setup = " ".join(
                body for selector, body in _rules(css) if selector.endswith("#zs-setup")
            )
            toast = " ".join(
                body for selector, body in _rules(css) if selector.endswith(".zs-toast")
            )
            self.assertIn("min(288px, calc(100vw - 36px))", setup)
            self.assertIn("min(300px, calc(100vw - 36px))", toast)
            self.assertIn("box-sizing: border-box", setup)
            self.assertIn("box-sizing: border-box", toast)

    def test_design_review_findings_resolved(self):
        css = CANONICAL_OVERLAY.read_text(encoding="utf-8")
        # 1. High: light-appearance .zs-site-go must not use low-contrast #9ca3af.
        self.assertNotIn("#9ca3af", css)
        self.assertRegex(
            css, r"html\.zs-light\s+\.zs-site-go\s*\{[^}]*color:\s*(?:#1d4ed8|var\(--zs-accent\))"
        )
        # 2. Medium: reduced-motion hides #zs-composer-glow::before (opacity: 0).
        self.assertRegex(
            css,
            r"@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?#zs-composer-glow::before\s*\{[^}]*opacity:\s*0\s*;",
        )
        # 3. Medium: restrained backdrop blur (12px / 1.15), not 24px / 1.3.
        self.assertIn("blur(12px) saturate(1.15)", css)
        self.assertNotIn("blur(24px)", css)
        # 4. Low: #zs-unstable uses accent/blue-family border, never amber 251, 191, 36.
        self.assertNotIn("251, 191, 36", css)
        self.assertNotIn("#fbbf24", css.lower())
        # Review report records all 4 improvements as completed.
        review = REVIEW_DOC.read_text(encoding="utf-8")
        self.assertEqual(len(re.findall(r"^- \[x\] \*\*(?:High|Medium|Low)", review, re.M)), 4)

    def test_per_provider_tokens_defined_and_documented(self):
        css = CANONICAL_OVERLAY.read_text(encoding="utf-8")
        design = DESIGN_DOC.read_text(encoding="utf-8")
        for provider in REQUIRED_PROVIDERS:
            dark_pattern = (
                rf"html\.zs-site-{provider}\s*,\s*#zs-bar\.zs-prov-{provider}\s*\{{([^}}]*)\}}"
            )
            dark_match = re.search(dark_pattern, css)
            self.assertIsNotNone(dark_match, f"missing dark token block for {provider}")
            dark_body = dark_match.group(1)
            for token in ("--zs-font-ui:", "--zs-surface:", "--zs-accent:", "--zs-hairline:", "--zs-bar-radius:"):
                self.assertIn(token, dark_body, f"{provider} dark tokens missing {token}")

            light_pattern = (
                rf"html\.zs-light\.zs-site-{provider}\s*,\s*html\.zs-light\s+#zs-bar\.zs-prov-{provider}\s*\{{([^}}]*)\}}"
            )
            light_match = re.search(light_pattern, css)
            self.assertIsNotNone(light_match, f"missing light token block for {provider}")
            light_body = light_match.group(1)
            for token in ("--zs-surface:", "--zs-accent:", "--zs-hairline:"):
                self.assertIn(token, light_body, f"{provider} light tokens missing {token}")

            self.assertIn(f"`{provider}`", design, f"DESIGN.md missing provider {provider}")

    def test_css_isolation_barrier_present(self):
        css = CANONICAL_OVERLAY.read_text(encoding="utf-8")
        self.assertIn("isolation: isolate;", css)
        self.assertIn("text-transform: none;", css)
        self.assertIn("appearance: none;", css)
        self.assertIn(":is(#zs-root, #zs-bar,", css)

    def test_chip_body_and_composer_height_lock_rules(self):
        css = CANONICAL_OVERLAY.read_text(encoding="utf-8")
        chip_open = " ".join(
            body for selector, body in _rules(css) if ".zs-chip.open .zs-chip-body" in selector
        )
        self.assertIn("max-height:", chip_open)
        self.assertIn("vh", chip_open)
        self.assertIn("overflow-y: auto", chip_open)
        self.assertIn("overscroll-behavior: contain", chip_open)

        height_lock = " ".join(
            body for selector, body in _rules(css) if ".zs-typing.zs-height-locked" in selector
        )
        self.assertIn("height: var(--zs-lock-h) !important", height_lock)
        self.assertIn("min-height: var(--zs-lock-h) !important", height_lock)
        self.assertIn("max-height: var(--zs-lock-h) !important", height_lock)
        self.assertIn("overflow: hidden !important", height_lock)

        state_rule = " ".join(
            body for selector, body in _rules(css) if selector.endswith("#zs-state")
        )
        self.assertIn("min-height: var(--zs-control-h)", state_rule)


if __name__ == "__main__":
    unittest.main()
