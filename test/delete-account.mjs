// Suppression de compte dans l'application : parcours navigateur (propriétaire seul, parent simple, propriétaire avec parents).
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startServer, newFamily, Client } from './helpers.js';

const S = await startServer();
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch();
let step = 0; const ok = (m) => console.log(`✓ ${++step}. ${m}`);
const PW = 'motdepasse-solide';
const open = async (client) => {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 700 }, isMobile: true, hasTouch: true });
  await ctx.addCookies([{ name: 'ph_session', value: decodeURIComponent(client.cookie.split('=')[1]), url: S.base }]);
  const P = await ctx.newPage(); P.errs = []; P.on('pageerror', (e) => P.errs.push(e.message));
  await P.goto(S.base + '/#/family'); await P.waitForSelector('[data-act=delAcc]');
  return P;
};

// 1. propriétaire seul
{
  const { parent } = await newFamily(S.base);
  const P = await open(parent);
  assert.ok(await P.locator('a[href$="/confidentialite"]').count());
  await P.click('[data-act=delAcc]');
  await P.waitForSelector('form[data-form=delacc]');
  assert.match(await P.locator('.panel').innerText(), /supprime aussi la famille/);
  await P.fill('input[name=password]', PW); await P.fill('input[name=confirm]', 'SUPPRIMER');
  await P.click('.panel .btn.danger'); // case de compréhension non cochée : le navigateur refuse l'envoi
  await P.waitForTimeout(400);
  assert.equal((await parent.get('/api/family/state')).status, 200, 'rien supprimé sans la case');
  await P.check('input[name=deleteFamily]');
  await P.fill('input[name=password]', 'faux-mot-de-passe-1'); await P.click('.panel .btn.danger');
  await P.waitForSelector('.panel .err'); assert.match(await P.locator('.panel .err').first().innerText(), /incorrect/i);
  assert.equal((await parent.get('/api/family/state')).status, 200);
  await P.fill('input[name=password]', PW); await P.click('.panel .btn.danger');
  await P.waitForSelector('form[data-form=login]');
  assert.match(await P.locator('body').innerText(), /Compte et famille supprimés/);
  assert.equal(Number((await S.query('SELECT count(*) FROM families')).rows[0].count), 0);
  assert.deepEqual(P.errs, []); ok('propriétaire seul : confirmations, mauvais mot de passe, suppression, retour à la connexion');
}

// 2. propriétaire avec parent, transfert via l'interface, puis suppression de l'ancien propriétaire
{
  const { parent } = await newFamily(S.base);
  const inv = await parent.post('/api/family/invites'); const p2 = new Client(S.base);
  await p2.post('/api/auth/register', { email: `x-${crypto.randomUUID().slice(0, 6)}@ex.fr`, name: 'Papa', password: PW });
  await p2.post('/api/family/join', { code: inv.body.code });
  await parent.post(`/api/family/members/${(await p2.get('/api/auth/me')).body.user.id}/approve`);
  const P = await open(parent);
  await P.click('[data-act=delAcc]'); await P.waitForSelector('.panel .warn');
  assert.equal(await P.locator('form[data-form=delacc]').count(), 0, 'pas de formulaire tant que propriétaire');
  assert.match(await P.locator('.panel').innerText(), /nomme d’abord un autre propriétaire/);
  await P.keyboard.press('Escape');
  await P.click('[data-act=memberMenu]'); await P.click('[data-act=makeOwner]');
  await P.click('.panel .btn.danger, .panel .btn.primary'); // confirmation
  await P.waitForTimeout(800);
  assert.equal((await p2.get('/api/auth/me')).body.membership.role, 'owner');
  await P.click('[data-act=delAcc]'); await P.waitForSelector('form[data-form=delacc]');
  assert.match(await P.locator('.panel').innerText(), /ne sont pas touchés/);
  await P.fill('input[name=password]', PW); await P.fill('input[name=confirm]', 'supprimer'); await P.click('.panel .btn.danger');
  await P.waitForSelector('form[data-form=login]');
  assert.match(await P.locator('body').innerText(), /Compte supprimé/);
  assert.equal((await p2.get('/api/family/state')).status, 200);
  assert.deepEqual(P.errs, []); ok('transfert de propriété puis suppression d’un parent : la famille continue');
}
await browser.close(); await S.close(); console.log('OK');
