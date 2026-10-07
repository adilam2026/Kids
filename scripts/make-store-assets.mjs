// Visuels de la fiche Google Play, générés avec la VRAIE interface sur une famille fictive (aucune donnée personnelle).
//   Base de test locale requise (voir test/guard.js) :  node scripts/make-store-assets.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { startServer, Client } from '../test/helpers.js';

const { chromium } = createRequire(import.meta.url)('playwright');
const S = await startServer();
const OUT = 'store';
fs.mkdirSync(`${OUT}/graphics`, { recursive: true }); fs.mkdirSync(`${OUT}/screenshots`, { recursive: true });

// --- famille fictive ---
const parent = new Client(S.base);
await parent.post('/api/auth/register', { email: 'famille.exemple@example.com', name: 'Camille', password: 'exemple-fictif-123', familyName: 'Famille Exemple' });
await parent.post('/api/auth/recovery-codes', { password: 'exemple-fictif-123' });
const kid = async (name, avatar, color, age) => (await parent.post('/api/children', { name, avatar, color, age })).body.id;
const [leo, mila, noe] = [await kid('Léo', '🦊', '#FF8A3D', 8), await kid('Mila', '🐰', '#8E6CEF', 6), await kid('Noé', '🐻', '#3BA4F5', 4)];
const st0 = await parent.state();
const act = (t) => st0.actions.find((a) => a.title.toLowerCase().includes(t));
const give = (id, a) => parent.post(`/api/children/${id}/points`, { value: a.value, actionId: a.id });
const acts = st0.actions.filter((a) => a.value > 0 && !a.min_interval_hours);
for (let i = 0; i < 6; i++) await give(leo, acts[i % acts.length]);
for (let i = 0; i < 4; i++) await give(mila, acts[(i + 2) % acts.length]);
for (let i = 0; i < 2; i++) await give(noe, acts[(i + 4) % acts.length]);
await parent.post(`/api/children/${leo}/points`, { value: 12, reason: 'Aide pour ranger le garage' });
await parent.post(`/api/children/${mila}/points`, { value: 10, reason: 'Bravo pour la lecture' });
const tidy = acts[0];
await parent.post('/api/challenges', { title: 'Une semaine de rangement', icon: '🧹', actionId: tidy.id, childIds: [leo, mila, noe], collective: false, startsOn: st0.today, endsOn: st0.today, target: 3, frequency: 'any', bonus: 10 });
await parent.post(`/api/children/${leo}/points`, { value: tidy.value, actionId: tidy.id });

const browser = await chromium.launch();
const mk = async (w, h, dpr) => {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr, isMobile: true, hasTouch: true, locale: 'fr-FR' });
  await ctx.addCookies([{ name: 'ph_session', value: decodeURIComponent(parent.cookie.split('=')[1]), url: S.base }]);
  return ctx;
};
const ctx = await mk(360, 640, 3); // 1080 × 1920
const P = await ctx.newPage();
const shot = async (file) => { await P.waitForTimeout(500); await P.screenshot({ path: `${OUT}/screenshots/${file}.png` }); console.log('✓', file); };
await P.goto(S.base + '/#/children'); await P.waitForSelector('.child.mini');
await shot('01-enfants');
await P.click(`.child.mini:first-child [data-act=points][data-sign="+"]`); await P.waitForTimeout(500);
await P.click('.seg button:has-text("Bonne action")'); await shot('02-donner-des-points');
await P.keyboard.press('Escape');
await P.goto(S.base + `/#/child/${leo}`); await P.waitForTimeout(900);
await P.evaluate(() => { [...document.querySelectorAll('h2.sec')].find((h) => h.textContent.trim() === 'Historique').scrollIntoView({ block: 'start' }); window.scrollBy(0, -110); });
await shot('03-fiche-enfant-historique');
await P.goto(S.base + '/#/challenges'); await P.waitForTimeout(600); await shot('04-defis');
await P.goto(S.base + '/#/rewards'); await P.waitForTimeout(600); await shot('05-recompenses');
await P.goto(S.base + '/#/family'); await P.waitForTimeout(600);
await P.evaluate(() => { document.querySelector('[data-act=toggleSound]').scrollIntoView({ block: 'start' }); window.scrollBy(0, -110); });
await shot('06-famille-reglages');
await ctx.close();

// Icône 512 et image de présentation : issues de l'illustration mascotte (android/icon-source/petits-heros-mascotte.png) — non régénérées ici.
await browser.close(); await S.close();
console.log('visuels écrits dans store/');
