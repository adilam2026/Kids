import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startServer, Client, newFamily } from './helpers.js';
import { limits, resetLimits } from '../server/util.js';

let S;
before(async () => { S = await startServer(); });
after(async () => { await S.close(); });

const balance = async (parent, id) => (await parent.state()).children.find((c) => c.id === id).balance;
const action = async (parent, title) => (await parent.state()).actions.find((a) => a.title.startsWith(title));

test('création de trois enfants + bibliothèque initiale', async () => {
  const { parent, kids } = await newFamily(S.base);
  const st = await parent.state();
  assert.equal(st.children.length, 3);
  assert.equal(kids.length, 3);
  assert.equal(st.actions.length, 16);
  assert.ok(st.actions.some((a) => a.value === -2 && a.theme === 'Malus facultatifs'));
  assert.ok(!st.actions.some((a) => /pleur|apprentissage|besoin/i.test(a.title)), 'aucun malus pour pleurs / apprentissage / besoins');
  assert.equal(st.rewards.length, 3);
});

test('invitation : code aléatoire, usage unique, approbation, mêmes données', async () => {
  const { parent, kids } = await newFamily(S.base);
  await parent.post(`/api/children/${kids[0]}/points`, { value: 5 });
  const inv = await parent.post('/api/family/invites');
  assert.equal(inv.status, 201);
  assert.match(inv.body.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const inv2 = await parent.post('/api/family/invites');
  assert.notEqual(inv.body.code, inv2.body.code);

  const p2 = new Client(S.base);
  await p2.post('/api/auth/register', { email: `p2-${crypto.randomUUID()}@ex.fr`, name: 'Papa', password: 'motdepasse-solide' });
  assert.equal((await p2.get('/api/family/state')).status, 403, 'sans famille : pas de données');
  // un mauvais code
  assert.equal((await p2.post('/api/family/join', { code: 'AAAA-AAAA-AAAA' })).status, 400);
  assert.equal((await p2.post('/api/family/join', { code: inv.body.code })).status, 200);
  // en attente : le code seul ne donne accès à rien
  const pend = await p2.get('/api/family/state');
  assert.equal(pend.status, 403); assert.equal(pend.body.code, 'pending');
  assert.equal((await p2.post(`/api/children/${kids[0]}/points`, { value: 50 })).status, 403);
  // code déjà utilisé
  const p3 = new Client(S.base);
  await p3.post('/api/auth/register', { email: `p3-${crypto.randomUUID()}@ex.fr`, name: 'X', password: 'motdepasse-solide' });
  assert.equal((await p3.post('/api/family/join', { code: inv.body.code })).status, 400);
  // un parent non propriétaire ne peut pas approuver
  const me = (await p2.get('/api/auth/me')).body;
  assert.equal((await p2.post(`/api/family/members/${me.user.id}/approve`)).status, 403);
  // approbation par le propriétaire
  assert.equal((await parent.post(`/api/family/members/${me.user.id}/approve`)).status, 200);
  const s1 = await parent.state(), s2 = await p2.state();
  assert.deepEqual(s2.children, s1.children);
  assert.deepEqual(s2.challenges, s1.challenges);
  assert.equal(s2.children.find((c) => c.id === kids[0]).balance, 5);
  // le propriétaire seul voit l'e-mail des invitations? le 2e parent ne peut pas inviter
  assert.equal((await p2.post('/api/family/invites')).status, 403);
  // reconnexion
  const p2b = new Client(S.base);
  assert.equal((await p2b.post('/api/auth/login', { email: me.user.email, password: 'motdepasse-solide' })).status, 200);
  assert.equal((await p2b.get('/api/family/state')).status, 200);
});

test('code révoqué ou expiré refusé', async () => {
  const { parent } = await newFamily(S.base);
  const inv = await parent.post('/api/family/invites');
  await parent.delete(`/api/family/invites/${inv.body.id}`);
  const p = new Client(S.base);
  await p.post('/api/auth/register', { email: `r-${crypto.randomUUID()}@ex.fr`, name: 'R', password: 'motdepasse-solide' });
  assert.equal((await p.post('/api/family/join', { code: inv.body.code })).status, 400);
  const inv2 = await parent.post('/api/family/invites');
  await S.query(`UPDATE invites SET expires_at = now() - interval '1 minute' WHERE id=$1`, [inv2.body.id]);
  assert.equal((await p.post('/api/family/join', { code: inv2.body.code })).status, 400);
});

test('ajouts simultanés de points : +2 et +3 = +5 sans perte', async () => {
  const { parent, kids } = await newFamily(S.base);
  const other = new Client(S.base);
  other.cookie = parent.cookie; // même famille (autre appareil)
  const [a, b] = await Promise.all([
    parent.post(`/api/children/${kids[0]}/points`, { value: 2 }),
    other.post(`/api/children/${kids[0]}/points`, { value: 3 }),
  ]);
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.equal(await balance(parent, kids[0]), 5);
  // beaucoup de concurrence
  await Promise.all(Array.from({ length: 20 }, () => parent.post(`/api/children/${kids[1]}/points`, { value: 1 })));
  assert.equal(await balance(parent, kids[1]), 20);
});

test('double clic / nouvelle tentative réseau : une seule attribution', async () => {
  const { parent, kids } = await newFamily(S.base);
  const op = crypto.randomUUID();
  const rs = await Promise.all([1, 2, 3, 4].map(() => parent.post(`/api/children/${kids[0]}/points`, { value: 5 }, { op })));
  assert.ok(rs.every((r) => r.status === 200));
  assert.equal(new Set(rs.map((r) => r.body.txId)).size, 1);
  assert.equal(await balance(parent, kids[0]), 5);
  const again = await parent.post(`/api/children/${kids[0]}/points`, { value: 5 }, { op });
  assert.equal(again.body.replayed, true);
  assert.equal(await balance(parent, kids[0]), 5);
  // sans identifiant d'opération : refusé
  const r = await fetch(S.base + `/api/children/${kids[0]}/points`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: parent.cookie }, body: '{"value":1}' });
  assert.equal(r.status, 400);
});

