#!/usr/bin/env python3
"""Vérifie que l'APK embarque bien les icônes du dépôt (comparaison des pixels décodés, indépendante du nom ni de la recompression).
Usage : python3 android/scripts/check-icon.py app.apk"""
import sys, io, zipfile, os
from PIL import Image, ImageChops
apk = sys.argv[1]; RES = 'android/app/src/main/res'
want = {}
for d in ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']:
    for n in ['ic_launcher', 'ic_launcher_round', 'ic_launcher_foreground', 'ic_launcher_monochrome']:
        want[f'mipmap-{d}/{n}.png'] = Image.open(f'{RES}/mipmap-{d}/{n}.png').convert('RGBA')
found = dict.fromkeys(want, False)
with zipfile.ZipFile(apk) as z:
    for name in z.namelist():
        if not name.endswith('.png') or not name.startswith('res/'): continue
        try: im = Image.open(io.BytesIO(z.read(name))).convert('RGBA')
        except Exception: continue
        for k, ref in want.items():
            if not found[k] and im.size == ref.size and ImageChops.difference(im, ref).getbbox() is None: found[k] = True
miss = [k for k, v in found.items() if not v]
if miss: print('ÉCHEC : icônes du dépôt absentes de l\'APK :', ', '.join(miss)); sys.exit(1)
print(f'icônes OK : {len(found)} images identiques à celles du dépôt (classiques, rondes, adaptatives, monochromes)')
