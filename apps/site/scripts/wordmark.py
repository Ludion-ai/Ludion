"""Wordmark for design B: "ludion" in Schibsted Grotesk, heavy and tight; the i's dot is a circle that floats a
little higher than the dot would, the ludion (the diver). The variable font is pinned to a static instance with
fontTools.varLib.instancer, then the outlines are written as one SVG path (Schibsted Grotesk is OFL; outlines may be embedded).
Regenerate (needs fonttools and brotli):
  python apps/site/scripts/wordmark.py node_modules/@fontsource-variable/schibsted-grotesk/files/schibsted-grotesk-latin-wght-normal.woff2 apps/site/src/assets/wordmark.svg
"""
import sys

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

WEIGHT = 850
TRACKING = -34  # font units between glyphs: tight, like the headline
TEXT = "ludıon"  # dotless i; the dot is drawn as a circle

src, out = sys.argv[1], sys.argv[2]
font = instancer.instantiateVariableFont(TTFont(src), {"wght": WEIGHT})
glyphs = font.getGlyphSet()
cmap = font.getBestCmap()
hmtx = font["hmtx"]


def bounds(name):
    pen = BoundsPen(glyphs)
    glyphs[name].draw(pen)
    return pen.bounds


pen = SVGPathPen(glyphs, ntos=lambda v: f"{v:.0f}")  # whole font units are plenty at 2000/em
x = 0
dotless_x = None
for ch in TEXT:
    name = cmap[ord(ch)]
    if ch == "ı":
        dotless_x = x
    glyphs[name].draw(TransformPen(pen, (1, 0, 0, -1, x, 0)))  # flip y: SVG grows downward
    x += hmtx[name][0] + TRACKING
width = x - TRACKING

# Where the real i puts its dot, so the circle can sit just above it.
i_box = bounds(cmap[ord("i")])
stem_box = bounds(cmap[ord("ı")])
stem_cx = dotless_x + (stem_box[0] + stem_box[2]) / 2
stem_w = stem_box[2] - stem_box[0]
dot_top = i_box[3]
r = stem_w * 0.62
cy = dot_top + r * 0.55  # centre above the dot's top edge: risen
top = cy + r + 8
bottom = -(min(b[1] for b in (bounds(cmap[ord(c)]) for c in TEXT)) - 8)

d = pen.getCommands()
svg = (
    f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 {-top:.0f} {width:.0f} {top + bottom:.0f}" aria-hidden="true" focusable="false" fill="currentColor">'
    f'<path d="{d}"/><circle cx="{stem_cx:.1f}" cy="{-cy:.1f}" r="{r:.1f}"/></svg>'
)
with open(out, "w", encoding="utf-8") as f:
    f.write(svg)
print(f"width {width:.0f}, height {top + bottom:.0f}, dot r {r:.1f} at ({stem_cx:.0f}, {cy:.0f}), path {len(d)} chars")
