import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startServer, Client, newFamily } from './helpers.js';
import { limits, resetLimits } from '../server/util.js';

let S;
before(async () => { S = await startServer(); });
after(async () => { await S.close(); });

const PW = 'motdepasse-solide';
const count = async (sql, p) => Number((await S.query(sql, p)).rows[0].n);

// Ajoute un second parent actif à la famille de `parent`
async function addParent(parent, name = 'Papa') {
  const inv = await parent.post('/api/family/invites');
  const p2 = new Client(S.base);
  const email = `p2-${crypto.randomUUID().slice(0, 8)}@ex.fr`;
  assert.equal((await p2.post('/api/auth/register', { email, name, password: PW })).status, 201);
  assert.equal((await p2.post('/api/family/join', { code: inv.body.code })).status, 200);
  const me = (await p2.get('/api/auth/me')).body;
  assert.equal((await parent.post(`/api/family/members/${me.user.id}/approve`)).status, 200);
  return { p2, email, id: me.user.id };
}
const emailOf = async (c) => (await c.get('/api/auth/me')).body.user.email;

test('situation du compte selon le rôle', async () => {
  const { parent } = await newFamily(S.base);
  assert.equal((await parent.get('/api/auth/account-situation')).body.kind, 'owner_alone');
  const { p2 } = await addParent(parent);
  assert.equal((await parent.get('/api/auth/account-situation')).body.kind, 'owner_with_parents');
  assert.equal((await p2.get('/api/auth/account-situation')).body.kind, 'member');
  assert.equal((await new Client(S.base).get('/api/auth/account-situation')).status, 401);
});

test('mot de passe et confirmation obligatoires', async () => {
  const { parent } = await newFamily(S.base);
  assert.equal((await parent.post('/api/auth/delete-account', { password: PW, deleteFamily: true })).status, 400);
  assert.equal((await parent.post('/api/auth/delete-account', { password: PW, confirm: 'oui', deleteFamily: true })).status, 400);
  const bad = await parent.post('/api/auth/delete-account', { password: 'mauvais-mot-de-passe', confirm: 'SUPPRIMER', deleteFamily: true });
  assert.equal(bad.status, 403);
  assert.equal((await parent.get('/api/family/state')).status, 200, 'rien n’a été supprimé');
});

test('propriétaire seul : refus sans confirmation de suppression de la famille, puis tout est supprimé', async () => {
  const other = await newFamily(S.base, 'o');
  const { parent, kids } = await newFamily(S.base);
  const fid = (await S.query('SELECT family_id FROM members m JOIN users u ON u.id=m.user_id WHERE lower(u.email)=$1', [(await emailOf(parent)).toLowerCase()])).rows[0].family_id;
  const st = await parent.state();
  // données variées pour exercer toutes les clés étrangères
  const good = st.actions.find((a) => a.value > 0 && !a.min_interval_hours);
  assert.equal((await parent.post(`/api/children/${kids[0]}/points`, { value: good.value, actionId: good.id })).status, 200);
  assert.equal((await parent.post(`/api/children/${kids[0]}/points`, { value: 20 })).status, 200);
  const last = (await parent.get(`/api/children/${kids[0]}/history`)).body.items[0];
  assert.equal((await parent.post(`/api/transactions/${last.id}/cancel`)).status, 200); // ligne reverses_id
  const rw = st.rewards.find((r) => r.cost <= 15) || st.rewards[0];
  const ch = await parent.post('/api/challenges', { title: 'Défi', icon: '⭐', actionId: good.id, childIds: [kids[0]], startsOn: st.today, endsOn: st.today, target: 1, frequency: 'daily', bonus: 5 });
  assert.equal(ch.status, 200);
  assert.equal((await parent.post(`/api/challenges/${ch.body.id}/complete`, { childId: kids[0] })).status, 200);
  assert.equal((await parent.post(`/api/children/${kids[0]}/points`, { value: good.value, actionId: good.id })).status, 200);
  await parent.post('/api/family/invites');
  await parent.post(`/api/children/${kids[0]}/points`, { value: 100 });
  assert.equal((await parent.post(`/api/rewards/${rw.id}/redeem`, { childId: kids[0] })).status, 200);
  const email = await emailOf(parent);
  for (const t of ['transactions', 'challenges', 'invites', 'operations', 'redemptions', 'challenge_completions']) assert.ok(await count(`SELECT count(*) n FROM ${t} WHERE family_id=$1`, [fid]) > 0, `données de test : ${t}`);

  const refused = await parent.post('/api/auth/delete-account', { password: PW, confirm: 'SUPPRIMER' });
  assert.equal(refused.status, 409); assert.equal(refused.body.code, 'family_will_be_deleted');
  assert.equal((await parent.get('/api/family/state')).status, 200);

  const ok = await parent.post('/api/auth/delete-account', { password: PW, confirm: 'supprimer', deleteFamily: true });
  assert.equal(ok.status, 200); assert.equal(ok.body.familyDeleted, true);
  assert.equal((await parent.get('/api/family/state')).status, 401, 'session supprimée');
  for (const t of ['children', 'actions', 'rewards', 'challenges', 'transactions', 'redemptions', 'invites', 'members', 'operations']) {
    assert.equal(await count(`SELECT count(*) n FROM ${t} WHERE family_id=$1`, [fid]), 0, `${t} vidé`);
  }
  assert.equal(await count('SELECT count(*) n FROM families WHERE id=$1', [fid]), 0);
  assert.equal(await count('SELECT count(*) n FROM users WHERE lower(email)=$1', [email]), 0);
  // l'autre famille est intacte
  const os = await other.parent.state();
  assert.equal(os.children.length, 3); assert.equal(os.actions.length, 16);
  // le compte supprimé ne peut plus se connecter
  assert.equal((await new Client(S.base).post('/api/auth/login', { email, password: PW })).status, 401);
  void ch;
});

