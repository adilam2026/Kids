import crypto from 'node:crypto';
import { createApp } from '../server/app.js';
import { migrate } from '../server/migrate.js';
import { getPool, closePool } from '../server/db.js';
import { limits, resetLimits } from '../server/util.js';

import { resetTestDatabase } from './guard.js';

export async function startServer() {
  await resetTestDatabase();
  await migrate(() => {});
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  limits.enabled = false; resetLimits();
  return { base, query: (...a) => getPool().query(...a), close: async () => { server.close(); await closePool(); } };
}

export class Client {
  constructor(base) { this.base = base; this.cookie = ''; }
  async req(method, path, body, { op, headers = {} } = {}) {
    const h = { ...headers };
    if (body !== undefined) h['content-type'] = 'application/json';
    if (this.cookie) h.cookie = this.cookie;
    if (method !== 'GET') h['x-op-id'] = op || crypto.randomUUID();
    const r = await fetch(this.base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.getSetCookie?.() || [];
    for (const c of sc) {
      const [kv] = c.split(';');
      if (/Max-Age=0/i.test(c)) this.cookie = ''; else this.cookie = kv;
    }
    let json = null;
    try { json = await r.json(); } catch {}
    return { status: r.status, body: json };
  }
  get(p) { return this.req('GET', p); }
  post(p, b = {}, o) { return this.req('POST', p, b, o); }
  patch(p, b = {}, o) { return this.req('PATCH', p, b, o); }
  delete(p) { return this.req('DELETE', p); }
  async state() { const r = await this.get('/api/family/state'); return r.body.state; }
}

export async function newFamily(base, tag = '') {
  const id = crypto.randomUUID().slice(0, 8);
  const parent = new Client(base);
  const r = await parent.post('/api/auth/register', { email: `p-${id}${tag}@ex.fr`, name: 'Maman', password: 'motdepasse-solide', familyName: 'Les Test' });
  if (r.status !== 201) throw new Error('register ' + JSON.stringify(r.body));
  const kids = [];
  for (const [name, avatar, color] of [['Léa', '🦊', '#FF8A3D'], ['Tom', '🐻', '#3BA4F5'], ['Zoé', '🐰', '#8E6CEF']]) {
    const c = await parent.post('/api/children', { name, avatar, color, age: 5 });
    kids.push(c.body.id);
  }
  return { parent, kids, id };
}
