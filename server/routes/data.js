import { Router } from 'express';
import { query } from '../db.js';
import { config } from '../config.js';
import { HttpError, wrap, str, int, date, uuid, uuidList, bad } from '../util.js';
import { requireParent } from '../auth.js';
import { applyTx, cancelTransaction, cancelCompletion, completeChallenge, redeem } from '../points.js';
import { mutate } from './helpers.js';

export const dataRouter = Router();
dataRouter.use(requireParent);

const AVATARS = ['🦊', '🐻', '🐰', '🐼', '🦁', '🐯', '🐸', '🐵', '🦄', '🐙', '🐧', '🐨', '🦉', '🐶', '🐱', '🐢', '🐘', '🦒', '🐬', '🦋'];
const COLORS = ['#FF8A3D', '#F5617A', '#8E6CEF', '#3BA4F5', '#2FBF9B', '#F2B705', '#E8590C', '#6C8E3A'];
const icon = (v) => str(v, 'Icône', { required: true, max: 8 });

async function ownChild(c, fam, id, { active = true } = {}) {
  const r = (await c.query('SELECT * FROM children WHERE id=$1 AND family_id=$2', [uuid(id, 'enfant'), fam])).rows[0];
  if (!r) throw new HttpError(404, 'Enfant introuvable');
  if (active && r.archived_at) throw new HttpError(409, 'Profil archivé');
  return r;
}
async function checkChildIds(c, fam, ids) {
  if (!ids.length) return;
  const n = (await c.query('SELECT count(*) AS n FROM children WHERE family_id=$1 AND id = ANY($2::uuid[])', [fam, ids])).rows[0].n;
  if (n !== ids.length) throw new HttpError(404, 'Enfant introuvable');
}

// ---- Enfants ----
function childFields(b, partial) {
  const o = {};
  if (!partial || b.name !== undefined) o.name = str(b.name, 'Prénom', { required: true, max: 30 });
  if (!partial || b.avatar !== undefined) { if (!AVATARS.includes(b.avatar)) throw bad('Avatar invalide'); o.avatar = b.avatar; }
  if (!partial || b.color !== undefined) { if (!COLORS.includes(b.color)) throw bad('Couleur invalide'); o.color = b.color; }
  if (!partial || b.age !== undefined) o.age = int(b.age, 'Âge', { min: 0, max: 18, required: false });
  return o;
}
dataRouter.post('/children', mutate(async (req, c, fam) => {
  const o = childFields(req.body || {}, false);
  const r = (await c.query('INSERT INTO children(family_id, name, avatar, color, age) VALUES ($1,$2,$3,$4,$5) RETURNING id', [fam, o.name, o.avatar, o.color, o.age]));
  return { id: r.rows[0].id };
}));
dataRouter.patch('/children/:id', mutate(async (req, c, fam) => {
  const ch = await ownChild(c, fam, req.params.id, { active: false });
  const o = childFields(req.body || {}, true);
  await c.query('UPDATE children SET name=$2, avatar=$3, color=$4, age=$5 WHERE id=$1',
    [ch.id, o.name ?? ch.name, o.avatar ?? ch.avatar, o.color ?? ch.color, 'age' in o ? o.age : ch.age]);
}));
dataRouter.post('/children/:id/archive', mutate(async (req, c, fam) => {
  const ch = await ownChild(c, fam, req.params.id, { active: false });
  await c.query('UPDATE children SET archived_at = now() WHERE id=$1', [ch.id]);
}));
dataRouter.post('/children/:id/unarchive', mutate(async (req, c, fam) => {
  const ch = await ownChild(c, fam, req.params.id, { active: false });
  await c.query('UPDATE children SET archived_at = NULL WHERE id=$1', [ch.id]);
}));

