// « Point non validé » : retour visuel seulement. Aucun point, aucun solde, aucune transaction, aucun malus, aucun blocage.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { startServer, newFamily } from './helpers.js';

const S = await startServer();
const { parent, kids } = await newFamily(S.base);
await parent.post(`/api/children/${kids[0]}/points`, { value: 7, reason: 'départ' });
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch();
let step = 0; const ok = (m) => console.log(`✓ ${++step}. ${m}`);
const db = async () => JSON.stringify({
  bal: (await S.query('SELECT id, balance FROM children ORDER BY id')).rows,
  tx: (await S.query('SELECT count(*) FROM transactions')).rows[0].count,
  ops: (await S.query('SELECT count(*) FROM operations')).rows[0].count,
});

for (const [label, size] of [['mobile 360×700', { width: 360, height: 700 }], ['petit écran 320×568', { width: 320, height: 568 }]]) {
  const ctx = await browser.newContext({ viewport: size, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await ctx.addCookies([{ name: 'ph_session', value: decodeURIComponent(parent.cookie.split('=')[1]), url: S.base }]);
  await ctx.addInitScript(() => { window.__audio = 0; const A = window.Audio; window.Audio = function (...a) { window.__audio++; return new A(...a); }; });
  const P = await ctx.newPage(); const errs = []; P.on('pageerror', (e) => errs.push(e.message));
  const writes = []; P.on('request', (r) => { if (r.url().startsWith(S.base + '/api/') && r.method() !== 'GET') writes.push(`${r.method()} ${r.url()}`); });
  await P.goto(S.base); await P.waitForSelector('.child.mini');
  const lea = () => P.locator('.child.mini:first-child .bal b').innerText().then(Number);
  const before = await db(); const balBefore = await lea(); assert.equal(balBefore, 7);

  // bouton : présent en haut de « Donner des points », discret, distinct du bouton d'enregistrement ; absent de « Retirer »
  await P.click('.child.mini:first-child [data-act=points][data-sign="+"]');
  const btn = P.locator('[data-act=notValidated]'); await P.waitForTimeout(450);
  assert.equal(await btn.count(), 1); assert.equal((await btn.innerText()).trim(), 'Point non validé');
  const geo = await P.evaluate(() => { const b = document.querySelector('[data-act=notValidated]').getBoundingClientRect(), seg = document.querySelector('.seg').getBoundingClientRect(), hd = document.querySelector('.panel-head').getBoundingClientRect(), save = document.querySelector('[data-act=pointsConfirm]');
    return { aboveTabs: b.bottom <= seg.top + 1, nearTop: b.top - hd.bottom < 24 && b.top >= hd.bottom - 1, h: b.height, w: b.width, isSave: save === document.querySelector('[data-act=notValidated]'), cls: document.querySelector('[data-act=notValidated]').className }; });
  assert.ok(geo.aboveTabs && geo.nearTop, 'bouton en haut, au-dessus des onglets ' + JSON.stringify(geo)); assert.ok(geo.h >= 44 && geo.w >= 44, 'cible tactile ≥ 44 px'); assert.ok(/ghost/.test(geo.cls) && !/primary/.test(geo.cls), 'bouton secondaire discret');
  for (const t of ['Libre', 'Bonne action', 'Bonus']) { await P.click(`.seg button:has-text("${t}")`); assert.equal(await btn.count(), 1, `présent dans l’onglet ${t}`); }
  await P.keyboard.press('Escape');
  await P.click('.child.mini:first-child [data-act=points][data-sign="-"]'); assert.equal(await P.locator('[data-act=notValidated]').count(), 0, 'absent de « Retirer des points »'); await P.keyboard.press('Escape');

  // action : écran « Point non validé »
  await P.click('.child.mini:first-child [data-act=points][data-sign="+"]');
  await P.click('.seg button:has-text("Bonus")'); await P.click('.quick button >> nth=0'); // une saisie en cours : elle est simplement abandonnée
  await btn.click();
  await P.waitForSelector('.declined');
  assert.equal(await P.locator('.panel').count(), 0, 'la fenêtre « Donner des points » est fermée');
  const scr = await P.evaluate(() => { const d = document.querySelector('.declined'), x = document.querySelector('.big-x'), cs = getComputedStyle(x), ok = document.querySelector('#decl-ok').getBoundingClientRect();
    const all = [d, ...d.querySelectorAll('*')].map((e) => getComputedStyle(e).animationName);
    return { x: x.textContent.trim(), xColor: cs.color, xSize: x.getBoundingClientRect().width, title: document.querySelector('#decl-t').innerText, msg: document.querySelector('#decl-m').innerText, okLabel: document.querySelector('#decl-ok').innerText,
      okH: ok.height, focus: document.activeElement?.id, anim: all.filter((a) => a !== 'none'), role: d.getAttribute('role'), ovf: document.documentElement.scrollWidth - document.documentElement.clientWidth, fits: d.scrollHeight <= d.clientHeight, covers: d.getBoundingClientRect().width >= innerWidth }; });
  assert.equal(scr.x, '✕'); assert.equal(scr.xColor, 'rgb(217, 48, 37)', 'croix rouge'); assert.ok(scr.xSize >= 120, 'grande croix');
  assert.equal(scr.title, 'Point non validé'); assert.equal(scr.msg, 'Cette fois, cette action ne donne pas de point.'); assert.equal(scr.okLabel, 'D’accord');
  assert.ok(scr.okH >= 44); assert.equal(scr.focus, 'decl-ok'); assert.deepEqual(scr.anim, [], 'aucune animation'); assert.equal(scr.role, 'alertdialog');
  assert.ok(scr.ovf <= 0 && scr.fits && scr.covers, `écran complet sans débordement (${label})`);
  if (size.width === 360) await P.screenshot({ path: '/tmp/ph-shots/decline.png' });
  // rien n'a été écrit ni changé
  assert.deepEqual(writes, [], 'aucune requête d’écriture');
  assert.equal(await P.evaluate(() => window.__audio), 0, 'aucun son');
  assert.equal(await db(), before, 'solde, transactions et opérations inchangés en base');
  ok(`${label} : bouton discret en haut (≥ 44 px, secondaire), écran calme avec grande croix rouge, titre et message exacts, aucune animation ni son, aucune écriture`);

  // « D'accord » → liste des enfants, solde et historique inchangés
  await P.click('#decl-ok');
  await P.waitForSelector('.declined', { state: 'detached' });
  assert.match(P.url(), /#\/children$/); assert.equal(await P.locator('.child.mini').count(), 3, 'cartes compactes conservées');
  assert.equal(await lea(), balBefore);
  await P.click('.child.mini:first-child .child-head'); await P.waitForSelector('.hist');
  assert.equal(await P.locator('.hist').count(), 1, 'historique inchangé (1 mouvement)'); await P.click('.back');
  assert.equal(await db(), before);

  // aucun blocage : on peut immédiatement donner des points normalement (bonus puis action)
  await P.click('.child.mini:first-child [data-act=points][data-sign="+"]'); await P.click('.seg button:has-text("Bonus")'); await P.click('.quick button >> nth=0');
  await P.locator('[data-act=pointsConfirm]').click(); await P.waitForSelector('.panel', { state: 'detached' });
  assert.equal(await lea(), 12);
  await P.click('.child.mini:first-child [data-act=points][data-sign="+"]'); await P.click('.seg button:has-text("Bonne action")'); await P.click('.row:has-text("Ranger ses jouets")');
  await P.locator('[data-act=pointsConfirm]').click(); await P.waitForSelector('.panel', { state: 'detached' });
  assert.equal(await lea(), 14);
  assert.equal((await S.query('SELECT count(*) FROM transactions')).rows[0].count, 3);
  assert.equal((await S.query(`SELECT count(*) FROM transactions WHERE type='malus'`)).rows[0].count, 0);
  ok(`${label} : « D’accord » → liste des enfants (3 cartes compactes), solde 7 et historique intacts ; +5 puis +2 enregistrés normalement juste après (7 → 14, aucun malus)`);

  // Échap ferme aussi l'écran ; le refus répété n'enregistre toujours rien
  const b2 = await db();
  for (let i = 0; i < 3; i++) { await P.click('.child.mini:first-child [data-act=points][data-sign="+"]'); await P.click('[data-act=notValidated]'); await P.waitForSelector('.declined'); await (i % 2 ? P.keyboard.press('Escape') : P.click('#decl-ok')); await P.waitForSelector('.declined', { state: 'detached' }); }
  assert.equal(await db(), b2); assert.deepEqual(writes.filter((w) => !/\/points$/.test(w)), []);
  assert.deepEqual(errs, []);
  await ctx.close();
  // remettre l'état de départ pour le 2ᵉ format
  await S.query(`DELETE FROM transactions WHERE reason <> 'départ'`); await S.query(`UPDATE children SET balance = 7 WHERE id = $1`, [kids[0]]); await S.query('DELETE FROM operations');
}
await browser.close(); await S.close();
console.log('\n« Point non validé » : tous les contrôles passent (Chromium mobile émulé).');
