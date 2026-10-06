// Garde-fous des tests destructifs. Les tests ne lisent JAMAIS DATABASE_URL (réservé à l'application) :
// ils utilisent TEST_DATABASE_URL, et ne réinitialisent une base que si TOUT ceci est vrai :
//   1. NODE_ENV n'est pas « production » ;
//   2. l'hôte est local (localhost, 127.0.0.1, ::1, socket Unix) — sauf PH_TEST_ALLOW_REMOTE=1 ;
//   3. le nom de la base se termine par « _test » ;
//   4. ce n'est pas la même base que DATABASE_URL (celle de l'application / de la production) ;
//   5. la base est vide OU porte le marqueur _ph_test_marker posé par un précédent reset de test.
import pg from 'pg';

export const DEFAULT_TEST_URL = 'postgres://postgres@localhost:5433/kids_test';

export function parseDb(url) {
  const u = new URL(url);
  const host = u.hostname || u.searchParams.get('host') || '';
  return { host, db: decodeURIComponent(u.pathname.replace(/^\//, '')), port: u.port || '5432' };
}

export function assertSafeTestUrl(url, env = process.env) {
  const refuse = (why) => { throw new Error(`Test destructif REFUSÉ : ${why}`); };
  if (env.NODE_ENV === 'production') refuse('NODE_ENV=production');
  let t;
  try { t = parseDb(url); } catch { refuse('URL de base invalide'); }
  const local = ['localhost', '127.0.0.1', '::1', '[::1]', ''].includes(t.host) || t.host.startsWith('/');
  if (!local && env.PH_TEST_ALLOW_REMOTE !== '1') refuse(`hôte « ${t.host} » non local (PH_TEST_ALLOW_REMOTE=1 pour une base de test distante dédiée)`);
  if (/railway\.(internal|app)|rlwy\.net/i.test(t.host)) refuse('hôte Railway : jamais pour les tests');
  if (!/^[a-z0-9_]*_test$/.test(t.db)) refuse(`la base « ${t.db} » ne se termine pas par _test`);
  if (env.DATABASE_URL) {
    let a = null;
    try { a = parseDb(env.DATABASE_URL); } catch { /* DATABASE_URL illisible : ignorée */ }
    if (a && a.host === t.host && a.port === t.port && a.db === t.db) refuse('même base que DATABASE_URL (application)');
  }
  return url;
}

export function testDatabaseUrl(env = process.env) {
  return assertSafeTestUrl(env.TEST_DATABASE_URL || DEFAULT_TEST_URL, env);
}

// Réinitialise la base de test (après garde-fous) et configure l'application pour l'utiliser.
export async function resetTestDatabase(env = process.env) {
  const url = testDatabaseUrl(env);
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    const marker = (await c.query(`SELECT to_regclass('public._ph_test_marker') AS m`)).rows[0].m;
    const tables = (await c.query(`SELECT count(*) AS n FROM information_schema.tables WHERE table_schema='public'`)).rows[0].n;
    if (!marker && Number(tables) > 0) throw new Error('Test destructif REFUSÉ : la base contient des tables sans marqueur de base de test');
    await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; CREATE TABLE _ph_test_marker (created_at timestamptz DEFAULT now()); INSERT INTO _ph_test_marker DEFAULT VALUES;');
  } finally { await c.end(); }
  env.DATABASE_URL = url; // l'application sous test utilise cette base
  return url;
}
