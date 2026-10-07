import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { query } from './db.js';
import { HttpError, wrap } from './util.js';
import { loadAuth, isNativeClient } from './auth.js';
import { mailEnabled } from './mail.js';
import { authRouter } from './routes/auth.js';
import { familyRouter } from './routes/family.js';
import { dataRouter, META } from './routes/data.js';

const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Railway place un proxy devant l'application

  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'X-Frame-Options': 'DENY',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    });
    if (config.isProd) res.set('Strict-Transport-Security', 'max-age=15552000');
    next();
  });

  // Santé : base joignable ET toutes les migrations du code appliquées (sinon 503 → Railway ne bascule pas le trafic).
  app.get('/healthz', async (_req, res) => {
    try {
      const applied = (await query('SELECT count(*) AS n FROM schema_migrations')).rows[0].n;
      const expected = fs.readdirSync(path.join(pub, '..', 'migrations')).filter((f) => f.endsWith('.sql')).length;
      if (applied < expected) return res.status(503).json({ ok: false, db: true, migrations: `${applied}/${expected}` });
      res.set('Cache-Control', 'no-store').json({ ok: true, db: true, migrations: applied, commit: (process.env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 7) || undefined, mail: mailEnabled() ? 'brevo' : 'off' });
    } catch { res.status(503).json({ ok: false, db: false }); }
  });

  // CORS strict pour l'application Android (jetons Bearer, pas de cookies → pas de Allow-Credentials)
  app.use('/api', (req, res, next) => {
    const origin = req.get('origin');
    const allowed = origin && config.corsOrigins.includes(origin);
    if (allowed) {
      res.set({
        'Access-Control-Allow-Origin': origin, Vary: 'Origin',
        'Access-Control-Allow-Headers': 'authorization, content-type, x-op-id, x-client',
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
        'Access-Control-Expose-Headers': 'Retry-After', 'Access-Control-Max-Age': '600',
      });
    }
    if (req.method === 'OPTIONS') return res.sendStatus(allowed || !origin ? 204 : 403);
    next();
  });
  // Mise à jour obligatoire : l'interface Android est embarquée, l'API doit pouvoir refuser un build trop ancien
  app.use('/api', (req, _res, next) => {
    const m = /^native-android\/(\d+)$/.exec(req.get('x-client') || '');
    if (m && Number(m[1]) < config.minNativeBuild) return next(new HttpError(426, 'Mise à jour de l’application nécessaire.', 'upgrade_required'));
    next();
  });
  app.use('/api', express.json({ limit: '50kb' }));
  // Protection CSRF (requêtes authentifiées par COOKIE) : Origin vérifié sur les écritures + JSON obligatoire.
  // Les requêtes à jeton Bearer n'utilisent aucun identifiant ambiant : pas de CSRF possible.
  app.use('/api', (req, _res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    // Jeton Bearer, ou client natif (en-tête X-Client = préflight CORS obligatoire, accordé à la seule origine de l'application)
    const nativeApp = isNativeClient(req) && config.corsOrigins.includes(req.get('origin'));
    if (req.get('authorization') !== undefined || nativeApp) { if (req.method !== 'DELETE' && !req.is('application/json')) return next(new HttpError(415, 'JSON attendu')); return next(); }
    const origin = req.get('origin');
    let originHost = null;
    try { originHost = origin ? new URL(origin).host : null; } catch { return next(new HttpError(403, 'Origine refusée')); }
    if (originHost && originHost !== req.get('host')) return next(new HttpError(403, 'Origine refusée'));
    if (req.method !== 'DELETE' && !req.is('application/json')) return next(new HttpError(415, 'JSON attendu'));
    next();
  });
  app.use('/api', loadAuth);
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  app.get('/api/meta', (_req, res) => res.json({ ...META, minNativeBuild: config.minNativeBuild }));
  app.use('/api/auth', authRouter);
  app.use('/api/family', familyRouter);
  app.use('/api', dataRouter);
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Introuvable')));

  // Pages légales publiques (exigées par Google Play) : modèles HTML dans public/legal/, identité injectée depuis la configuration.
  const LEGAL_UPDATED = '7 octobre 2026';
  const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const legal = (file) => (_req, res) => {
    const html = fs.readFileSync(path.join(pub, 'legal', file), 'utf8')
      .replaceAll('{{CONTACT_EMAIL}}', esc(config.contactEmail)).replaceAll('{{PUBLISHER}}', esc(config.publisherName)).replaceAll('{{UPDATED}}', LEGAL_UPDATED);
    res.set('Cache-Control', 'no-cache').type('html').send(html);
  };
  app.get(['/confidentialite', '/confidentialite/'], legal('confidentialite.html'));
  app.get(['/suppression-compte', '/suppression-compte/'], legal('suppression-compte.html'));
  app.get('/sw.js', (_req, res) => { res.set('Cache-Control', 'no-cache'); res.sendFile(path.join(pub, 'sw.js')); });
  app.use(express.static(pub, { maxAge: 0, etag: true, setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));
  app.use((req, res) => res.status(404).sendFile(path.join(pub, 'index.html')));

  app.use((err, req, res, _next) => {
    if (res.headersSent) return;
    if (err instanceof HttpError) {
      if (err.retryAfter) res.set('Retry-After', String(err.retryAfter));
      return res.status(err.status).json({ ok: false, error: err.message, code: err.code });
    }
    if (err.type === 'entity.parse.failed' || err.status === 400) return res.status(400).json({ ok: false, error: 'Requête invalide' });
    if (err.code === '22P02') return res.status(404).json({ ok: false, error: 'Introuvable' });
    console.error(`erreur serveur ${req.method} ${req.path} (${err.code || err.name || 'inconnue'})`);   // jamais le message complet : il peut contenir des données personnelles
    res.status(500).json({ ok: false, error: 'Erreur serveur' });
  });
  return app;
}