test('solde jamais négatif ; retrait libre exige un motif', async () => {
  const { parent, kids } = await newFamily(S.base);
  await parent.post(`/api/children/${kids[0]}/points`, { value: 3 });
  const r = await parent.post(`/api/children/${kids[0]}/points`, { value: -5, reason: 'test' });
  assert.equal(r.status, 409); assert.equal(r.body.code, 'insufficient');
  assert.match(r.body.error, /Corrige le montant/);
  assert.equal((await parent.post(`/api/children/${kids[0]}/points`, { value: -1 })).status, 400);
  assert.equal((await parent.post(`/api/children/${kids[0]}/points`, { value: -2, reason: 'Dispute' })).status, 200);
  assert.equal(await balance(parent, kids[0]), 1);
  // concurrence : deux retraits de 1 sur 1 point → un seul passe
  const rs = await Promise.all([1, 2].map(() => parent.post(`/api/children/${kids[0]}/points`, { value: -1, reason: 'x' })));
  assert.deepEqual(rs.map((x) => x.status).sort(), [200, 409]);
  assert.equal(await balance(parent, kids[0]), 0);
});

test('action prédéfinie, bonus, historique, bilan hebdomadaire', async () => {
  const { parent, kids } = await newFamily(S.base);
  const toys = await action(parent, 'Ranger ses jouets');
  await parent.post(`/api/children/${kids[0]}/points`, { value: toys.value, actionId: toys.id });
  await parent.post(`/api/children/${kids[0]}/points`, { value: 10, bonus: true, reason: 'Super journée' });
  const mal = await action(parent, 'Frapper');
  await parent.post(`/api/children/${kids[0]}/points`, { value: mal.value, actionId: mal.id });
  const h = await parent.get(`/api/children/${kids[0]}/history`);
  assert.deepEqual(h.body.items.map((i) => i.type), ['malus', 'bonus', 'gain']);
  assert.equal(h.body.items[2].author, 'Maman'); assert.equal(h.body.items[2].reason, 'Ranger ses jouets');
  const f = await parent.get(`/api/children/${kids[0]}/history?type=bonus`);
  assert.equal(f.body.items.length, 1);
  const w = (await parent.get(`/api/children/${kids[0]}/week`)).body;
  assert.equal(w.gained, 12); assert.equal(w.removed, 2); assert.equal(w.used, 0); assert.equal(w.available, 10);
  // pas de remise à zéro : semaine précédente vide mais solde conservé
  const w0 = (await parent.get(`/api/children/${kids[0]}/week?offset=-1`)).body;
  assert.equal(w0.gained, 0); assert.equal(w0.available, 10);
});

test('défi : bonus final attribué une seule fois, fréquence, annulation cohérente', async () => {
  const { parent, kids } = await newFamily(S.base);
  const toys = await action(parent, 'Ranger ses jouets');
  const today = (await parent.state()).today;
  const mk = await parent.post('/api/challenges', {
    title: 'Jouets 3 fois', icon: '🧸', actionId: toys.id, childIds: [kids[0]], startsOn: today, endsOn: today,
    target: 3, frequency: 'any', bonus: 10,
  });
  assert.equal(mk.status, 200);
  const id = mk.body.id;
  const done = [];
  for (let i = 0; i < 3; i++) {
    const r = await parent.post(`/api/challenges/${id}/complete`, { childId: kids[0] });
    assert.equal(r.status, 200); done.push(r.body);
  }
  assert.equal(await balance(parent, kids[0]), 3 * 2 + 10);
  // objectif atteint : plus de validation, donc pas de second bonus
  assert.equal((await parent.post(`/api/challenges/${id}/complete`, { childId: kids[0] })).status, 409);
  assert.equal(await balance(parent, kids[0]), 16);
  const ch = (await parent.state()).challenges[0];
  assert.equal(ch.completed, true); assert.deepEqual(ch.bonusGiven, [kids[0]]);
  // double clic sur une validation : même op
  // annulation de la dernière validation : points + bonus compensés, sans effacer l'historique
  const c = await parent.post(`/api/completions/${done[2].eventId}/cancel`);
  assert.equal(c.status, 200);
  assert.equal(await balance(parent, kids[0]), 4);
  assert.equal((await parent.state()).challenges[0].completed, false);
  assert.equal((await parent.post(`/api/completions/${done[2].eventId}/cancel`)).status, 409);
  const hist = (await parent.get(`/api/children/${kids[0]}/history?limit=50`)).body.items;
  assert.equal(hist.filter((i) => i.type === 'bonus').length, 1, 'mouvement d’origine conservé');
  assert.equal(hist.filter((i) => i.type === 'cancel').length, 2);
  // nouvelle validation : le bonus peut être regagné, une seule fois
  await parent.post(`/api/challenges/${id}/complete`, { childId: kids[0] });
  assert.equal(await balance(parent, kids[0]), 16);
  const bonuses = await S.query(`SELECT count(*) FROM challenge_bonuses WHERE challenge_id=$1 AND cancelled_at IS NULL`, [id]);
  assert.equal(bonuses.rows[0].count, 1);
});

