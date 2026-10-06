import { HttpError } from './util.js';
import { config } from './config.js';

export const today = async (c) =>
  (await c.query(`SELECT (now() AT TIME ZONE $1)::date AS d`, [config.timezone])).rows[0].d;

// Applique un mouvement de façon atomique : le solde ne peut jamais devenir négatif.
export async function applyTx(c, f) {
  const { familyId, childId, value, type, reason = '', authorId = null, actionId = null,
    challengeId = null, redemptionId = null, reversesId = null, allowArchived = false } = f;
  const upd = await c.query(
    `UPDATE children SET balance = balance + $1
      WHERE id = $2 AND family_id = $3 AND balance + $1 >= 0 ${allowArchived ? '' : 'AND archived_at IS NULL'}
      RETURNING balance, name`,
    [value, childId, familyId],
  );
  if (!upd.rows[0]) {
    const ch = (await c.query('SELECT balance, name, archived_at FROM children WHERE id=$1 AND family_id=$2', [childId, familyId])).rows[0];
    if (!ch) throw new HttpError(404, 'Enfant introuvable');
    if (ch.archived_at && !allowArchived) throw new HttpError(409, `${ch.name} est archivé(e)`, 'archived');
    throw new HttpError(409,
      `Solde insuffisant : ${ch.name} a ${ch.balance} point${ch.balance > 1 ? 's' : ''}. Corrige le montant.`,
      'insufficient');
  }
  const balance = upd.rows[0].balance;
  const t = (await c.query(
    `INSERT INTO transactions(family_id, child_id, value, type, reason, author_id, balance_after, action_id, challenge_id, redemption_id, reverses_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [familyId, childId, value, type, reason, authorId, balance, actionId, challengeId, redemptionId, reversesId],
  )).rows[0];
  return { tx: t, balance, childName: upd.rows[0].name };
}

async function reverse(c, fam, t, userId, why) {
  return applyTx(c, {
    familyId: fam, childId: t.child_id, value: -t.value, type: 'cancel',
    reason: `Annulation : ${why || t.reason}`, authorId: userId, reversesId: t.id,
    actionId: t.action_id, challengeId: t.challenge_id, redemptionId: t.redemption_id, allowArchived: true,
  });
}

// ---- Défis -----------------------------------------------------------------
async function counts(c, ch) {
  const rows = (await c.query(
    ch.collective
      ? `SELECT NULL::uuid AS child_id, count(DISTINCT event_id) AS n FROM challenge_completions WHERE challenge_id=$1 AND cancelled_at IS NULL`
      : `SELECT child_id, count(*) AS n FROM challenge_completions WHERE challenge_id=$1 AND cancelled_at IS NULL GROUP BY child_id`,
    [ch.id],
  )).rows;
  return rows;
}
export const countFor = (rows, ch, childId) =>
  ch.collective ? (rows[0]?.n || 0) : (rows.find((r) => r.child_id === childId)?.n || 0);

// Bonus final : une seule fois par enfant et par défi (index unique partiel + contrôle).
async function awardBonuses(c, fam, ch, userId) {
  const rows = await counts(c, ch);
  for (const childId of ch.child_ids) {
    if (countFor(rows, ch, childId) < ch.target || ch.bonus <= 0) continue;
    const exists = await c.query('SELECT 1 FROM challenge_bonuses WHERE challenge_id=$1 AND child_id=$2 AND cancelled_at IS NULL', [ch.id, childId]);
    if (exists.rowCount) continue;
    const child = (await c.query('SELECT archived_at FROM children WHERE id=$1', [childId])).rows[0];
    if (!child || child.archived_at) continue;
    const r = await applyTx(c, { familyId: fam, childId, value: ch.bonus, type: 'bonus',
      reason: `Bonus du défi « ${ch.title} »`, authorId: userId, challengeId: ch.id, actionId: ch.action_id });
    await c.query('INSERT INTO challenge_bonuses(challenge_id, child_id, tx_id) VALUES ($1,$2,$3)', [ch.id, childId, r.tx.id]);
  }
  await refreshCompleted(c, ch);
}
async function refreshCompleted(c, ch) {
  const rows = await counts(c, ch);
  const done = ch.child_ids.every((id) => countFor(rows, ch, id) >= ch.target);
  await c.query('UPDATE challenges SET completed_at = CASE WHEN $2 THEN COALESCE(completed_at, now()) ELSE NULL END WHERE id=$1', [ch.id, done]);
}
// Après une annulation : un bonus n'est conservé que si l'objectif reste atteint.
async function revokeStaleBonuses(c, fam, ch, userId) {
  const rows = await counts(c, ch);
  const bonuses = (await c.query('SELECT * FROM challenge_bonuses WHERE challenge_id=$1 AND cancelled_at IS NULL', [ch.id])).rows;
  for (const b of bonuses) {
    if (countFor(rows, ch, b.child_id) >= ch.target) continue;
    const t = (await c.query('SELECT * FROM transactions WHERE id=$1', [b.tx_id])).rows[0];
    await reverse(c, fam, t, userId, 'objectif du défi plus atteint');
    await c.query('UPDATE challenge_bonuses SET cancelled_at = now() WHERE id=$1', [b.id]);
  }
  await refreshCompleted(c, ch);
}

export async function completeChallenge(c, fam, userId, challengeId, childId) {
  const ch = (await c.query('SELECT * FROM challenges WHERE id=$1 AND family_id=$2', [challengeId, fam])).rows[0];
  if (!ch || ch.archived_at) throw new HttpError(404, 'Défi introuvable');
  const day = await today(c);
  if (day < ch.starts_on || day > ch.ends_on) throw new HttpError(409, 'Ce défi n’est pas en cours', 'out_of_period');
  let targets;
  if (ch.collective) targets = ch.child_ids;
  else {
    if (!ch.child_ids.includes(childId)) throw new HttpError(400, 'Cet enfant ne participe pas à ce défi');
    targets = [childId];
  }
  const rows = await counts(c, ch);
  if (countFor(rows, ch, ch.collective ? null : childId) >= ch.target) throw new HttpError(409, 'Objectif déjà atteint', 'target_reached');
  if (ch.frequency === 'daily') {
    const dup = await c.query(
      `SELECT 1 FROM challenge_completions WHERE challenge_id=$1 AND day=$2 AND cancelled_at IS NULL ${ch.collective ? '' : 'AND child_id=$3'}`,
      ch.collective ? [ch.id, day] : [ch.id, day, childId],
    );
    if (dup.rowCount) throw new HttpError(409, 'Déjà validé aujourd’hui', 'already_today');
  }
  const action = ch.action_id ? (await c.query('SELECT * FROM actions WHERE id=$1', [ch.action_id])).rows[0] : null;
  const eventId = (await c.query('SELECT gen_random_uuid() AS id')).rows[0].id;
  const txs = [];
  for (const id of targets) {
    const child = (await c.query('SELECT archived_at FROM children WHERE id=$1 AND family_id=$2', [id, fam])).rows[0];
    if (!child || child.archived_at) continue;
    let txId = null;
    if (action && action.value > 0) {
      const r = await applyTx(c, { familyId: fam, childId: id, value: action.value, type: 'gain',
        reason: `Défi « ${ch.title} » : ${action.title}`, authorId: userId, actionId: action.id, challengeId: ch.id });
      txId = r.tx.id; txs.push(r.tx.id);
    }
    await c.query('INSERT INTO challenge_completions(family_id, challenge_id, event_id, child_id, day, tx_id, author_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [fam, ch.id, eventId, id, day, txId, userId]);
  }
  await awardBonuses(c, fam, ch, userId);
  return { eventId, txIds: txs };
}

export async function cancelCompletion(c, fam, userId, eventId) { return cancelCompletionEvent(c, fam, eventId, userId); }
async function cancelCompletionEvent(c, fam, eventId, userId) {
  const comps = (await c.query('SELECT * FROM challenge_completions WHERE event_id=$1 AND family_id=$2 AND cancelled_at IS NULL FOR UPDATE', [eventId, fam])).rows;
  if (!comps.length) throw new HttpError(409, 'Déjà annulé');
  const ch = (await c.query('SELECT * FROM challenges WHERE id=$1', [comps[0].challenge_id])).rows[0];
  for (const k of comps) {
    if (k.tx_id) {
      const t = (await c.query('SELECT * FROM transactions WHERE id=$1', [k.tx_id])).rows[0];
      await reverse(c, fam, t, userId);
    }
    await c.query('UPDATE challenge_completions SET cancelled_at = now() WHERE id=$1', [k.id]);
  }
  await revokeStaleBonuses(c, fam, ch, userId);
}

// ---- Annulation générale ----------------------------------------------------
// Règles :
//  * on ne supprime jamais un mouvement : on ajoute une compensation liée (reverses_id, unique) ;
//  * si l'annulation ferait passer le solde sous zéro (points déjà dépensés), elle est refusée ;
//  * annuler une validation de défi annule aussi le bonus final s'il n'est plus mérité ;
//  * une récompense déjà réalisée ne peut pas être annulée.
export async function cancelTransaction(c, fam, userId, txId) {
  const t = (await c.query('SELECT * FROM transactions WHERE id=$1 AND family_id=$2 FOR UPDATE', [txId, fam])).rows[0];
  if (!t) throw new HttpError(404, 'Mouvement introuvable');
  if (t.type === 'cancel') throw new HttpError(409, 'Une annulation ne peut pas être annulée');
  if ((await c.query('SELECT 1 FROM transactions WHERE reverses_id=$1', [t.id])).rowCount) throw new HttpError(409, 'Déjà annulé', 'already_cancelled');
  const comp = (await c.query('SELECT event_id FROM challenge_completions WHERE tx_id=$1 AND cancelled_at IS NULL', [t.id])).rows[0];
  if (comp) { await cancelCompletionEvent(c, fam, comp.event_id, userId); return; }
  const bonus = (await c.query('SELECT * FROM challenge_bonuses WHERE tx_id=$1 AND cancelled_at IS NULL', [t.id])).rows[0];
  if (bonus) {
    await reverse(c, fam, t, userId);
    await c.query('UPDATE challenge_bonuses SET cancelled_at = now() WHERE id=$1', [bonus.id]);
    const ch = (await c.query('SELECT * FROM challenges WHERE id=$1', [bonus.challenge_id])).rows[0];
    await c.query('UPDATE challenges SET completed_at = NULL WHERE id=$1', [ch.id]);
    return;
  }
  const red = (await c.query('SELECT * FROM redemptions WHERE tx_id=$1 FOR UPDATE', [t.id])).rows[0];
  if (red) {
    if (red.status !== 'todo') throw new HttpError(409, red.status === 'done' ? 'Cette récompense est déjà réalisée' : 'Déjà annulé');
    await c.query(`UPDATE redemptions SET status='cancelled', cancelled_at=now() WHERE id=$1`, [red.id]);
  }
  await reverse(c, fam, t, userId);
}

// ---- Récompenses -------------------------------------------------------------
export async function redeem(c, fam, userId, rewardId, childId) {
  const rw = (await c.query('SELECT * FROM rewards WHERE id=$1 AND family_id=$2', [rewardId, fam])).rows[0];
  if (!rw || rw.archived_at) throw new HttpError(404, 'Récompense introuvable');
  if (rw.child_ids.length && !rw.child_ids.includes(childId)) throw new HttpError(400, 'Récompense non proposée à cet enfant');
  const red = (await c.query(
    `INSERT INTO redemptions(family_id, reward_id, child_id, title, icon, cost, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [fam, rw.id, childId, rw.title, rw.icon, rw.cost, userId],
  )).rows[0];
  const r = await applyTx(c, { familyId: fam, childId, value: -rw.cost, type: 'reward', reason: rw.title, authorId: userId, redemptionId: red.id });
  await c.query('UPDATE redemptions SET tx_id=$1 WHERE id=$2', [r.tx.id, red.id]);
  return { redemptionId: red.id, txId: r.tx.id, balance: r.balance, childName: r.childName };
}