// ---- Points ----
// value > 0 : gain (ou bonus exceptionnel) ; value < 0 : retrait (motif obligatoire si libre)
dataRouter.post('/children/:id/points', mutate(async (req, c, fam) => {
  const b = req.body || {};
  const ch = await ownChild(c, fam, req.params.id);
  const value = int(b.value, 'Valeur', { min: -1000, max: 1000 });
  if (value === 0) throw bad('Valeur : entier différent de 0');
  let reason = str(b.reason, 'Motif', { max: 120 });
  let actionId = null;
  if (b.actionId) {
    const a = (await c.query('SELECT * FROM actions WHERE id=$1 AND family_id=$2', [uuid(b.actionId, 'action'), fam])).rows[0];
    if (!a) throw new HttpError(404, 'Action introuvable');
    if (Math.sign(a.value) !== Math.sign(value)) throw bad('Le signe ne correspond pas à l’action');
    actionId = a.id;
    reason = reason || a.title;
  }
  const type = value < 0 ? 'malus' : b.bonus ? 'bonus' : 'gain';
  if (!reason) {
    if (type === 'malus') throw bad('Indique un motif pour retirer des points');
    reason = type === 'bonus' ? 'Bonus exceptionnel' : 'Points offerts';
  }
  const r = await applyTx(c, { familyId: fam, childId: ch.id, value, type, reason, authorId: req.user.id, actionId });
  return { txId: r.tx.id, balance: r.balance, childId: ch.id, childName: ch.name, value, type };
}));

dataRouter.post('/transactions/:id/cancel', mutate(async (req, c, fam) => {
  const t = (await c.query('SELECT child_id FROM transactions WHERE id=$1 AND family_id=$2', [uuid(req.params.id, 'mouvement'), fam])).rows[0];
  if (!t) throw new HttpError(404, 'Mouvement introuvable');
  await cancelTransaction(c, fam, req.user.id, req.params.id);
  const bal = (await c.query('SELECT balance FROM children WHERE id=$1', [t.child_id])).rows[0].balance;
  return { childId: t.child_id, balance: bal };
}));

// ---- Historique & bilan ----
const TYPES = ['gain', 'malus', 'bonus', 'reward', 'cancel'];
dataRouter.get('/children/:id/history', wrap(async (req, res) => {
  const ch = await ownChild({ query }, req.member.familyId, req.params.id, { active: false });
  const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
  const p = [ch.id, limit + 1];
  let where = '';
  if (req.query.type) {
    if (!TYPES.includes(req.query.type)) throw bad('Type invalide');
    p.push(req.query.type); where += ` AND t.type = $${p.length}`;
  }
  if (req.query.before) {
    const d = new Date(String(req.query.before));
    if (Number.isNaN(d.getTime())) throw bad('Date invalide');
    p.push(d.toISOString()); where += ` AND t.created_at < $${p.length}`;
  }
  const rows = (await query(
    `SELECT t.id, t.value, t.type, t.reason, t.created_at, t.balance_after, t.action_id, t.challenge_id, t.redemption_id,
            t.reverses_id, u.name AS author,
            EXISTS (SELECT 1 FROM transactions x WHERE x.reverses_id = t.id) AS reversed
       FROM transactions t LEFT JOIN users u ON u.id = t.author_id
      WHERE t.child_id = $1 ${where} ORDER BY t.created_at DESC, t.id DESC LIMIT $2`, p)).rows;
  res.json({ items: rows.slice(0, limit), more: rows.length > limit });
}));

// Bilan d'une semaine (lundi → dimanche, fuseau APP_TZ). offset = 0 semaine courante, -1 précédente…
// Les compensations sont rattachées au type du mouvement d'origine : une annulation efface son effet du bilan.
dataRouter.get('/children/:id/week', wrap(async (req, res) => {
  const ch = await ownChild({ query }, req.member.familyId, req.params.id, { active: false });
  const offset = Math.min(0, Math.max(-520, int(req.query.offset ?? 0, 'Semaine', { min: -520, max: 0 })));
  const r = (await query(
    `WITH w AS (
       SELECT date_trunc('week', now() AT TIME ZONE $2) + make_interval(weeks => $3) AS s
     )
     SELECT (SELECT s FROM w)::date AS start_day, ((SELECT s FROM w) + interval '6 days')::date AS end_day,
       COALESCE(SUM(CASE WHEN e.etype IN ('gain','bonus') THEN t.value END), 0) AS gained,
       COALESCE(-SUM(CASE WHEN e.etype = 'malus' THEN t.value END), 0) AS removed,
       COALESCE(-SUM(CASE WHEN e.etype = 'reward' THEN t.value END), 0) AS used
     FROM transactions t
     LEFT JOIN transactions o ON o.id = t.reverses_id
     CROSS JOIN LATERAL (SELECT COALESCE(o.type, t.type) AS etype) e
     WHERE t.child_id = $1
       AND t.created_at >= ((SELECT s FROM w) AT TIME ZONE $2)
       AND t.created_at <  (((SELECT s FROM w) + interval '7 days') AT TIME ZONE $2)`,
    [ch.id, config.timezone, offset])).rows[0];
  res.json({ childId: ch.id, available: ch.balance, offset, ...r });
}));

