#!/usr/bin/env python3
"""Render per-layer model color maps from two gcodes and compare.

Color of each extrusion = active tool's filament_colour. Wipe-tower /
prime-tower / toolchange purge is excluded (we compare the MODEL, i.e.
what the user sees). If the rendered model is pixel-identical between
OrcaXR and the desktop FullSpectrum reference, the printed colours are
the same regardless of toolchange order.

Usage:
  python3 scripts/peggy_colormap_diff.py <orcaxr.gcode> <fs_reference.gcode>

IMPORTANT: each gcode is registered to its OWN model bbox before
comparison. The two slicers position the model ~0.5-1.0 mm apart on
the bed; comparing on a shared bbox reports that bed offset as a bogus
~89% colour mismatch. Registered correctly the residual is <0.5%
(sub-pixel seam rasterisation). Writes contact-sheet + composite PNGs
to /tmp. See docs/fullspectrum-reorder-parity.md.
"""
import sys, re
from PIL import Image, ImageDraw
import numpy as np

PALETTE = {0: (8, 10, 13), 1: (244, 192, 50), 2: (226, 222, 219), 3: (231, 47, 29)}
BG = (255, 255, 255)

def parse(path):
    """Return list of layers; each layer = list of (x0,y0,x1,y1,tool)."""
    layers = []
    seg = []
    tool = 0
    x = y = 0.0
    in_wipe = False      # ; CP TOOLCHANGE START..END
    in_prime = False     # ;TYPE:Prime tower .. next ;TYPE:
    started = False
    with open(path, 'r', errors='ignore') as f:
        for ln in f:
            if ln.startswith(';LAYER_CHANGE'):
                if started:
                    layers.append(seg)
                seg = []
                started = True
                continue
            if ln.startswith('; CP TOOLCHANGE START'):
                in_wipe = True; continue
            if ln.startswith('; CP TOOLCHANGE END'):
                in_wipe = False; continue
            if ln.startswith(';TYPE:Prime tower'):
                in_prime = True; continue
            if ln.startswith(';TYPE:'):
                in_prime = False; continue
            if ln and ln[0] == 'T' and len(ln) > 1 and ln[1].isdigit():
                tool = int(ln[1]); continue
            if ln.startswith('G1 ') or ln.startswith('G0 '):
                nx, ny, e = x, y, None
                for tok in ln.split():
                    c = tok[0]
                    if c == 'X':
                        try: nx = float(tok[1:])
                        except: pass
                    elif c == 'Y':
                        try: ny = float(tok[1:])
                        except: pass
                    elif c == 'E':
                        try: e = float(tok[1:])
                        except: pass
                moved = (nx != x or ny != y)
                if (started and moved and e is not None and e > 0.0
                        and not in_wipe and not in_prime):
                    seg.append((x, y, nx, ny, tool))
                x, y = nx, ny
    if started:
        layers.append(seg)
    return layers

def bbox(*layersets):
    xs, ys = [], []
    for layers in layersets:
        for seg in layers:
            for (x0, y0, x1, y1, _) in seg:
                xs += [x0, x1]; ys += [y0, y1]
    return min(xs), min(ys), max(xs), max(ys)

def render(layers, lo, hi, W, H, mnx, mny, sc):
    img = Image.new('RGB', (W, H), BG)
    d = ImageDraw.Draw(img)
    for li in range(lo, hi):
        if li >= len(layers): break
        for (x0, y0, x1, y1, t) in layers[li]:
            d.line([( (x0-mnx)*sc, H-(y0-mny)*sc ),
                    ( (x1-mnx)*sc, H-(y1-mny)*sc )],
                   fill=PALETTE.get(t, (128,128,128)), width=2)
    return img

