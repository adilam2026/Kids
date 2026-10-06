// Application Android : authentification par jeton Bearer (le WebView n'est pas de même origine que l'API),
// CORS strict, CSRF, révocation, synchronisation avec la version web.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startServer, Client, newFamily } from './helpers.js';

let S;
before(async () => { S = await startServer(); });
after(async () => { delete process.env.MIN_NATIVE_BUILD; await S.close(); });

const ORIGIN = 'https://localhost'; // origine du WebView Capacitor (androidScheme: https)
const native = (base, build = 7) => { const c = new Client(base); c.headers = { 'x-client': `native-android/${build}`, origin: ORIGIN }; return c; };

test('connexion native : jeton renvoyé, aucun cookie, Bearer accepté', async () => {
  const { parent } = await newFamily(S.base);
  const email = (await S.query('SELECT email FROM users ORDER BY created_at DESC LIMIT 1')).rows[0].email;
  const a = native(S.base);
  const r = await a.post('/api/auth/login', { email, password: 'motdepasse-solide' });
  assert.equal(r.status, 200); assert.match(r.body.token, /^[A-Za-z0-9_-]{40,}$/);
  assert.equal(r.headers.getSetCookie().length, 0, 'aucun cookie pour le client natif');
  a.token = r.body.token;
  const st = await a.state(); assert.equal(st.children.length, 3);
  // la version web (cookie) et l'application voient les mêmes données et se synchronisent
  const kid = st.children[0].id;
  await a.post(`/api/children/${kid}/points`, { value: 4 });
  assert.equal((await parent.state()).children.find((c) => c.id === kid).balance, 4);
  await parent.post(`/api/children/${kid}/points`, { value: 3 });
  assert.equal((await a.state()).children.find((c) => c.id === kid).balance, 7);
  // le web ne reçoit jamais de jeton dans la réponse
  const web = new Client(S.base);
  const w = await web.post('/api/auth/login', { email, password: 'motdepasse-solide' });
  assert.equal(w.body.token, undefined); assert.equal(w.headers.getSetCookie().length, 1);
});

test('inscription native : jeton + codes de secours, connexion conservée', async () => {
  const a = native(S.base);
  const r = await a.post('/api/auth/register', { email: `n-${crypto.randomUUID()}@ex.fr`, name: 'Nat', password: 'motdepasse-solide', familyName: 'Nat' });
  assert.equal(r.status, 201); assert.equal(r.body.recoveryCodes.length, 8); assert.ok(r.body.token);
  assert.equal(r.headers.getSetCookie().length, 0);
  a.token = r.body.token;
  assert.equal((await a.get('/api/auth/me')).body.user.name, 'Nat');
  // « fermeture / réouverture » : un nouveau client qui ne présente que le jeton stocké est reconnu
  const again = native(S.base); again.token = r.body.token;
  assert.equal((await again.get('/api/family/state')).status, 200);
});

test('jeton invalide : refusé, sans repli sur un cookie valide', async () => {
  const { parent } = await newFamily(S.base);
  const c = new Client(S.base); c.cookie = parent.cookie; c.token = 'A'.repeat(43);
  assert.equal((await c.get('/api/family/state')).status, 401, 'Bearer faux + cookie valide → 401');
  c.token = 'pas un jeton'; assert.equal((await c.get('/api/family/state')).status, 401);
  assert.equal((await new Client(S.base).get('/api/family/state')).status, 401);
});

