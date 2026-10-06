import { createApp } from './app.js';
import { migrate } from './migrate.js';
import { config } from './config.js';
import { query, closePool } from './db.js';

if (!config.databaseUrl) { console.error('DATABASE_URL manquant : référencez le service PostgreSQL (voir docs/DEPLOY.md).'); process.exit(1); }
if (config.isProd && !config.appUrl) console.warn('APP_URL non défini : les liens des e-mails de réinitialisation seront incomplets.');
await migrate();
const app = createApp();
const server = app.listen(config.port, '0.0.0.0', () => console.log(`Petits Héros écoute sur :${config.port}`));

// Nettoyage horaire des données temporaires
const clean = () => Promise.all([
  query('DELETE FROM sessions WHERE expires_at < now()'),
  query(`DELETE FROM operations WHERE created_at < now() - interval '7 days'`),
  query(`DELETE FROM invites WHERE expires_at < now() - interval '7 days'`),
  query(`DELETE FROM password_resets WHERE expires_at < now() - interval '1 day'`),
]).catch((e) => console.error('cleanup', e.message));
setInterval(clean, 3600_000).unref();

const stop = () => { server.close(() => closePool().then(() => process.exit(0))); setTimeout(() => process.exit(0), 8000).unref(); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
