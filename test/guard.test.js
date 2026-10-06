import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeTestUrl } from './guard.js';

const refused = (url, env = {}) => assert.throws(() => assertSafeTestUrl(url, env), /REFUSÉ/);
const ok = (url, env = {}) => assert.equal(assertSafeTestUrl(url, env), url);

test('garde-fous : bases et environnements refusés', () => {
  refused('postgres://u:p@postgres.railway.internal:5432/railway');
  refused('postgres://u:p@viaduct.proxy.rlwy.net:1234/railway_test'); // Railway, même nommée _test
  refused('postgres://postgres@localhost:5432/petits_heros');          // pas _test
  refused('postgres://postgres@db.example.com:5432/kids_test');        // hôte distant
  refused('postgres://postgres@localhost:5432/kids_test', { NODE_ENV: 'production' });
  refused('postgres://postgres@localhost:5432/kids_test', { DATABASE_URL: 'postgres://x@localhost:5432/kids_test' }); // = base de l'app
  refused('pas une url');
});
test('garde-fous : bases de test locales acceptées', () => {
  ok('postgres://postgres@localhost:5433/kids_test');
  ok('postgres://postgres@127.0.0.1:5432/ph_test', { DATABASE_URL: 'postgres://x@localhost:5432/petits_heros' });
  ok('postgres://u@db.example.com/ph_test', { PH_TEST_ALLOW_REMOTE: '1' });
});
