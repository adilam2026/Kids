import { withTx } from '../db.js';
import { HttpError, wrap, bad } from '../util.js';
import { loadState } from '../state.js';

const OP = /^[A-Za-z0-9_-]{8,64}$/;

// Toute écriture : parent actif, identifiant d'opération unique, verrou famille,
// transaction atomique, réponse mémorisée (un rejeu renvoie la même réponse sans rien refaire).
export function mutate(handler) {
  return wrap(async (req, res) => {
    const opId = req.get('x-op-id');
    if (!opId || !OP.test(opId)) throw bad('Identifiant d’opération manquant ou invalide', 'op_id');
    const fam = req.member.familyId;
    const out = await withTx(async (c) => {
      // verrou exclusif sur la famille : les écritures d'une même famille sont sérialisées
      await c.query('SELECT 1 FROM families WHERE id=$1 FOR UPDATE', [fam]);
      const prev = await c.query('SELECT response FROM operations WHERE family_id=$1 AND op_id=$2', [fam, opId]);
      if (prev.rows[0]) return { ...prev.rows[0].response, replayed: true };
      const result = (await handler(req, c, fam)) ?? {};
      const rev = (await c.query('UPDATE families SET rev = rev + 1 WHERE id=$1 RETURNING rev', [fam])).rows[0].rev;
      const body = { ok: true, rev, ...result };
      await c.query('INSERT INTO operations(family_id, op_id, response) VALUES ($1,$2,$3)', [fam, opId, JSON.stringify(body)]);
      return body;
    });
    res.json(out);
  });
}

export const ctxState = async (req, c) => loadState(c, req.member, req.user);
export { HttpError };
