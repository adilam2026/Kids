// Génère l'icône Android (adaptative + classique + monochrome) et les écrans de lancement dans android/app/src/main/res.
// Nécessite Playwright + Chromium (voir README). Les PNG générés sont versionnés : la CI n'en a pas besoin.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const { chromium } = createRequire(import.meta.url)('playwright');
const RES = 'android/app/src/main/res';
const STAR = 'M256 92l46 100 109 12-81 74 23 108-97-55-97 55 23-108-81-74 109-12z';
const FACE = '<circle cx="226" cy="262" r="12" fill="#3B2F2F"/><circle cx="286" cy="262" r="12" fill="#3B2F2F"/><path d="M226 296q30 28 60 0" stroke="#3B2F2F" stroke-width="12" fill="none" stroke-linecap="round"/>';
const GRAD = '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFB05A"/><stop offset="1" stop-color="#FF6F3D"/></linearGradient></defs>';
// zone de sécurité adaptative : 66 dp visibles sur 108 → le motif occupe ≈ 56 % du carré
const fit = (inner) => `<g transform="translate(256 256) scale(.56) translate(-256 -256)">${inner}</g>`;
const svg = (body, bg = 'none') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="100%" height="100%">${GRAD}${bg === 'none' ? '' : bg}${body}</svg>`;
const full = svg(`<path d="${STAR}" fill="#FFF7EC"/>${FACE}`, '<rect width="512" height="512" fill="url(#g)"/>');
const roundBg = (r) => `<rect width="512" height="512" rx="${r}" fill="url(#g)"/>`;

const browser = await chromium.launch(); const page = await browser.newPage();
async function png(file, size, markup, transparent = true, w = size, h = size) {
  await page.setViewportSize({ width: w, height: h });
  await page.setContent(`<body style="margin:0;background:transparent;width:${w}px;height:${h}px;display:grid;place-items:center">${markup}</body>`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await page.screenshot({ path: file, omitBackground: transparent });
}
const box = (s, inner) => `<div style="width:${s}px;height:${s}px">${inner}</div>`;
const legacy = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
for (const [d, s] of Object.entries(legacy)) {
  const dir = `${RES}/mipmap-${d}`;
  await png(`${dir}/ic_launcher.png`, s, box(s, svg(`<path d="${STAR}" fill="#FFF7EC"/>${FACE}`, roundBg(112))));
  await png(`${dir}/ic_launcher_round.png`, s, box(s, svg(`<path d="${STAR}" fill="#FFF7EC"/>${FACE}`, '<circle cx="256" cy="256" r="256" fill="url(#g)"/>')));
  const f = Math.round(s * 108 / 48);
  await png(`${dir}/ic_launcher_foreground.png`, f, box(f, svg(fit(`<path d="${STAR}" fill="#FFF7EC"/>${FACE}`))));
  await png(`${dir}/ic_launcher_monochrome.png`, f, box(f, svg(fit(`<path d="${STAR}" fill="#000"/>`))));
}
fs.writeFileSync(`${RES}/values/ic_launcher_background.xml`, '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#FF8A3D</color>\n</resources>\n');
for (const f of ['ic_launcher.xml', 'ic_launcher_round.xml']) fs.writeFileSync(`${RES}/mipmap-anydpi-v26/${f}`,
  '<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n    <background android:drawable="@color/ic_launcher_background"/>\n    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n    <monochrome android:drawable="@mipmap/ic_launcher_monochrome"/>\n</adaptive-icon>\n');
// icône du Play Store / aperçu 512 (non utilisée par l'APK)
await png('android/store-icon-512.png', 512, box(512, full), false);
// écrans de lancement (Android < 12) : fond crème + mascotte
const portrait = { mdpi: [320, 480], hdpi: [480, 800], xhdpi: [720, 1280], xxhdpi: [960, 1600], xxxhdpi: [1280, 1920] };
for (const [d, [w, h]] of Object.entries(portrait)) for (const [dir, W, H] of [[`drawable-port-${d}`, w, h], [`drawable-land-${d}`, h, w], ...(d === 'mdpi' ? [['drawable', w, h]] : [])]) {
  const s = Math.round(Math.min(W, H) * 0.32);
  await png(`${RES}/${dir}/splash.png`, 0, `<div style="width:${W}px;height:${H}px;background:#FFF7EC;display:grid;place-items:center"><div style="width:${s}px;height:${s}px">${svg(`<path d="${STAR}" fill="#FFF7EC"/>${FACE}`, roundBg(112))}</div></div>`, false, W, H);
}
await browser.close();
console.log('icônes et écrans de lancement générés');