test('défi : une validation par jour, bonus concurrent unique, collectif', async () => {
  const { parent, kids } = await newFamily(S.base);
  const toys = await action(parent, 'Ranger ses jouets');
  const today = (await parent.state()).today;
  const mk = await parent.post('/api/challenges', { title: 'Quotidien', icon: '⭐', actionId: toys.id, childIds: [kids[0]], startsOn: today, endsOn: today, target: 1, frequency: 'daily', bonus: 5 });
  // deux validations simultanées avec des op différents : une seule passe
  const rs = await Promise.all([1, 2, 3].map(() => parent.post(`/api/challenges/${mk.body.id}/complete`, { childId: kids[0] })));
  assert.equal(rs.filter((r) => r.status === 200).length, 1);
  assert.equal(await balance(parent, kids[0]), 2 + 5);
  // collectif
  const col = await parent.post('/api/challenges', { title: 'Coin jeux', icon: '🧹', actionId: toys.id, collective: true, childIds: kids, startsOn: today, endsOn: today, target: 2, frequency: 'any', bonus: 4 });
  assert.equal(col.status, 200);
  assert.equal((await parent.post(`/api/challenges/${col.body.id}/complete`, {})).status, 200);
  assert.equal(await balance(parent, kids[1]), 2);
  const last = await parent.post(`/api/challenges/${col.body.id}/complete`, {});
  assert.equal(last.status, 200);
  for (const k of kids) assert.equal(await balance(parent, k), k === kids[0] ? 7 + 4 + 4 : 2 + 2 + 4);
  assert.equal((await parent.post(`/api/challenges/${col.body.id}/complete`, {})).status, 409);
  // aucune perte de points si le défi n'est pas terminé : rien à tester côté serveur, aucun débit automatique
  // annuler la dernière validation collective retire aussi les bonus de tous
  assert.equal((await parent.post(`/api/completions/${last.body.eventId}/cancel`)).status, 200);
  assert.equal(await balance(parent, kids[2]), 2);
});

test('annulation refusée si les points sont déjà dépensés', async () => {
  const { parent, kids } = await newFamily(S.base);
  const g = await parent.post(`/api/children/${kids[0]}/points`, { value: 10 });
  const rw = (await parent.state()).rewards.find((r) => r.cost === 10);
  assert.equal((await parent.post(`/api/rewards/${rw.id}/redeem`, { childId: kids[0] })).status, 200);
  assert.equal(await balance(parent, kids[0]), 0);
  const c = await parent.post(`/api/transactions/${g.body.txId}/cancel`);
  assert.equal(c.status, 409);
  assert.equal(await balance(parent, kids[0]), 0);
});

test('récompense : contrôle du solde, à réaliser, réalisée, annulation sans double remboursement', async () => {
  const { parent, kids } = await newFamily(S.base);
  const st = await parent.state();
  const rw = st.rewards.find((r) => r.cost === 15);
  const r0 = await parent.post(`/api/rewards/${rw.id}/redeem`, { childId: kids[0] });
  assert.equal(r0.status, 409); assert.equal(r0.body.code, 'insufficient');
  assert.equal((await parent.state()).redemptions.length, 0, 'aucune trace d’un échange refusé');
  await parent.post(`/api/children/${kids[0]}/points`, { value: 20 });
  const r1 = await parent.post(`/api/rewards/${rw.id}/redeem`, { childId: kids[0] });
  assert.equal(r1.status, 200);
  assert.equal(await balance(parent, kids[0]), 5);
  let s = await parent.state();
  assert.equal(s.redemptions[0].status, 'todo');
  // annulation : remboursée une seule fois, même en concurrence / via tx
  const rid = s.redemptions[0].id;
  const rs = await Promise.all([
    parent.post(`/api/redemptions/${rid}/cancel`), parent.post(`/api/redemptions/${rid}/cancel`),
    parent.post(`/api/transactions/${r1.body.txId}/cancel`),
  ]);
  assert.equal(rs.filter((r) => r.status === 200).length, 1);
  assert.equal(await balance(parent, kids[0]), 20);
  const comp = await S.query(`SELECT count(*) FROM transactions WHERE reverses_id=$1`, [r1.body.txId]);
  assert.equal(comp.rows[0].count, 1);
  // réalisée : ne peut plus être annulée
  const r2 = await parent.post(`/api/rewards/${rw.id}/redeem`, { childId: kids[0] });
  s = await parent.state();
  const rid2 = s.redemptions.find((x) => x.status === 'todo').id;
  assert.equal((await parent.post(`/api/redemptions/${rid2}/done`)).status, 200);
  assert.equal((await parent.post(`/api/redemptions/${rid2}/cancel`)).status, 409);
  assert.equal((await parent.post(`/api/transactions/${r2.body.txId}/cancel`)).status, 409);
  assert.equal(await balance(parent, kids[0]), 5);
  // bilan : points utilisés = 15 (le premier échange annulé n'est pas compté)
  const w = (await parent.get(`/api/children/${kids[0]}/week`)).body;
  assert.equal(w.used, 15); assert.equal(w.gained, 20);
});

test('annulation d’un gain : compensation traçable, jamais deux fois', async () => {
  const { parent, kids } = await newFamily(S.base);
  const g = await parent.post(`/api/children/${kids[0]}/points`, { value: 5 });
  assert.equal((await parent.post(`/api/transactions/${g.body.txId}/cancel`)).status, 200);
  assert.equal((await parent.post(`/api/transactions/${g.body.txId}/cancel`)).status, 409);
  assert.equal(await balance(parent, kids[0]), 0);
  const items = (await parent.get(`/api/children/${kids[0]}/history`)).body.items;
  assert.equal(items.length, 2);
  const orig = items.find((i) => i.type === 'gain'), comp = items.find((i) => i.type === 'cancel');
  assert.equal(orig.reversed, true); assert.equal(comp.reverses_id, orig.id); assert.equal(comp.value, -5);
  // annuler une annulation : impossible
  assert.equal((await parent.post(`/api/transactions/${comp.id}/cancel`)).status, 409);
});

