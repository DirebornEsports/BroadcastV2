"""Generate Uprising 2 art with Cloudflare Workers AI (free daily allowance) and cut it out of its black background.
Needs CLOUDFLARE_API_TOKEN in ../online/.env (Workers AI permission). Run from hub/:
  python tools/uprising2-gen.py            # all assets
  python tools/uprising2-gen.py island-1   # one asset
Writes public/themes/uprising2/gen/<name>.png (cut out, cropped) and keeps the raw jpg in gen/raw/."""
import base64, io, json, os, sys, urllib.request
from PIL import Image, ImageChops

MODEL = '@cf/black-forest-labs/flux-1-schnell'
STYLE = ('stylized fantasy game art, painterly, cool slate-blue and navy stone with ivory highlights, '
         'glowing jade-teal crystals, soft rim light, centered, isolated on pure solid black background, no text, no frame')
ASSETS = {
    'island-1': 'a large floating rock island with a small ancient stone ruin and arch on its flat top, jagged rock underside, hanging jade crystals',
    'island-2': 'a small floating rock island, flat top with a few ivory stones, cone shaped jagged underside, one glowing jade crystal',
    'island-3': 'a medium floating rock island with a cluster of tall glowing jade crystals growing on top, jagged underside',
    'crystal':  'a single tall glowing jade-teal crystal shard, faceted, bright inner light',
    'shards':   'five small floating broken rock shards and crystal splinters scattered, debris',
    'sky':      None,  # full-frame backdrop, not cut out
}
SKY = ('dramatic fantasy sky full of swirling navy blue and ivory clouds, beams of pale light from the top, '
       'stylized painterly game art, deep navy palette with faint teal glow, no islands, no text, full frame')


def env_token():
    for line in open(os.path.join('..', 'online', '.env'), encoding='utf-8'):
        k, _, v = line.strip().partition('=')
        if k == 'CLOUDFLARE_API_TOKEN':
            return v.strip().strip('"')
    sys.exit('CLOUDFLARE_API_TOKEN missing in online/.env')


def call(url, token, body=None):
    req = urllib.request.Request(url, data=body and json.dumps(body).encode(), method='POST' if body else 'GET',
                                 headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=120) as r:
        d = json.load(r)
    if not d.get('success'):
        sys.exit(f'Cloudflare error: {d.get("errors")}')
    return d['result']


def cut(im):
    """Black background -> alpha from the brightest channel, then crop to content."""
    im = im.convert('RGB')
    r, g, b = im.split()
    brightest = ImageChops.lighter(ImageChops.lighter(r, g), b)
    alpha = brightest.point(lambda v: 0 if v < 14 else min(255, (v - 14) * 6))
    out = im.copy()
    out.putalpha(alpha)
    box = alpha.point(lambda v: 255 if v > 24 else 0).getbbox()
    return out.crop(box) if box else out


def main():
    token = env_token()
    acc = call('https://api.cloudflare.com/client/v4/accounts', token)[0]['id']
    os.makedirs('public/themes/uprising2/gen/raw', exist_ok=True)
    for name in sys.argv[1:] or ASSETS:
        prompt = SKY if name == 'sky' else f'{ASSETS[name]}, {STYLE}'
        res = call(f'https://api.cloudflare.com/client/v4/accounts/{acc}/ai/run/{MODEL}', token, {'prompt': prompt, 'steps': 8})
        raw = base64.b64decode(res['image'])
        open(f'public/themes/uprising2/gen/raw/{name}.jpg', 'wb').write(raw)
        im = Image.open(io.BytesIO(raw))
        if name == 'sky':
            im.convert('RGB').save('public/themes/uprising2/gen/sky.jpg', quality=82)
        else:
            out = cut(im)
            out.thumbnail((640, 640))
            out.save(f'public/themes/uprising2/gen/{name}.png', optimize=True)
        print(name, 'ok')


if __name__ == '__main__':
    main()
