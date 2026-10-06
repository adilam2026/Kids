import { Router } from 'express';
import { query, withTx, getPool } from '../db.js';
import { HttpError, wrap, str, hit, uuid, intList } from '../util.js';
import { requireUser, requireParent, requireOwner, sha256, randomToken, randomCode, normalizeCode, prettyCode } from '../auth.js';
import { loadState } from '../state.js';
import { mutate } from './helpers.js';
import { suggestionStatus, SUGGESTED_ACTIONS, SUGGESTED_REWARDS } from '../seed.js';

export const familyRouter = Router();
const INVITE_HOURS = 48;
const newCode = () => randomCode(12);
const normalize = normalizeCode;
const pretty = prettyCode;

// ---- Rejoindre avec un code : crée seulement une demande, aucun accès aux données ----
familyRouter.post('/join', requireUser, wrap(async (req, res) => {
  hit(`join:u:${req.user.id}`, 6, 15 * 60_000);
  hit(`join:ip:${req.ip}`, 30, 15 * 60_000);
  if (req.member) throw new HttpError(409, 'Tu fais déjà partie d’une famille');
  const code = normalize(req.body?.code);
  const fail = () => new HttpError(400, 'Code invalide, expiré ou déjà utilisé', 'bad_code');
  if (code.length !== 12) throw fail();
  await withTx(async (c) => {
    const inv = (await c.query(
      `SELECT * FROM invites WHERE code_hash=$1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now() FOR UPDATE`,
      [sha256(code)])).rows[0];
    if (!inv) throw fail();
    await c.query('UPDATE invites SET used_at=now(), used_by=$2 WHERE id=$1', [inv.id, req.user.id]);
    await c.query(`INSERT INTO members(family_id, user_id, role, status) VALUES ($1,$2,'parent','pending')`, [inv.family_id, req.user.id]);
    await c.query('UPDATE families SET rev = rev + 1 WHERE id=$1', [inv.family_id]);
  });
  res.json({ ok: true });
}));

familyRouter.post('/leave', requireUser, wrap(async (req, res) => {
  if (!req.member) throw new HttpError(404, 'Aucune famille');
  if (req.member.role === 'owner') throw new HttpError(409, 'Le propriétaire ne peut pas quitter la famille');
  await query('DELETE FROM members WHERE user_id=$1', [req.user.id]);
  await query('UPDATE families SET rev = rev + 1 WHERE id=$1', [req.member.familyId]);
  res.json({ ok: true });
}));

// ---- À partir d'ici : parent actif uniquement ----
familyRouter.use(requireParent);

// Synchronisation : état complet seulement si la révision a changé.
familyRouter.get('/state', wrap(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const since = Number(req.query.since);
  if (Number.isFinite(since)) {
    const r = (await query('SELECT rev FROM families WHERE id=$1', [req.member.familyId])).rows[0];
    if (r.rev === since) return res.json({ changed: false, rev: r.rev });
  }
  const c = await getPool().connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const state = await loadState(c, req.member, req.user);
    await c.query('COMMIT');
    res.json({ changed: true, state });
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}));

familyRouter.patch('/settings', requireOwner, mutate(async (req, c, fam) => {
  const b = req.body || {};
  if (b.name !== undefined) await c.query('UPDATE families SET name=$2 WHERE id=$1', [fam, str(b.name, 'Nom', { required: true, max: 60 })]);
  if (b.quickPlus !== undefined) await c.query('UPDATE families SET quick_plus=$2 WHERE id=$1', [fam, intList(b.quickPlus, 'Valeurs +')]);
  if (b.quickMinus !== undefined) await c.query('UPDATE families SET quick_minus=$2 WHERE id=$1', [fam, intList(b.quickMinus, 'Valeurs −')]);
}));

// ---- Suggestions : aperçu puis ajout choisi, jamais de doublon, rien d'existant modifié ----
familyRouter.get('/suggestions', wrap(async (req, res) => {
  const s = await suggestionStatus({ query }, req.member.familyId);
  res.json({ ok: true, actions: s.actions, rewards: s.rewards });
}));
familyRouter.post('/suggestions/apply', mutate(async (req, c, fam) => {
  const b = req.body || {};
  const pick = (v, catalog, label) => {
    if (v == null) return [];
    if (!Array.isArray(v) || v.length > 50) throw new HttpError(400, `Sélection « ${label} » invalide`);
    const keys = [...new Set(v)];
    if (keys.some((k) => !catalog.some((s) => s.key === k))) throw new HttpError(400, `Suggestion « ${label} » inconnue`);
    return keys;
  };
  const aKeys = pick(b.actionKeys, SUGGESTED_ACTIONS, 'actions'), rKeys = pick(b.rewardKeys, SUGGESTED_REWARDS, 'récompenses');
  if (!aKeys.length && !rKeys.length) throw new HttpError(400, 'Sélectionne au moins une suggestion');
  const st = await suggestionStatus(c, fam); // recalculé sous le verrou de la famille : pas de doublon, même en concurrence
  let addedA = 0, addedR = 0;
  for (const s of st.actions.filter((x) => aKeys.includes(x.key) && !x.existing)) {
    await c.query(`INSERT INTO actions(family_id, theme, title, icon, value, sort) VALUES ($1,$2,$3,$4,$5,(SELECT COALESCE(max(sort),0)+1 FROM actions WHERE family_id=$1))`, [fam, s.theme, s.title, s.icon, s.value]);
    addedA++;
  }
  for (const s of st.rewards.filter((x) => rKeys.includes(x.key) && !x.existing)) {
    await c.query('INSERT INTO rewards(family_id, title, icon, cost) VALUES ($1,$2,$3,$4)', [fam, s.title, s.icon, s.cost]);
    addedR++;
  }
  return { addedActions: addedA, addedRewards: addedR, skipped: aKeys.length + rKeys.length - addedA - addedR };
}));

