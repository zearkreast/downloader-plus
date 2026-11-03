"""
Universal Media Downloader+ — application icon generator.

Mark concept: an eight-blade aperture with a plus in its opening. It says
"capture, from any source" without falling back on the download-arrow cliche,
and the plus is the name's own.

The whole mark is arithmetic. The opening is a regular octagon, and extending
each of its edges past the corner gives the pinwheel of lines an iris is made
of. A blade is what lies between two neighbouring lines inside the disc:

    n[i]   . p <= apothem - seam / 2     inside this edge's line
    n[i+1] . p >= apothem + seam / 2     outside the next one's
    |p| <= radius

The two half-planes meet in a wedge whose tip sits at a corner of the opening,
and the seam is the distance kept from each line. Each blade is lit from its
tip to the rim, and the blades as a set from the upper left, which is what
turns a flat ring of wedges into something that seems to have depth.

The mark is drawn flat on transparency and nothing else: it has to carry itself
in a Windows title bar at 16px and in the notification area at 20px, where there
is no tile to hold its shape. That is what set the proportions below. Seams
narrower than a pixel at 16px read as a grey wash rather than a cut.

The same proportions are written twice more -- as vectors in
src/components/layout/Logo.tsx, and as a pixel test in
scripts/extension/make-icons.mjs. Change one and you have to change all three.

There is a second output, and it is the same mark with more air around it.
Android composes a launcher icon from a foreground drawn on a 108dp canvas of
which only the middle 72dp is guaranteed to survive the launcher's mask, so a
foreground that reaches the edge loses its rim to whatever shape the phone
crops to. The Tauri CLI has an `android_fg_scale` for exactly this and it does
nothing in the version this repository uses, measured rather than assumed, so
the inset is drawn in instead.

There is a third, for the Android status bar. Android draws a notification's
small icon from its alpha alone and tints it itself, so anything with colour or
a missing asset comes out as a white blob or the system's stand-in glyph. It is
the mark in pure white, rasterised per density rather than as a vector drawable
because a vector drawable has no masks and the seams are subtractions.

Run:  python scripts/generate/icon.py
Out:  src-tauri/icons/icon-source-flat.png  1024x1024 bare mark, transparent
      src-tauri/icons/icon-source-fg.png    the same, inset for Android
      docs/logo.png                         the README's copy
      src-tauri/gen/android/.../drawable-*dpi/ic_stat_mark.png  status bar
"""
from __future__ import annotations

import math
import os

from PIL import Image, ImageDraw

SIZE = 1024
SS = 4  # supersample factor; downsampled with LANCZOS for clean edges
S = SIZE * SS

EMBER = (255, 78, 44)
AMBER = (255, 168, 56)

BLADES = 8

# All as a fraction of the disc's diameter, so the shape is resolution-free.
INNER_R = 0.30
SEAM_W = 0.058
PLUS_SPAN = 0.30
PLUS_W = 0.10

# A flat edge of the opening faces up, so the plus sits square inside it.
ROTATION = -90 + 180 / BLADES

# Where the light comes from, in degrees; the upper left.
LIGHT = -125

# The disc's share of the square it is drawn into. The margin is what keeps the
# rim off the edge of a title-bar icon, which otherwise looks wedged in.
MARK_FILL = 0.94

# The same share for the Android adaptive foreground, chosen to sit inside the
# 72dp of a 108dp canvas that a launcher mask cannot crop.
ANDROID_FILL = 0.60

# The status-bar icon is a 24dp square with a 1dp keyline around its live area.
STATUS_FILL = 22 / 24
STATUS_DENSITIES = {"mdpi": 24, "hdpi": 36, "xhdpi": 48, "xxhdpi": 72, "xxxhdpi": 96}


