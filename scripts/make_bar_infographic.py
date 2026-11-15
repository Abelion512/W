"""Compose the before/after infographic for the in-page bar (PR #31).

Cropping is fractional so it survives a different window size: each panel shows
the composer area only, which is where the change is.
"""
from PIL import Image, ImageDraw, ImageFont
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "assets" / "bar-seating-before-after.png"

# (site, before, after, before-box, after-box); boxes are fractions of the frame
# (x0, x1, y0, y1), and the after-box may differ because Grok's composer moves.
ROWS = [
    ("Claude", "/tmp/bar-claude.png", "/tmp/v3-claude.ai.png", (0.21, 0.79, 0.77, 0.99), (0.21, 0.79, 0.77, 0.99)),
    ("Gemini", "/tmp/bar-gemini.png", "/tmp/v3-gemini.google.com.png", (0.24, 0.79, 0.71, 0.98), (0.24, 0.79, 0.71, 0.98)),
    ("GLM", "/tmp/bar-glm.png", "/tmp/v4-glm.png", (0.29, 0.86, 0.65, 1.0), (0.29, 0.86, 0.65, 1.0)),
    ("Grok", "/tmp/bar-grok2.png", "/tmp/grok-live.png", (0.27, 0.89, 0.24, 0.52), (0.27, 0.95, 0.78, 1.0)),
]

PANEL_W = 760
PAD = 24
LABEL_H = 34
GAP = 10


def font(size, bold=False):
    for name in (
        "DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf",
        "LiberationSans-Bold.ttf" if bold else "LiberationSans-Regular.ttf",
    ):
        for base in ("/usr/share/fonts/truetype/dejavu/", "/usr/share/fonts/truetype/liberation/"):
            try:
                return ImageFont.truetype(base + name, size)
            except OSError:
                continue
    return ImageFont.load_default()


def crop(path, frac):
    img = Image.open(path).convert("RGB")
    w, h = img.size
    x0, x1, y0, y1 = frac
    box = (int(w * x0), int(h * y0), int(w * x1), int(h * y1))
    part = img.crop(box)
    scale = PANEL_W / part.width
    return part.resize((PANEL_W, max(1, int(part.height * scale))), Image.LANCZOS)


def main():
    title_f, site_f, tag_f = font(30, True), font(22, True), font(17, True)
    crops = [(site, crop(b, fb), crop(a, fa)) for site, b, a, fb, fa in ROWS]
    row_h = [max(b.height, a.height) + LABEL_H for _, b, a in crops]

    width = PAD * 2 + PANEL_W * 2 + GAP
    height = PAD * 2 + 54 + sum(row_h) + GAP * (len(crops) - 1) + PAD
    canvas = Image.new("RGB", (width, height), (17, 18, 22))
    d = ImageDraw.Draw(canvas)
    d.text((PAD, PAD - 4), "Snapgent in-page bar: before / after", font=title_f, fill=(236, 237, 242))

    y = PAD + 54
    for (site, before, after), rh in zip(crops, row_h):
        d.text((PAD, y), site, font=site_f, fill=(160, 200, 255))
        d.text((PAD + PANEL_W + GAP, y), "", font=site_f, fill=(160, 200, 255))
        y += LABEL_H
        for x, img, tag, colour in (
            (PAD, before, "before", (248, 113, 113)),
            (PAD + PANEL_W + GAP, after, "after", (74, 222, 128)),
        ):
            canvas.paste(img, (x, y))
            d.rectangle([x, y, x + 88, y + 26], fill=colour)
            d.text((x + 10, y + 4), tag, font=tag_f, fill=(15, 16, 20))
            d.rectangle([x, y, x + PANEL_W - 1, y + img.height - 1], outline=(70, 72, 82))
        y += rh
        if (site, before, after) != crops[-1]:
            y += GAP

    OUT.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(OUT, optimize=True)
    print("wrote", OUT, canvas.size)


if __name__ == "__main__":
    main()
