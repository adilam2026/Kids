import pg from 'pg';
import { config } from './config.js';

// bigint -> number (compteurs, sommes), date -> chaîne 'YYYY-MM-DD'
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1082, (v) => v);

let pool;
export function getPool() {
  if (!pool) {
    if (!config.databaseUrl) throw new Error('DATABASE_URL manquant');
    pool = new pg.Pool({
      connectionString: config.databaseUrl,
      max: 10,
      idleTimeoutMillis: 30000,
      ssl: config.pgSsl ? { rejectUnauthorized: false } : undefined,
    });
  }
  return pool;
}
export const query = (text, params) => getPool().query(text, params);

export async function withTx(fn) {
  const c = await getPool().connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
export async function closePool() { if (pool) { await pool.end(); pool = undefined; } }