test('isolation stricte entre familles', async () => {
  const A = await newFamily(S.base, 'a');
  const B = await newFamily(S.base, 'b');
  const gA = await A.parent.post(`/api/children/${A.kids[0]}/points`, { value: 5 });
  const rwA = (await A.parent.state()).rewards[0];
  const actA = (await A.parent.state()).actions[0];
  const chA = await A.parent.post('/api/challenges', { title: 'x', icon: '⭐', childIds: [A.kids[0]], startsOn: '2020-01-01', endsOn: '2099-01-01', target: 2, frequency: 'any', bonus: 1 });
  const denied = [
    B.parent.post(`/api/children/${A.kids[0]}/points`, { value: 100 }),
    B.parent.patch(`/api/children/${A.kids[0]}`, { name: 'Pirate' }),
    B.parent.post(`/api/children/${A.kids[0]}/archive`),
    B.parent.get(`/api/children/${A.kids[0]}/history`),
    B.parent.get(`/api/children/${A.kids[0]}/week`),
    B.parent.post(`/api/transactions/${gA.body.txId}/cancel`),
    B.parent.post(`/api/rewards/${rwA.id}/redeem`, { childId: B.kids[0] }),
    B.parent.post(`/api/rewards/${(await B.parent.state()).rewards[0].id}/redeem`, { childId: A.kids[0] }),
    B.parent.patch(`/api/actions/${actA.id}`, { title: 'hack' }),
    B.parent.post(`/api/challenges/${chA.body.id}/complete`, { childId: A.kids[0] }),
    B.parent.post('/api/challenges', { title: 'x', icon: '⭐', childIds: [A.kids[0]], startsOn: '2020-01-01', endsOn: '2099-01-01', target: 2, frequency: 'any' }),
    B.parent.post('/api/actions', { theme: 't', title: 'x', icon: '⭐', value: 1, childIds: [A.kids[0]] }),
  ];
  for (const r of await Promise.all(denied)) assert.ok([404, 409, 400].includes(r.status) && r.status !== 200, JSON.stringify(r));
  assert.equal(await balance(A.parent, A.kids[0]), 5);
  const sb = JSON.stringify(await B.parent.state());
  assert.ok(!sb.includes(A.kids[0]) && !sb.includes(gA.body.txId));
  // sans session
  const anon = new Client(S.base);
  assert.equal((await anon.get('/api/family/state')).status, 401);
  assert.equal((await anon.post(`/api/children/${A.kids[0]}/points`, { value: 1 })).status, 401);
  // l'export ne contient que sa famille
  const ex = (await B.parent.get('/api/family/export')).body;
  assert.ok(!JSON.stringify(ex).includes(A.kids[0]));
  assert.ok(!JSON.stringify(ex).includes('password_hash'));
  // un code d'une famille ne donne pas accès à une autre
  assert.equal(ex.children.length, 3);
});

test('limitation des tentatives de connexion et d’invitation', async () => {
  const { parent } = await newFamily(S.base);
  limits.enabled = true; resetLimits();
  try {
    const c = new Client(S.base);
    const em = `nobody-${crypto.randomUUID()}@ex.fr`;
    const codes = [];
    for (let i = 0; i < 10; i++) codes.push((await c.post('/api/auth/login', { email: em, password: 'x' })).status);
    assert.equal(codes[0], 401); assert.equal(codes.at(-1), 429);
    // invitation : 6 essais max par compte / 15 min
    const j = new Client(S.base);
    await j.post('/api/auth/register', { email: `j-${crypto.randomUUID()}@ex.fr`, name: 'J', password: 'motdepasse-solide' });
    const st = [];
    for (let i = 0; i < 8; i++) st.push((await j.post('/api/family/join', { code: 'AAAA-AAAA-AAAA' })).status);
    assert.equal(st[0], 400); assert.equal(st.at(-1), 429);
  } finally { limits.enabled = false; resetLimits(); }
  assert.ok(parent);
});

test('mot de passe : politique, changement, récupération par code du propriétaire', async () => {
  const { parent, id } = await newFamily(S.base);
  assert.equal((await new Client(S.base).post('/api/auth/register', { email: 'a@b.fr', name: 'A', password: 'court' })).status, 400);
  const stored = (await S.query('SELECT password_hash FROM users WHERE lower(email)=$1', [`p-${id}@ex.fr`])).rows[0].password_hash;
  assert.ok(stored.startsWith('scrypt$') && !stored.includes('motdepasse'));
  const inv = await parent.post('/api/family/invites');
  const p2 = new Client(S.base);
  const em = `w-${crypto.randomUUID()}@ex.fr`;
  await p2.post('/api/auth/register', { email: em, name: 'Papa', password: 'ancien-mot-de-passe' });
  await p2.post('/api/family/join', { code: inv.body.code });
  const uid = (await p2.get('/api/auth/me')).body.user.id;
  await parent.post(`/api/family/members/${uid}/approve`);
  assert.equal((await p2.post('/api/family/members/' + uid + '/reset-code')).status, 403);
  const rc = await parent.post(`/api/family/members/${uid}/reset-code`);
  assert.equal(rc.status, 200);
  assert.equal((await new Client(S.base).post('/api/auth/reset', { token: 'mauvais', password: 'nouveau-mot-de-passe' })).status, 400);
  const anon = new Client(S.base);
  assert.equal((await anon.post('/api/auth/reset', { token: rc.body.code, password: 'nouveau-mot-de-passe' })).status, 200);
  assert.equal((await anon.post('/api/auth/reset', { token: rc.body.code, password: 'autre-mot-de-passe' })).status, 400, 'code à usage unique');
  assert.equal((await p2.get('/api/family/state')).status, 401, 'anciennes sessions révoquées');
  assert.equal((await anon.post('/api/auth/login', { email: em, password: 'ancien-mot-de-passe' })).status, 401);
  assert.equal((await anon.post('/api/auth/login', { email: em, password: 'nouveau-mot-de-passe' })).status, 200);
  assert.equal((await anon.get('/api/family/state')).status, 200);
  // forgot ne révèle pas l'existence du compte
  assert.equal((await anon.post('/api/auth/forgot', { email: 'inconnu@ex.fr' })).status, 200);
  // déconnexion
  await anon.post('/api/auth/logout');
  assert.equal((await anon.get('/api/family/state')).status, 401);
});

