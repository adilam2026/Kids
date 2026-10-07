// E-mails de récupération via l'API HTTPS Brevo (faux serveur Brevo local) : contenu, sécurité du lien, limitation, erreurs honnêtes, journaux propres.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { startServer, Client } from './helpers.js';
import { limits, resetLimits } from '../server/util.js';
import { drainMail } from '../server/routes/auth.js';
import { mailEnabled, sendMail } from '../server/mail.js';

const KEY = 'xkeysib-TEST-SECRET-0123456789abcdef';
let S, brevo, calls, mode, logs;
const allLogs = [];  // tout ce que le serveur a écrit pendant le fichier de tests
const origLog = console.log, origErr = console.error;
const ENV = ['BREVO_API_KEY', 'BREVO_FROM_EMAIL', 'BREVO_FROM_NAME', 'BREVO_API_URL', 'APP_URL', 'RAILWAY_PUBLIC_DOMAIN', 'MAIL_TIMEOUT_MS'];

before(async () => {
  S = await startServer();
  brevo = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; });
    req.on('end', () => {
      calls.push({ headers: req.headers, url: req.url, body: JSON.parse(b || '{}') });
      if (mode === 'hang') return; // ne répond jamais
      if (mode === '401') { res.writeHead(401, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ code: 'unauthorized', message: `Key not found ${KEY}` })); }
      if (mode === '400') { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ code: 'invalid_parameter', message: 'Sender not validated' })); }
      if (mode === '500') { res.writeHead(500); return res.end('boom'); }
      if (mode === 'nomsgid') { res.writeHead(201, { 'content-type': 'application/json' }); return res.end('{}'); }
      res.writeHead(201, { 'content-type': 'application/json' }); res.end(JSON.stringify({ messageId: '<202610070900.1234@smtp-relay.mailin.fr>' }));
    });
  });
  await new Promise((r) => brevo.listen(0, '127.0.0.1', r));
  console.log = (...a) => { logs.push(a.join(' ')); allLogs.push(a.join(' ')); }; console.error = (...a) => { logs.push(a.join(' ')); allLogs.push(a.join(' ')); };
});
after(async () => { console.log = origLog; console.error = origErr; brevo.closeAllConnections?.(); brevo.close(); for (const k of ENV) delete process.env[k]; await S.close(); });

function configure(over = {}) {
  Object.assign(process.env, { BREVO_API_KEY: KEY, BREVO_FROM_EMAIL: 'adilam.pro@gmail.com', BREVO_FROM_NAME: 'Petits Héros', BREVO_API_URL: `http://127.0.0.1:${brevo.address().port}/v3/smtp/email`, APP_URL: 'https://app.example', MAIL_TIMEOUT_MS: '400' }, over);
  for (const [k, v] of Object.entries(over)) if (v === undefined) delete process.env[k];
}
async function account() {
  const email = `rec-${crypto.randomUUID().slice(0, 8)}@example.fr`, c = new Client(S.base);
  const r = await c.post('/api/auth/register', { email, name: 'Maman', password: 'ancien-mot-de-passe', familyName: 'F' });
  assert.equal(r.status, 201); return { email, c };
}
const forgot = async (email) => { const r = await new Client(S.base).post('/api/auth/forgot', { email }); await drainMail(); return r; };
const tokenFrom = (call) => /#\/reset\/([A-Za-z0-9_-]+)/.exec(call.body.textContent)[1];
const reset = (token, password = 'nouveau-mot-de-passe') => new Client(S.base).post('/api/auth/reset', { token, password });
const fresh = () => { calls = []; logs = []; mode = 'ok'; limits.enabled = false; resetLimits(); for (const k of ENV) delete process.env[k]; };

test('mailEnabled : reconnaît la configuration Brevo, et seulement elle', () => {
  fresh(); assert.equal(mailEnabled(), false);
  process.env.BREVO_API_KEY = KEY; assert.equal(mailEnabled(), false, 'clé sans expéditeur');
  process.env.BREVO_FROM_EMAIL = 'pas-un-email'; assert.equal(mailEnabled(), false, 'expéditeur invalide');
  process.env.BREVO_FROM_EMAIL = 'adilam.pro@gmail.com'; assert.equal(mailEnabled(), true);
  delete process.env.BREVO_API_KEY; assert.equal(mailEnabled(), false, 'expéditeur sans clé');
  fresh(); process.env.RESEND_API_KEY = 'x'; process.env.MAIL_FROM = 'a@b.fr'; assert.equal(mailEnabled(), false, 'l’ancienne configuration Resend n’est plus reconnue'); delete process.env.RESEND_API_KEY; delete process.env.MAIL_FROM;
});

test('non configuré : aucun appel Brevo, réponse générique, mailEnabled=false', async () => {
  fresh(); const { email } = await account();
  const r = await forgot(email);
  assert.equal(r.status, 200); assert.deepEqual(r.body, { ok: true, mailEnabled: false }); assert.equal(calls.length, 0);
});

