#!/usr/bin/env python3
"""Generate oto logo assets (SVG paths + 1024 PNG) from brand fonts."""
import os
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.boundsPen import BoundsPen
from fontTools.misc.transform import Transform

OUT = "/Users/jony.money/Documents/Dev/Explorations/oto/docs/brand/logo"
os.makedirs(OUT, exist_ok=True)

INK = "#181A13"
PAPER = "#F4F7EE"
MOEGI = "#7BA428"

clash = TTFont("clash600.woff2")
zen = TTFont("zenkaku-medium.ttf")


def glyph_path(font, char, dx, scale=1.0):
    """SVG path for one glyph, flipped to y-down, translated by dx (font units)."""
    cmap = font.getBestCmap()
    gname = cmap[ord(char)]
    gs = font.getGlyphSet()
    pen = SVGPathPen(gs)
    tpen = TransformPen(pen, Transform(scale, 0, 0, -scale, dx * scale, 0))
    gs[gname].draw(tpen)
    return pen.getCommands(), gs[gname].width


def adv(font, char):
    gs = font.getGlyphSet()
    return gs[font.getBestCmap()[ord(char)]].width


UPM = clash["head"].unitsPerEm  # expect 1000
TRACK = -0.03 * UPM             # letter-spacing -.03em
GAP = 0.10 * UPM                # gap before dot
DOT_D = 0.22 * UPM              # dot diameter
DOT_RAISE = 0.02 * UPM

ao, at = adv(clash, "o"), adv(clash, "t")

# glyph x offsets
x_o1 = 0
x_t = ao + TRACK
x_o2 = ao + at + 2 * TRACK
wm_end = x_o2 + ao

p_o1, _ = glyph_path(clash, "o", x_o1)
p_t, _ = glyph_path(clash, "t", x_t)
p_o2, _ = glyph_path(clash, "o", x_o2)

# dot geometry (y-down coords: baseline y=0, up is negative)
dot_cx = wm_end + GAP + DOT_D / 2
dot_cy = -(DOT_D / 2 + DOT_RAISE)
dot_r = DOT_D / 2

# bounds of letters
bp = BoundsPen(clash.getGlyphSet())
for ch, dx in (("o", x_o1), ("t", x_t), ("o", x_o2)):
    tp = TransformPen(bp, Transform(1, 0, 0, -1, dx, 0))
    clash.getGlyphSet()[clash.getBestCmap()[ord(ch)]].draw(tp)
xmin, ymin, xmax, ymax = bp.bounds  # y-down space
PAD = 40


def svg(width_end, elems, name, ymin_=None, ymax_=None):
    y0 = (ymin_ if ymin_ is not None else ymin) - PAD
    y1 = (ymax_ if ymax_ is not None else ymax) + PAD
    vb = f"{xmin - PAD} {y0} {width_end - xmin + 2 * PAD} {y1 - y0}"
    body = "\n".join(elems)
    doc = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}">\n{body}\n</svg>\n')
    with open(os.path.join(OUT, name), "w") as f:
        f.write(doc)
    print("wrote", name, "viewBox", vb)


letters = f'<path fill="{INK}" d="{p_o1} {p_t} {p_o2}"/>'
letters_cc = f'<path fill="currentColor" d="{p_o1} {p_t} {p_o2}"/>'
dot = f'<circle fill="{MOEGI}" cx="{dot_cx}" cy="{dot_cy}" r="{dot_r}"/>'
dot_cc = f'<circle fill="currentColor" cx="{dot_cx}" cy="{dot_cy}" r="{dot_r}"/>'

# W1 two-tone, W1 mono (currentColor), W3 watermark (no dot, 40%)
svg(dot_cx + dot_r, [letters, dot], "wordmark.svg")
svg(dot_cx + dot_r, [letters_cc, dot_cc], "wordmark-mono.svg")
svg(wm_end, [f'<g opacity="0.4">{letters_cc}</g>'], "wordmark-watermark.svg")

# M1 mark: o + dot
m_end = ao + GAP + DOT_D
m_dot_cx = ao + GAP + DOT_D / 2
bp2 = BoundsPen(clash.getGlyphSet())
tp2 = TransformPen(bp2, Transform(1, 0, 0, -1, 0, 0))
clash.getGlyphSet()[clash.getBestCmap()[ord("o")]].draw(tp2)
oxmin, oymin, oxmax, oymax = bp2.bounds
p_mo, _ = glyph_path(clash, "o", 0)
with open(os.path.join(OUT, "mark.svg"), "w") as f:
    vb = f"{oxmin - PAD} {oymin - PAD} {m_dot_cx + dot_r - oxmin + 2 * PAD} {oymax - oymin + 2 * PAD}"
    f.write(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}">\n'
            f'<path fill="{INK}" d="{p_mo}"/>\n'
            f'<circle fill="{MOEGI}" cx="{m_dot_cx}" cy="{dot_cy}" r="{dot_r}"/>\n</svg>\n')
print("wrote mark.svg")

