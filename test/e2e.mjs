// Test navigateur de bout en bout : deux « téléphones » (Chromium), vrai serveur, vraie base.
// Lancer : DATABASE_URL=... node test/e2e.mjs   (nécessite Playwright + Chromium)
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resetTestDatabase } from './guard.js';
import { createApp } from '../server/app.js';
import { migrate } from '../server/migrate.js';
import { closePool } from '../server/db.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const OUT = process.env.SHOTS || '/tmp/ph-shots';
fs.mkdirSync(OUT, { recursive: true });

await resetTestDatabase();
await migrate(() => {});
const server = createApp().listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const phone = { viewport: { width: 390, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'fr-FR' };
const ctxA = await browser.newContext(phone), ctxB = await browser.newContext(phone);
const A = await ctxA.newPage(), B = await ctxB.newPage();
const errors = [];
for (const [n, p] of [['A', A], ['B', B]]) p.on('pageerror', (e) => errors.push(`${n}: ${e.message}`));
const shot = async (p, name) => { await p.waitForTimeout(450); return p.screenshot({ path: `${OUT}/${name}.png` }); };
const text = (p, sel) => p.locator(sel).first().innerText();
const bal = async (p, name) => Number(await p.locator(`.child:has(h2:text-is("${name}")) .bal b`).first().innerText());
let step = 0; const ok = (m) => console.log(`✓ ${++step}. ${m}`);

// 1. Parent A crée sa famille et trois enfants
await A.goto(base);
await A.click('text=Créer ma famille');
await A.fill('input[name=name]', 'Maman'); await A.fill('input[name=email]', 'maman@example.fr');
await A.fill('input[name=password]', 'motdepasse-solide'); await A.fill('input[name=familyName]', 'Les Martin');
await shot(A, '01-register');
await A.click('button:has-text("Créer mon compte")');
// écran obligatoire des codes de secours (une seule fois)
await A.waitForSelector('.recovery code');
assert.equal(await A.locator('.recovery code').count(), 8);
assert.ok(await A.locator('#ackBtn').isDisabled());
await shot(A, '00-codes-secours');
const recoveryCodes = await A.locator('.recovery code').allInnerTexts();
await A.check('#ackRecovery'); await A.click('#ackBtn');
await A.waitForSelector('text=Ajoute ton premier enfant');
for (const n of ['Léa', 'Tom', 'Zoé']) {
  await A.click('[data-act=childForm]');
  await A.fill('input[name=name]', n);
  await A.click('.panel button:has-text("Ajouter")');
  await A.waitForSelector(`.child h2:text-is("${n}")`);
}
await shot(A, '02-enfants');
ok('création de 3 enfants via l’interface');

// 2. Invitation → second parent
await A.click('.tabs a:has-text("Famille")');
await A.click('text=Inviter l’autre parent');
await A.waitForSelector('.big-code');
const code = await text(A, '.big-code');
assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
await shot(A, '03-invitation');
await A.click('[data-act=closeSheet]');
await B.goto(base);
await B.click('text=J’ai un code d’invitation');
await B.fill('input[name=name]', 'Papa'); await B.fill('input[name=email]', 'papa@example.fr');
await B.fill('input[name=password]', 'autre-mot-de-passe'); await B.fill('input[name=code]', code);
await B.click('button:has-text("Rejoindre")');
await B.waitForSelector('.recovery code'); await B.check('#ackRecovery'); await B.click('#ackBtn');
await B.waitForSelector('text=Presque prêt');
await shot(B, '04-attente');
ok('second parent : compte + code → en attente d’approbation');
await A.waitForSelector('button:has-text("Approuver")', { timeout: 6000 });
await A.click('button:has-text("Approuver")');
await B.waitForSelector('.child h2:text-is("Léa")', { timeout: 8000 });
ok('approbation → le second parent voit les mêmes enfants (sans recharger)');

// 3. Attribution : A donne +3 à Léa via une bonne action ; B le voit en < 5 s
await A.click('.tabs a:has-text("Enfants")');
await A.click('.child:has(h2:text-is("Léa")) [data-act=points][data-sign="+"]');
await A.click('.seg button:has-text("Bonne action")');
await shot(A, '05-bonne-action');
await A.click('.row:has-text("Aider son frère ou sa sœur")');
await A.click('[data-act=pointsConfirm]');
await A.waitForSelector('.toast:has-text("+3")');
await shot(A, '06-toast');
assert.equal(await bal(A, 'Léa'), 3);
const t0 = Date.now();
await B.waitForFunction(() => document.querySelector('.child .bal b')?.innerText === '3', null, { timeout: 5000 });
ok(`le solde apparaît sur l’autre téléphone en ${Date.now() - t0} ms`);

// 4. Double clic sur « Confirmer » : une seule attribution
await A.click('.child:has(h2:text-is("Tom")) [data-act=points][data-sign="+"]');
await A.click('.quick button:has-text("+5")');
await A.locator('[data-act=pointsConfirm]').dblclick();
await A.waitForSelector('.toast:has-text("Tom")');
await A.waitForTimeout(600);
assert.equal(await bal(A, 'Tom'), 5);
ok('double clic → +5 attribué une seule fois');

// 5. Ajouts simultanés des deux parents
await Promise.all([
  (async () => { await A.click('.child:has(h2:text-is("Zoé")) [data-act=points][data-sign="+"]'); await A.click('.quick button:has-text("+2")'); await A.click('[data-act=pointsConfirm]'); })(),
  (async () => { await B.click('.child:has(h2:text-is("Zoé")) [data-act=points][data-sign="+"]'); await B.click('.quick button:has-text("+5")'); await B.click('[data-act=pointsConfirm]'); })(),
]);
await A.waitForFunction(() => [...document.querySelectorAll('.child')].find((c) => c.querySelector('h2').innerText === 'Zoé')?.querySelector('.bal b').innerText === '7', null, { timeout: 6000 });
ok('+2 (A) et +5 (B) simultanés → 7');

// 6. Retrait : refus si solde insuffisant, puis OK, puis Annuler
await A.click('.child:has(h2:text-is("Léa")) [data-act=points][data-sign="-"]');
await A.click('.seg button:has-text("Libre")');
await A.fill('input[data-bind=value]', '-10'); await A.fill('input[data-bind=reason]', 'test');
assert.ok(await A.locator('[data-act=pointsConfirm]').isDisabled());
await shot(A, '07-retrait-insuffisant');
await A.fill('input[data-bind=value]', '-2');
await A.click('[data-act=pointsConfirm]');
await A.waitForSelector('.toast:has-text("−2")');
assert.equal(await bal(A, 'Léa'), 1);
await A.click('.toast button:has-text("Annuler")');
await A.waitForSelector('.toast:has-text("Annulé")');
assert.equal(await bal(A, 'Léa'), 3);
ok('retrait trop élevé bloqué ; retrait puis « Annuler » restaure le solde');

// 7. Défi + récompense
await A.click('.tabs a:has-text("Défis")');
await A.click('[data-act=challengeForm]');
await A.fill('input[name=title]', 'Jouets 2 fois');
await A.selectOption('select[name=actionId]', { label: '🧸 Ranger ses jouets (+2)' });
await A.check('input[name=kids] >> nth=0');
await A.fill('input[name=target]', '2'); await A.fill('input[name=bonus]', '10');
await A.selectOption('select[name=frequency]', 'any');
await shot(A, '08-defi-form');
await A.click('button:has-text("Lancer le défi")');
await A.waitForSelector('.card:has-text("Jouets 2 fois")');
await A.click('button:has-text("Valider")'); await A.waitForSelector('.toast:has-text("+2")'); await A.waitForTimeout(300);
await A.click('button:has-text("Valider")'); await A.waitForSelector('.toast:has-text("défi réussi")');
await shot(A, '09-defi-reussi');
await A.click('.tabs a:has-text("Enfants")');
assert.equal(await bal(A, 'Léa'), 3 + 2 + 2 + 10);
ok('défi : +2, +2 puis bonus final +10 une seule fois → 17');
await A.click('.tabs a:has-text("Récompenses")');
await shot(A, '10-recompenses');
await A.click('.card:has-text("Choisir le jeu familial") button:has-text("Échanger")');
await A.click('button:has-text("Échanger 10 pts")');
await A.waitForSelector('.toast:has-text("à réaliser")');
await A.waitForSelector('h2:has-text("À réaliser")');
ok('échange de récompense → « à réaliser » (solde débité)');
await A.click('button:has-text("Réalisée")');
await A.waitForSelector('text=Déjà réalisées');
ok('récompense marquée réalisée');

// 8. Profil : historique + bilan
await A.click('.tabs a:has-text("Enfants")');
await A.click('.child:has(h2:text-is("Léa")) .child-head');
await A.waitForSelector('.hist');
await shot(A, '11-profil');
const histTxt = await text(A, '.card:has(.hist)');
assert.ok(histTxt.includes('Bonus du défi'));
ok('profil enfant : historique et bilan hebdomadaire');

// 9. Hors connexion : indicateur + modifications désactivées
await ctxB.setOffline(true);
await B.waitForSelector('.banner:has-text("Hors connexion")', { timeout: 8000 });
await shot(B, '12-hors-ligne');
const pe = await B.locator('.child [data-act=points]').first().evaluate((el) => getComputedStyle(el).pointerEvents);
assert.equal(pe, 'none');
ok('hors connexion : bandeau visible, boutons +/− désactivés, données conservées');
await ctxB.setOffline(false);
await B.waitForSelector('.banner', { state: 'detached', timeout: 8000 });

// 10. Mode enfant
await B.click('.tabs a:has-text("Famille")');
await B.click('[data-act=lockOn]'); await B.fill('input[name=pin]', '1234'); await B.click('button:has-text("Activer")');
await B.waitForSelector('.lock');
assert.equal(await B.locator('[data-act=points]').count(), 0);
await shot(B, '13-mode-enfant');
await B.click('.tabs a:has-text("Famille")'); await B.click('button:has-text("Je suis un parent")');
await B.fill('input[name=pin]', '0000'); await B.click('button:has-text("Déverrouiller")');
await B.waitForSelector('.err');
await B.fill('input[name=pin]', '1234'); await B.click('button:has-text("Déverrouiller")');
await B.waitForSelector('.lock', { state: 'detached' });
ok('mode enfant : lecture seule, déverrouillage par code');

// 11. Famille / bibliothèque
await A.click('.tabs a:has-text("Famille")');
await shot(A, '14-famille');
await A.click('text=Bibliothèque d’actions');
await shot(A, '15-bibliotheque');
ok('écrans Famille et Bibliothèque');

// ===== Vérifications mobile / cache / sécurité locale (Chromium émulé) =====
const MIN = 44;
const overflowX = (p) => p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const smallTargets = (p, scope = 'body') => p.evaluate(({ scope, MIN }) => {
  const bad = [];
  for (const el of document.querySelectorAll(`${scope} button, ${scope} a, ${scope} select, ${scope} input:not([type=checkbox]):not([type=hidden])`)) {
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    if (r.width === 0 || r.height === 0 || cs.visibility === 'hidden' || cs.display === 'none') continue;
    if (r.height < MIN - 1 || r.width < MIN - 1) bad.push(`${el.tagName} "${(el.innerText || el.name || el.ariaLabel || '').slice(0, 25)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
  }
  return bad;
}, { scope, MIN });
const minFont = (p) => p.evaluate(() => { let m = 99; for (const el of document.querySelectorAll('#app *')) { if (!el.childNodes.length || ![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue; m = Math.min(m, parseFloat(getComputedStyle(el).fontSize)); } return m; });

// 12. écran étroit (iPhone SE / petit Android : 320x568) — pas de débordement, cibles tactiles, texte lisible
const ctxS = await browser.newContext({ ...phone, viewport: { width: 320, height: 568 } });
const S1 = await ctxS.newPage(); S1.on('pageerror', (e) => errors.push('S: ' + e.message));
await S1.goto(base);
await S1.fill('input[name=email]', 'maman@example.fr'); await S1.fill('input[name=password]', 'motdepasse-solide');
await S1.click('button:has-text("Se connecter")');
await S1.waitForSelector('.child h2');
for (const tab of ['Enfants', 'Défis', 'Récompenses', 'Famille']) {
  await S1.click(`.tabs a:has-text("${tab}")`); await S1.waitForTimeout(250);
  assert.ok((await overflowX(S1)) <= 0, `débordement horizontal sur ${tab}`);
  const bad = await smallTargets(S1, '#app');
  assert.deepEqual(bad, [], `cibles tactiles < ${MIN}px sur ${tab}: ${bad.join(', ')}`);
  assert.ok((await minFont(S1)) >= 13.5, `texte trop petit sur ${tab}: ${await minFont(S1)}px`);
}
await shot(S1, '16-etroit-famille');
ok('320×568 : aucun débordement horizontal, cibles tactiles ≥ 44 px, texte ≥ 13,5 px sur les 4 onglets');

// fenêtres : défilement interne, bouton de confirmation atteignable, pas de débordement, fond figé
await S1.click('.tabs a:has-text("Enfants")');
await S1.click('.child:has(h2:text-is("Zoé")) [data-act=points][data-sign="+"]');
await S1.click('.seg button:has-text("Bonne action")');
const sheetInfo = await S1.evaluate(() => { const p = document.querySelector('.panel'); return { sh: p.scrollHeight, ch: p.clientHeight, ph: p.getBoundingClientRect().height, vh: innerHeight, body: getComputedStyle(document.body).overflow, ow: p.scrollWidth - p.clientWidth }; });
assert.ok(sheetInfo.sh > sheetInfo.ch, 'la fenêtre doit défiler (contenu long)'); assert.ok(sheetInfo.ph <= sheetInfo.vh, 'fenêtre plus haute que l’écran'); assert.equal(sheetInfo.body, 'hidden'); assert.ok(sheetInfo.ow <= 0);
const bad = await smallTargets(S1, '.panel'); assert.deepEqual(bad, [], 'cibles de la fenêtre : ' + bad.join(', '));
await S1.click('.row:has-text("Ranger ses jouets")');
await S1.locator('[data-act=pointsConfirm]').scrollIntoViewIfNeeded();
const cb = await S1.locator('[data-act=pointsConfirm]').boundingBox(); assert.ok(cb.y + cb.height <= 568 && cb.y >= 0, 'bouton Confirmer hors écran');
await S1.keyboard.press('Escape');
ok('fenêtre : défilement interne, fond figé, bouton Confirmer atteignable à 320×568');

// clavier : la zone visible rétrécit (≈ clavier ouvert) → le champ actif et le bouton restent atteignables
await S1.click('.child:has(h2:text-is("Zoé")) [data-act=points][data-sign="-"]');
await S1.click('.seg button:has-text("Libre")');
await S1.focus('input[data-bind=reason]');
await S1.setViewportSize({ width: 320, height: 300 });
await S1.waitForTimeout(700);
const kb = await S1.evaluate(() => { const i = document.querySelector('input[data-bind=reason]').getBoundingClientRect(); const p = document.querySelector('.panel').getBoundingClientRect(); return { top: i.top, bottom: i.bottom, vh: innerHeight, panelBottom: p.bottom }; });
assert.ok(kb.top >= 0 && kb.bottom <= kb.vh, `champ masqué par le clavier simulé (${JSON.stringify(kb)})`); assert.ok(kb.panelBottom <= kb.vh + 1);
await S1.fill('input[data-bind=value]', '-1'); await S1.fill('input[data-bind=reason]', 'test clavier');
await S1.locator('[data-act=pointsConfirm]').scrollIntoViewIfNeeded();
assert.ok(await S1.locator('[data-act=pointsConfirm]').isEnabled());
await S1.setViewportSize({ width: 320, height: 568 }); await S1.keyboard.press('Escape');
ok('clavier simulé (viewport réduit à 300 px) : champ visible, confirmation atteignable');

// notifications : ne masquent ni la navigation ni les boutons d'action
await S1.click('.child:has(h2:text-is("Zoé")) [data-act=points][data-sign="+"]');
await S1.click('.quick button >> nth=1'); await S1.click('[data-act=pointsConfirm]');
await S1.waitForSelector('.toast');
// la notification doit rester DANS la zone d'en-tête (sticky, sans action) ; on défile pour mettre des boutons « + » sous l'en-tête
await S1.evaluate(() => window.scrollTo(0, 120)); await S1.waitForTimeout(500);
const ov = await S1.evaluate(() => { const t = document.querySelector('.toast').getBoundingClientRect(); const h = document.querySelector('.topbar').getBoundingClientRect();
  const hit = (sel) => [...document.querySelectorAll(sel)].some((el) => { const r = el.getBoundingClientRect(); return r.width && !(t.right < r.left || t.left > r.right || t.bottom < r.top || t.top > r.bottom); });
  return { inHeader: t.top >= h.top - 1 && t.bottom <= h.bottom + 1, tabs: hit('.tabs a'), undoH: document.querySelector('.toast button').getBoundingClientRect().height, tb: t.bottom, hb: h.bottom }; });
assert.ok(ov.inHeader, 'la notification dépasse de l’en-tête ' + JSON.stringify(ov)); assert.equal(ov.tabs, false); assert.ok(ov.undoH >= 44);
await shot(S1, '17-toast-haut');
ok('notification (Annuler ≥ 44 px) contenue dans l’en-tête fixe : ne recouvre ni onglets ni boutons d’action');
const nfx = await S1.locator('.fx').count(); assert.ok(nfx <= 5, `trop de confettis: ${nfx}`);
ok(`confettis réduits (${nfx} particules max 5)`);

// animations : réglage système « réduire les animations » → aucune particule
const ctxR = await browser.newContext({ ...phone, reducedMotion: 'reduce' });
const R = await ctxR.newPage();
await R.goto(base); await R.fill('input[name=email]', 'maman@example.fr'); await R.fill('input[name=password]', 'motdepasse-solide');
await R.click('button:has-text("Se connecter")'); await R.waitForSelector('.child h2');
await R.click('.child:has(h2:text-is("Zoé")) [data-act=points][data-sign="+"]'); await R.click('.quick button >> nth=0'); await R.click('[data-act=pointsConfirm]');
await R.waitForSelector('.toast'); assert.equal(await R.locator('.fx').count(), 0);
await R.click('.tabs a:has-text("Famille")'); assert.ok((await R.innerText('[data-act=toggleAnim]')).includes('Réduites'));
await ctxR.close();
ok('prefers-reduced-motion respecté : aucune animation de confettis, réglage affiché');

// 13. PWA : manifeste, icônes, service worker, installabilité, cache
const mf = await (await S1.request.get(base + '/manifest.webmanifest')).json();
for (const ic of mf.icons) { const r = await S1.request.get(base + ic.src); assert.equal(r.status(), 200); assert.match(r.headers()['content-type'], /png/); }
assert.equal(mf.display, 'standalone'); assert.ok(mf.icons.some((i) => i.purpose === 'maskable'));
await S1.waitForFunction(() => navigator.serviceWorker.controller || navigator.serviceWorker.ready.then(() => true));
await S1.reload(); await S1.waitForSelector('.child h2');
assert.ok(await S1.evaluate(() => !!navigator.serviceWorker.controller), 'service worker actif');
const cached = await S1.evaluate(async () => { const out = []; for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) out.push(new URL(r.url).pathname); return out; });
assert.ok(cached.length > 0 && !cached.some((p) => p.startsWith('/api/')), 'aucune réponse API dans le cache : ' + cached.join(','));
const cdp = await ctxS.newCDPSession(S1); const inst = await cdp.send('Page.getInstallabilityErrors');
assert.deepEqual(inst.installabilityErrors, [], 'installabilité : ' + JSON.stringify(inst.installabilityErrors));
ok(`PWA : manifeste + icônes OK, service worker actif, installabilité Chromium sans erreur, cache sans /api (${cached.length} fichiers)`);

// 14. reconnexion : fermer / rouvrir = session persistante ; hors ligne puis retour
await S1.close(); const S2 = await ctxS.newPage(); await S2.goto(base); await S2.waitForSelector('.child h2');
ok('reconnexion : session persistante après fermeture de l’onglet');

// 15. déconnexion : données locales effacées, rien de visible pour le compte suivant, même hors ligne
await S2.click('.tabs a:has-text("Famille")'); await S2.click('[data-act=logout]'); await S2.waitForSelector('form[data-form=login]');
assert.equal(await S2.evaluate(() => localStorage.getItem('ph_cache')), null);
assert.ok(!(await S2.innerText('body')).includes('Zoé'), 'données familiales encore dans la page');
await ctxS.setOffline(true); await S2.reload().catch(() => {}); await S2.waitForSelector('form[data-form=login]');
assert.ok(!(await S2.innerText('body')).includes('Zoé')); await ctxS.setOffline(false);
await S2.evaluate(() => history.back()); await S2.waitForTimeout(300); assert.ok(!(await S2.innerText('body')).includes('Zoé'));
// compte suivant (autre famille) sur le même appareil
await S2.goto(base); await S2.click('text=Créer ma famille');
await S2.fill('input[name=name]', 'Voisin'); await S2.fill('input[name=email]', 'voisin@example.fr'); await S2.fill('input[name=password]', 'motdepasse-voisin'); await S2.fill('input[name=familyName]', 'Les Dupont');
await S2.click('button:has-text("Créer mon compte")'); await S2.check('#ackRecovery'); await S2.click('#ackBtn'); await S2.waitForSelector('text=Ajoute ton premier enfant');
assert.ok(!(await S2.innerText('body')).includes('Zoé') && !(await S2.innerText('body')).includes('Les Martin'));
const cache2 = await S2.evaluate(() => JSON.parse(localStorage.getItem('ph_cache') || 'null'));
assert.ok(!cache2 || !JSON.stringify(cache2).includes('Zoé'));
ok('déconnexion / changement de compte : cache local effacé, rien de l’ancienne famille (en ligne, hors ligne, retour arrière)');

// 16. membre retiré : session déjà ouverte invalide, données locales effacées ; copie hors ligne
await A.click('.tabs a:has-text("Famille")');
await A.click('[data-act=memberMenu]'); await A.click('button:has-text("Retirer de la famille")');
await B.waitForSelector('form[data-form=login]', { timeout: 8000 });
assert.equal(await B.evaluate(() => localStorage.getItem('ph_cache')), null);
assert.ok(!(await B.innerText('body')).includes('Zoé'));
ok('membre retiré : au prochain échange avec le serveur (≤ 3 s) il est renvoyé à la connexion et ses données locales sont effacées');

// 16b. membre retiré pendant que son téléphone est HORS LIGNE : la copie locale reste lisible (≤ 7 jours) jusqu'à la reconnexion
await A.click('.tabs a:has-text("Famille")'); await A.click('text=Inviter l’autre parent'); await A.waitForSelector('.big-code');
const code2 = await text(A, '.big-code'); await A.click('[data-act=closeSheet]');
const ctxC = await browser.newContext(phone); const C = await ctxC.newPage();
await C.goto(base); await C.click('text=J’ai un code d’invitation');
await C.fill('input[name=name]', 'Mamie'); await C.fill('input[name=email]', 'mamie@example.fr'); await C.fill('input[name=password]', 'mot-de-passe-mamie'); await C.fill('input[name=code]', code2);
await C.click('button:has-text("Rejoindre")'); await C.check('#ackRecovery'); await C.click('#ackBtn'); await C.waitForSelector('text=Presque prêt');
await A.waitForSelector('button:has-text("Approuver")', { timeout: 6000 }); await A.click('button:has-text("Approuver")');
await C.waitForSelector('.child h2:text-is("Léa")', { timeout: 8000 });
await ctxC.setOffline(true); await C.waitForSelector('.banner');
await A.click('[data-act=memberMenu]'); await A.click('button:has-text("Retirer de la famille")'); await A.waitForTimeout(800);
await C.reload().catch(() => {}); await C.waitForSelector('.child h2:text-is("Léa")');
assert.ok((await C.innerText('.banner')).includes('Hors connexion'));
assert.equal(await C.locator('[data-act=points]').count() > 0, true); // boutons présents mais inertes hors ligne
assert.equal(await C.locator('.child [data-act=points]').first().evaluate((el) => getComputedStyle(el).pointerEvents), 'none');
await ctxC.setOffline(false);
await C.waitForSelector('form[data-form=login]', { timeout: 8000 });
assert.equal(await C.evaluate(() => localStorage.getItem('ph_cache')), null);
ok('retiré hors ligne : copie locale lisible (sans modification possible) jusqu’au retour du réseau, puis effacée et accès refusé');

// 17. récupération du compte propriétaire avec un code de secours (sans e-mail)
const ctxO = await browser.newContext(phone); const O = await ctxO.newPage();
await O.goto(base); await O.click('text=Mot de passe oublié'); await O.click('text=J’ai un code de secours');
await O.fill('input[name=email]', 'maman@example.fr'); await O.fill('input[name=code]', recoveryCodes[0]); await O.fill('input[name=password]', 'nouveau-mdp-solide');
await O.click('button:has-text("Changer mon mot de passe")'); await O.waitForSelector('.ok:has-text("Mot de passe modifié")');
await O.fill('input[name=email]', 'maman@example.fr'); await O.fill('input[name=password]', 'nouveau-mdp-solide'); await O.click('button:has-text("Se connecter")');
await O.waitForSelector('.child h2');
await A.reload(); await A.waitForSelector('form[data-form=login]');
ok('propriétaire : mot de passe retrouvé avec un code de secours ; anciennes sessions déconnectées');

assert.deepEqual(errors, [], 'erreurs JS : ' + errors.join('; '));
await browser.close(); server.close(); await closePool();
console.log(`\nTous les parcours navigateur sont passés (captures : ${OUT})`);