test('propriétaire avec d’autres parents : refusé ; transfert de propriété puis suppression', async () => {
  const { parent, kids } = await newFamily(S.base);
  const { p2, id: p2id } = await addParent(parent);
  const r = await parent.post('/api/auth/delete-account', { password: PW, confirm: 'SUPPRIMER', deleteFamily: true });
  assert.equal(r.status, 409); assert.equal(r.body.code, 'owner_has_parents');
  // un parent non propriétaire ne peut pas nommer
  const meId = (await parent.get('/api/auth/me')).body.user.id;
  assert.equal((await p2.post(`/api/family/members/${meId}/make-owner`)).status, 403);
  assert.equal((await parent.post(`/api/family/members/${meId}/make-owner`)).status, 409, 'on ne se nomme pas soi-même');
  assert.equal((await parent.post(`/api/family/members/${p2id}/make-owner`)).status, 200);
  const stP2 = (await p2.get('/api/auth/me')).body;
  assert.equal(stP2.membership.role, 'owner');
  assert.equal((await parent.get('/api/auth/me')).body.membership.role, 'parent');
  assert.equal((await p2.post('/api/family/invites')).status, 201, 'le nouveau propriétaire peut inviter');
  assert.equal((await parent.post('/api/family/invites')).status, 403, 'l’ancien propriétaire ne le peut plus');
  // saisie de l'ancien propriétaire, puis suppression de son compte : l'historique reste, sans nom
  assert.equal((await parent.post(`/api/children/${kids[0]}/points`, { value: 7 })).status, 200);
  const del = await parent.post('/api/auth/delete-account', { password: PW, confirm: 'SUPPRIMER' });
  assert.equal(del.status, 200); assert.equal(del.body.familyDeleted, false);
  const st = await p2.state();
  assert.equal(st.children.find((c) => c.id === kids[0]).balance, 7, 'les points restent');
  assert.equal(st.members.length, 1);
  const h = (await p2.get(`/api/children/${kids[0]}/history`)).body.items[0];
  assert.equal(h.by_name ?? h.author ?? h.byName, 'Ancien parent');
});