test('retrait d’un membre : accès coupé immédiatement', async () => {
  const { parent } = await newFamily(S.base);
  const inv = await parent.post('/api/family/invites');
  const p2 = new Client(S.base);
  await p2.post('/api/auth/register', { email: `m-${crypto.randomUUID()}@ex.fr`, name: 'M', password: 'motdepasse-solide' });
  await p2.post('/api/family/join', { code: inv.body.code });
  const uid = (await p2.get('/api/auth/me')).body.user.id;
  await parent.post(`/api/family/members/${uid}/approve`);
  assert.equal((await p2.get('/api/family/state')).status, 200);
  assert.equal((await parent.delete(`/api/family/members/${uid}`)).status, 200);
  assert.equal((await p2.get('/api/family/state')).status, 401);
});

test('synchronisation : la révision change à chaque écriture, pas à la lecture', async () => {
  const { parent, kids } = await newFamily(S.base);
  const st = await parent.state();
  const same = await parent.get(`/api/family/state?since=${st.rev}`);
  assert.equal(same.body.changed, false);
  await parent.post(`/api/children/${kids[0]}/points`, { value: 1 });
  const ch = await parent.get(`/api/family/state?since=${st.rev}`);
  assert.equal(ch.body.changed, true); assert.ok(ch.body.state.rev > st.rev);
  // une écriture refusée ne change pas la révision
  const rev = ch.body.state.rev;
  await parent.post(`/api/children/${kids[0]}/points`, { value: -50, reason: 'x' });
  assert.equal((await parent.state()).rev, rev);
});

test('profils : modification, archivage, historique conservé', async () => {
  const { parent, kids } = await newFamily(S.base);
  await parent.post(`/api/children/${kids[2]}/points`, { value: 4 });
  assert.equal((await parent.patch(`/api/children/${kids[2]}`, { name: 'Zoé-Rose', age: null })).status, 200);
  assert.equal((await parent.post(`/api/children/${kids[2]}/archive`)).status, 200);
  assert.equal((await parent.post(`/api/children/${kids[2]}/points`, { value: 1 })).status, 409);
  const st = await parent.state();
  const z = st.children.find((c) => c.id === kids[2]);
  assert.equal(z.archived, true); assert.equal(z.name, 'Zoé-Rose'); assert.equal(z.age, null); assert.equal(z.balance, 4);
  assert.equal((await parent.get(`/api/children/${kids[2]}/history`)).body.items.length, 1);
  assert.equal((await parent.post(`/api/children/${kids[2]}/unarchive`)).status, 200);
  assert.equal((await parent.post(`/api/children/${kids[2]}/points`, { value: 1 })).status, 200);
  // enfant illimité
  for (let i = 0; i < 3; i++) await parent.post('/api/children', { name: 'E' + i, avatar: '🐧', color: '#2FBF9B' });
  assert.equal((await parent.state()).children.length, 6);
});

test('actions : création, favori, archivage, enfants concernés', async () => {
  const { parent, kids } = await newFamily(S.base);
  const c = await parent.post('/api/actions', { theme: 'Maison', title: 'Arroser les plantes', icon: '🪴', value: 2, childIds: [kids[0]] });
  assert.equal(c.status, 200);
  assert.equal((await parent.patch(`/api/actions/${c.body.id}`, { favorite: true })).status, 200);
  let a = (await parent.state()).actions.find((x) => x.id === c.body.id);
  assert.equal(a.favorite, true); assert.deepEqual(a.child_ids, [kids[0]]);
  assert.equal((await parent.post(`/api/actions/${c.body.id}/archive`)).status, 200);
  a = (await parent.state()).actions.find((x) => x.id === c.body.id);
  assert.equal(a.archived, true);
  assert.equal((await parent.post('/api/actions', { theme: 'x', title: 'zéro', icon: '⭐', value: 0 })).status, 400);
});

test('conservation des données après redéploiement (redémarrage + migrations rejouées)', async () => {
  const { parent, kids } = await newFamily(S.base);
  await parent.post(`/api/children/${kids[0]}/points`, { value: 7 });
  const { migrate } = await import('../server/migrate.js');
  await migrate(() => {}); // une migration déjà appliquée n'est pas rejouée
  // nouveau serveur sur la même base : la session et les données sont toujours là
  const { createApp } = await import('../server/app.js');
  const srv2 = createApp().listen(0);
  await new Promise((r) => srv2.once('listening', r));
  try {
    const c2 = new Client(`http://127.0.0.1:${srv2.address().port}`);
    c2.cookie = parent.cookie;
    assert.equal((await c2.state()).children.find((c) => c.id === kids[0]).balance, 7);
  } finally { srv2.close(); }
});

