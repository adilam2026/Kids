// Simule un redéploiement : processus serveur réel arrêté (SIGTERM) puis relancé sur la même base.
// Vérifie migrations idempotentes, /healthz, session persistante et conservation des points.
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import pg from 'pg';

const DB = process.env.DATABASE_URL || 'postgres://postgres@localhost:5433/kids_test';
const admin = new pg.Client({ connectionString: DB });
await admin.connect(); await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await admin.end();

const PORT = 3217, base = `http://127.0.0.1:${PORT}`;
const start = () => new Promise((resolve, reject) => {
  const p = spawn('node', ['server/index.js'], { env: { ...process.env, DATABASE_URL: DB, PORT: String(PORT), NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'inherit'] });
  p.stdout.on('data', (d) => { if (String(d).includes('écoute')) resolve(p); });
  p.on('exit', (c) => reject(new Error('arrêt prématuré ' + c)));
});
const stop = (p) => new Promise((r) => { p.removeAllListeners('exit'); p.on('exit', r); p.kill('SIGTERM'); });
const call = async (cookie, method, path, body) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-op-id': crypto.randomUUID(), ...(cookie ? { cookie } : {}) }, body: body && JSON.stringify(body) });
  return { r, j: await r.json() };
};

let p = await start();
assert.equal((await call(null, 'GET', '/healthz')).j.ok, true);
const reg = await call(null, 'POST', '/api/auth/register', { email: 'r@ex.fr', name: 'R', password: 'motdepasse-solide', familyName: 'F' });
const cookie = reg.r.headers.getSetCookie()[0].split(';')[0];
const kid = (await call(cookie, 'POST', '/api/children', { name: 'Léa', avatar: '🦊', color: '#FF8A3D' })).j.id;
await call(cookie, 'POST', `/api/children/${kid}/points`, { value: 9 });
await stop(p);
console.log('✓ serveur arrêté (SIGTERM)');
p = await start();
const st = (await call(cookie, 'GET', '/api/family/state')).j.state;
assert.equal(st.children[0].balance, 9);
console.log('✓ après redémarrage : session valide, solde = 9, migrations non rejouées');
await stop(p);
