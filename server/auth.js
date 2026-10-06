import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { query } from './db.js';
import { config } from './config.js';
import { HttpError, wrap } from './util.js';

const scrypt = promisify(crypto.scrypt);
const N = 16384, R = 8, P = 1, KEYLEN = 64;

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}
const DUMMY = await hashPassword('dummy-password-for-timing');
export async function verifyPassword(pw, stored) {
  const parts = (stored || DUMMY).split('$');
  const [, n, r, p, salt, key] = parts;
  const expected = Buffer.from(key, 'base64');
  const actual = await scrypt(pw, Buffer.from(salt, 'base64'), expected.length, { N: +n, r: +r, p: +p });
  return crypto.timingSafeEqual(actual, expected) && !!stored;
}
export function checkPasswordStrength(pw) {
  if (typeof pw !== 'string' || pw.length < 10) throw new HttpError(400, 'Mot de passe : 10 caractères minimum');
  if (pw.length > 200) throw new HttpError(400, 'Mot de passe trop long');
}

// Codes lisibles (sans I, O, 0, 1) : invitations et codes de secours
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function randomCode(len = 12) { let s = ''; for (let i = 0; i < len; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)]; return s; }
export const normalizeCode = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export const prettyCode = (s) => s.match(/.{4}/g).join('-');

export const COOKIE = 'ph_session';
const SESSION_DAYS = 90;

export function parseCookies(h = '') {
  const out = {};
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
export function setSessionCookie(res, token, isProd) {
  res.append('Set-Cookie', `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${isProd ? '; Secure' : ''}`);
}
export function clearSessionCookie(res, isProd) {
  res.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isProd ? '; Secure' : ''}`);
}
export async function createSession(userId) {
  const token = randomToken();
  await query(
    `INSERT INTO sessions(user_id, token_hash, expires_at) VALUES ($1,$2, now() + make_interval(days => $3))`,
    [userId, sha256(token), SESSION_DAYS],
  );
  return token;
}

// Charge l'utilisateur et son appartenance familiale (jamais lue depuis le client).
// Jeton : en-tête Authorization (application Android) OU cookie (navigateur). Si un en-tête Authorization est
// présent il est le seul pris en compte (jamais de repli sur le cookie).
export const isNativeClient = (req) => /^native-android\//.test(req.get('x-client') || '');
export const loadAuth = wrap(async (req, res, next) => {
  const authz = req.get('authorization');
  const token = authz !== undefined ? (/^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(authz)?.[1]) : parseCookies(req.headers.cookie)[COOKIE];
  req.authVia = authz !== undefined ? 'bearer' : 'cookie';
  if (token) {
    const { rows } = await query(
      `SELECT s.id AS sid, s.last_seen, u.id, u.email, u.name,
              m.family_id, m.role, m.status, f.name AS family_name
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         LEFT JOIN members m ON m.user_id = u.id
         LEFT JOIN families f ON f.id = m.family_id
        WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [sha256(token)],
    );
    const r = rows[0];
    if (r) {
      req.user = { id: r.id, email: r.email, name: r.name, sessionId: r.sid };
      if (r.family_id) req.member = { familyId: r.family_id, role: r.role, status: r.status, familyName: r.family_name };
      if (Date.now() - new Date(r.last_seen).getTime() > 86400000) {
        await query(`UPDATE sessions SET last_seen = now(), expires_at = now() + make_interval(days => $2) WHERE id = $1`, [r.sid, SESSION_DAYS]);
        if (req.authVia === 'cookie') setSessionCookie(res, token, config.isProd); // prolonge aussi le cookie : la session glisse côté serveur ET navigateur
      }
    }
  }
  next();
});

export function requireUser(req, _res, next) {
  if (!req.user) return next(new HttpError(401, 'Connexion requise', 'auth'));
  next();
}
// Parent actif d'une famille : base de TOUTES les routes de données.
export function requireParent(req, _res, next) {
  if (!req.user) return next(new HttpError(401, 'Connexion requise', 'auth'));
  if (!req.member) return next(new HttpError(403, 'Aucune famille', 'no_family'));
  if (req.member.status !== 'active') return next(new HttpError(403, 'Accès en attente d’approbation', 'pending'));
  next();
}
export function requireOwner(req, _res, next) {
  if (req.member?.role !== 'owner' || req.member.status !== 'active') return next(new HttpError(403, 'Réservé au parent propriétaire de la famille', 'owner_only'));
  next();
}

// Ouvre une session : cookie pour le navigateur ; jeton renvoyé dans la réponse pour l'application Android
// (le WebView Capacitor n'est pas de même origine que l'API : on ne compte pas sur les cookies).
export async function startSession(req, res, userId) {
  const token = await createSession(userId);
  if (isNativeClient(req)) return { token };
  setSessionCookie(res, token, config.isProd);
  return {};
}
