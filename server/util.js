export class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
export const bad = (m, code) => new HttpError(400, m, code);
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function uuid(v, label = 'identifiant') {
  if (typeof v !== 'string' || !UUID.test(v)) throw new HttpError(404, `${label} introuvable`);
  return v.toLowerCase();
}
export function uuidList(v, label = 'enfants') {
  if (v == null) return [];
  if (!Array.isArray(v) || v.length > 50) throw bad(`Liste « ${label} » invalide`);
  return [...new Set(v.map((x) => uuid(x, label)))];
}
export function str(v, label, { min = 0, max = 100, required = false } = {}) {
  if (v == null || v === '') {
    if (required) throw bad(`${label} : champ obligatoire`);
    return '';
  }
  if (typeof v !== 'string') throw bad(`${label} invalide`);
  const s = v.trim().replace(/\s+/g, ' ');
  if (required && !s) throw bad(`${label} : champ obligatoire`);
  if (s.length < min || s.length > max) throw bad(`${label} : ${min}–${max} caractères`);
  return s;
}
export function int(v, label, { min = -1000, max = 1000, required = true } = {}) {
  if (v == null || v === '') {
    if (required) throw bad(`${label} : valeur obligatoire`);
    return null;
  }
  const n = typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : v;
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`${label} : entier entre ${min} et ${max}`);
  return n;
}
export function date(v, label) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw bad(`${label} : date invalide`);
  return v;
}
export function intList(v, label, fallback) {
  if (v == null) return fallback;
  if (!Array.isArray(v) || v.length < 1 || v.length > 8) throw bad(`${label} invalides`);
  return [...new Set(v.map((x) => int(x, label, { min: 1, max: 1000 })))].sort((a, b) => a - b);
}

// Limiteur de tentatives en mémoire (une seule instance applicative en V1).
const buckets = new Map();
export const limits = { enabled: true };
export function hit(key, max, windowMs) {
  if (!limits.enabled) return;
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.reset < now) { buckets.set(key, { n: 1, reset: now + windowMs }); return; }
  b.n += 1;
  if (b.n > max) {
    const e = new HttpError(429, 'Trop de tentatives. Réessaie dans quelques minutes.', 'rate_limited');
    e.retryAfter = Math.ceil((b.reset - now) / 1000);
    throw e;
  }
}
export function resetLimits() { buckets.clear(); }
setInterval(() => { const n = Date.now(); for (const [k, v] of buckets) if (v.reset < n) buckets.delete(k); }, 60000).unref();
