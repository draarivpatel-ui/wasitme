"""Builds fonts/web/*.woff2 (renamed subsets for HTML) from fonts/app/*.ttf (unmodified IBM Plex).

IBM Plex is licensed under the SIL OFL 1.1 with Reserved Font Name "Plex". A subset is a Modified
Version under the OFL, so the web subsets are renamed "Wasitme Serif" / "Wasitme Mono". The full TTFs
in fonts/app/ are unmodified and keep their names (bundled in the Mac app).

Needs fontTools + brotli (pip install fonttools brotli). The outputs are committed, so nobody else
has to run this. Usage: python3 design/system/fonts/subset.py
"""
import os
from fontTools import subset
from fontTools.ttLib import TTFont

HERE = os.path.dirname(os.path.abspath(__file__))
TEXT_RANGES = [(0x20, 0x7E), (0xA0, 0xFF), (0x131, 0x131), (0x152, 0x153), (0x2009, 0x200A),
               (0x2010, 0x2015), (0x2018, 0x201E), (0x2020, 0x2022), (0x2026, 0x2026), (0x2030, 0x2030),
               (0x2032, 0x2033), (0x2039, 0x203A), (0x2044, 0x2044), (0x20AC, 0x20AC), (0x2122, 0x2122),
               (0x2190, 0x2193), (0x2212, 0x2212), (0x2215, 0x2215), (0x2248, 0x2248), (0x2260, 0x2260),
               (0x2264, 0x2265)]
MONO_EXTRA = [(0x2500, 0x257F), (0x2580, 0x259F), (0x25A0, 0x25FF)]
JOBS = [
    ("IBMPlexSerif-Regular.ttf", "WasitmeSerif-Regular", "IBM Plex Serif", "Wasitme Serif", TEXT_RANGES),
    ("IBMPlexSerif-Italic.ttf", "WasitmeSerif-Italic", "IBM Plex Serif", "Wasitme Serif", TEXT_RANGES),
    ("IBMPlexSerif-Bold.ttf", "WasitmeSerif-Bold", "IBM Plex Serif", "Wasitme Serif", TEXT_RANGES),
    ("IBMPlexSerif-BoldItalic.ttf", "WasitmeSerif-BoldItalic", "IBM Plex Serif", "Wasitme Serif", TEXT_RANGES),
    ("IBMPlexMono-Regular.ttf", "WasitmeMono-Regular", "IBM Plex Mono", "Wasitme Mono", TEXT_RANGES + MONO_EXTRA),
    ("IBMPlexMono-Bold.ttf", "WasitmeMono-Bold", "IBM Plex Mono", "Wasitme Mono", TEXT_RANGES + MONO_EXTRA),
]

def rename(font, old_family, new_family):
    old_ps, new_ps = old_family.replace(" ", ""), new_family.replace(" ", "")
    for rec in font["name"].names:
        if rec.nameID in (1, 3, 4, 6, 16, 17, 21, 22):
            s = rec.toUnicode().replace(old_family, new_family).replace(old_ps, new_ps)
            rec.string = s
        elif rec.nameID == 5:
            rec.string = rec.toUnicode() + "; wasitme subset"
    for rec in font["name"].names:
        if rec.nameID in (1, 4, 6, 16, 21) and "Plex" in rec.toUnicode():
            raise SystemExit(f"rename failed: {rec.toUnicode()}")

for src, out, old, new, ranges in JOBS:
    font = TTFont(os.path.join(HERE, "app", src))
    opts = subset.Options()
    opts.flavor = "woff2"
    opts.layout_features = ["*"]
    opts.name_IDs = ["*"]
    opts.name_languages = ["*"]
    opts.notdef_outline = True
    opts.hinting = False
    sub = subset.Subsetter(opts)
    unis = [u for a, b in ranges for u in range(a, b + 1)]
    sub.populate(unicodes=unis)
    sub.subset(font)
    rename(font, old, new)
    font.flavor = "woff2"
    dest = os.path.join(HERE, "web", out + ".woff2")
    font.save(dest)
    print(f"{out}.woff2  {os.path.getsize(dest) // 1024} KB  glyphs {len(font.getGlyphOrder())}")
