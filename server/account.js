import { HttpError } from './util.js';

// Suppression d'un compte parent et, si c'est le seul parent, de la famille et de TOUTES ses données.
// Règles (affichées telles quelles à l'utilisateur) :
//  • parent non propriétaire (ou compte sans famille / en attente) : son compte, ses sessions, ses codes de secours et son appartenance sont supprimés ;
//    la famille et ses données restent pour les autres parents ; les mouvements qu'il a saisis restent dans l'historique, sans son nom ;
//  • propriétaire avec d'autres parents actifs : refusé (nommer un autre propriétaire ou retirer les autres parents d'abord) ;
//  • propriétaire seul : suppression de la famille entière (enfants, points, historique, défis, récompenses, invitations) avec son compte,
//    à condition d'avoir confirmé explicitement (deleteFamily = true).
export async function accountSituation(c, userId) {
  const m = (await c.query('SELECT family_id, role, status FROM members WHERE user_id=$1', [userId])).rows[0] || null;
  if (!m) return { kind: 'no_family' };
  if (m.status !== 'active') return { kind: 'pending', familyId: m.family_id };
  if (m.role !== 'owner') return { kind: 'member', familyId: m.family_id };
  const others = (await c.query(`SELECT count(*) FILTER (WHERE status='active') AS active, count(*) FILTER (WHERE status='pending') AS pending
                                   FROM members WHERE family_id=$1 AND user_id<>$2`, [m.family_id, userId])).rows[0];
  return others.active > 0 ? { kind: 'owner_with_parents', familyId: m.family_id, activeParents: others.active } : { kind: 'owner_alone', familyId: m.family_id, pending: others.pending };
}

async function wipeFamily(c, familyId) {
  // ordre explicite : certaines clés étrangères n'ont pas d'action en cascade
  await c.query('DELETE FROM challenge_bonuses WHERE challenge_id IN (SELECT id FROM challenges WHERE family_id=$1)', [familyId]);
  for (const t of ['challenge_completions', 'redemptions', 'transactions', 'operations', 'invites']) await c.query(`DELETE FROM ${t} WHERE family_id=$1`, [familyId]);
  for (const t of ['challenges', 'rewards', 'actions', 'children']) await c.query(`DELETE FROM ${t} WHERE family_id=$1`, [familyId]);
  await c.query('DELETE FROM members WHERE family_id=$1', [familyId]);
  await c.query('DELETE FROM families WHERE id=$1', [familyId]);
}

// À appeler dans une transaction. Retourne { familyDeleted }.
export async function deleteAccount(c, userId, { deleteFamily = false } = {}) {
  const s = await accountSituation(c, userId);
  let familyDeleted = false;
  if (s.kind === 'owner_with_parents') {
    throw new HttpError(409, `Tu es propriétaire de la famille et ${s.activeParents} autre${s.activeParents > 1 ? 's' : ''} parent${s.activeParents > 1 ? 's y ont' : ' y a'} accès. Avant de supprimer ton compte, nomme un autre propriétaire (Famille › ⋯ › Nommer propriétaire) ou retire les autres parents.`, 'owner_has_parents');
  }
  if (s.kind === 'owner_alone') {
    if (!deleteFamily) {
      throw new HttpError(409, 'Tu es le seul parent : supprimer ton compte supprime aussi la famille et toutes ses données (enfants, points, historique, défis, récompenses). Confirme explicitement pour continuer.', 'family_will_be_deleted');
    }
    await c.query('SELECT 1 FROM families WHERE id=$1 FOR UPDATE', [s.familyId]);
    await wipeFamily(c, s.familyId);
    familyDeleted = true;
  }
  if (s.kind === 'member' || s.kind === 'pending') {
    await c.query('UPDATE families SET rev = rev + 1 WHERE id=$1', [s.familyId]); // les autres parents voient le changement
  }
  // cascade : sessions, appartenance, codes de secours, jetons de réinitialisation ; les mouvements saisis gardent leur ligne (auteur → NULL)
  await c.query('DELETE FROM users WHERE id=$1', [userId]);
  return { familyDeleted };
}
