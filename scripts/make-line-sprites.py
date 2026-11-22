#!/usr/bin/env python3
"""Cuts The Line's sprites out of design/line-reference.png (the artwork the Line is based on).
Everything dark becomes transparent (the panel behind is near-black), so machines sit on the panel like in the artwork, with their openings see-through.
Writes ui/art/*.webp and ui/linesprites.js (the boxes, in the artwork's own pixel coordinates, so the JS can place each sprite exactly)."""
import json, os, sys
import numpy as np
from PIL import Image
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
SRC = Image.open(os.path.join(ROOT, 'design', 'line-reference.png')).convert('RGB')
OUT = os.path.join(ROOT, 'ui', 'art'); os.makedirs(OUT, exist_ok=True)
LO, HI = 21.0, 46.0

def key(img, lo=LO, hi=HI):
    a = np.asarray(img).astype(np.float32); lum = a[..., 0] * .299 + a[..., 1] * .587 + a[..., 2] * .114
    # colourful pixels (orange, green, cardboard) are never background even when dark
    chroma = a.max(-1) - a.min(-1); alpha = np.clip((lum - lo) / (hi - lo), 0, 1); alpha = np.maximum(alpha, np.clip((chroma - 14) / 20, 0, 1))
    out = np.dstack([a, alpha * 255]).astype(np.uint8); return Image.fromarray(out, 'RGBA')

def key_solid(img, size=13, lo=LO, hi=HI):
    """Like key(), but dark metal INSIDE the outline stays solid (a binary closing fills the dark faces of posts and housings that the plain key would make see-through)."""
    from PIL import ImageFilter
    rgba = key(img, lo, hi); a = np.asarray(rgba).copy(); m = Image.fromarray(((a[..., 3] > 60) * 255).astype(np.uint8), 'L').filter(ImageFilter.MaxFilter(size)).filter(ImageFilter.MinFilter(size)); closed = np.asarray(m) > 128
    a[..., 3] = np.where(closed, np.maximum(a[..., 3], 255), a[..., 3]); return Image.fromarray(a)

def silhouette(img, box, poly, lo=LO, hi=HI):
    """Keep EVERYTHING inside a hand-drawn outline (artwork coordinates), dark metal included, and nothing outside it. For machines whose dark faces the plain key would eat."""
    from PIL import ImageDraw
    rgba = key(img, lo, hi); w, h = rgba.size; m = Image.new('L', (w * 4, h * 4), 0); ImageDraw.Draw(m).polygon([((x - box[0]) * 4, (y - box[1]) * 4) for x, y in poly], fill=255); m = np.asarray(m.resize((w, h), Image.LANCZOS)).astype(np.float32) / 255
    a = np.asarray(rgba).copy(); a[..., 3] = (np.maximum(a[..., 3].astype(np.float32), 255 * (m > 0.5)) * m).astype(np.uint8); return Image.fromarray(a)

def paint(img, box, rgb):
    a = np.asarray(img).copy(); x0, y0, x1, y1 = box; a[y0:y1, x0:x1] = rgb; return Image.fromarray(a)

def hole(rgba, poly_or_box, box_origin):
    """Make a region fully transparent (a polygon in artwork coordinates)."""
    from PIL import ImageDraw
    m = Image.new('L', rgba.size, 0); d = ImageDraw.Draw(m); ox, oy = box_origin; d.polygon([(x - ox, y - oy) for x, y in poly_or_box], fill=255)
    a = np.asarray(rgba).copy(); mm = np.asarray(m) > 0; a[..., 3][mm] = 0; return Image.fromarray(a, 'RGBA')

manifest = {}
def save(name, box, img=None, **kw):
    src = img if img is not None else SRC; rgba = key(src.crop(box), **kw) if not kw.get('raw') else src.crop(box).convert('RGBA')
    return rgba

def emit(name, rgba, box):
    rgba.save(os.path.join(OUT, name + '.webp'), 'WEBP', quality=92, method=6, alpha_quality=95); manifest[name] = list(box)

