// Test navigateur de bout en bout : deux « téléphones » (Chromium), vrai serveur, vraie base.
// Lancer : DATABASE_URL=... node test/e2e.mjs   (nécessite Playwright + Chromium)
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import pg from 'pg';
import { createApp } from '../server/app.js';
import { migrate } from '../server/migrate.js';
import { closePool } from '../server/db.js';

process.env.DATABASE_URL ||= 'postgres://postgres@localhost:5433/kids_test';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const OUT = process.env.SHOTS || '/tmp/ph-shots';
fs.mkdirSync(OUT, { recursive: true });

const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
await admin.connect(); await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await admin.end();
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

assert.deepEqual(errors, [], 'erreurs JS : ' + errors.join('; '));
await browser.close(); server.close(); await closePool();
console.log(`\nTous les parcours navigateur sont passés (captures : ${OUT})`);