// ---- Actions ----
function actionFields(b) {
  const value = int(b.value, 'Valeur', { min: -100, max: 100 });
  if (value === 0) throw bad('Valeur : entier différent de 0');
  return {
    theme: str(b.theme, 'Thème', { required: true, max: 40 }),
    title: str(b.title, 'Titre', { required: true, max: 80 }),
    icon: icon(b.icon), value, favorite: !!b.favorite, childIds: uuidList(b.childIds),
  };
}
dataRouter.post('/actions', mutate(async (req, c, fam) => {
  const o = actionFields(req.body || {});
  await checkChildIds(c, fam, o.childIds);
  const r = await c.query(
    `INSERT INTO actions(family_id, theme, title, icon, value, favorite, child_ids, sort)
     VALUES ($1,$2,$3,$4,$5,$6,$7, (SELECT COALESCE(max(sort),0)+1 FROM actions WHERE family_id=$1)) RETURNING id`,
    [fam, o.theme, o.title, o.icon, o.value, o.favorite, o.childIds]);
  return { id: r.rows[0].id };
}));
dataRouter.patch('/actions/:id', mutate(async (req, c, fam) => {
  const a = (await c.query('SELECT * FROM actions WHERE id=$1 AND family_id=$2', [uuid(req.params.id, 'action'), fam])).rows[0];
  if (!a) throw new HttpError(404, 'Action introuvable');
  const b = req.body || {};
  // mise à jour partielle (ex. favori seul)
  const merged = {
    theme: b.theme ?? a.theme, title: b.title ?? a.title, icon: b.icon ?? a.icon, value: b.value ?? a.value,
    favorite: b.favorite ?? a.favorite, childIds: b.childIds ?? a.child_ids,
  };
  const o = actionFields(merged);
  await checkChildIds(c, fam, o.childIds);
  await c.query('UPDATE actions SET theme=$2,title=$3,icon=$4,value=$5,favorite=$6,child_ids=$7 WHERE id=$1',
    [a.id, o.theme, o.title, o.icon, o.value, o.favorite, o.childIds]);
}));
for (const [path, val] of [['archive', 'now()'], ['unarchive', 'NULL']]) {
  dataRouter.post(`/actions/:id/${path}`, mutate(async (req, c, fam) => {
    const r = await c.query(`UPDATE actions SET archived_at=${val} WHERE id=$1 AND family_id=$2`, [uuid(req.params.id, 'action'), fam]);
    if (!r.rowCount) throw new HttpError(404, 'Action introuvable');
  }));
}

