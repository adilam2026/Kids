import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const md = fs.readFileSync('store/listing-fr.md', 'utf8');
const block = (title) => { const m = md.split(`## ${title}`)[1]?.match(/```\n([\s\S]*?)```/); assert.ok(m, title); return m[1].trim(); };
const app = fs.readFileSync('public/app.js', 'utf8');
const seed = fs.readFileSync('server/seed.js', 'utf8');
const authSrc = fs.readFileSync('server/routes/auth.js', 'utf8');

test('limites de longueur Google Play', () => {
  assert.ok(block('Titre').length <= 30);
  assert.ok(block('Description courte (≤ 80)').length <= 80);
  assert.ok(block('Description complète').length <= 4000);
  assert.ok(block('Notes de version (« Nouveautés », ≤ 500 caractères)').length <= 500);
});

test('chaque fonction annoncée existe réellement dans le code', () => {
  const claims = {
    'profils enfants avec avatars': /avatar/,
    'historique': /Historique/,
    'actions prédéfinies': /DEFAULT_ACTIONS/,
    'défis individuels ou collectifs': /collective/,
    'récompenses': /Récompenses/,
    'invitation par code': /J’ai un code d’invitation/,
    'sons désactivables': /toggleSound/,
    'suppression de compte dans l’application': /delacc/,
    'nommer propriétaire': /Nommer propriétaire/,
    'point non validé': /Point non validé/,
    'récupération par e-mail': /forgot/,
    'actions nuit / assiette': /nuit complète|Nuit complète/i,
  };
  const all = app + seed + authSrc;
  for (const [k, re] of Object.entries(claims)) assert.match(all, re, `fonction annoncée introuvable : ${k}`);
});

test('mentions interdites : pas de promesse non vérifiable', () => {
  const t = md.toLowerCase();
  for (const bad of ['meilleure application', '#1', 'gratuit à vie', 'conforme rgpd', 'approuvé par google', 'certifié', 'hors connexion complet']) assert.ok(!t.includes(bad), bad);
});

test('« pas de publicité / pistage / achat » : aucune dépendance ni permission correspondante', () => {
  const manifest = fs.readFileSync('android/app/src/main/AndroidManifest.xml', 'utf8');
  assert.deepEqual([...manifest.matchAll(/uses-permission[^>]*android:name="([^"]+)"/g)].map((m) => m[1]), ['android.permission.INTERNET']);
  const gradle = fs.readFileSync('android/app/build.gradle', 'utf8') + fs.readFileSync('package.json', 'utf8');
  for (const sdk of ['admob', 'firebase', 'play-services-ads', 'billingclient', 'analytics', 'crashlytics', 'facebook', 'sentry']) assert.ok(!gradle.toLowerCase().includes(sdk), `dépendance ${sdk}`);
  assert.ok(!/gtag|googletagmanager|analytics\.js|fbq\(|sentry/i.test(app + fs.readFileSync('public/index.html', 'utf8')));
});

test('par défaut, aucune action de malus pour pleurs, besoins essentiels ou apprentissage', () => {
  assert.ok(!/pleur|apprentissage|besoin/i.test((seed.match(/DEFAULT_ACTIONS[\s\S]*?\];/) || [''])[0].replace(/note:[^\n]*/g, '')));
});
