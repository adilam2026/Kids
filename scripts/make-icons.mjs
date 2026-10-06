// Génère les icônes PNG de la PWA à partir de public/icons/icon.svg (Chromium via Playwright).
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const svg = fs.readFileSync('public/icons/icon.svg', 'utf8');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage();
const shot = async (size, file, pad = 0) => {
  await page.setViewportSize({ width: size, height: size });
  const inner = Math.round(size * (1 - pad * 2));
  await page.setContent(`<body style="margin:0;background:#FF8A3D;display:grid;place-items:center;width:${size}px;height:${size}px"><div style="width:${inner}px;height:${inner}px">${svg.replace('<svg ', '<svg width="100%" height="100%" ')}</div></body>`);
  await page.screenshot({ path: file, omitBackground: false });
};
await shot(192, 'public/icons/icon-192.png');
await shot(512, 'public/icons/icon-512.png');
await shot(512, 'public/icons/icon-maskable-512.png', 0.12); // zone de sécurité maskable
await shot(180, 'public/icons/apple-touch-icon.png');
await browser.close();