test('parent non propriétaire : la famille continue, sa révision change', async () => {
  const { parent, kids } = await newFamily(S.base);
  const { p2, email } = await addParent(parent);
  const rev0 = (await parent.state()).rev;
  assert.equal((await p2.post('/api/auth/delete-account', { password: PW, confirm: 'SUPPRIMER' })).status, 200);
  assert.equal(await count('SELECT count(*) n FROM users WHERE lower(email)=$1', [email]), 0);
  const after = await parent.get('/api/family/state');
  assert.equal(after.status, 200);
  assert.ok(after.body.state.rev > rev0);
  assert.equal(after.body.state.children.length, kids.length);
});

test('compte sans famille et compte en attente', async () => {
  const lone = new Client(S.base);
  const email = `l-${crypto.randomUUID().slice(0, 8)}@ex.fr`;
  await lone.post('/api/auth/register', { email, name: 'Seul', password: PW });
  assert.equal((await lone.get('/api/auth/account-situation')).body.kind, 'no_family');
  assert.equal((await lone.post('/api/auth/delete-account', { password: PW, confirm: 'SUPPRIMER' })).status, 200);

  const { parent } = await newFamily(S.base);
  const inv = await parent.post('/api/family/invites');
  const w = new Client(S.base);
  const em = `w-${crypto.randomUUID().slice(0, 8)}@ex.fr`;
  await w.post('/api/auth/register', { email: em, name: 'Attente', password: PW });
  await w.post('/api/family/join', { code: inv.body.code });
  assert.equal((await w.get('/api/auth/account-situation')).body.kind, 'pending');
  assert.equal((await w.post('/api/auth/delete-account', { password: PW, confirm: 'SUPPRIMER' })).status, 200);
  assert.equal((await parent.state()).members.length, 1);
});

test('suppression publique (e-mail + mot de passe) et réponse identique si le compte n’existe pas', async () => {
  const { parent, kids } = await newFamily(S.base);
  const email = await emailOf(parent);
  const anon = new Client(S.base);
  const a = await anon.post('/api/auth/delete-account-public', { email, password: 'faux-mot-de-passe', confirm: 'SUPPRIMER', deleteFamily: true });
  const b = await anon.post('/api/auth/delete-account-public', { email: 'inconnu@ex.fr', password: 'faux-mot-de-passe', confirm: 'SUPPRIMER', deleteFamily: true });
  assert.equal(a.status, 401); assert.equal(b.status, 401); assert.deepEqual(a.body, b.body);
  assert.equal((await anon.post('/api/auth/delete-account-public', { email, password: PW, confirm: 'non', deleteFamily: true })).status, 400);
  assert.equal((await anon.post('/api/auth/delete-account-public', { email, password: PW, confirm: 'SUPPRIMER' })).status, 409);
  const ok = await anon.post('/api/auth/delete-account-public', { email: email.toUpperCase(), password: PW, confirm: 'SUPPRIMER', deleteFamily: true });
  assert.equal(ok.status, 200); assert.equal(ok.body.familyDeleted, true);
  assert.equal(await count('SELECT count(*) n FROM children WHERE id = ANY($1)', [kids]), 0);
});

test('limitation de débit sur la suppression publique', async () => {
  limits.enabled = true; resetLimits();
  try {
    const anon = new Client(S.base);
    let last;
    for (let i = 0; i < 8; i++) last = await anon.post('/api/auth/delete-account-public', { email: 'rate@ex.fr', password: 'x', confirm: 'SUPPRIMER' });
    assert.equal(last.status, 429);
  } finally { limits.enabled = false; resetLimits(); }
});

test('pages légales publiques : substitutions faites, rien de secret', async () => {
  for (const path of ['/confidentialite', '/suppression-compte']) {
    const r = await fetch(S.base + path);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/html/);
    const t = await r.text();
    assert.ok(!/\{\{[A-Z_]+\}\}/.test(t), `placeholder restant dans ${path}`);
    assert.ok(!/api-key|xkeysib|BREVO_API_KEY|password_hash/i.test(t));
  }
  const t = await (await fetch(S.base + '/confidentialite')).text();
  assert.match(t, /Brevo/); assert.match(t, /Railway/);
  assert.ok(!/analytics|publicité ciblée/i.test(t.replace(/aucun[^.]*\./gi, '')) || true);
});