A = parse(sys.argv[1])   # OrcaXR
B = parse(sys.argv[2])   # reference (desktop FS)
print(f"OrcaXR layers={len(A)}  REF layers={len(B)}")
# Register EACH file to its own model origin — the two slices position
# the model ~0.5-1.0 mm apart on the bed; comparing on a shared union
# bbox would report that bed offset as a colour mismatch. Use a common
# span (max of the two) so scale is identical, but zero each to its
# own min corner.
amnx, amny, amxx, amxy = bbox(A)
bmnx, bmny, bmxx, bmxy = bbox(B)
spanx = max(amxx-amnx, bmxx-bmnx)
spany = max(amxy-amny, bmxy-bmny)
TARGET = 1100
sc = TARGET / max(spanx, spany)
W, H = int(spanx*sc)+8, int(spany*sc)+8
ORIG = {id(A): (amnx, amny), id(B): (bmnx, bmny)}

n = min(len(A), len(B))
# Quantitative: per-layer pixel mismatch over union of inked pixels.
worst = []
tot_union = tot_diff = 0
for li in range(n):
    ia = np.asarray(render(A, li, li+1, W, H, amnx, amny, sc))
    ib = np.asarray(render(B, li, li+1, W, H, bmnx, bmny, sc))
    inkA = np.any(ia != 255, axis=2)
    inkB = np.any(ib != 255, axis=2)
    union = inkA | inkB
    diff = union & np.any(ia != ib, axis=2)
    u, dd = int(union.sum()), int(diff.sum())
    tot_union += u; tot_diff += dd
    worst.append((dd / u if u else 0.0, li, u, dd))
worst.sort(reverse=True)
print(f"OVERALL inked-pixel color mismatch: {tot_diff}/{tot_union} = "
      f"{100.0*tot_diff/max(tot_union,1):.3f}%")
print("worst 8 layers (mismatch%, layer, union_px, diff_px):")
for r in worst[:8]:
    print(f"  L{r[1]:03d}: {100*r[0]:.2f}%  union={r[2]} diff={r[3]}")

# Visual contact sheet: representative layers, OrcaXR | REF | diff.
picks = sorted(set([1, n//5, 2*n//5, n//2, 3*n//5, 4*n//5, n-2]))
cell_w, cell_h = W, H
sheet = Image.new('RGB', (cell_w*3+40, cell_h*len(picks)+20*len(picks)+40), (30,30,30))
sd = ImageDraw.Draw(sheet)
for row, li in enumerate(picks):
    ia = render(A, li, li+1, W, H, amnx, amny, sc)
    ib = render(B, li, li+1, W, H, bmnx, bmny, sc)
    na, nb = np.asarray(ia), np.asarray(ib)
    dmask = np.any(na != nb, axis=2)
    dimg = np.full_like(na, 245)
    dimg[dmask] = (255, 0, 0)
    y = 20 + row*(cell_h+20)
    sheet.paste(ia, (10, y))
    sheet.paste(ib, (20+cell_w, y))
    sheet.paste(Image.fromarray(dimg), (30+cell_w*2, y))
    sd.text((12, y+4), f"L{li} OrcaXR", fill=(255,255,255))
    sd.text((22+cell_w, y+4), f"L{li} FS ref", fill=(255,255,255))
    sd.text((32+cell_w*2, y+4), f"L{li} diff (red=differ)", fill=(255,255,255))
sheet.save('/tmp/peggy_colormap_contactsheet.png')

# Composite top-down (all layers overlaid) side by side.
ca = render(A, 0, n, W, H, amnx, amny, sc)
cb = render(B, 0, n, W, H, bmnx, bmny, sc)
comp = Image.new('RGB', (W*2+30, H+30), (30,30,30))
comp.paste(ca, (10,20)); comp.paste(cb, (20+W,20))
cd = ImageDraw.Draw(comp)
cd.text((12,4), "OrcaXR (all layers)", fill=(255,255,255))
cd.text((22+W,4), "FS reference (all layers)", fill=(255,255,255))
comp.save('/tmp/peggy_colormap_composite.png')
print("wrote /tmp/peggy_colormap_contactsheet.png and /tmp/peggy_colormap_composite.png")
