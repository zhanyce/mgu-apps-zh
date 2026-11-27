#!/usr/bin/env python3
"""bake_arabic.py <arabic.ttf> <latin.ttf> <out.json> <size> ... : the kit's 'arabic' atlas (kit/runtime/fonts.js):
Arabic presentation forms and letters from the Arabic font, Latin (ASCII, Latin-1, quotes, dashes) from the Latin one,
both at a semi-bold weight. Text with Arabic in it is drawn whole in this family (arabic.js shapes it first)."""
import base64, hashlib, json, os, sys, zlib
from PIL import Image, ImageDraw, ImageFont

LATIN = list(range(32, 127)) + list(range(160, 256)) + [0x2018, 0x2019, 0x201C, 0x201D, 0x2013, 0x2014, 0x2026, 0x2022, 0x00B7]
ARABIC = list(range(0xFE70, 0xFEFD)) + [0x060C, 0x061B, 0x061F, 0x0640] + list(range(0x0660, 0x066A)) + \
    [0xFB56, 0xFB57, 0xFB58, 0xFB59, 0xFB7A, 0xFB7B, 0xFB7C, 0xFB7D, 0xFB8A, 0xFB8B, 0xFB8E, 0xFB8F, 0xFB90, 0xFB91,
     0xFB92, 0xFB93, 0xFB94, 0xFB95, 0xFBFC, 0xFBFD, 0xFBFE, 0xFBFF]
ATLAS_W, PAD = 1024, 1

def font(path, size):
    f = ImageFont.truetype(path, size)
    try: f.set_variation_by_axes([600] if 'Arabic' in path else [14, 600])
    except Exception:
        try: f.set_variation_by_name('SemiBold')
        except Exception: pass
    return f

def bake(ar, la, size):
    fa, fl = font(ar, size), font(la, size)
    asc, desc = fl.getmetrics()
    boxes = []
    for cp in LATIN + ARABIC:
        f = fa if cp >= 0x0600 else fl
        ch = chr(cp); adv = round(f.getlength(ch), 2)
        l, t, r, b = f.getbbox(ch, anchor='ls')
        boxes.append((cp, ch, f, l, t, r - l, b - t, adv))
    x = y = shelf = 0; place = {}
    for cp, ch, f, l, t, w, h, adv in sorted(boxes, key=lambda g: -g[6]):
        if w <= 0 or h <= 0: place[cp] = (0, 0, 0, 0); continue
        if x + w + PAD > ATLAS_W: x = 0; y += shelf + PAD; shelf = 0
        place[cp] = (x, y, w, h); x += w + PAD; shelf = max(shelf, h)
    H = y + shelf + PAD
    atlas = Image.new('L', (ATLAS_W, H), 0); d = ImageDraw.Draw(atlas); glyphs = {}
    for cp, ch, f, l, t, w, h, adv in boxes:
        gx, gy, gw, gh = place[cp]
        if gw: d.text((gx - l, gy - t), ch, font=f, fill=255, anchor='ls')
        glyphs[str(cp)] = [gx, gy, gw, gh, l if gw else 0, t if gw else 0, adv]
    return {'size': size, 'ascent': asc, 'descent': desc, 'atlasW': ATLAS_W, 'atlasH': H,
            'alpha': base64.b64encode(zlib.compress(atlas.tobytes(), 9)).decode('ascii'), 'glyphs': glyphs}

ar, la, out, sizes = sys.argv[1], sys.argv[2], sys.argv[3], [int(s) for s in sys.argv[4:]]
j = {'family': 'arabic', 'source': os.path.basename(ar) + ' + ' + os.path.basename(la), 'sizes': [bake(ar, la, s) for s in sizes]}
j['cacheKey'] = 'arabic-' + hashlib.sha1(json.dumps(j['sizes'], sort_keys=True).encode()).hexdigest()[:10]
json.dump(j, open(out, 'w'), separators=(',', ':'))
print('wrote %s, sizes %s, %d KB' % (out, sizes, os.path.getsize(out) // 1024))