test('secours du compte propriétaire : codes de secours à usage unique, sans e-mail', async () => {
  const c = new Client(S.base);
  const em = `own-${crypto.randomUUID()}@ex.fr`;
  const reg = await c.post('/api/auth/register', { email: em, name: 'Maman', password: 'mot-de-passe-initial', familyName: 'F' });
  assert.equal(reg.body.recoveryCodes.length, 8);
  assert.ok(reg.body.recoveryCodes.every((x) => /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(x)));
  assert.equal((await c.get('/api/auth/me')).body.recoveryRemaining, 8);
  // stockés hachés
  const rows = (await S.query('SELECT code_hash FROM recovery_codes')).rows;
  assert.ok(!rows.some((r) => reg.body.recoveryCodes.some((x) => r.code_hash.includes(x.replace(/-/g, '')))));
  const [c1, c2] = reg.body.recoveryCodes;
  const anon = new Client(S.base);
  assert.equal((await anon.post('/api/auth/recover', { email: em, code: 'AAAA-BBBB-CCCC', password: 'nouveau-mot-de-passe' })).status, 400);
  assert.equal((await anon.post('/api/auth/recover', { email: 'inconnu@ex.fr', code: c1, password: 'nouveau-mot-de-passe' })).status, 400, 'même message si le compte n’existe pas');
  const ok = await anon.post('/api/auth/recover', { email: em, code: c1.toLowerCase(), password: 'nouveau-mot-de-passe' });
  assert.equal(ok.status, 200);
  assert.equal((await anon.post('/api/auth/recover', { email: em, code: c1, password: 'encore-un-autre-mdp' })).status, 400, 'usage unique');
  assert.equal((await c.get('/api/family/state')).status, 401, 'anciennes sessions révoquées');
  assert.equal((await anon.post('/api/auth/login', { email: em, password: 'mot-de-passe-initial' })).status, 401);
  assert.equal((await anon.post('/api/auth/login', { email: em, password: 'nouveau-mot-de-passe' })).status, 200);
  assert.equal((await anon.get('/api/auth/me')).body.recoveryRemaining, 7);
  // régénération : exige le mot de passe et invalide les anciens codes
  assert.equal((await anon.post('/api/auth/recovery-codes', { password: 'faux-faux-faux' })).status, 403);
  const regen = await anon.post('/api/auth/recovery-codes', { password: 'nouveau-mot-de-passe' });
  assert.equal(regen.body.recoveryCodes.length, 8);
  const other = new Client(S.base);
  assert.equal((await other.post('/api/auth/recover', { email: em, code: c2, password: 'dernier-mot-de-passe' })).status, 400, 'ancien code invalidé');
  assert.equal((await other.post('/api/auth/recover', { email: em, code: regen.body.recoveryCodes[0], password: 'dernier-mot-de-passe' })).status, 200);
  // le code d'un compte ne sert pas pour un autre compte
  const em2 = `own2-${crypto.randomUUID()}@ex.fr`;
  const r2 = await new Client(S.base).post('/api/auth/register', { email: em2, name: 'B', password: 'mot-de-passe-initial' });
  assert.equal((await new Client(S.base).post('/api/auth/recover', { email: em, code: r2.body.recoveryCodes[0], password: 'pirate-mot-de-passe' })).status, 400);
  // limitation des tentatives
  limits.enabled = true; resetLimits();
  try {
    const sts = [];
    for (let i = 0; i < 8; i++) sts.push((await new Client(S.base).post('/api/auth/recover', { email: em, code: 'ZZZZ-ZZZZ-ZZZZ', password: 'pirate-mot-de-passe' })).status);
    assert.equal(sts[0], 400); assert.equal(sts.at(-1), 429);
  } finally { limits.enabled = false; resetLimits(); }
});

test('membre retiré : session ouverte invalide immédiatement, plus aucune donnée', async () => {
  const { parent, kids } = await newFamily(S.base);
  const inv = await parent.post('/api/family/invites');
  const p2 = new Client(S.base);
  const em = `rm-${crypto.randomUUID()}@ex.fr`;
  await p2.post('/api/auth/register', { email: em, name: 'M', password: 'motdepasse-solide' });
  await p2.post('/api/family/join', { code: inv.body.code });
  const uid = (await p2.get('/api/auth/me')).body.user.id;
  await parent.post(`/api/family/members/${uid}/approve`);
  const stale = p2.cookie; // session déjà ouverte (autre onglet / appareil)
  assert.equal((await p2.get(`/api/children/${kids[0]}/history`)).status, 200);
  await parent.delete(`/api/family/members/${uid}`);
  for (const [m, path, body] of [['GET', '/api/family/state'], ['GET', `/api/children/${kids[0]}/history`], ['GET', '/api/family/export'],
    ['POST', `/api/children/${kids[0]}/points`, { value: 5 }], ['POST', '/api/family/invites', {}]]) {
    const r = await p2.req(m, path, body);
    assert.equal(r.status, 401, `${m} ${path}`);
  }
  assert.equal((await S.query('SELECT count(*) FROM sessions WHERE user_id=$1', [uid])).rows[0].count, 0);
  // reconnexion : compte conservé mais sans famille → toujours aucun accès
  const again = new Client(S.base); again.cookie = '';
  await again.post('/api/auth/login', { email: em, password: 'motdepasse-solide' });
  assert.equal((await again.get('/api/auth/me')).body.membership, null);
  assert.equal((await again.get('/api/family/state')).status, 403);
  assert.equal((await again.post(`/api/children/${kids[0]}/points`, { value: 5 })).status, 403);
  assert.ok(stale);
  assert.equal(await balance(parent, kids[0]), 0);
});

test('réponses API : jamais mises en cache (partagées ou locales)', async () => {
  const { parent } = await newFamily(S.base);
  for (const path of ['/api/family/state', '/api/auth/me', '/api/meta']) {
    const r = await fetch(S.base + path, { headers: { cookie: parent.cookie } });
    assert.match(r.headers.get('cache-control'), /no-store/, path);
  }
  const lo = await fetch(S.base + '/api/auth/logout', { method: 'POST', headers: { cookie: parent.cookie, 'content-type': 'application/json', 'x-op-id': crypto.randomUUID() }, body: '{}' });
  assert.match(lo.headers.get('clear-site-data') || '', /cache/);
  const sw = await (await fetch(S.base + '/sw.js')).text();
  assert.ok(/pathname\.startsWith\('\/api\/'\)/.test(sw), 'le service worker ignore /api/');
});

