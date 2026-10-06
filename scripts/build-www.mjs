// Construit l'interface embarquée dans l'application Android (dossier www/) à partir de public/.
//   node scripts/build-www.mjs              → www/ pour Capacitor (production)
//   node scripts/build-www.mjs --test --api http://127.0.0.1:3000 --out /tmp/www-test   → build de test Chromium
// Variables : PH_API_BASE (https://… obligatoire en production), VERSION_NAME, VERSION_CODE.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const TEST = process.argv.includes('--test');
const out = path.resolve(arg('out', path.join(root, 'www')));
const api = (arg('api', process.env.PH_API_BASE || 'https://petits-heros-production.up.railway.app')).replace(/\/$/, '');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const versionName = process.env.VERSION_NAME || pkg.version;
const versionCode = Number(process.env.VERSION_CODE || 1);

if (!TEST && !/^https:\/\//.test(api)) throw new Error(`PH_API_BASE doit être en HTTPS (reçu : ${api})`);
if (!Number.isInteger(versionCode) || versionCode < 1) throw new Error('VERSION_CODE invalide');

fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(root, 'public'), out, { recursive: true, filter: (p) => !/[\\/](sw\.js|manifest\.webmanifest)$/.test(p) });
fs.writeFileSync(path.join(out, 'config.js'),
  `window.PH_API_BASE = ${JSON.stringify(api)};\nwindow.PH_BUILD = ${versionCode};\nwindow.PH_VERSION = ${JSON.stringify(versionName)};\n`);
await build({
  entryPoints: [path.join(root, 'native', 'bridge.js')], bundle: true, format: 'iife', minify: true, target: 'es2020',
  outfile: path.join(out, 'native-bridge.js'), define: { __PH_TEST_NATIVE__: String(TEST) }, logLevel: 'warning',
});

// index.html : pont natif + CSP. connect-src limité à l'API ; pas de ressource distante.
// 'unsafe-inline' (scripts) : le pont Capacitor peut injecter du code inline ; à resserrer après essai sur appareil.
const csp = `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ${new URL(api).origin}; object-src 'none'; base-uri 'none'; form-action 'none'`;
let html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
html = html
  .replace('<link rel="manifest" href="/manifest.webmanifest">\n', '')
  .replace('<meta charset="utf-8">', `<meta charset="utf-8">\n<meta http-equiv="Content-Security-Policy" content="${csp}">`)
  .replace('<script src="/config.js"></script>', '<script src="/config.js"></script>\n<script src="/native-bridge.js"></script>');
if (!html.includes('native-bridge.js') || !html.includes('Content-Security-Policy')) throw new Error('index.html : injection échouée');
fs.writeFileSync(path.join(out, 'index.html'), html);
console.log(`www prêt : ${out} (API ${api}, version ${versionName}, build ${versionCode}${TEST ? ', MODE TEST' : ''})`);