def lerp(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


def intersect(n1, c1, n2, c2):
    """The point where n1.p = c1 and n2.p = c2."""
    det = n1[0] * n2[1] - n1[1] * n2[0]
    return ((c1 * n2[1] - c2 * n1[1]) / det, (n1[0] * c2 - n2[0] * c1) / det)


def to_rim(point, direction, radius):
    """Where the ray from `point` along the unit `direction` leaves the disc."""
    b = point[0] * direction[0] + point[1] * direction[1]
    c = point[0] ** 2 + point[1] ** 2 - radius**2
    t = -b + math.sqrt(b * b - c)
    return (point[0] + direction[0] * t, point[1] + direction[1] * t)


def blades(radius: float):
    """Every blade around the origin: its tip and its two points on the rim.

    A blade runs from `tip` along one line to `near`, round the rim to `far`,
    and back along the other.
    """
    diameter = radius * 2
    step = 2 * math.pi / BLADES
    first = math.radians(ROTATION) + step / 2
    apothem = diameter * INNER_R * math.cos(step / 2)
    half_seam = diameter * SEAM_W / 2

    normal = lambda i: (math.cos(first + i * step), math.sin(first + i * step))
    along = lambda i: (-math.sin(first + i * step), math.cos(first + i * step))

    out = []
    for i in range(BLADES):
        tip = intersect(normal(i), apothem - half_seam, normal(i + 1), apothem + half_seam)
        near = to_rim(tip, along(i), radius)
        far = to_rim(tip, along(i + 1), radius)
        out.append({"index": i, "tip": tip, "near": near, "far": far})
    return out


def blade_outline(blade, radius, cx, cy, steps=96):
    a0 = math.atan2(blade["near"][1], blade["near"][0])
    a1 = math.atan2(blade["far"][1], blade["far"][0])
    if a1 < a0:
        a1 += 2 * math.pi
    points = [blade["tip"]]
    for k in range(steps + 1):
        angle = a0 + (a1 - a0) * k / steps
        points.append((radius * math.cos(angle), radius * math.sin(angle)))
    return [(cx + x, cy + y) for x, y in points]


def blade_colours(blade):
    """The colour at the blade's tip and at the middle of its rim."""
    tip, near, far = blade["tip"], blade["near"], blade["far"]
    mid = math.atan2(near[1] + far[1], near[0] + far[0])
    lit = 0.5 + 0.5 * math.cos(mid - math.radians(LIGHT))
    return lerp(EMBER, AMBER, lit * 0.35), lerp(EMBER, AMBER, 0.35 + lit * 0.65)


def blade_paint(blade, radius, size, canvas, cx, cy):
    """A linear gradient from the tip to the middle of the rim, as an RGB image."""
    tip, near, far = blade["tip"], blade["near"], blade["far"]
    mid = math.atan2(near[1] + far[1], near[0] + far[0])
    end = (radius * math.cos(mid), radius * math.sin(mid))
    dx, dy = end[0] - tip[0], end[1] - tip[1]
    length = dx * dx + dy * dy
    start_colour, end_colour = blade_colours(blade)

    n = 96
    scale = size / (n - 1)
    grad = Image.new("RGB", (n, n))
    px = grad.load()
    for y in range(n):
        for x in range(n):
            ox = x * scale - cx - tip[0]
            oy = y * scale - cy - tip[1]
            t = max(0.0, min(1.0, (ox * dx + oy * dy) / length))
            px[x, y] = tuple(round(v) for v in lerp(start_colour, end_colour, t))
    return grad.resize((canvas, canvas), Image.Resampling.BICUBIC)


def plus_boxes(radius: float):
    half = radius * 2 * PLUS_SPAN / 2
    arm = radius * 2 * PLUS_W / 2
    return half, arm


def draw_plus(d: ImageDraw.ImageDraw, c: float, radius: float, fill):
    half, arm = plus_boxes(radius)
    corner = arm * 0.42
    d.rounded_rectangle((c - half, c - arm, c + half, c + arm), corner, fill=fill)
    d.rounded_rectangle((c - arm, c - half, c + arm, c + half), corner, fill=fill)


def mark_mask(size: int) -> Image.Image:
    """Everything the mark covers, as alpha."""
    c = size / 2
    radius = size / 2
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    for blade in blades(radius):
        d.polygon(blade_outline(blade, radius, c, c), fill=255)
    draw_plus(d, c, radius, 255)
    return mask


def build_mark(size: int) -> Image.Image:
    c = size / 2
    radius = size / 2
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))

    for blade in blades(radius):
        mask = Image.new("L", (size, size), 0)
        ImageDraw.Draw(mask).polygon(blade_outline(blade, radius, c, c), fill=255)
        paint = blade_paint(blade, radius, size, size, c, c).convert("RGBA")
        layer.paste(paint, (0, 0), mask)

    half, _ = plus_boxes(radius)
    mask = Image.new("L", (size, size), 0)
    draw_plus(ImageDraw.Draw(mask), c, radius, 255)
    n = 96
    grad = Image.new("RGB", (n, n))
    px = grad.load()
    for y in range(n):
        for x in range(n):
            t = (x / (n - 1) + y / (n - 1)) / 2
            # Measured across the plus, not the canvas, so it spans the colours.
            t = max(0.0, min(1.0, (t - 0.5) * radius / half + 0.5))
            px[x, y] = tuple(round(v) for v in lerp(AMBER, EMBER, t))
    paint = grad.resize((size, size), Image.Resampling.BICUBIC).convert("RGBA")
    layer.paste(paint, (0, 0), mask)
    return layer