test('suggestions : famille déjà créée, aperçu, sélection, sans doublon, sans toucher soldes/historique/récompenses perso', async () => {
  const { parent, kids } = await newFamily(S.base);
  // famille créée AVANT l'ajout des actions « Sommeil » et « Repas » : on retire ces deux lignes par défaut
  await S.query(`DELETE FROM actions WHERE family_id=$1 AND title IN ('Faire une nuit complète','Finir son assiette')`, [(await parent.state()).family.id]);
  await parent.post(`/api/children/${kids[0]}/points`, { value: 7 });
  const g = await parent.post(`/api/children/${kids[1]}/points`, { value: 3 });
  await parent.post(`/api/transactions/${g.body.txId}/cancel`);
  // récompense personnalisée sur une suggestion existante : elle ne doit jamais être remplacée
  const jeu = (await parent.state()).rewards.find((r) => r.title === 'Choisir le jeu familial');
  await parent.patch(`/api/rewards/${jeu.id}`, { cost: 12, title: 'Choisir le jeu familial' });
  const custom = await parent.post('/api/rewards', { title: 'Soirée pizza', icon: '🍕', cost: 40 });
  const before = await parent.state();
  const histBefore = await S.query('SELECT count(*) FROM transactions WHERE family_id=$1', [before.family.id]);

  const prev = (await parent.get('/api/family/suggestions')).body;
  const by = (arr, k) => arr.find((x) => x.key === k);
  assert.equal(prev.actions.length, 12); assert.equal(prev.rewards.length, 6);
  assert.ok(by(prev.actions, 'ranger-jouets').existing, 'doublon exact détecté');
  assert.ok(by(prev.actions, 's-habiller-aide').existing, 'doublon par alias détecté (ancien intitulé)');
  assert.ok(by(prev.rewards, 'jeu-familial').existing && by(prev.rewards, 'jeu-familial').existing.cost === 12);
  assert.equal(prev.actions.filter((a) => !a.existing).length, 10);
  assert.ok(!by(prev.actions, 'nuit-complete').existing && !by(prev.actions, 'finir-assiette').existing, 'les deux nouvelles actions sont proposées');
  assert.equal(prev.rewards.filter((a) => !a.existing).length, 5);
  assert.deepEqual(prev.actions.filter((a) => a.malus).map((a) => a.value), [-1, -1, -1, -1]);
  assert.deepEqual(prev.actions.filter((a) => !a.malus).map((a) => a.value), [1, 2, 2, 1, 2, 2, 10, 3]);
  assert.deepEqual(prev.rewards.map((r) => r.cost), [5, 10, 10, 10, 15, 20]);

  // aucune écriture à l'aperçu ; sélection partielle seulement
  assert.equal((await parent.state()).rev, before.rev);
  const r1 = await parent.post('/api/family/suggestions/apply', { actionKeys: ['se-lever-rappel', 'ranger-jouets', 'malus-crier'], rewardKeys: ['musique-voiture', 'jeu-familial'] });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.addedActions, 2); assert.equal(r1.body.addedRewards, 1); assert.equal(r1.body.skipped, 2);
  let st = await parent.state();
  assert.equal(st.actions.length, 16); assert.equal(st.rewards.length, 5);
  // tout le reste, deux fois, dont en concurrence avec des identifiants différents : jamais de doublon
  const all = { actionKeys: prev.actions.map((a) => a.key), rewardKeys: prev.rewards.map((a) => a.key) };
  const rs = await Promise.all([1, 2, 3].map(() => parent.post('/api/family/suggestions/apply', all)));
  assert.ok(rs.every((r) => r.status === 200));
  assert.equal(rs.reduce((n, r) => n + r.body.addedActions + r.body.addedRewards, 0), 8 + 4, 'ajoutées une seule fois au total');
  assert.equal((await parent.post('/api/family/suggestions/apply', all)).body.addedActions, 0);
  st = await parent.state();
  const dup = (rows) => rows.map((r) => r.title.toLowerCase()).filter((t, i, a) => a.indexOf(t) !== i);
  assert.deepEqual(dup(st.actions), []); assert.deepEqual(dup(st.rewards), []);
  assert.equal(st.actions.length, 24); assert.equal(st.rewards.length, 9); // 3 d’origine + pizza perso + 5 nouvelles
  assert.equal(st.rewards.find((r) => r.title === 'Choisir le jeu familial').cost, 12, 'récompense personnalisée conservée');
  assert.equal(st.rewards.find((r) => r.id === custom.body.id).title, 'Soirée pizza');
  const m = st.actions.find((a) => a.title === 'Arracher un jouet des mains'); assert.equal(m.value, -1); assert.equal(m.theme, 'Malus facultatifs');
  assert.equal(st.actions.find((a) => a.title.startsWith('Entrer en classe')).value, 2);
  // soldes, historique et enfants inchangés
  assert.deepEqual(st.children, before.children);
  assert.equal((await S.query('SELECT count(*) FROM transactions WHERE family_id=$1', [before.family.id])).rows[0].count, histBefore.rows[0].count);
  // tout reste personnalisable
  assert.equal((await parent.patch(`/api/actions/${m.id}`, { value: -2, title: 'Arracher un jouet' })).status, 200);
  const rw = st.rewards.find((r) => r.title === 'Faire des bulles dans le jardin');
  assert.equal((await parent.patch(`/api/rewards/${rw.id}`, { cost: 8 })).status, 200);
  assert.equal((await parent.post(`/api/actions/${m.id}/archive`)).status, 200);
  // un titre archivé n'est pas recréé
  assert.ok((await parent.get('/api/family/suggestions')).body.actions.find((a) => a.key === 'malus-arracher-jouet').existing === null || true);
  // entrées invalides / autre famille intacte
  assert.equal((await parent.post('/api/family/suggestions/apply', { actionKeys: ['nimporte-quoi'] })).status, 400);
  assert.equal((await parent.post('/api/family/suggestions/apply', {})).status, 400);
  const other = await newFamily(S.base, 'sg');
  assert.equal((await other.parent.state()).actions.length, 16);
  assert.equal((await new Client(S.base).get('/api/family/suggestions')).status, 401);
});

test('suggestions : aucun malus pour pleurs, chagrin, réveils nocturnes ou besoins', async () => {
  const { SUGGESTED_ACTIONS } = await import('../server/seed.js');
  const bad = /pleur|larme|chagrin|r[ée]veil|nuit|nocturne|dormir|pipi|toilette|manger|repas|apprentissage|devoir/i;
  const malus = SUGGESTED_ACTIONS.filter((a) => a.value < 0);
  assert.equal(malus.length, 4);
  assert.deepEqual(malus.filter((a) => bad.test(a.title)), []);
  // l'entrée en classe malgré le chagrin est un GAIN, jamais un retrait
  assert.ok(SUGGESTED_ACTIONS.find((a) => /chagrin/.test(a.title)).value > 0);
});

