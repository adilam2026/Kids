// Enregistrement des points (gains, bonus, retraits) sous réseau lent / dégradé : un clic = un mouvement, jamais de doublon.
// Chromium mobile émulé ; le réseau est perturbé par interception des requêtes (réponses retardées, perdues, erreurs).
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { startServer, newFamily } from './helpers.js';

const S = await startServer();
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch();
let step = 0; const ok = (m) => console.log(`✓ ${++step}. ${m}`);
const LAT = 2000;               // latence simulée de chaque réponse
const TIMEOUT = 1500;           // délai maximal client du scénario « délai dépassé » (production : 20 s)

async function scenario(name, { mode = 'slow', balance = 0, timeout = 6000 } = {}, fn) {
  const { parent, kids } = await newFamily(S.base, name.slice(0, 3));
  if (balance) await parent.post(`/api/children/${kids[0]}/points`, { value: balance });
  const ctx = await browser.newContext({ viewport: { width: 360, height: 700 }, isMobile: true, hasTouch: true });
  await ctx.addCookies([{ name: 'ph_session', value: decodeURIComponent(parent.cookie.split('=')[1]), url: S.base }]);
  await ctx.addInitScript((t) => { window.PH_TIMEOUT_MS = t; }, timeout);
  const P = await ctx.newPage(); const errs = []; P.on('pageerror', (e) => errs.push(e.message));
  const net = { mode, posts: [], pointsPosts: 0 };
  await P.route('**/api/**', async (route) => {
    const req = route.request(), isPoints = req.method() === 'POST' && /\/points$/.test(req.url());
    if (isPoints) { net.pointsPosts++; net.posts.push(req.headers()['x-op-id']); }
    if (net.mode === 'slow' || (isPoints && net.mode === 'online-after')) { const resp = await route.fetch(); await new Promise((r) => setTimeout(r, LAT)); await route.fulfill({ response: resp }).catch(() => {}); return; }
    if (isPoints && net.pointsPosts === 1 && net.mode === 'drop-first') { await route.fetch(); await route.abort('failed'); return; }          // le serveur enregistre, la réponse est perdue
    if (isPoints && net.pointsPosts === 1 && net.mode === 'timeout-first') { const resp = await route.fetch(); await new Promise((r) => setTimeout(r, TIMEOUT + 900)); await route.fulfill({ response: resp }).catch(() => {}); return; } // réponse trop tardive
    if (isPoints && net.pointsPosts === 1 && net.mode === 'error-first') { await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'Erreur serveur' }) }); return; }
    await route.continue();
  });
  await P.goto(S.base); await P.waitForSelector('.child.mini', { timeout: 30000 });
  const txs = async () => Number((await S.query(`SELECT count(*) FROM transactions WHERE child_id=$1 AND type<>'cancel'`, [kids[0]])).rows[0].count) - (balance ? 1 : 0);
  const bal = () => P.locator('.child.mini:first-child .bal b').innerText().then(Number);
  await fn({ P, net, parent, kids, txs, bal });
  assert.deepEqual(errs, [], 'erreurs JS : ' + errs.join('; '));
  await ctx.close();
}
const openPlus = async (P, tab) => { await P.click('.child.mini:first-child [data-act=points][data-sign="+"]'); if (tab) await P.click(`.seg button:has-text("${tab}")`); };
const openMinus = async (P) => { await P.click('.child.mini:first-child [data-act=points][data-sign="-"]'); await P.click('.seg button:has-text("Libre")'); };
const confirm = (P) => P.locator('[data-act=pointsConfirm]');
const sheetGone = (P, t = 15000) => P.waitForSelector('.panel', { state: 'detached', timeout: t });

// 1. BONUS, réseau lent, clics répétés
await scenario('bonus', {}, async ({ P, txs, bal }) => {
  await openPlus(P, 'Bonus'); await P.click('.quick button >> nth=0'); // +5
  const btn = confirm(P);
  assert.match(await btn.innerText(), /^Enregistrer \+5 pour/);
  const t0 = Date.now(); await btn.click();
  await P.waitForFunction(() => document.querySelector('[data-act=pointsConfirm]')?.disabled, null, { timeout: 500 });
  const during = { label: await btn.innerText(), disabled: await btn.isDisabled(), busy: await P.locator('.panel').getAttribute('aria-busy') };
  assert.equal(during.label, 'Enregistrement…'); assert.equal(during.disabled, true); assert.equal(during.busy, 'true');
  for (let i = 0; i < 8; i++) { await P.mouse.click(180, 640).catch(() => {}); await btn.click({ force: true, timeout: 200 }).catch(() => {}); await P.keyboard.press('Enter'); } // 8 clics + Entrée répétés
  assert.equal(await txs(), 1, 'le mouvement est enregistré dès le 1er clic, une seule fois');
  assert.equal(await P.locator('.panel').count(), 1, 'la fenêtre reste ouverte tant que le serveur n’a pas répondu');
  await sheetGone(P); const dt = Date.now() - t0;
  assert.ok(dt >= LAT - 100 && dt < LAT + 1300, `fenêtre fermée après ${dt} ms (≈ 1 aller-retour de ${LAT} ms, pas 2)`);
  assert.equal(await bal(), 5, 'solde mis à jour dès la confirmation du serveur (sans attendre l’actualisation)');
  assert.match(await P.innerText('.toast'), /\+5 → 5 pts/);
  await P.waitForTimeout(LAT * 2 + 1500); // l'actualisation d'arrière-plan arrive : même solde
  assert.equal(await bal(), 5); assert.equal(await txs(), 1);
  ok(`bonus +5, réseau lent (${LAT} ms), 8 clics + Entrée répétés : 1 seul mouvement, bouton « Enregistrement… » désactivé pendant l’envoi, fenêtre fermée à ${dt} ms avec solde et message`);
});

