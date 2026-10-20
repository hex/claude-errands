# ABOUTME: Draws assets/icon.svg, the plugin icon: a brief, its lines in Claude's orange,
# ABOUTME: leaving along an arrow in Codex's green, on a dark tile.
"""Usage: python3 assets/make-icon.py [OUT]

assets/icon.png is this drawing at 512x512, RGB on white, made with:

    magick -background white assets/icon.svg -alpha remove -alpha off -type TrueColor PNG24:assets/icon.png

Filled shapes only: they stay legible at 32 px, and magick's built-in SVG
renderer skipped a stroked path, drew a line's stroke black and turned a
rotated rect the wrong way.
"""
import pathlib, sys

TILE, PAPER, FOLD = "#1c1c1e", "#f2f2f7", "#c7c7cc"
CLAUDE, CODEX = "#d97757", "#10a37f"

svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
<rect x="40" y="40" width="432" height="432" rx="100" fill="{TILE}"/>
<path d="M104 172 h132 l52 52 v188 h-184 z" fill="{PAPER}"/>
<path d="M236 172 v52 h52 z" fill="{FOLD}"/>
<rect x="132" y="274" width="128" height="22" rx="11" fill="{CLAUDE}"/>
<rect x="132" y="318" width="128" height="22" rx="11" fill="{CLAUDE}"/>
<rect x="132" y="362" width="84" height="22" rx="11" fill="{CLAUDE}"/>
<rect x="280" y="100" width="132" height="40" rx="20" fill="{CODEX}"/>
<rect x="372" y="100" width="40" height="132" rx="20" fill="{CODEX}"/>
<path d="M290.1 250.1 L406.1 134.1 L377.9 105.9 L261.9 221.9 Z" fill="{CODEX}"/>
<circle cx="276" cy="236" r="20" fill="{CODEX}"/>
</svg>
'''
pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else
             pathlib.Path(__file__).resolve().parent / "icon.svg").write_text(svg)
