#!/usr/bin/env python3
"""Génère les icônes Android (classiques, adaptatives, monochrome, écrans de lancement) à partir de android/icon-source/petits-heros-mascotte.png.
Usage : python3 scripts/make-android-icon.py [--preview DIR]    (Pillow + numpy requis ; les PNG générés sont versionnés)
Principe : le fond crème est retiré (remplissage depuis les bords) → mascotte détourée (étoile, cape, éclats).
 • adaptative : couche avant 108 dp, toute la mascotte dans le cercle de sécurité de 66 dp ; fond uni crème ;
 • classique carrée (coins arrondis) et ronde : la mascotte entière à l'intérieur du masque ;
 • monochrome (Android 13+) : silhouette."""
import sys, os, collections
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
SRC = 'android/icon-source/petits-heros-mascotte.png'
RES = 'android/app/src/main/res'
CREAM = (252, 250, 237)          # fond de l'illustration fournie
SPLASH_BG = (255, 247, 236)      # fond existant de l'écran de lancement (#FFF7EC)

def cutout():
    im = Image.open(SRC).convert('RGB'); a = np.array(im).astype(float); h, w, _ = a.shape
    d = np.abs(a - np.array(CREAM)).sum(2)
    bgmask = np.zeros((h, w), bool); q = collections.deque()
    for x in range(w):
        for y in (0, h - 1): q.append((y, x))
    for y in range(h):
        for x in (0, w - 1): q.append((y, x))
    while q:
        y, x = q.popleft()
        if y < 0 or x < 0 or y >= h or x >= w or bgmask[y, x] or d[y, x] > 14: continue
        bgmask[y, x] = True
        q.extend(((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)))
    alpha = np.where(bgmask, 0.0, 1.0)
    # bord anti-crénelé : pixels voisins du fond → alpha proportionnel à l'écart de couleur, couleur « dé-mélangée »
    near = np.array(Image.fromarray((bgmask * 255).astype('uint8')).filter(ImageFilter.MaxFilter(5))) > 0
    edge = near & ~bgmask
    al = np.clip(d / 70.0, 0.15, 1.0)
    alpha = np.where(edge, al, alpha)
    rgb = a.copy()
    e = edge[..., None]
    mixed = (a - (1 - alpha[..., None]) * np.array(CREAM)) / np.maximum(alpha[..., None], 1e-3)
    rgb = np.where(e, np.clip(mixed, 0, 255), a)
    out = np.dstack([rgb, alpha * 255]).astype('uint8')
    return Image.fromarray(out, 'RGBA')

def subject_geometry(im):
    al = np.array(im.split()[3]) > 40
    ys, xs = np.where(al)
    cx, cy = (xs.min() + xs.max()) / 2, (ys.min() + ys.max()) / 2
    return xs, ys, cx, cy

def place(im, size, max_radius_frac, bg=None, centre_on='bbox'):
    """Place la mascotte sur un carré size×size : tous les pixels visibles à ≤ max_radius_frac*size du centre."""
    xs, ys, cx, cy = subject_geometry(im)
    r = np.sqrt((xs - cx) ** 2 + (ys - cy) ** 2).max()
    s = max_radius_frac * size / r
    sub = im.resize((round(im.width * s), round(im.height * s)), Image.LANCZOS)
    canvas = Image.new('RGBA', (size, size), (*bg, 255) if bg else (0, 0, 0, 0))
    ox, oy = round(size / 2 - cx * s), round(size / 2 - cy * s)
    layer = Image.new('RGBA', (size, size), (0, 0, 0, 0)); layer.paste(sub, (ox, oy), sub)
    return Image.alpha_composite(canvas, layer), layer

def mask_round(img, radius_frac=None, circle=False):
    n = img.width; m = Image.new('L', (n * 4, n * 4), 0); dr = ImageDraw.Draw(m)
    if circle: dr.ellipse((0, 0, n * 4 - 1, n * 4 - 1), fill=255)
    else: dr.rounded_rectangle((0, 0, n * 4 - 1, n * 4 - 1), radius=int(n * 4 * radius_frac), fill=255)
    m = m.resize((n, n), Image.LANCZOS); out = img.copy(); out.putalpha(m); return out