// 2. RETRAIT libre (motif obligatoire), réseau lent, clics répétés, puis Entrée
await scenario('retrait', { balance: 10 }, async ({ P, txs, bal }) => {
  assert.equal(await bal(), 10);
  await openMinus(P); await P.fill('input[data-bind=value]', '-4'); await P.fill('input[data-bind=reason]', 'Dispute');
  const btn = confirm(P); const t0 = Date.now(); await btn.click();
  for (let i = 0; i < 6; i++) await btn.click({ force: true, timeout: 150 }).catch(() => {});
  assert.equal(await btn.innerText(), 'Enregistrement…');
  await sheetGone(P); const dt = Date.now() - t0;
  assert.ok(dt < LAT + 1300, `fermée après ${dt} ms`);
  assert.equal(await bal(), 6); assert.match(await P.innerText('.toast'), /−4 → 6 pts/);
  assert.equal(await txs(), 1);
  const h = (await S.query(`SELECT type, value, reason FROM transactions WHERE type='malus' ORDER BY created_at DESC LIMIT 1`)).rows[0]; assert.deepEqual([h.type, h.value, h.reason], ['malus', -4, 'Dispute']);
  // même chose en tapant Entrée dans le champ (un seul geste)
  await openMinus(P); await P.fill('input[data-bind=value]', '-1'); await P.fill('input[data-bind=reason]', 'Cri'); await P.keyboard.press('Enter');
  for (let i = 0; i < 4; i++) await P.keyboard.press('Enter');
  await sheetGone(P); assert.equal(await txs(), 2); assert.equal(await bal(), 5);
  ok('retrait −4 puis −1 (bouton, puis touche Entrée répétée) sous réseau lent : un mouvement par opération, solde 10 → 6 → 5');
});

// 3. GAIN ORDINAIRE (action prédéfinie), réseau lent, double clic
await scenario('gain', {}, async ({ P, txs, bal }) => {
  await openPlus(P, 'Bonne action'); await P.click('.row:has-text("Ranger ses jouets")');
  await P.locator('[data-act=pointsConfirm]').dblclick();
  assert.equal(await confirm(P).innerText(), 'Enregistrement…');
  await sheetGone(P); assert.equal(await bal(), 2); assert.equal(await txs(), 1); await P.waitForTimeout(500);
  assert.equal(await txs(), 1);
  ok('gain ordinaire (action prédéfinie +2), double clic, réseau lent : 1 seul mouvement, fenêtre fermée, solde 2');
});

// 4. ERREUR serveur : la fenêtre reste ouverte avec l'explication ; réessai possible ; un seul mouvement
await scenario('erreur', { mode: 'error-first' }, async ({ P, txs, bal, net }) => {
  await openPlus(P, 'Bonus'); await P.click('.quick button >> nth=1'); // +10
  await confirm(P).click();
  await P.waitForSelector('#sheet-err .err');
  assert.match(await P.innerText('#sheet-err'), /Erreur serveur/);
  assert.equal(await P.locator('.panel').count(), 1);
  assert.equal(await confirm(P).isDisabled(), false); assert.match(await confirm(P).innerText(), /^Enregistrer \+10/);
  assert.equal(await txs(), 0, 'rien n’est enregistré après une erreur serveur');
  await confirm(P).click(); await sheetGone(P);
  assert.equal(await txs(), 1); assert.equal(await bal(), 10); assert.equal(net.pointsPosts, 2);
  ok('erreur serveur : fenêtre ouverte, message visible, bouton réactivé ; le réessai enregistre une seule fois');
});

