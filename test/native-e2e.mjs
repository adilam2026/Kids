// Application Android : test de l'interface EMBARQUÉE (build www de test) dans Chromium mobile, face au vrai serveur.
// Origine de l'interface ≠ origine de l'API (comme dans le WebView Capacitor) → jetons Bearer, CORS, aucun cookie partagé.
// ⚠️ N'est PAS un test sur Android : pas de WebView, pas de plugins natifs (simulés par le build de test).
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startServer, Client, newFamily } from './helpers.js';

const WWW = '/tmp/ph-www-test';
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const stat = http.createServer((req, res) => {
  const f = path.join(WWW, req.url.split('?')[0] === '/' ? 'index.html' : req.url.split('?')[0]);
  if (!f.startsWith(WWW) || !fs.existsSync(f)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': mime[path.extname(f)] || 'application/octet-stream' }).end(fs.readFileSync(f));
});
await new Promise((r) => stat.listen(0, 'localhost', r));
const APP = `http://localhost:${stat.address().port}`; // origine du « WebView »
process.env.CORS_ORIGINS = APP;
const S = await startServer();
execFileSync('node', ['scripts/build-www.mjs', '--test', '--api', S.base, '--out', WWW], { stdio: 'inherit', env: { ...process.env, VERSION_CODE: '7', VERSION_NAME: '1.2.3' } });

const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch();
const phone = { viewport: { width: 360, height: 700 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'fr-FR' };
const errors = [], csp = [];
const track = (p, n) => { p.on('pageerror', (e) => errors.push(`${n}: ${e.message}`)); p.on('console', (m) => { if (/Content Security Policy|CORS|blocked/i.test(m.text())) csp.push(m.text()); }); };
let step = 0; const ok = (m) => console.log(`✓ ${++step}. ${m}`);
const bal = (p, name) => p.locator(`.child:has(h2:text-is("${name}")) .bal b`).first().innerText().then(Number);
const email = async () => (await S.query('SELECT email FROM users ORDER BY created_at DESC LIMIT 1')).rows[0].email;
const tok = (p) => p.evaluate(() => localStorage.getItem('CapacitorStorage.ph_token'));

// 1. un parent a déjà sa famille sur la version WEB (cookie)
const { parent: web, kids } = await newFamily(S.base);
const mail = await email();

// 2. application : connexion → jeton stocké, aucun cookie, mêmes données
const ctx = await browser.newContext(phone);
let P = await ctx.newPage(); track(P, 'app');
const apiReqs = []; P.on('request', (r) => { if (r.url().startsWith(S.base + '/api/')) apiReqs.push({ url: r.url(), h: r.headers() }); });
await P.goto(APP);
await P.waitForSelector('form[data-form=login]');
assert.equal(await P.locator('text=Installer l’application').count(), 0, 'pas de bouton « Installer » dans l’application');
assert.equal((await P.evaluate(() => navigator.serviceWorker.getRegistrations().then((r) => r.length))), 0, 'pas de service worker dans l’application');
await P.fill('input[name=email]', mail); await P.fill('input[name=password]', 'motdepasse-solide');
await P.click('button:has-text("Se connecter")');
await P.waitForSelector('.child.mini h2');
assert.ok((await tok(P) || '').length > 30, 'jeton stocké (Preferences)');
assert.deepEqual((await ctx.cookies(S.base)), [], 'aucun cookie pour l’API');
assert.ok(apiReqs.some((r) => r.h.authorization?.startsWith('Bearer ')) && apiReqs.every((r) => r.h['x-client'] === 'native-android/7'));
assert.equal(await P.locator('.child.mini').count(), 3);
ok('connexion native : jeton Bearer stocké, aucun cookie, en-tête X-Client, mêmes enfants que la version web, cartes compactes');

// 3. fermeture / réouverture : la connexion est conservée
await P.close(); P = await ctx.newPage(); track(P, 'app2'); await P.goto(APP);
await P.waitForSelector('.child.mini h2', { timeout: 8000 });
assert.equal(await P.locator('form[data-form=login]').count(), 0);
ok('fermeture puis réouverture : connexion conservée (jeton relu depuis le stockage de l’application)');

// 4. synchronisation avec la version web, dans les deux sens
await P.click('.child:has(h2:text-is("Léa")) [data-act=points][data-sign="+"]'); await P.click('.quick button >> nth=2'); await P.click('[data-act=pointsConfirm]');
await P.waitForSelector('.toast:has-text("+5")');
assert.equal((await web.state()).children.find((c) => c.id === kids[0]).balance, 5);
await web.post(`/api/children/${kids[0]}/points`, { value: 2 });
const t0 = Date.now(); await P.waitForFunction(() => [...document.querySelectorAll('.child')].find((c) => c.querySelector('h2').innerText === 'Léa').querySelector('.bal b').innerText === '7', null, { timeout: 5500 });
ok(`synchronisation app ↔ web : +5 côté app visible côté web ; +2 côté web visible dans l'app en ${Date.now() - t0} ms`);

// 5. écrans conservés : défis, récompenses, suggestions
await P.click('.tabs a:has-text("Défis")'); await P.waitForSelector('text=Aucun défi en cours');
await P.click('.tabs a:has-text("Récompenses")'); await P.waitForSelector('text=Choisir le jeu familial');
await P.click('.tabs a:has-text("Famille")'); await P.waitForSelector('text=Application Android · version 1.2.3 (build 7)');
// famille créée AVANT les actions Sommeil / Repas : on retire ces deux lignes par défaut, puis on les ajoute via « Ajouter les suggestions »
const famId = (await S.query('SELECT family_id FROM children WHERE id=$1', [kids[0]])).rows[0].family_id;
await S.query(`DELETE FROM actions WHERE family_id=$1 AND title IN ('Faire une nuit complète','Finir son assiette')`, [famId]);
const snap = async () => JSON.stringify([(await S.query('SELECT id, balance FROM children WHERE family_id=$1 ORDER BY id', [famId])).rows, (await S.query('SELECT count(*) FROM transactions WHERE family_id=$1', [famId])).rows]);
const before = await snap();
await P.click('[data-act=suggest]'); await P.waitForSelector('.check.sg');
const prev = await P.innerText('.panel');
for (const w of ['Faire une nuit complète', 'Finir son assiette', 'Aucun retrait en cas de réveil', 'On ne force jamais l’enfant s’il n’a plus faim', '1 validation / 12 h', '1 validation / 3 h']) assert.ok(prev.includes(w), `aperçu : « ${w} » absent`);
assert.ok((await P.innerText('[data-act=sgApply]')).includes('Ajouter 15 suggestions'));
await P.click('[data-act=sgAll][data-v="0"]');
await P.click('.check.sg:has-text("Faire une nuit complète") input'); await P.click('.check.sg:has-text("Finir son assiette") input');
await P.click('[data-act=sgApply]'); await P.waitForSelector('.toast:has-text("2 suggestions ajoutées")');
const rows = (await S.query(`SELECT title, value, theme, icon, note, min_interval_hours FROM actions WHERE family_id=$1 AND title IN ('Faire une nuit complète','Finir son assiette') ORDER BY title`, [famId])).rows;
assert.deepEqual(rows.map((r) => [r.title, r.value, r.theme, r.icon, r.min_interval_hours]), [['Faire une nuit complète', 10, 'Sommeil', '🌙', 12], ['Finir son assiette', 3, 'Repas', '🍽️', 3]]);
assert.equal(await snap(), before, 'soldes et historique inchangés');
await P.click('[data-act=suggest]'); await P.waitForSelector('.check.sg');
assert.equal(await P.locator('.check.sg.dim').filter({ hasText: 'Faire une nuit complète' }).count(), 1, 'plus proposées une 2ᵉ fois (aucun doublon)');
assert.ok((await P.innerText('[data-act=sgApply]')).includes('Ajouter 13 suggestions'));
await P.keyboard.press('Escape');
ok('suggestions sur une famille existante : « Faire une nuit complète » (+10, Sommeil) et « Finir son assiette » (+3, Repas) proposées avec leur note, ajoutées sans doublon, soldes et historique inchangés');

// 6. bouton Retour
await P.click('.tabs a:has-text("Enfants")');
await P.click('[data-act=points][data-sign="+"]'); await P.waitForSelector('.panel');
await P.evaluate(() => window.PHNative._test.back()); await P.waitForSelector('.panel', { state: 'detached' });
await P.click('.child.mini:first-child .child-head'); await P.waitForSelector('.avatar.lg');
await P.evaluate(() => window.PHNative._test.back()); await P.waitForSelector('.child.mini');
await P.click('.tabs a:has-text("Famille")'); await P.click('a[href="#/library"]'); await P.waitForSelector('text=Bibliothèque d’actions');
await P.evaluate(() => window.PHNative._test.back()); await P.waitForSelector('text=Parents');
await P.evaluate(() => window.PHNative._test.back()); await P.waitForSelector('.child.mini');
assert.equal(await P.evaluate(() => window.__exited || 0), 0, 'ne quitte pas avant la racine');
await P.evaluate(() => window.PHNative._test.back());
assert.equal(await P.evaluate(() => window.__exited), 1, 'quitte à la racine');
ok('bouton Retour : ferme la fenêtre, remonte d’un niveau (profil, bibliothèque, onglets), quitte seulement à la racine');

// 7. zones de sécurité Android (variables injectées par Capacitor) et clavier
await P.evaluate(() => { const s = document.documentElement.style; s.setProperty('--safe-area-inset-top', '36px'); s.setProperty('--safe-area-inset-bottom', '28px'); });
const sa = await P.evaluate(() => ({ top: parseFloat(getComputedStyle(document.querySelector('.top')).paddingTop), tabs: parseFloat(getComputedStyle(document.querySelector('.tabs')).paddingBottom), tabsRect: document.querySelector('.tabs').getBoundingClientRect().height }));
assert.ok(sa.top >= 46 && sa.tabs >= 28, JSON.stringify(sa));
await P.click('.child.mini:first-child [data-act=points][data-sign="-"]'); await P.click('.seg button:has-text("Libre")'); await P.focus('input[data-bind=reason]');
await P.setViewportSize({ width: 360, height: 320 }); await P.waitForTimeout(700);
const kb = await P.evaluate(() => { const r = document.querySelector('input[data-bind=reason]').getBoundingClientRect(); return { t: r.top, b: r.bottom, vh: innerHeight }; });
assert.ok(kb.t >= 0 && kb.b <= kb.vh, JSON.stringify(kb)); await P.setViewportSize(phone.viewport); await P.keyboard.press('Escape');
ok('zones de sécurité (status bar / barre de gestes) appliquées via les variables Capacitor ; champ visible avec un clavier simulé');

// 8. export et codes de secours : partage de fichier (le WebView ne télécharge pas les blobs)
await P.click('.tabs a:has-text("Famille")'); await P.click('[data-act=exportData]'); await P.waitForFunction(() => window.__saved);
const saved = await P.evaluate(() => window.__saved);
assert.equal(saved.mime, 'application/json'); const exp = JSON.parse(saved.text); assert.equal(exp.children.length, 3); assert.ok(!saved.text.includes('password_hash'));
ok('export des données : transmis au pont de partage avec le jeton Bearer (fichier JSON valide, sans mot de passe)');

// 9. deuxième parent sur l'application : inscription, code, attente, approbation
const inv = await web.post('/api/family/invites');
const ctx2 = await browser.newContext(phone); const Q = await ctx2.newPage(); track(Q, 'app-p2'); await Q.goto(APP);
await Q.click('text=J’ai un code d’invitation');
await Q.fill('input[name=name]', 'Papa'); await Q.fill('input[name=email]', 'papa-native@example.fr'); await Q.fill('input[name=password]', 'autre-mot-de-passe'); await Q.fill('input[name=code]', inv.body.code);
await Q.click('button:has-text("Rejoindre")'); await Q.waitForSelector('.recovery code'); assert.equal(await Q.locator('.recovery code').count(), 8);
await Q.click('[data-act=saveRecovery]'); await Q.waitForFunction(() => window.__saved); assert.ok((await Q.evaluate(() => window.__saved.text)).includes('papa-native@example.fr'));
await Q.check('#ackRecovery'); await Q.click('#ackBtn'); await Q.waitForSelector('text=Presque prêt');
const uid = (await S.query(`SELECT id FROM users WHERE email='papa-native@example.fr'`)).rows[0].id;
await web.post(`/api/family/members/${uid}/approve`);
await Q.waitForSelector('.child.mini h2', { timeout: 9000 });
assert.ok((await tok(Q)).length > 30);
ok('second parent : inscription native, code d’invitation, codes de secours enregistrables, approbation → mêmes données');

// 10. membre retiré : l'application est renvoyée à la connexion, jeton et copie locale effacés
await web.delete(`/api/family/members/${uid}`);
await Q.waitForSelector('form[data-form=login]', { timeout: 8000 });
assert.equal(await tok(Q), null); assert.equal(await Q.evaluate(() => localStorage.getItem('ph_cache')), null);
ok('membre retiré : jeton révoqué côté serveur, l’application efface jeton et données locales');

// 11. déconnexion : jeton supprimé et révoqué
const token = await tok(P);
await P.click('.tabs a:has-text("Famille")'); await P.click('[data-act=logout]'); await P.waitForSelector('form[data-form=login]');
assert.equal(await tok(P), null);
const stale = new Client(S.base); stale.token = token; assert.equal((await stale.get('/api/family/state')).status, 401);
ok('déconnexion : jeton effacé de l’appareil ET révoqué côté serveur');

// 12. hors ligne : dernières données + bandeau
await P.fill('input[name=email]', mail); await P.fill('input[name=password]', 'motdepasse-solide'); await P.click('button:has-text("Se connecter")'); await P.waitForSelector('.child.mini h2');
await ctx.setOffline(true); await P.waitForSelector('.banner:has-text("Hors connexion")', { timeout: 8000 });
assert.equal(await P.locator('.child.mini').count(), 3);
await ctx.setOffline(false); await P.waitForSelector('.banner', { state: 'detached', timeout: 8000 });
ok('hors ligne : dernières données et bandeau, reprise automatique au retour du réseau');

// 13. mise à jour obligatoire
process.env.MIN_NATIVE_BUILD = '99';
await P.reload(); await P.waitForSelector('text=Mise à jour nécessaire');
assert.ok(await P.locator('text=Tes données sont conservées').count()); delete process.env.MIN_NATIVE_BUILD;
await P.reload(); await P.waitForSelector('.child.mini h2');
ok('build trop ancien : écran « Mise à jour nécessaire » ; retour à la normale ensuite');

assert.deepEqual(csp, [], 'violations CSP / CORS : ' + csp.join(' | '));
assert.deepEqual(errors, [], 'erreurs JS : ' + errors.join('; '));
await browser.close(); stat.close(); await S.close();
console.log('\nInterface Android embarquée : tous les parcours Chromium sont passés (≠ test sur téléphone Android).');