test('envoi : requête Brevo conforme (HTTPS API, clé en en-tête, expéditeur, destinataire, lien)', async () => {
  fresh(); configure(); const { email } = await account();
  const r = await forgot(email);
  assert.equal(r.status, 200); assert.deepEqual(r.body, { ok: true, mailEnabled: true });
  assert.equal(calls.length, 1); const c = calls[0];
  assert.equal(c.url, '/v3/smtp/email'); assert.equal(c.headers['api-key'], KEY); assert.match(c.headers['content-type'], /application\/json/);
  assert.deepEqual(c.body.sender, { name: 'Petits Héros', email: 'adilam.pro@gmail.com' }); assert.deepEqual(c.body.to, [{ email }]);
  assert.match(c.body.subject, /nouveau mot de passe/); assert.match(c.body.textContent, /valable 1 heure/); assert.match(c.body.textContent, /une seule fois/);
  assert.match(c.body.textContent, /^.*https:\/\/app\.example\/#\/reset\/[A-Za-z0-9_-]{20,}$/m); assert.match(c.body.htmlContent, /href="https:\/\/app\.example\/#\/reset\//);
  assert.ok(logs.some((l) => /acceptée par Brevo \(messageId </.test(l)), 'succès journalisé seulement après acceptation');
});

test('lien : usage unique, expirant, un seul lien valide à la fois, change le mot de passe et ferme les sessions', async () => {
  fresh(); configure(); const { email, c: owner } = await account();
  await forgot(email); const t1 = tokenFrom(calls[0]);
  await forgot(email); const t2 = tokenFrom(calls[1]);
  assert.notEqual(t1, t2); assert.equal((await reset(t1)).status, 400, 'l’ancien lien est invalidé par la nouvelle demande');
  const ok = await reset(t2); assert.equal(ok.status, 200);
  assert.equal((await reset(t2, 'autre-mot-de-passe-2')).status, 400, 'usage unique');
  assert.equal((await owner.get('/api/family/state')).status, 401, 'anciennes sessions fermées');
  const l = new Client(S.base);
  assert.equal((await l.post('/api/auth/login', { email, password: 'ancien-mot-de-passe' })).status, 401);
  assert.equal((await l.post('/api/auth/login', { email, password: 'nouveau-mot-de-passe' })).status, 200);
  // expiration
  await forgot(email); const t3 = tokenFrom(calls[2]);
  await S.query(`UPDATE password_resets SET expires_at = now() - interval '1 second' WHERE token_hash = encode(sha256($1::bytea),'hex')`, [t3]);
  assert.equal((await reset(t3, 'encore-un-autre-mdp')).status, 400, 'lien expiré refusé');
  // le jeton n'est stocké que haché
  const stored = (await S.query('SELECT token_hash FROM password_resets')).rows.map((r) => r.token_hash);
  assert.ok(stored.every((h) => h !== t1 && h !== t2 && h !== t3));
});

test('compte inconnu : aucune requête Brevo et réponse identique (pas d’énumération)', async () => {
  fresh(); configure(); const { email } = await account();
  const known = await forgot(email), unknown = await forgot(`inconnu-${crypto.randomUUID().slice(0, 6)}@example.fr`);
  assert.equal(calls.length, 1, 'une seule requête : pour le compte existant');
  assert.equal(known.status, unknown.status); assert.deepEqual(known.body, unknown.body);
});

test('limitation : par adresse (3/h) et par IP (5/h)', async () => {
  fresh(); configure(); const { email } = await account(); limits.enabled = true; resetLimits();
  const codes = []; for (let i = 0; i < 4; i++) codes.push((await new Client(S.base).post('/api/auth/forgot', { email })).status);
  await drainMail(); assert.deepEqual(codes, [200, 200, 200, 429]); assert.equal(calls.length, 3);
  resetLimits(); const c2 = []; for (let i = 0; i < 6; i++) c2.push((await new Client(S.base).post('/api/auth/forgot', { email: `x${i}-${crypto.randomUUID().slice(0, 4)}@example.fr` })).status);
  assert.deepEqual(c2, [200, 200, 200, 200, 200, 429]);
});

for (const [name, m, expectLog, tokenValid] of [['clé refusée (401)', '401', /HTTP 401 \(unauthorized\)/, false], ['paramètre refusé (400)', '400', /HTTP 400 \(invalid_parameter\)/, false], ['erreur serveur Brevo (500)', '500', /HTTP 500/, false], ['réponse 2xx sans messageId', 'nomsgid', /unconfirmed/, true]]) {
  test(`erreur Brevo — ${name} : aucun succès annoncé, lien non conservé si échec certain, journaux sans secret`, async () => {
    fresh(); configure(); mode = m; const { email } = await account();
    const r = await forgot(email);
    assert.equal(r.status, 200, 'réponse HTTP générique (pas de fuite d’existence)');
    assert.ok(logs.some((l) => /échec de l’envoi/.test(l) && expectLog.test(l)), logs.join('|'));
    assert.ok(!logs.some((l) => /acceptée par Brevo/.test(l)), 'jamais de succès journalisé');
    const tok = tokenFrom(calls[0]); const res = await reset(tok);
    assert.equal(res.status, tokenValid ? 200 : 400, tokenValid ? 'issue inconnue : le lien reste valable' : 'échec certain : lien invalidé');
    const all = logs.join('\n'); assert.ok(!all.includes(KEY) && !all.includes('Key not found') && !all.includes(tok) && !all.includes('/#/reset/') && !all.includes(email), 'ni clé, ni lien, ni jeton, ni adresse dans les journaux');
  });
}

test('délai maximal : Brevo ne répond pas → échec « timeout » sans bloquer la requête ni annoncer un envoi', async () => {
  fresh(); configure({ MAIL_TIMEOUT_MS: '300' }); mode = 'hang'; const { email } = await account();
  const t0 = Date.now(); const r = await new Client(S.base).post('/api/auth/forgot', { email }); const answered = Date.now() - t0;
  assert.equal(r.status, 200); assert.ok(answered < 250, `réponse immédiate (${answered} ms), l’envoi est en arrière-plan`);
  await drainMail(); const total = Date.now() - t0;
  assert.ok(total >= 280 && total < 1500, `abandon au délai maximal (${total} ms)`);
  assert.ok(logs.some((l) => /timeout.*issue inconnue/.test(l))); assert.ok(!logs.some((l) => /acceptée par Brevo/.test(l)));
  assert.equal((await reset(tokenFrom(calls[0]))).status, 200, 'issue inconnue : le lien est conservé');
  await assert.rejects(() => sendMail({ to: 'a@b.fr', subject: 's', text: 't' }), (e) => e.kind === 'timeout');
});

test('réseau : Brevo injoignable → échec « network », lien invalidé, aucune clé journalisée', async () => {
  fresh(); configure({ BREVO_API_URL: 'http://127.0.0.1:9/v3/smtp/email' }); const { email } = await account();
  assert.equal((await forgot(email)).status, 200);
  assert.ok(logs.some((l) => /échec de l’envoi.*network/.test(l))); assert.ok(!logs.join('\n').includes(KEY));
  assert.equal((await S.query(`SELECT count(*) FROM password_resets WHERE used_at IS NULL AND user_id=(SELECT id FROM users WHERE lower(email)=$1)`, [email])).rows[0].count, 0);
});

test('sécurité de configuration : URL non HTTPS refusée (hors local), APP_URL absente = pas d’envoi, jamais de lien tiré de l’en-tête Host', async () => {
  fresh(); configure({ BREVO_API_URL: 'http://api.brevo.example/v3/smtp/email' });
  await assert.rejects(() => sendMail({ to: 'a@b.fr', subject: 's', text: 't' }), (e) => e.kind === 'configuration');
  fresh(); configure({ APP_URL: undefined }); const { email } = await account();
  const r = await new Client(S.base).post('/api/auth/forgot', { email }, { headers: { host: 'evil.example' } }); await drainMail();
  assert.equal(r.status, 200); assert.equal(calls.length, 0, 'pas d’e-mail sans URL publique de confiance'); assert.ok(logs.some((l) => /APP_URL/.test(l)));
  fresh(); configure({ APP_URL: undefined, RAILWAY_PUBLIC_DOMAIN: 'petits-heros-production.up.railway.app' }); const b = await account();
  await forgot(b.email); assert.match(calls[0].body.textContent, /https:\/\/petits-heros-production\.up\.railway\.app\/#\/reset\//, 'domaine public fourni par Railway');
});

test('healthz : indique la configuration mail et le commit déployé (sans secret)', async () => {
  fresh(); configure(); process.env.RAILWAY_GIT_COMMIT_SHA = 'abcdef1234567890';
  const j = await (await fetch(S.base + '/healthz')).json();
  assert.equal(j.mail, 'brevo'); assert.equal(j.commit, 'abcdef1'); assert.ok(!JSON.stringify(j).includes(KEY));
  fresh(); assert.equal((await (await fetch(S.base + '/healthz')).json()).mail, 'off'); delete process.env.RAILWAY_GIT_COMMIT_SHA;
});

test('journaux : sur l’ensemble des scénarios, ni clé API, ni lien de récupération, ni adresse e-mail', () => {
  const all = allLogs.join('\n');
  assert.ok(allLogs.length > 5, 'le serveur a bien journalisé des événements');
  assert.ok(!all.includes(KEY) && !all.includes('xkeysib') && !all.includes('/#/reset/') && !/rec-[0-9a-f]{8}@example\.fr/.test(all) && !/reset\/[A-Za-z0-9_-]{20,}/.test(all));
});
