"""Draw Bookwyrm's icons from SVG: the app icon (macOS .icns, Windows .ico, PNG) and the
menu-bar / tray icons. Run from app/: python build/make-icons.py  (needs cairosvg and Pillow)."""

import io
from pathlib import Path

import cairosvg
from PIL import Image

OUT = Path(__file__).resolve().parent
BLUE = "#0a84ff"


def robot(fill_metal=("#f4f5f7", "#c3c6cc"), eye="#7cc0ff", ribbon=BLUE, edge="#00000030") -> str:
    """The robot's head and shoulders, in the 64x64 frame the app draws it in."""
    top, bottom = fill_metal
    return f"""
  <defs><linearGradient id="m" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="{top}"/><stop offset="1" stop-color="{bottom}"/></linearGradient>
    <filter id="g" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="0.9" result="b"/>
    <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
  <rect x="22" y="45" width="20" height="11" rx="5.5" fill="url(#m)" stroke="{edge}" stroke-width="0.6"/>
  <path d="M32 13V7.5" stroke="{bottom}" stroke-width="1.6" stroke-linecap="round"/>
  <circle cx="32" cy="6" r="2.6" fill="{eye}"/>
  <rect x="7.5" y="24" width="5" height="12" rx="2.5" fill="url(#m)" stroke="{edge}" stroke-width="0.6"/>
  <rect x="51.5" y="24" width="5" height="12" rx="2.5" fill="url(#m)" stroke="{edge}" stroke-width="0.6"/>
  <rect x="11" y="12" width="42" height="35" rx="12.5" fill="url(#m)" stroke="{edge}" stroke-width="0.6"/>
  <path d="M41 11h4.6v11.5l-2.3-1.9-2.3 1.9z" fill="{ribbon}"/>
  <rect x="16" y="18" width="32" height="23" rx="7.5" fill="#15171a"/>
  <g filter="url(#g)" fill="{eye}">
    <rect x="22.5" y="24" width="5.5" height="9" rx="2.75"/><rect x="36" y="24" width="5.5" height="9" rx="2.75"/>
    <rect x="29" y="35.2" width="6" height="1.6" rx="0.8" opacity="0.75"/></g>"""


def app_icon(bleed: bool) -> str:
    # macOS: the squircle tile sits inside the canvas with room for its shadow (824 of 1024).
    # Windows/Linux: the tile fills the canvas.
    pad, size, radius = (100, 824, 186) if not bleed else (0, 1024, 200)
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#3a4150"/><stop offset="1" stop-color="#1d2129"/></linearGradient>
    <filter id="s" x="-10%" y="-10%" width="120%" height="130%"><feDropShadow dx="0" dy="12" stdDeviation="14" flood-opacity="0.3"/></filter></defs>
  <rect x="{pad}" y="{pad}" width="{size}" height="{size}" rx="{radius}" fill="url(#bg)" {'' if bleed else 'filter="url(#s)"'}/>
  <g transform="translate({pad + size * 0.14} {pad + size * 0.15}) scale({size * 0.72 / 64})">{robot()}</g>
</svg>"""


def tray_template() -> str:
    """macOS menu bar: black glyph on transparent; macOS recolours it for light and dark."""
    return """<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <path d="M32 14V7" stroke="#000" stroke-width="4" stroke-linecap="round"/>
  <circle cx="32" cy="6" r="4.5" fill="#000"/>
  <path fill="#000" fill-rule="evenodd" d="M20 14h24a13 13 0 0 1 13 13v14a13 13 0 0 1-13 13H20A13 13 0 0 1 7 41V27a13 13 0 0 1 13-13z
    M22 26h0a4 4 0 0 1 4 4v8a4 4 0 0 1-8 0v-8a4 4 0 0 1 4-4z M42 26a4 4 0 0 1 4 4v8a4 4 0 0 1-8 0v-8a4 4 0 0 1 4-4z"/>
</svg>"""


def tray_colour() -> str:
    """Windows / Linux tray: the robot in colour, readable on light and dark taskbars."""
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="4 2 56 56">{robot(edge="#00000060")}</svg>'


def png(svg: str, size: int) -> Image.Image:
    return Image.open(io.BytesIO(cairosvg.svg2png(bytestring=svg.encode(), output_width=size, output_height=size))).convert("RGBA")


def main():
    mac = png(app_icon(bleed=False), 1024)
    mac.save(OUT / "icon.icns", sizes=[(s, s) for s in (16, 32, 64, 128, 256, 512, 1024)])
    full = png(app_icon(bleed=True), 1024)
    full.resize((512, 512), Image.LANCZOS).save(OUT / "icon.png")
    full.save(OUT / "icon.ico", sizes=[(s, s) for s in (16, 24, 32, 48, 64, 128, 256)])
    png(tray_template(), 16).save(OUT / "trayTemplate.png")
    png(tray_template(), 32).save(OUT / "trayTemplate@2x.png")
    png(tray_colour(), 32).save(OUT / "tray.png")
    png(tray_colour(), 64).save(OUT / "tray@2x.png")
    png(tray_colour(), 256).save(OUT / "tray.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48)])
    print("icons written to", OUT)


if __name__ == "__main__":
    main()