BG_DARK = (12, 13, 12)
# --- the six machines and the hopper / bin
emit('claim', key_solid(SRC.crop((298, 222, 482, 396))), (298, 222, 482, 396))
emit('sandbox', key_solid(SRC.crop((506, 222, 664, 396))), (506, 222, 664, 396))
gate = key_solid(SRC.crop((868, 226, 1036, 398))); emit('gate', gate, (868, 226, 1036, 398))
PUSH_BOX = (1054, 256, 1212, 398)
PUSH_POLY = [(1066, 306), (1080, 298), (1094, 294), (1094, 262), (1126, 258), (1180, 262), (1186, 280), (1192, 298), (1203, 310), (1206, 386), (1190, 388), (1176, 386), (1140, 386), (1100, 386), (1066, 386)]
emit('push', silhouette(SRC.crop(PUSH_BOX), PUSH_BOX, PUSH_POLY), PUSH_BOX)
# press: paint out the parcel that is baked in under it (a real parcel now rides there)
pr = paint(SRC, (1272, 300, 1352, 357), BG_DARK); emit('press', key_solid(pr.crop((1222, 212, 1408, 398))), (1222, 212, 1408, 398))
# the parcel itself, cut from that same spot of the artwork
emit('parcel', key(SRC.crop((1274, 304, 1350, 362)), lo=30, hi=52), (1274, 304, 1350, 362))
# hopper with its front panel cut away so parcels can pile up from the bottom inside it
hop = key(SRC.crop((18, 194, 264, 402))); hop = hole(hop, [(48, 254), (212, 254), (173, 338), (87, 338)], (18, 194)); emit('hopper', hop, (18, 194, 264, 402))
# robot: cut into its real parts so each bends at its own joint: the base (with the shoulder's stalk), the lower arm (shoulder ball to elbow ball), the upper arm (to the wrist ball) and the wrist with its gripper.
# Joints in artwork pixels: shoulder (772, 317), elbow (731, 263), wrist (804, 227).
from PIL import ImageDraw
def part(box, shapes_in, shapes_out=()):
    """Key the crop, then keep only what lies inside the shapes (polygons or circles, artwork coordinates) and not inside the ones to cut out; the edge is feathered by a pixel."""
    rgba = key(SRC.crop(box)); w, h = rgba.size; m = Image.new('L', (w * 4, h * 4), 0); d = ImageDraw.Draw(m)
    def draw(sh, fill):
        if sh[0] == 'c': _, cx, cy, r = sh; d.ellipse([(cx - r - box[0]) * 4, (cy - r - box[1]) * 4, (cx + r - box[0]) * 4, (cy + r - box[1]) * 4], fill=fill)
        else: d.polygon([((x - box[0]) * 4, (y - box[1]) * 4) for x, y in sh[1]], fill=fill)
    for sh in shapes_in: draw(sh, 255)
    for sh in shapes_out: draw(sh, 0)
    m = m.resize((w, h), Image.LANCZOS); a = np.asarray(rgba).copy(); a[..., 3] = (a[..., 3].astype(np.float32) * np.asarray(m).astype(np.float32) / 255).astype(np.uint8); return Image.fromarray(a)
S1, S2, S3 = (772, 317), (731, 263), (804, 227)
wrist_poly = ('p', [(797, 238), (830, 238), (848, 262), (848, 312), (798, 312), (797, 262)])
lower_in = [('c', S1[0], S1[1], 14), ('c', S2[0], S2[1], 15), ('p', [(716, 262), (746, 252), (752, 268), (786, 300), (786, 318), (758, 322), (724, 292), (716, 280)])]
upper_in = [('p', [(738, 226), (770, 218), (794, 206), (818, 206), (822, 232), (800, 240), (762, 254), (744, 262)]), ('c', S3[0], S3[1], 17)]
emit('robot-base', part((708, 316, 812, 394), [('p', [(708, 316), (812, 316), (812, 394), (708, 394)])], [('c', S1[0], S1[1], 14)]), (708, 316, 812, 394))
emit('robot-lower', part((700, 244, 800, 334), lower_in), (700, 244, 800, 334))
emit('robot-upper', part((730, 200, 830, 266), upper_in, [('c', S2[0], S2[1], 15)]), (730, 200, 830, 266))
emit('robot-wrist', part((790, 226, 856, 316), [wrist_poly], [('c', S3[0], S3[1], 17)]), (790, 226, 856, 316))
# shipped bin: frame (interior painted dark so it becomes see-through) and the stack of trays on their own
bn = paint(SRC, (1462, 224, 1628, 388), BG_DARK); emit('bin-frame', key(bn.crop((1436, 198, 1652, 414))), (1436, 198, 1652, 414))
emit('bin-trays', key(SRC.crop((1462, 232, 1630, 386)), lo=26, hi=50), (1462, 232, 1630, 386))
# belt pieces: left cap, a slab section that tiles, a leg, right cap
emit('belt-cap-l', key(SRC.crop((203, 360, 258, 442))), (203, 360, 258, 442))
emit('belt-top', key(SRC.crop((250, 362, 313, 404))), (250, 362, 313, 404))
emit('belt-front', key(SRC.crop((296, 404, 452, 442))), (296, 404, 452, 442))
emit('belt-leg', key(SRC.crop((452, 398, 498, 476))), (452, 398, 498, 476))
open(os.path.join(ROOT, 'ui', 'linesprites.js'), 'w').write('// Generated by scripts/make-line-sprites.py from design/line-reference.png. Boxes are [x0, y0, x1, y1] in the artwork\'s own pixel space.\nexport const SPRITES = ' + json.dumps(manifest, indent=1) + ';\n')
print(json.dumps({k: v for k, v in manifest.items()}))
print(sum(os.path.getsize(os.path.join(OUT, f)) for f in os.listdir(OUT)) // 1024, 'KB total')
