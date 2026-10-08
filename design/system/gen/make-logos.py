"""Builds the colour logo files from tokens.json and the bundled IBM Plex Mono Bold outlines:
glyphs/mark.svg, glyphs/wordmark.svg (+ -dark), glyphs/appicon-1024.svg (+ -dark).
Letters are converted to outlines, so the SVGs don't depend on any installed font.
Needs fontTools (pip install fonttools). Outputs are committed. Usage: python3 design/system/gen/make-logos.py
"""
import json, os
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
T = json.load(open(os.path.join(ROOT, "tokens.json")))
FONT = TTFont(os.path.join(ROOT, "fonts", "app", "IBMPlexMono-Bold.ttf"))
GS, CMAP, UPM = FONT.getGlyphSet(), FONT.getBestCmap(), FONT["head"].unitsPerEm
L, D = T["color"]["light"], T["color"]["dark"]

def text_path(s, x, baseline, size, anchor="start"):
    """Outline path for a string set in Plex Mono Bold at `size` px; returns (d, width)."""
    scale = size / UPM
    adv = sum(GS[CMAP[ord(c)]].width for c in s) * scale
    if anchor == "middle": x -= adv / 2
    pen = SVGPathPen(GS)
    cx = x
    for c in s:
        g = GS[CMAP[ord(c)]]
        g.draw(TransformPen(pen, (scale, 0, 0, -scale, cx, baseline)))
        cx += g.width * scale
    return pen.getCommands(), adv

def r(v): return f"{v:.2f}".rstrip("0").rstrip(".")

def mark_svg(size=64, dark=False):
    C = D if dark else L
    ink = C["ink"]["primary"] if not dark else D["surface"]["sheet"]
    you, agent = C["party"]["you"]["fill"], C["party"]["agent"]["fill"]
    # square sticker top-left, the agent's triangle bottom-right; no rule between them (the states have one)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 64 64">'
            f'<title>wasitme</title>'
            f'<rect x="5" y="6" width="29" height="29" rx="3" transform="rotate(-5 19.5 20.5)" fill="{you}" stroke="{ink}" stroke-width="2.5"/>'
            f'<path d="M45 30 L60 57 L30 57 Z" fill="{agent}" stroke="{ink}" stroke-width="2.5" stroke-linejoin="round"/></svg>\n')

def wordmark_svg(dark=False):
    C = D if dark else L
    ink = C["ink"]["primary"]
    d1, w1 = text_path("wasit", 0, 40, 48)
    d2, w2 = text_path("me", w1, 40, 48)
    w = w1 + w2
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{r(w + 2)}" height="56" viewBox="0 0 {r(w + 2)} 56">'
            f'<title>wasitme</title><path d="{d1}" fill="{ink}"/><path d="{d2}" fill="{ink}"/>'
            f'<rect x="{r(w1 + 1)}" y="47" width="{r(w2 - 2)}" height="6" fill="{C["party"]["you"]["fill"]}"/></svg>\n')

def appicon_svg(dark=False):
    C = D if dark else L
    sheet = C["surface"]["sheet"] if not dark else D["surface"]["well"]
    hair = C["rule"]["hair"]
    ink = L["ink"]["primary"]
    you, agent = C["party"]["you"]["fill"], C["party"]["agent"]["fill"]
    lines = "".join(f'<rect x="100" y="{y}" width="824" height="3" fill="{hair}"/>' for y in range(236, 900, 88))
    margin = f'<rect x="212" y="100" width="3" height="824" fill="{hair}"/>'
    one, _ = text_path("1", 335, 476, 230, "middle")
    a, _ = text_path("A", 665, 748, 200, "middle")
    shadow = 'fill="#000" fill-opacity="0.14"'
    tag = "M665 382 L832 478 L832 832 L498 832 L498 478 Z"
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
<title>wasitme</title>
<defs><clipPath id="tile"><rect x="100" y="100" width="824" height="824" rx="185.4"/></clipPath></defs>
<rect x="100" y="100" width="824" height="824" rx="185.4" fill="{sheet}"/>
<g clip-path="url(#tile)">{lines}{margin}</g>
<g transform="rotate(5 665 610)">
  <path d="{tag}" transform="translate(12 14)" {shadow}/>
  <path d="{tag}" fill="{agent}" stroke="{ink}" stroke-width="12" stroke-linejoin="round"/>
  <circle cx="665" cy="482" r="24" fill="{sheet}" stroke="{ink}" stroke-width="10"/>
  <path d="{a}" fill="{ink}"/>
</g>
<g transform="rotate(-6 335 395)">
  <rect x="170" y="230" width="330" height="330" rx="16" transform="translate(12 14)" {shadow}/>
  <rect x="170" y="230" width="330" height="330" rx="16" fill="{you}" stroke="{ink}" stroke-width="12"/>
  <path d="{one}" fill="{ink}"/>
</g>
<rect x="100.5" y="100.5" width="823" height="823" rx="185" fill="none" stroke="#000" stroke-opacity="0.12" stroke-width="1"/>
</svg>
'''

out = {
    "glyphs/mark.svg": mark_svg(),
    "glyphs/mark-dark.svg": mark_svg(dark=True),
    "glyphs/wordmark.svg": wordmark_svg(),
    "glyphs/wordmark-dark.svg": wordmark_svg(dark=True),
    "glyphs/appicon-1024.svg": appicon_svg(),
    "glyphs/appicon-1024-dark.svg": appicon_svg(dark=True),
}
for rel, body in out.items():
    open(os.path.join(ROOT, rel), "w").write(body)
    print("wrote", rel)