def main():
    preview = sys.argv[sys.argv.index('--preview') + 1] if '--preview' in sys.argv else None
    im = cutout()
    legacy = {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}
    for d, s in legacy.items():
        dr = f'{RES}/mipmap-{d}'; os.makedirs(dr, exist_ok=True)
        S = s * 4
        sq, _ = place(im, S, 0.47, bg=CREAM)                      # carrée : la diagonale utile reste dans le carré à coins arrondis
        mask_round(sq, 0.2).resize((s, s), Image.LANCZOS).save(f'{dr}/ic_launcher.png')
        rd, _ = place(im, S, 0.42, bg=CREAM)                      # ronde : toute la mascotte dans le cercle
        mask_round(rd, circle=True).resize((s, s), Image.LANCZOS).save(f'{dr}/ic_launcher_round.png')
        f = round(s * 108 / 48); F = f * 4
        _, fg = place(im, F, 33 * 0.96 / 108)                     # cercle de sécurité adaptatif : rayon 33 dp sur 108, marge 4 %
        fg.resize((f, f), Image.LANCZOS).save(f'{dr}/ic_launcher_foreground.png')
        small = fg.resize((f, f), Image.LANCZOS); sil = Image.new('RGBA', (f, f), (0, 0, 0, 0)); sil.putalpha(small.split()[3]); sil.save(f'{dr}/ic_launcher_monochrome.png')
    open(f'{RES}/values/ic_launcher_background.xml', 'w').write('<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#%02X%02X%02X</color>\n</resources>\n' % CREAM)
    # icône 512 (Play Store / aperçu), pleine, sans transparence
    Image.open(SRC).convert('RGB').save('android/store-icon-512.png')
    # écrans de lancement (Android < 12) : fond existant + mascotte
    portrait = {'mdpi': (320, 480), 'hdpi': (480, 800), 'xhdpi': (720, 1280), 'xxhdpi': (960, 1600), 'xxxhdpi': (1280, 1920)}
    for d, (w, h) in portrait.items():
        for name, W, H in [(f'drawable-port-{d}', w, h), (f'drawable-land-{d}', h, w)] + ([('drawable', w, h)] if d == 'mdpi' else []):
            sz = round(min(W, H) * 0.42); sub, _ = place(im, sz, 0.5)
            cv = Image.new('RGB', (W, H), SPLASH_BG); cv.paste(sub, ((W - sz) // 2, (H - sz) // 2), sub)
            os.makedirs(f'{RES}/{name}', exist_ok=True); cv.save(f'{RES}/{name}/splash.png')
    if preview: make_preview(im, preview)
    print('icônes générées')

def make_preview(im, outdir):
    """Planche de contrôle : adaptative 108 dp sous 5 masques (rond, carré arrondi, écureuil, carré, goutte) + icônes classiques."""
    os.makedirs(outdir, exist_ok=True)
    N = 432  # 4 px / dp
    _, fg = place(im, N, 33 * 0.96 / 108)
    bgl = Image.new('RGBA', (N, N), (*CREAM, 255)); full = Image.alpha_composite(bgl, fg)
    view = N * 72 // 108; off = (N - view) // 2
    def crop(img): return img.crop((off, off, off + view, off + view))
    def shape(kind):
        m = Image.new('L', (view * 4, view * 4), 0); d = ImageDraw.Draw(m); n = view * 4
        if kind == 'circle': d.ellipse((0, 0, n - 1, n - 1), fill=255)
        elif kind == 'squircle': d.rounded_rectangle((0, 0, n - 1, n - 1), radius=int(n * .34), fill=255)
        elif kind == 'rounded': d.rounded_rectangle((0, 0, n - 1, n - 1), radius=int(n * .16), fill=255)
        elif kind == 'square': d.rectangle((0, 0, n - 1, n - 1), fill=255)
        elif kind == 'teardrop':
            d.rounded_rectangle((0, 0, n - 1, n - 1), radius=int(n * .5), fill=255); d.rectangle((n // 2, n // 2, n - 1, n - 1), fill=255)
        return m.resize((view, view), Image.LANCZOS)
    kinds = ['circle', 'squircle', 'rounded', 'square', 'teardrop']
    sheet = Image.new('RGB', (view * 5 + 60, view * 2 + 90), (225, 225, 225)); x = 10
    for k in kinds:
        c = crop(full).convert('RGBA'); c.putalpha(shape(k)); sheet.paste(c, (x, 10), c); x += view + 10
    # ligne 2 : sans masque (fond crème), cercle de sécurité 66 dp tracé, icônes classiques
    raw = crop(full).convert('RGB'); sheet.paste(raw, (10, view + 40))
    chk = crop(full).convert('RGB'); dd = ImageDraw.Draw(chk); rr = view * 66 // 72 // 2; dd.ellipse((view // 2 - rr, view // 2 - rr, view // 2 + rr, view // 2 + rr), outline=(220, 40, 40), width=2)
    sheet.paste(chk, (view + 20, view + 40))
    for i, n in enumerate(['ic_launcher', 'ic_launcher_round']):
        ic = Image.open(f'{RES}/mipmap-xxxhdpi/{n}.png').convert('RGBA').resize((view, view), Image.LANCZOS); sheet.paste(ic, (view * (2 + i) + 30 + 10 * i, view + 40), ic)
    mono = Image.open(f'{RES}/mipmap-xxxhdpi/ic_launcher_monochrome.png').convert('RGBA'); mo = Image.new('RGBA', mono.size, (255, 255, 255, 255)); mo.paste(mono, (0, 0), mono)
    sheet.paste(crop(mo.resize((N, N), Image.LANCZOS)).convert('RGB'), (view * 4 + 50, view + 40))
    sheet.save(f'{outdir}/controle-masques.png')
    # contrôle chiffré : rayon max des pixels visibles / rayon de sécurité (33 dp sur 108)
    al = np.array(fg.split()[3]) > 40; ys, xs = np.where(al); r = np.sqrt((xs - N / 2) ** 2 + (ys - N / 2) ** 2).max() / (N / 108)
    print(f'rayon max des pixels visibles : {r:.1f} dp (limite de sécurité 33 dp ; masque rond visible : 36 dp)')
    assert r <= 33.0, 'la mascotte dépasse le cercle de sécurité'

if __name__ == '__main__': main()