// 4b. ERREUR métier réelle : « Faire une nuit complète » limitée à une validation par nuit
await scenario('nuit', { mode: 'online' }, async ({ P, txs, bal }) => {
  const night = async () => { await openPlus(P, 'Bonne action'); await P.click('.row:has-text("Faire une nuit complète")'); await confirm(P).click(); };
  await night(); await sheetGone(P); assert.equal(await bal(), 10);
  await night(); await P.waitForSelector('#sheet-err .err'); assert.match(await P.innerText('#sheet-err'), /déjà été validé/);
  assert.equal(await P.locator('.panel').count(), 1); assert.equal(await confirm(P).isDisabled(), false); assert.equal(await txs(), 1);
  ok('« Faire une nuit complète » une 2ᵉ fois : refus explicite dans la fenêtre restée ouverte (une validation par nuit), 1 seul mouvement');
});

// 5. RÉPONSE PERDUE (le serveur a enregistré) : réessai = même identifiant, aucun doublon
await scenario('perdue', { mode: 'drop-first' }, async ({ P, txs, bal, net }) => {
  await openPlus(P, 'Bonus'); await P.click('.quick button >> nth=0');
  await confirm(P).click();
  await P.waitForSelector('#sheet-err .err');
  assert.match(await P.innerText('#sheet-err'), /Réponse non reçue.*aucun doublon/s);
  assert.equal(await txs(), 1, 'le serveur avait déjà enregistré');
  assert.equal(await P.locator('.panel').count(), 1);
  assert.match(await confirm(P).innerText(), /^Réessayer \+5/); assert.equal(await P.locator('.panel.locked').count(), 1, 'saisie figée : on ne peut renvoyer que la même demande');
  await confirm(P).click(); await sheetGone(P);
  assert.equal(net.posts.length, 2); assert.equal(net.posts[0], net.posts[1], 'même identifiant d’opération');
  assert.equal(await txs(), 1, 'toujours 1 mouvement'); assert.equal(await bal(), 5);
  ok('réponse perdue après enregistrement : message honnête (« non confirmé »), réessai avec le même identifiant → 1 seul mouvement');
});

// 5b. RÉPONSE PERDUE puis fenêtre fermée et rouverte : la tentative non confirmée est reprise, pas dupliquée
await scenario('rouverte', { mode: 'drop-first' }, async ({ P, txs, bal, net }) => {
  await openPlus(P, 'Bonus'); await P.click('.quick button >> nth=0'); await confirm(P).click();
  await P.waitForSelector('#sheet-err .err'); await P.click('[data-act=closeSheet]');
  await P.waitForSelector('.panel', { state: 'detached' });
  await P.click('.child.mini:first-child [data-act=points][data-sign="+"]');
  assert.match(await confirm(P).innerText(), /^Réessayer \+5/, 'la tentative non confirmée est reprise');
  await confirm(P).click(); await sheetGone(P);
  assert.equal(net.posts[0], net.posts[1]); assert.equal(await txs(), 1); assert.equal(await bal(), 5);
  ok('fenêtre fermée puis rouverte après une réponse perdue : le réessai reprend la même opération (1 mouvement)');
});

// 6. DÉLAI DÉPASSÉ
await scenario('delai', { mode: 'timeout-first', timeout: TIMEOUT }, async ({ P, txs, bal, net }) => {
  await openPlus(P, 'Bonus'); await P.click('.quick button >> nth=2'); // +15
  const t0 = Date.now(); await confirm(P).click();
  await P.waitForSelector('#sheet-err .err', { timeout: TIMEOUT + 2000 }); const dt = Date.now() - t0;
  assert.ok(dt >= TIMEOUT - 100 && dt < TIMEOUT + 800, `erreur de délai après ${dt} ms`);
  assert.match(await P.innerText('#sheet-err'), /trop de temps.*aucun doublon/s);
  assert.equal(await confirm(P).isDisabled(), false);
  await P.waitForTimeout(1200); await confirm(P).click(); await sheetGone(P);
  assert.equal(net.posts[0], net.posts[1]); assert.equal(await txs(), 1); assert.equal(await bal(), 15);
  ok(`délai dépassé (${dt} ms) : erreur claire, bouton réactivé, réessai avec le même identifiant → 1 seul mouvement`);
});

// 7. BOUTON D'ENVOI : ne vole pas le focus du champ (le clavier ne se referme pas, la mise en page ne bouge pas)
await scenario('focus', { mode: 'online' }, async ({ P, txs }) => {
  await openPlus(P, 'Bonus'); await P.fill('input[data-bind=value]', '7'); await P.focus('input[data-bind=reason]');
  const b = await confirm(P).boundingBox();
  await P.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await P.mouse.down();
  const focusKept = await P.evaluate(() => document.activeElement?.matches('input[data-bind=reason]'));
  await P.mouse.up(); await sheetGone(P);
  assert.equal(focusKept, true, 'le champ garde le focus pendant l’appui sur le bouton');
  assert.equal(await txs(), 1);
  ok('appui sur le bouton d’envoi : le champ garde le focus (pas de fermeture du clavier / décalage), 1 mouvement');
});

await browser.close(); await S.close();
console.log('\nEnregistrement des points : tous les scénarios réseau passent (Chromium mobile émulé).');
