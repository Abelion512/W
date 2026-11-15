"""Draw the in-page bar's design scale as one picture (PR: token unification).

Every number in this image is read from overlay.css, so re-running the script
after a scale change re-shoots the picture instead of drifting from the code:

    python3 scripts/make_token_scale.py
"""
import re
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
CSS = ROOT / "snapgent-extension" / "overlay.css"
OUT = ROOT / "docs" / "assets" / "bar-token-scale.png"

W, H = 1080, 620
PAD = 40
BG = (20, 20, 28)
INK = (232, 232, 236)
DIM = (150, 150, 160)
ACCENT = (199, 210, 254)
GOLD = (234, 179, 8)


def font(size, bold=False):
    for name in (
        "DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf",
        "LiberationSans-Bold.ttf" if bold else "LiberationSans-Regular.ttf",
    ):
        for base in ("/usr/share/fonts/truetype/dejavu/", "/usr/share/fonts/truetype/liberation/"):
            p = Path(base + name)
            if p.exists():
                return ImageFont.truetype(str(p), size)
    return ImageFont.load_default()


def read_tokens():
    """Pull the scale out of the one place that defines it."""
    css = CSS.read_text()
    block = css[css.index(":root,") : css.index("--zs-weight-strong: var(--zs-w-bold);")]
    out = {}
    for name, value in re.findall(r"(--zs-[\w-]+):\s*([^;]+);", block):
        out[name] = value.strip()
    return out


def px(value):
    value = value.replace("var(", "").replace(")", "").strip()
    m = re.search(r"(\d+(?:\.\d+)?)px", value)
    return float(m.group(1)) if m else None


def main():
    tok = read_tokens()
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    d.text((PAD, PAD - 6), "one scale, one bar", font=font(30, True), fill=INK)
    d.text(
        (PAD, PAD + 34),
        "radius, space, type and control height are steps - a site re-points a token, it never adds pixels",
        font=font(15),
        fill=DIM,
    )

    # ── space ────────────────────────────────────────────────────────────────
    col = PAD
    d.text((col, 130), "SPACE  --zs-sp-*", font=font(15, True), fill=ACCENT)
    y = 162
    steps = [(k, px(v)) for k, v in tok.items() if k.startswith("--zs-sp-")]
    steps.sort(key=lambda kv: kv[1])
    for name, val in steps:
        d.rectangle([col, y, col + val * 3.2, y + 10], fill=(99, 102, 241))
        d.text((col + 110, y - 3), f"{int(val)}px", font=font(12), fill=INK)
        d.text((col + 158, y - 3), name.replace("--zs-", ""), font=font(12), fill=DIM)
        y += 26

    # ── radius ───────────────────────────────────────────────────────────────
    col = 400
    d.text((col, 130), "RADIUS  --zs-r-*", font=font(15, True), fill=ACCENT)
    y = 162
    steps = [(k, px(v)) for k, v in tok.items() if k.startswith("--zs-r-")]
    steps.sort(key=lambda kv: (kv[1] > 900, kv[1]))
    for name, val in steps:
        r = 15 if val > 900 else val
        d.rounded_rectangle([col, y, col + 62, y + 30], radius=r, outline=(99, 102, 241), width=2)
        label = "pill" if val > 900 else f"{int(val)}px"
        d.text((col + 76, y + 7), f"{label:<6} {name.replace('--zs-', '')}", font=font(12), fill=INK)
        y += 40

    # ── type + control height ────────────────────────────────────────────────
    col = 700
    d.text((col, 130), "TYPE  --zs-text-*", font=font(15, True), fill=ACCENT)
    y = 158
    steps = [(k, px(v)) for k, v in tok.items() if k.startswith("--zs-text-")]
    steps.sort(key=lambda kv: kv[1])
    for name, val in steps:
        f = font(max(11, int(round(val))))
        d.text((col, y), "Active · 30 tools", font=f, fill=INK)
        d.text((col + 250, y + 1), f"{val:g}px", font=font(12), fill=DIM)
        y += 28

    ch = tok.get("--zs-control-h", "32px")
    d.line([PAD, 540, W - PAD, 540], fill=(60, 60, 72), width=1)
    label = "every control is one height:"
    d.text((PAD, 556), label, font=font(15), fill=DIM)
    bx = PAD + d.textlength(label, font=font(15)) + 18
    d.rounded_rectangle([bx, 548, bx + 120, 548 + 34], radius=17, fill=GOLD)
    d.text((bx + 34, 558), "Stop", font=font(14, True), fill=(0, 0, 0))
    d.text((bx + 140, 556), f"--zs-control-h = {ch}", font=font(14, True), fill=INK)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    img.save(OUT)
    print("wrote", OUT.relative_to(ROOT), img.size)


if __name__ == "__main__":
    main()