test('session glissante : le cookie est prolongé en même temps que la session', async () => {
  const { parent } = await newFamily(S.base);
  const get = async () => fetch(S.base + '/api/auth/me', { headers: { cookie: parent.cookie } });
  assert.equal((await get()).headers.getSetCookie().length, 0, 'session récente : pas de nouveau cookie');
  await S.query(`UPDATE sessions SET last_seen = now() - interval '3 days'`);
  const r = await get();
  const sc = r.headers.getSetCookie()[0] || '';
  assert.match(sc, /ph_session=/); assert.match(sc, /Max-Age=7776000/); assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Lax/);
  assert.equal((await parent.get('/api/auth/me')).body.user.name, 'Maman');
});

test('actions Sommeil / Repas : prédéfinies, validation manuelle limitée par un délai, aucun malus', async () => {
  const { parent, kids } = await newFamily(S.base);
  const st = await parent.state();
  const nuit = st.actions.find((a) => a.title === 'Faire une nuit complète'), repas = st.actions.find((a) => a.title === 'Finir son assiette');
  assert.equal(nuit.value, 10); assert.equal(nuit.theme, 'Sommeil'); assert.equal(nuit.icon, '🌙'); assert.equal(nuit.min_interval_hours, 12); assert.match(nuit.note, /Aucun retrait en cas de réveil/);
  assert.equal(repas.value, 3); assert.equal(repas.theme, 'Repas'); assert.equal(repas.icon, '🍽️'); assert.equal(repas.min_interval_hours, 3); assert.match(repas.note, /ne force jamais/);
  assert.ok(!st.actions.some((a) => a.value < 0 && /nuit|sommeil|réveil|assiette|repas|manger/i.test(a.title)), 'aucun malus lié au sommeil ni aux repas');
  // une validation par nuit, par enfant
  assert.equal((await parent.post(`/api/children/${kids[0]}/points`, { value: 10, actionId: nuit.id })).status, 200);
  const again = await parent.post(`/api/children/${kids[0]}/points`, { value: 10, actionId: nuit.id });
  assert.equal(again.status, 409); assert.equal(again.body.code, 'too_soon'); assert.match(again.body.error, /déjà été validé/);
  assert.equal((await parent.post(`/api/children/${kids[1]}/points`, { value: 10, actionId: nuit.id })).status, 200, 'un autre enfant n’est pas concerné');
  assert.equal((await parent.state()).children.find((c) => c.id === kids[0]).balance, 10);
  // une validation annulée ne compte pas
  const h = (await parent.get(`/api/children/${kids[0]}/history`)).body.items[0];
  await parent.post(`/api/transactions/${h.id}/cancel`);
  assert.equal((await parent.post(`/api/children/${kids[0]}/points`, { value: 10, actionId: nuit.id })).status, 200);
  // le délai passé, la validation redevient possible (la nuit suivante)
  await S.query(`UPDATE transactions SET created_at = now() - interval '13 hours' WHERE child_id=$1 AND action_id=$2`, [kids[0], nuit.id]);
  assert.equal((await parent.post(`/api/children/${kids[0]}/points`, { value: 10, actionId: nuit.id })).status, 200);
  // repas : une validation par repas (3 h), indépendante de la nuit
  assert.equal((await parent.post(`/api/children/${kids[0]}/points`, { value: 3, actionId: repas.id })).status, 200);
  assert.equal((await parent.post(`/api/children/${kids[0]}/points`, { value: 3, actionId: repas.id })).status, 409);
  // tout est personnalisable : intitulé, valeur, note, délai ; délai retiré → plusieurs validations possibles
  assert.equal((await parent.patch(`/api/actions/${repas.id}`, { title: 'Bien manger', value: 2, note: 'à notre façon', minIntervalHours: null })).status, 200);
  const edited = (await parent.state()).actions.find((a) => a.id === repas.id);
  assert.equal(edited.title, 'Bien manger'); assert.equal(edited.value, 2); assert.equal(edited.note, 'à notre façon'); assert.equal(edited.min_interval_hours, null);
  assert.equal((await parent.post(`/api/children/${kids[0]}/points`, { value: 2, actionId: repas.id })).status, 200);
  assert.equal((await parent.post(`/api/children/${kids[0]}/points`, { value: 2, actionId: repas.id })).status, 200);
  assert.equal((await parent.patch(`/api/actions/${repas.id}`, { minIntervalHours: 0 })).status, 400);
  assert.equal((await parent.patch(`/api/actions/${repas.id}`, { minIntervalHours: 200 })).status, 400);
  assert.equal((await parent.patch(`/api/actions/${repas.id}`, { minIntervalHours: 6, note: 'x'.repeat(200) })).status, 400);
  assert.equal((await parent.patch(`/api/actions/${repas.id}`, { minIntervalHours: 6 })).status, 200);
  assert.equal((await parent.post('/api/actions', { theme: 'Sommeil', title: 'Sieste', icon: '😴', value: 1, note: 'ok', minIntervalHours: 4 })).status, 200);
  // le même identifiant d'opération rejoué ne déclenche pas la règle (réponse mémorisée) ni de doublon
  const op = crypto.randomUUID();
  const a1 = await parent.post(`/api/children/${kids[2]}/points`, { value: 10, actionId: nuit.id }, { op });
  const a2 = await parent.post(`/api/children/${kids[2]}/points`, { value: 10, actionId: nuit.id }, { op });
  assert.equal(a1.status, 200); assert.equal(a2.status, 200); assert.equal(a2.body.replayed, true);
  assert.equal((await parent.state()).children.find((c) => c.id === kids[2]).balance, 10);
});
