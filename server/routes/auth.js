import { Router } from 'express';
import { query, withTx } from '../db.js';
import { config } from '../config.js';
import { HttpError, wrap, str, hit, bad } from '../util.js';
import {
  hashPassword, verifyPassword, checkPasswordStrength, createSession, setSessionCookie,
  clearSessionCookie, requireUser, randomToken, sha256, randomCode, normalizeCode, prettyCode, startSession,
} from '../auth.js';
import { seedFamily } from '../seed.js';
import { sendMail, mailEnabled } from '../mail.js';

export const authRouter = Router();
const WEEK = 15 * 60 * 1000;

function email(v) {
  const e = str(v, 'E-mail', { required: true, max: 200 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw bad('E-mail invalide');
  return e;
}

const RECOVERY_COUNT = 8;
// Remplace les codes de secours non utilisés ; les codes en clair ne sont renvoyés qu'une fois.
export async function issueRecoveryCodes(c, userId) {
  await c.query('DELETE FROM recovery_codes WHERE user_id=$1 AND used_at IS NULL', [userId]);
  const codes = Array.from({ length: RECOVERY_COUNT }, () => randomCode(12));
  for (const code of codes) await c.query('INSERT INTO recovery_codes(user_id, code_hash) VALUES ($1,$2)', [userId, sha256(code)]);
  return codes.map(prettyCode);
}

export async function createFamilyFor(c, userId, name) {
  const f = (await c.query('INSERT INTO families(name) VALUES ($1) RETURNING id', [name])).rows[0];
  await c.query(`INSERT INTO members(family_id, user_id, role, status) VALUES ($1,$2,'owner','active')`, [f.id, userId]);
  await seedFamily(c, f.id);
  return f.id;
}

authRouter.post('/register', wrap(async (req, res) => {
  hit(`reg:${req.ip}`, 10, 3600_000);
  const b = req.body || {};
  const em = email(b.email);
  const name = str(b.name, 'Prénom', { required: true, max: 40 });
  checkPasswordStrength(b.password);
  const familyName = str(b.familyName, 'Nom de la famille', { max: 60 });
  const hash = await hashPassword(b.password);
  let recoveryCodes;
  const userId = await withTx(async (c) => {
    const dup = await c.query('SELECT 1 FROM users WHERE lower(email)=$1', [em]);
    if (dup.rowCount) throw new HttpError(409, 'Un compte existe déjà avec cet e-mail', 'email_taken');
    const u = (await c.query('INSERT INTO users(email, name, password_hash) VALUES ($1,$2,$3) RETURNING id', [em, name, hash])).rows[0];
    if (familyName) await createFamilyFor(c, u.id, familyName);
    recoveryCodes = await issueRecoveryCodes(c, u.id);
    return u.id;
  });
  const s = await startSession(req, res, userId);
  // Les codes de secours ne sont affichés qu'ici, une seule fois.
  res.status(201).json({ ok: true, recoveryCodes, ...s });
}));

authRouter.post('/login', wrap(async (req, res) => {
  const b = req.body || {};
  const em = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
  hit(`login:ip:${req.ip}`, 30, WEEK);
  hit(`login:em:${em}`, 8, WEEK);
  const u = (await query('SELECT id, password_hash FROM users WHERE lower(email)=$1', [em])).rows[0];
  const ok = await verifyPassword(String(b.password || ''), u?.password_hash);
  if (!u || !ok) throw new HttpError(401, 'E-mail ou mot de passe incorrect', 'bad_credentials');
  res.json({ ok: true, ...(await startSession(req, res, u.id)) });
}));

authRouter.post('/logout', wrap(async (req, res) => {
  if (req.user) await query('DELETE FROM sessions WHERE id=$1', [req.user.sessionId]);
  clearSessionCookie(res, config.isProd);
  res.set('Clear-Site-Data', '"cache"');
  res.json({ ok: true });
}));

authRouter.get('/me', wrap(async (req, res) => {
  if (!req.user) return res.json({ user: null });
  const left = (await query('SELECT count(*) AS n FROM recovery_codes WHERE user_id=$1 AND used_at IS NULL', [req.user.id])).rows[0].n;
  res.json({
    recoveryRemaining: left,
    user: { id: req.user.id, name: req.user.name, email: req.user.email },
    membership: req.member ? { status: req.member.status, role: req.member.role, familyName: req.member.familyName } : null,
    mailEnabled: mailEnabled(),
  });
}));

// Création de famille pour un compte qui n'en a pas encore
authRouter.post('/family', requireUser, wrap(async (req, res) => {
  if (req.member) throw new HttpError(409, 'Tu fais déjà partie d’une famille');
  const name = str(req.body?.familyName, 'Nom de la famille', { required: true, max: 60 });
  await withTx((c) => createFamilyFor(c, req.user.id, name));
  res.status(201).json({ ok: true });
}));

authRouter.post('/change-password', requireUser, wrap(async (req, res) => {
  hit(`chpw:${req.user.id}`, 10, WEEK);
  const u = (await query('SELECT password_hash FROM users WHERE id=$1', [req.user.id])).rows[0];
  if (!(await verifyPassword(String(req.body?.current || ''), u.password_hash))) throw new HttpError(403, 'Mot de passe actuel incorrect');
  checkPasswordStrength(req.body?.password);
  await query('UPDATE users SET password_hash=$2 WHERE id=$1', [req.user.id, await hashPassword(req.body.password)]);
  await query('DELETE FROM sessions WHERE user_id=$1 AND id<>$2', [req.user.id, req.user.sessionId]);
  res.json({ ok: true });
}));

// Récupération : e-mail (si service configuré). Réponse identique que le compte existe ou non.
authRouter.post('/forgot', wrap(async (req, res) => {
  hit(`forgot:${req.ip}`, 5, 3600_000);
  const em = email(req.body?.email);
  const u = (await query('SELECT id FROM users WHERE lower(email)=$1', [em])).rows[0];
  if (u && mailEnabled()) {
    const token = randomToken(24);
    await query(`INSERT INTO password_resets(user_id, token_hash, expires_at) VALUES ($1,$2, now() + interval '1 hour')`, [u.id, sha256(token)]);
    try {
      await sendMail({
        to: em, subject: 'Petits Héros — nouveau mot de passe',
        text: `Pour choisir un nouveau mot de passe (valable 1 heure) :\n${config.appUrl}/#/reset/${token}\n\nSi tu n’es pas à l’origine de cette demande, ignore ce message.`,
      });
    } catch (e) { console.error('mail:', e.message); }
  }
  res.json({ ok: true, mailEnabled: mailEnabled() });
}));

authRouter.post('/reset', wrap(async (req, res) => {
  hit(`reset:${req.ip}`, 10, WEEK);
  checkPasswordStrength(req.body?.password);
  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  const hash = await hashPassword(req.body.password);
  await withTx(async (c) => {
    const r = (await c.query(
      `UPDATE password_resets SET used_at=now() WHERE token_hash=$1 AND used_at IS NULL AND expires_at > now() RETURNING user_id`,
      [sha256(token)])).rows[0];
    if (!r) throw new HttpError(400, 'Lien ou code invalide ou expiré', 'bad_token');
    await c.query('UPDATE users SET password_hash=$2 WHERE id=$1', [r.user_id, hash]);
    await c.query('DELETE FROM sessions WHERE user_id=$1', [r.user_id]);
  });
  res.json({ ok: true });
}));

// Nouveaux codes de secours (invalide les anciens) : exige le mot de passe.
authRouter.post('/recovery-codes', requireUser, wrap(async (req, res) => {
  hit(`rc:${req.user.id}`, 10, WEEK);
  const u = (await query('SELECT password_hash FROM users WHERE id=$1', [req.user.id])).rows[0];
  if (!(await verifyPassword(String(req.body?.password || ''), u.password_hash))) throw new HttpError(403, 'Mot de passe incorrect');
  const codes = await withTx((c) => issueRecoveryCodes(c, req.user.id));
  res.json({ ok: true, recoveryCodes: codes });
}));

// Récupération sans e-mail : e-mail + code de secours à usage unique + nouveau mot de passe.
// Réponse identique que le compte existe ou non ; limitée par IP et par e-mail.
authRouter.post('/recover', wrap(async (req, res) => {
  const em = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  hit(`recover:ip:${req.ip}`, 10, WEEK);
  hit(`recover:em:${em}`, 5, WEEK);
  checkPasswordStrength(req.body?.password);
  const code = normalizeCode(req.body?.code);
  const hash = await hashPassword(req.body.password);
  const fail = () => new HttpError(400, 'E-mail ou code de secours invalide', 'bad_recovery');
  if (code.length !== 12) throw fail();
  await withTx(async (c) => {
    const u = (await c.query('SELECT id FROM users WHERE lower(email)=$1', [em])).rows[0];
    if (!u) throw fail();
    const used = (await c.query('UPDATE recovery_codes SET used_at=now() WHERE user_id=$1 AND code_hash=$2 AND used_at IS NULL RETURNING id', [u.id, sha256(code)])).rows[0];
    if (!used) throw fail();
    await c.query('UPDATE users SET password_hash=$2 WHERE id=$1', [u.id, hash]);
    await c.query('DELETE FROM sessions WHERE user_id=$1', [u.id]);
  });
  res.json({ ok: true });
}));