# M3 seal: 音 on ink rounded square (1024 canvas)
zupm = zen["head"].unitsPerEm
S = 1024
glyph_size = S * 0.56
zscale = glyph_size / zupm
a_on = adv(zen, "音")
p_on, _ = glyph_path(zen, "音", 0, scale=zscale)
# center: 音 advance ~ 1em; vertical: center cap between ascent/descent visually
gx = (S - a_on * zscale) / 2
asc = zen["hhea"].ascent * zscale
desc = zen["hhea"].descent * zscale  # negative
gy = (S + (asc + (-desc)) ) / 2 - (-desc)  # baseline y so glyph box centers
with open(os.path.join(OUT, "seal.svg"), "w") as f:
    f.write(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {S} {S}">\n'
            f'<rect width="{S}" height="{S}" rx="{S*0.22}" fill="{INK}"/>\n'
            f'<g transform="translate({gx},{gy})"><path fill="{PAPER}" d="{p_on}"/></g>\n</svg>\n')
print("wrote seal.svg")

# I1 app icon: full-bleed byakuroku square, oto + dot centered (1024)
wm_w = dot_cx + dot_r - xmin
target_w = S * 0.62
iscale = target_w / wm_w
# letter height for vertical centering
letter_h = ymax - ymin
ix = (S - wm_w * iscale) / 2 - xmin * iscale
iy = (S - letter_h * iscale) / 2 - ymin * iscale
p_o1s, _ = glyph_path(clash, "o", x_o1, iscale)
p_ts, _ = glyph_path(clash, "t", x_t, iscale)
p_o2s, _ = glyph_path(clash, "o", x_o2, iscale)
with open(os.path.join(OUT, "app-icon.svg"), "w") as f:
    f.write(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {S} {S}">\n'
            f'<rect width="{S}" height="{S}" fill="{PAPER}"/>\n'
            f'<g transform="translate({ix},{iy})">'
            f'<path fill="{INK}" d="{p_o1s} {p_ts} {p_o2s}"/>'
            f'<circle fill="{MOEGI}" cx="{dot_cx*iscale}" cy="{dot_cy*iscale}" r="{dot_r*iscale}"/>'
            f'</g>\n</svg>\n')
print("wrote app-icon.svg")

# 1024 PNG (flattened) via Pillow, drawing the same geometry
from PIL import Image, ImageDraw
import re

def draw_svg_paths_png():
    img = Image.new("RGB", (S, S), PAPER)
    d = ImageDraw.Draw(img)
    # rasterize glyph paths by sampling: use fontTools to get contours as polygons
    from fontTools.pens.recordingPen import RecordingPen
    import math

    def poly_points(font, char, dx, scale):
        gs = font.getGlyphSet()
        pen = RecordingPen()
        gs[font.getBestCmap()[ord(char)]].draw(pen)
        polys, cur = [], []
        last = None
        def flat_q(p0, p1, p2, n=16):
            return [( (1-t)**2*p0[0]+2*(1-t)*t*p1[0]+t*t*p2[0],
                      (1-t)**2*p0[1]+2*(1-t)*t*p1[1]+t*t*p2[1]) for t in [i/n for i in range(1,n+1)]]
        def flat_c(p0, p1, p2, p3, n=16):
            return [((1-t)**3*p0[0]+3*(1-t)**2*t*p1[0]+3*(1-t)*t*t*p2[0]+t**3*p3[0],
                     (1-t)**3*p0[1]+3*(1-t)**2*t*p1[1]+3*(1-t)*t*t*p2[1]+t**3*p3[1]) for t in [i/n for i in range(1,n+1)]]
        for op, args in pen.value:
            if op == "moveTo":
                if cur: polys.append(cur)
                cur = [args[0]]; last = args[0]
            elif op == "lineTo":
                cur.append(args[0]); last = args[0]
            elif op == "qCurveTo":
                pts = list(args)
                # TrueType: implied on-curve midpoints
                if pts[-1] is None: pts[-1] = cur[0]
                p0 = last
                ctrls = pts[:-1]; end = pts[-1]
                if len(ctrls) == 1:
                    cur += flat_q(p0, ctrls[0], end)
                else:
                    for i in range(len(ctrls)):
                        c0 = ctrls[i]
                        e = end if i == len(ctrls)-1 else ((ctrls[i][0]+ctrls[i+1][0])/2,(ctrls[i][1]+ctrls[i+1][1])/2)
                        cur += flat_q(p0, c0, e); p0 = e
                last = end
            elif op == "curveTo":
                cur += flat_c(last, *args); last = args[-1]
            elif op == "closePath":
                if cur: polys.append(cur); cur = []
        if cur: polys.append(cur)
        return [[((x+dx)*scale, -y*scale) for (x, y) in p] for p in polys]

    # draw letters into a mask with even-odd via 1-bit accumulation (xor)
    mask = Image.new("1", (S, S), 0)
    md = ImageDraw.Draw(mask)
    for ch, dx in (("o", x_o1), ("t", x_t), ("o", x_o2)):
        for poly in poly_points(clash, ch, dx, iscale):
            pts = [(px + ix, py + iy) for (px, py) in poly]
            tmp = Image.new("1", (S, S), 0)
            ImageDraw.Draw(tmp).polygon(pts, fill=1)
            mask = Image.eval(Image.composite(Image.new("1",(S,S),1), mask, tmp), lambda v: v) if False else mask
            # xor accumulate
            import PIL.ImageChops as IC
            mask = IC.logical_xor(mask, tmp)
    img.paste(INK, (0, 0), mask.convert("L").point(lambda v: 255 if v else 0))
    # dot
    cx, cy = dot_cx * iscale + ix, dot_cy * iscale + iy
    r = dot_r * iscale
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=MOEGI)
    img.save(os.path.join(OUT, "app-icon-1024.png"))
    print("wrote app-icon-1024.png")

draw_svg_paths_png()
print("done")
