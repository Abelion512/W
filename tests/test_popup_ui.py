"""Legibility contract for the extension popup (WCAG AA on its dark surfaces).

Regression guard for the UI audit in docs/ui-audit-2026-11-23.md: the old
``--muted-2`` token was 3.5:1 on the popup surfaces and sub-12px labels made
the status and pairing copy hard to read.
"""

import re
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
POPUP = REPO / "snapgent-extension" / "popup.html"
POPUP_JS = REPO / "snapgent-extension" / "popup.js"
SURFACES = ("#16161a", "#161825", "#0b0b0d")
AA_MIN = 4.5
FONT_FLOOR_PX = 11


def _luminance(hex_color):
    channels = [int(hex_color[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    linear = [c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4 for c in channels]
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]


def _contrast(a, b):
    high, low = sorted((_luminance(a), _luminance(b)), reverse=True)
    return (high + 0.05) / (low + 0.05)


class PopupUiTests(unittest.TestCase):
    def test_muted_token_meets_aa_on_every_popup_surface(self):
        css = POPUP.read_text(encoding="utf-8")
        match = re.search(r"--muted-2:\s*(#[0-9a-f]{6})", css, re.I)
        self.assertIsNotNone(match, "popup.html missing --muted-2 token")
        token = match.group(1)
        for surface in SURFACES:
            self.assertGreaterEqual(
                _contrast(token, surface), AA_MIN,
                f"{token} on {surface} fails WCAG AA body contrast",
            )

    def test_no_sub_floor_font_sizes(self):
        css = POPUP.read_text(encoding="utf-8")
        sizes = [float(x) for x in re.findall(r"font-size:\s*([\d.]+)px", css)]
        self.assertTrue(sizes)
        self.assertEqual([x for x in sizes if x < FONT_FLOOR_PX], [])

    def test_no_emoji_as_button_icons(self):
        for path in (POPUP, POPUP_JS):
            text = path.read_text(encoding="utf-8")
            emoji = [c for c in text if ord(c) > 0xFFFF]
            self.assertEqual(emoji, [], f"{path.name} uses emoji as icons: {emoji}")


if __name__ == "__main__":
    unittest.main()