test('CORS : seule l’origine de l’application est autorisée, sans credentials', async () => {
  const pre = (origin) => fetch(S.base + '/api/family/state', { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type,x-op-id,x-client' } });
  const ok = await pre(ORIGIN);
  assert.equal(ok.status, 204); assert.equal(ok.headers.get('access-control-allow-origin'), ORIGIN);
  assert.match(ok.headers.get('access-control-allow-headers'), /authorization/); assert.match(ok.headers.get('access-control-allow-headers'), /x-op-id/);
  assert.equal(ok.headers.get('access-control-allow-credentials'), null);
  const evil = await pre('https://evil.example');
  assert.equal(evil.status, 403); assert.equal(evil.headers.get('access-control-allow-origin'), null);
  const get = await fetch(S.base + '/api/meta', { headers: { origin: 'https://evil.example' } });
  assert.equal(get.headers.get('access-control-allow-origin'), null);
  assert.equal((await fetch(S.base + '/api/meta', { headers: { origin: ORIGIN } })).headers.get('access-control-allow-origin'), ORIGIN);
});

test('CSRF : une écriture par cookie depuis une autre origine reste refusée ; par jeton Bearer elle passe', async () => {
  const { parent, kids } = await newFamily(S.base);
  const viaCookie = new Client(S.base); viaCookie.cookie = parent.cookie; viaCookie.headers = { origin: 'https://evil.example' };
  assert.equal((await viaCookie.post(`/api/children/${kids[0]}/points`, { value: 9 })).status, 403);
  viaCookie.headers = { origin: ORIGIN };
  assert.equal((await viaCookie.post(`/api/children/${kids[0]}/points`, { value: 9 })).status, 403, 'cookie + origine native : refusé');
  const email = (await S.query('SELECT email FROM users ORDER BY created_at DESC LIMIT 1')).rows[0].email;
  const a = native(S.base); a.token = (await a.post('/api/auth/login', { email, password: 'motdepasse-solide' })).body.token;
  assert.equal((await a.post(`/api/children/${kids[0]}/points`, { value: 2 })).status, 200);
  assert.equal((await parent.state()).children.find((c) => c.id === kids[0]).balance, 2);
  // JSON obligatoire même en Bearer
  const raw = await fetch(S.base + `/api/children/${kids[0]}/points`, { method: 'POST', headers: { authorization: `Bearer ${a.token}`, 'content-type': 'text/plain', 'x-op-id': crypto.randomUUID() }, body: '{"value":1}' });
  assert.equal(raw.status, 415);
});

test('déconnexion native et membre retiré : le jeton est révoqué immédiatement', async () => {
  const { parent } = await newFamily(S.base);
  const email = (await S.query('SELECT email FROM users ORDER BY created_at DESC LIMIT 1')).rows[0].email;
  const a = native(S.base); a.token = (await a.post('/api/auth/login', { email, password: 'motdepasse-solide' })).body.token;
  assert.equal((await a.post('/api/auth/logout')).status, 200);
  assert.equal((await a.get('/api/family/state')).status, 401);
  // second parent sur l'application, retiré par le propriétaire
  const inv = await parent.post('/api/family/invites');
  const p2 = native(S.base);
  const em = `p2-${crypto.randomUUID()}@ex.fr`;
  p2.token = (await p2.post('/api/auth/register', { email: em, name: 'Papa', password: 'motdepasse-solide' })).body.token;
  assert.equal((await p2.post('/api/family/join', { code: inv.body.code })).status, 200);
  const uid = (await p2.get('/api/auth/me')).body.user.id;
  assert.equal((await p2.get('/api/family/state')).status, 403, 'en attente : pas de données');
  await parent.post(`/api/family/members/${uid}/approve`);
  assert.equal((await p2.get('/api/family/state')).status, 200);
  await parent.delete(`/api/family/members/${uid}`);
  assert.equal((await p2.get('/api/family/state')).status, 401, 'jeton déjà stocké sur le téléphone : révoqué');
});

test('mise à jour obligatoire : build natif trop ancien → 426, web et builds récents intacts', async () => {
  process.env.MIN_NATIVE_BUILD = '5';
  try {
    assert.equal((await fetch(S.base + '/api/meta')).status, 200);
    assert.equal((await (await fetch(S.base + '/api/meta')).json()).minNativeBuild, 5);
    const old = await fetch(S.base + '/api/auth/me', { headers: { 'x-client': 'native-android/4' } });
    assert.equal(old.status, 426); assert.equal((await old.json()).code, 'upgrade_required');
    assert.equal((await fetch(S.base + '/api/auth/me', { headers: { 'x-client': 'native-android/5' } })).status, 200);
    assert.equal((await fetch(S.base + '/api/auth/me')).status, 200, 'le web n’est pas concerné');
  } finally { delete process.env.MIN_NATIVE_BUILD; }
});
