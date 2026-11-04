"""Render plan.draw as an SVG preview using only Python's standard library."""

import html
import json
from pathlib import Path


ROOT = Path(__file__).parent
document = json.loads((ROOT / "plan.draw").read_text())
canvas = document["document"]["canvas"]["previewBounds"]
width, height = canvas["width"], canvas["height"]
background = document["document"]["canvas"]["background"]["color"]


def escape(value):
    return html.escape(str(value), quote=True)


def line_path(points):
    return "M " + " L ".join(f"{x} {y}" for x, y in points)


parts = [
    f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">',
    "<defs>",
    '<filter id="boardTexture" x="0" y="0" width="100%" height="100%">',
    '<feTurbulence type="fractalNoise" baseFrequency="0.021 0.028" numOctaves="4" seed="17" result="grain"/>',
    '<feColorMatrix in="grain" type="saturate" values="0" result="mono"/>',
    '<feComponentTransfer in="mono" result="softGrain"><feFuncA type="table" tableValues="0 0.18"/></feComponentTransfer>',
    '<feBlend in="SourceGraphic" in2="softGrain" mode="screen"/>',
    "</filter>",
    '<filter id="chalkEdge" x="-2%" y="-2%" width="104%" height="104%">',
    '<feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="1" seed="8" result="rough"/>',
    '<feDisplacementMap in="SourceGraphic" in2="rough" scale="1.2" xChannelSelector="R" yChannelSelector="G"/>',
    "</filter>",
    '<filter id="softSmudge" x="-20%" y="-30%" width="140%" height="160%"><feGaussianBlur stdDeviation="18"/></filter>',
    '<marker id="arrowHead" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto" markerUnits="strokeWidth"><path d="M1,1 L8,5 L1,9" fill="none" stroke="#f3c94c" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></marker>',
    '<radialGradient id="edgeShade"><stop offset="65%" stop-color="#000" stop-opacity="0"/><stop offset="100%" stop-color="#000" stop-opacity=".42"/></radialGradient>',
    "</defs>",
    f'<rect width="{width}" height="{height}" fill="{escape(background)}"/>',
    f'<rect width="{width}" height="{height}" filter="url(#boardTexture)" opacity=".82"/>',
    '<path d="M 130 250 C 330 180, 590 255, 850 180 M 170 445 C 400 390, 620 500, 930 410 M 160 970 C 390 900, 660 1020, 920 915 M 190 1480 C 420 1400, 670 1510, 930 1425" fill="none" stroke="#d2d0ca" stroke-width="34" stroke-linecap="round" opacity=".055" filter="url(#softSmudge)"/>',
    '<rect width="1080" height="1620" fill="url(#edgeShade)"/>',
]

for element in document["document"]["elements"]:
    kind = element["type"]
    style = element.get("style", {})
    stroke = escape(style.get("stroke", "#f2eee5"))
    color = escape(style.get("color", "#f6f2e9"))
    stroke_width = style.get("strokeWidth", 2)
    rough = ' filter="url(#chalkEdge)"' if style.get("roughness", 0) else ""

    if kind == "rectangle":
        dash = ' stroke-dasharray="12 10"' if style.get("strokeStyle") == "dashed" else ""
        parts.append(
            f'<rect x="{element["x"]}" y="{element["y"]}" width="{element["width"]}" height="{element["height"]}" rx="4" fill="{escape(style.get("fill", "none"))}" stroke="{stroke}" stroke-width="{stroke_width}" stroke-linejoin="round"{dash}{rough}/>'
        )
    elif kind in ("line", "arrow"):
        points = element.get("points", [])
        marker = ' marker-end="url(#arrowHead)"' if kind == "arrow" else ""
        parts.append(
            f'<path d="{line_path(points)}" fill="none" stroke="{stroke}" stroke-width="{stroke_width}" stroke-linecap="round" stroke-linejoin="round"{marker}{rough}/>'
        )
    elif kind == "text":
        font_size = style.get("fontSize", 24)
        family = "Chalkboard, 'Bradley Hand', 'Segoe Print', 'Comic Sans MS', cursive"
        weight = "700" if style.get("weight", 400) >= 700 else "400"
        align = style.get("align", "left")
        anchor = {"left": "start", "center": "middle", "right": "end"}.get(align, "start")
        x = element["x"] if anchor != "middle" else element["x"] + element["width"] / 2
        y = element["y"] + font_size
        lines = str(element["text"]).splitlines() or [""]
        tspans = []
        for index, line in enumerate(lines):
            dy = 0 if index == 0 else round(font_size * 1.17, 2)
            tspans.append(f'<tspan x="{x}" dy="{dy}">{escape(line)}</tspan>')
        parts.append(
            f'<text x="{x}" y="{y}" fill="{color}" font-family="{escape(family)}" font-size="{font_size}px" font-weight="{weight}" text-anchor="{anchor}" paint-order="stroke" stroke="#f6f2e9" stroke-opacity=".12" stroke-width=".45" stroke-linejoin="round">{"".join(tspans)}</text>'
        )

parts.append("</svg>")
(ROOT / "plan.svg").write_text("\n".join(parts))
print(f"Rendered {len(document['document']['elements'])} editable elements to {ROOT / 'plan.svg'}")