// ---- Défis ----
dataRouter.post('/challenges', mutate(async (req, c, fam) => {
  const b = req.body || {};
  const childIds = uuidList(b.childIds);
  if (!childIds.length) throw bad('Choisis au moins un enfant');
  await checkChildIds(c, fam, childIds);
  const collective = !!b.collective;
  if (collective && childIds.length < 2) throw bad('Un défi collectif demande au moins deux enfants');
  let actionId = null;
  if (b.actionId) {
    const a = (await c.query('SELECT value FROM actions WHERE id=$1 AND family_id=$2', [uuid(b.actionId, 'action'), fam])).rows[0];
    if (!a) throw new HttpError(404, 'Action introuvable');
    if (a.value < 0) throw bad('Choisis une action positive');
    actionId = b.actionId;
  }
  const starts = date(b.startsOn, 'Début'), ends = date(b.endsOn, 'Fin');
  if (ends < starts) throw bad('La fin doit suivre le début');
  const frequency = b.frequency === 'any' ? 'any' : 'daily';
  const r = await c.query(
    `INSERT INTO challenges(family_id,title,icon,action_id,collective,child_ids,starts_on,ends_on,target,frequency,bonus,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [fam, str(b.title, 'Titre', { required: true, max: 80 }), icon(b.icon), actionId, collective, childIds, starts, ends,
      int(b.target, 'Réalisations', { min: 1, max: 100 }), frequency, int(b.bonus ?? 0, 'Bonus', { min: 0, max: 500 }), req.user.id]);
  return { id: r.rows[0].id };
}));
dataRouter.post('/challenges/:id/archive', mutate(async (req, c, fam) => {
  const r = await c.query('UPDATE challenges SET archived_at=now() WHERE id=$1 AND family_id=$2', [uuid(req.params.id, 'défi'), fam]);
  if (!r.rowCount) throw new HttpError(404, 'Défi introuvable');
}));
dataRouter.post('/challenges/:id/complete', mutate(async (req, c, fam) => {
  const childId = req.body?.childId ? uuid(req.body.childId, 'enfant') : null;
  const r = await completeChallenge(c, fam, req.user.id, uuid(req.params.id, 'défi'), childId);
  const firstTx = r.txIds[0] || null;
  return { ...r, txId: firstTx };
}));
dataRouter.post('/completions/:eventId/cancel', mutate(async (req, c, fam) => {
  const k = (await c.query('SELECT tx_id FROM challenge_completions WHERE event_id=$1 AND family_id=$2 LIMIT 1', [uuid(req.params.eventId, 'validation'), fam])).rows[0];
  if (!k) throw new HttpError(404, 'Validation introuvable');
  await cancelCompletion(c, fam, req.user.id, req.params.eventId);
}));

// ---- Récompenses ----
function rewardFields(b) {
  return { title: str(b.title, 'Titre', { required: true, max: 80 }), icon: icon(b.icon),
    cost: int(b.cost, 'Coût', { min: 1, max: 1000 }), childIds: uuidList(b.childIds) };
}
dataRouter.post('/rewards', mutate(async (req, c, fam) => {
  const o = rewardFields(req.body || {});
  await checkChildIds(c, fam, o.childIds);
  const r = await c.query('INSERT INTO rewards(family_id,title,icon,cost,child_ids) VALUES ($1,$2,$3,$4,$5) RETURNING id', [fam, o.title, o.icon, o.cost, o.childIds]);
  return { id: r.rows[0].id };
}));
dataRouter.patch('/rewards/:id', mutate(async (req, c, fam) => {
  const a = (await c.query('SELECT * FROM rewards WHERE id=$1 AND family_id=$2', [uuid(req.params.id, 'récompense'), fam])).rows[0];
  if (!a) throw new HttpError(404, 'Récompense introuvable');
  const b = req.body || {};
  const o = rewardFields({ title: b.title ?? a.title, icon: b.icon ?? a.icon, cost: b.cost ?? a.cost, childIds: b.childIds ?? a.child_ids });
  await checkChildIds(c, fam, o.childIds);
  await c.query('UPDATE rewards SET title=$2,icon=$3,cost=$4,child_ids=$5 WHERE id=$1', [a.id, o.title, o.icon, o.cost, o.childIds]);
}));
dataRouter.post('/rewards/:id/archive', mutate(async (req, c, fam) => {
  const r = await c.query('UPDATE rewards SET archived_at=now() WHERE id=$1 AND family_id=$2', [uuid(req.params.id, 'récompense'), fam]);
  if (!r.rowCount) throw new HttpError(404, 'Récompense introuvable');
}));
dataRouter.post('/rewards/:id/redeem', mutate(async (req, c, fam) => {
  const ch = await ownChild(c, fam, req.body?.childId);
  const r = await redeem(c, fam, req.user.id, uuid(req.params.id, 'récompense'), ch.id);
  return { ...r, childId: ch.id };
}));
dataRouter.post('/redemptions/:id/done', mutate(async (req, c, fam) => {
  const r = await c.query(`UPDATE redemptions SET status='done', done_at=now() WHERE id=$1 AND family_id=$2 AND status='todo'`, [uuid(req.params.id, 'échange'), fam]);
  if (!r.rowCount) throw new HttpError(409, 'Cet échange n’est plus à réaliser');
}));
dataRouter.post('/redemptions/:id/cancel', mutate(async (req, c, fam) => {
  const red = (await c.query('SELECT * FROM redemptions WHERE id=$1 AND family_id=$2 FOR UPDATE', [uuid(req.params.id, 'échange'), fam])).rows[0];
  if (!red) throw new HttpError(404, 'Échange introuvable');
  if (red.status !== 'todo') throw new HttpError(409, red.status === 'done' ? 'Déjà réalisé : annulation impossible' : 'Déjà annulé');
  await cancelTransaction(c, fam, req.user.id, red.tx_id); // rembourse une seule fois (index unique reverses_id)
}));

export const META = { AVATARS, COLORS };