def build_icon(fill: float = MARK_FILL) -> Image.Image:
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    mark = build_mark(int(S * fill))
    off = (S - mark.width) // 2
    img.alpha_composite(mark, (off, off))
    return img.resize((SIZE, SIZE), Image.Resampling.LANCZOS)


def build_status_icon(px: int) -> Image.Image:
    """White mark on transparency at `px` square, for a notification."""
    big = px * 16
    mark = int(big * STATUS_FILL)
    alpha = Image.new("L", (big, big), 0)
    off = (big - mark) // 2
    alpha.paste(mark_mask(mark), (off, off))
    img = Image.new("RGBA", (big, big), (255, 255, 255, 0))
    img.putalpha(alpha)
    return img.resize((px, px), Image.Resampling.LANCZOS)


def write_preview(src: Image.Image, path: str):
    """A strip at the sizes that actually decide the shape, on both grounds.

    Over one ground only it is easy to believe the mark still reads when what
    the eye is really following is the contrast, so the same row is laid over
    the dark title bar and a light one.
    """
    sizes = (16, 20, 24, 32, 48)
    zoom, pad = 6, 8
    row = 48 * zoom + pad * 2
    width = pad + sum(s * zoom + pad for s in sizes)

    strip = Image.new("RGB", (width, row * 2))
    for index, ground in enumerate(((0x20, 0x20, 0x20), (0xF3, 0xF3, 0xF3))):
        band = Image.new("RGB", (width, row), ground)
        x = pad
        for s in sizes:
            tile = src.resize((s, s), Image.Resampling.LANCZOS)
            big = tile.resize((s * zoom, s * zoom), Image.Resampling.NEAREST)
            under = Image.new("RGBA", big.size, ground + (255,))
            under.alpha_composite(big)
            band.paste(under.convert("RGB"), (x, (row - s * zoom) // 2))
            x += s * zoom + pad
        strip.paste(band, (0, row * index))
    strip.save(path)


def main():
    here = os.path.dirname(__file__)
    root = os.path.join(here, "..", "..")
    out_dir = os.path.join(root, "src-tauri", "icons")
    os.makedirs(out_dir, exist_ok=True)

    icon = build_icon()
    icon.save(os.path.join(out_dir, "icon-source-flat.png"))
    build_icon(ANDROID_FILL).save(os.path.join(out_dir, "icon-source-fg.png"))
    write_preview(icon, os.path.join(here, "icon-preview.png"))
    docs = os.path.join(root, "docs")
    os.makedirs(docs, exist_ok=True)
    icon.resize((512, 512), Image.Resampling.LANCZOS).save(os.path.join(docs, "logo.png"))

    res = os.path.join(root, "src-tauri", "gen", "android", "app", "src", "main", "res")
    for density, px in STATUS_DENSITIES.items():
        folder = os.path.join(res, f"drawable-{density}")
        os.makedirs(folder, exist_ok=True)
        build_status_icon(px).save(os.path.join(folder, "ic_stat_mark.png"))

    print("wrote icon-source-flat.png, icon-source-fg.png, docs/logo.png, scripts/generate/icon-preview.png, ic_stat_mark.png")


if __name__ == "__main__":
    main()
