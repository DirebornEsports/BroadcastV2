"""Bake Uprising 2 assets from the Uprising 1 art: same shapes, recolored to the Uprising 2 palette
(navy / ice / ivory, jade only on gems). Gradient map on luminance, alpha kept.
Run from hub/: python tools/uprising2-assets.py  ->  public/themes/uprising2/*"""
import os
from PIL import Image, ImageOps, ImageDraw

SRC, OUT = 'public', 'public/themes/uprising2'
NAVY = [(0, '#070d24'), (.3, '#1a2a5c'), (.55, '#4a67a8'), (.72, '#b8c6e6'), (.85, '#f1e6cc'), (1, '#fffaf0')]
JADE = [(0, '#04201f'), (.4, '#0f6f66'), (.7, '#3de0c4'), (1, '#e8fff9')]


def lut(stops):
    rgb = [tuple(int(c[i:i + 2], 16) for i in (1, 3, 5)) for _, c in stops]
    out = []
    for v in range(256):
        t = v / 255
        i = max(k for k in range(len(stops)) if stops[k][0] <= t)
        j = min(i + 1, len(stops) - 1)
        span = (stops[j][0] - stops[i][0]) or 1
        f = (t - stops[i][0]) / span
        out.append(tuple(round(rgb[i][n] + (rgb[j][n] - rgb[i][n]) * f) for n in range(3)))
    return out


def remap(im, stops, gain=1.0):
    im = im.convert('RGBA')
    a = im.getchannel('A')
    g = ImageOps.autocontrast(im.convert('L'), cutoff=1).point(lambda v: min(255, int(v * gain)))
    table = lut(stops)
    r, gg, b = (g.point([table[v][n] for v in range(256)]) for n in range(3))
    out = Image.merge('RGBA', (r, gg, b, a))
    return out


os.makedirs(OUT, exist_ok=True)
base = Image.open(f'{SRC}/themes/uprising/base.png')
jobs = {
    'cloud-ornament.png': (Image.open(f'{SRC}/assets/cloud-ornament.png'), NAVY),
    'cloud-dark.png': (Image.open(f'{SRC}/assets/cloud-dark.png'), NAVY),
    'watermark.png': (Image.open(f'{SRC}/themes/uprising/watermark.png'), NAVY),
    'gem.png': (base.crop((915, 478, 1005, 572)), JADE),
    'sky.jpg': (Image.open(f'{SRC}/assets/clouds.jpg'), NAVY[:4]),
}
def finish(name, out):
    if name == 'gem.png':  # crop came off the panel: keep only the diamond
        m = Image.new('L', out.size, 0)
        ImageDraw.Draw(m).polygon([(45, 4), (86, 47), (45, 90), (4, 47)], fill=255)
        out.putalpha(m)
    elif name == 'watermark.png':  # flat ivory, shape from the source alpha
        flat = Image.new('RGBA', out.size, (241, 230, 204, 255)); flat.putalpha(out.getchannel('A')); out = flat
    return out


for name, (im, stops) in jobs.items():
    out = finish(name, remap(im, stops))
    if name.endswith('.jpg'):
        out.convert('RGB').save(f'{OUT}/{name}', quality=82)
    else:
        out.save(f'{OUT}/{name}', optimize=True)
    print(name, out.size)