// ---- Invitations (propriétaire) ----
familyRouter.post('/invites', requireOwner, wrap(async (req, res) => {
  const n = (await query(`SELECT count(*) AS n FROM invites WHERE family_id=$1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()`, [req.member.familyId])).rows[0].n;
  if (n >= 5) throw new HttpError(409, 'Trop de codes actifs : révoque-en un d’abord');
  const code = newCode();
  const r = (await query(
    `INSERT INTO invites(family_id, code_hash, created_by, expires_at) VALUES ($1,$2,$3, now() + make_interval(hours => $4)) RETURNING id, expires_at`,
    [req.member.familyId, sha256(code), req.user.id, INVITE_HOURS])).rows[0];
  res.status(201).json({ ok: true, id: r.id, code: pretty(code), expiresAt: r.expires_at }); // affiché une seule fois
}));
familyRouter.delete('/invites/:id', requireOwner, wrap(async (req, res) => {
  await query('UPDATE invites SET revoked_at=now() WHERE id=$1 AND family_id=$2 AND used_at IS NULL', [uuid(req.params.id), req.member.familyId]);
  res.json({ ok: true });
}));

// ---- Membres (propriétaire) ----
familyRouter.post('/members/:uid/approve', requireOwner, wrap(async (req, res) => {
  const r = await query(`UPDATE members SET status='active' WHERE family_id=$1 AND user_id=$2 AND status='pending'`, [req.member.familyId, uuid(req.params.uid)]);
  if (!r.rowCount) throw new HttpError(404, 'Demande introuvable');
  await query('UPDATE families SET rev = rev + 1 WHERE id=$1', [req.member.familyId]);
  res.json({ ok: true });
}));
familyRouter.delete('/members/:uid', requireOwner, wrap(async (req, res) => {
  const uid = uuid(req.params.uid);
  if (uid === req.user.id) throw new HttpError(409, 'Tu ne peux pas te retirer toi-même');
  await withTx(async (c) => {
    const r = await c.query('DELETE FROM members WHERE family_id=$1 AND user_id=$2', [req.member.familyId, uid]);
    if (!r.rowCount) throw new HttpError(404, 'Membre introuvable');
    await c.query('DELETE FROM sessions WHERE user_id=$1', [uid]); // déconnexion immédiate
    await c.query('UPDATE families SET rev = rev + 1 WHERE id=$1', [req.member.familyId]);
  });
  res.json({ ok: true });
}));
// Code de réinitialisation remis en main propre (fonctionne sans service e-mail)
familyRouter.post('/members/:uid/reset-code', requireOwner, wrap(async (req, res) => {
  hit(`resetcode:${req.user.id}`, 10, 3600_000);
  const uid = uuid(req.params.uid);
  const m = (await query('SELECT 1 FROM members WHERE family_id=$1 AND user_id=$2', [req.member.familyId, uid])).rows[0];
  if (!m) throw new HttpError(404, 'Membre introuvable');
  const token = randomToken(9);
  await query(`INSERT INTO password_resets(user_id, token_hash, expires_at) VALUES ($1,$2, now() + interval '1 hour')`, [uid, sha256(token)]);
  res.json({ ok: true, code: token, expiresInMinutes: 60 });
}));

// ---- Export complet des données de la famille ----
familyRouter.get('/export', requireOwner, wrap(async (req, res) => {
  const f = req.member.familyId;
  const t = async (sql) => (await query(sql, [f])).rows;
  const data = {
    exportedAt: new Date().toISOString(), format: 'petits-heros/1',
    family: (await t('SELECT id, name, quick_plus, quick_minus, created_at FROM families WHERE id=$1'))[0],
    members: await t(`SELECT u.id, u.name, u.email, m.role, m.status FROM members m JOIN users u ON u.id=m.user_id WHERE m.family_id=$1`),
    children: await t('SELECT * FROM children WHERE family_id=$1'),
    actions: await t('SELECT * FROM actions WHERE family_id=$1'),
    challenges: await t('SELECT * FROM challenges WHERE family_id=$1'),
    challenge_completions: await t('SELECT * FROM challenge_completions WHERE family_id=$1'),
    challenge_bonuses: await t('SELECT b.* FROM challenge_bonuses b JOIN challenges c ON c.id=b.challenge_id WHERE c.family_id=$1'),
    rewards: await t('SELECT * FROM rewards WHERE family_id=$1'),
    redemptions: await t('SELECT * FROM redemptions WHERE family_id=$1'),
    transactions: await t('SELECT * FROM transactions WHERE family_id=$1 ORDER BY created_at'),
  };
  res.set('Content-Disposition', `attachment; filename="petits-heros-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json(data);
}));
