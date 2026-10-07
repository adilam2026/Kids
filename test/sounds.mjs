// Sons : ding-ding montant (gain/bonus), dong descendant (retrait), uniquement après confirmation serveur, au plus un par opération.
// Une espionne sur Web Audio enregistre les notes programmées (fréquences, durées, volume). ⚠️ On n'« écoute » pas : aucun test de rendu sonore réel.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { startServer, newFamily } from './helpers.js';

const S = await startServer();
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch();
let step = 0; const ok = (m) => console.log(`✓ ${++step}. ${m}`);

const SPY = () => {
  window.__snd = { osc: [], peak: 0, ctx: 0 };
  const Real = window.AudioContext;
  window.AudioContext = class extends Real {
    constructor(...a) { super(...a); window.__snd.ctx++; }
    createOscillator() {
      const o = super.createOscillator(), rec = { t: performance.now(), f0: null, f1: null, start: null, stop: null }; window.__snd.osc.push(rec);
      const fr = o.frequency, sv = fr.setValueAtTime.bind(fr), ex = fr.exponentialRampToValueAtTime.bind(fr);
      fr.setValueAtTime = (v, t) => { if (rec.f0 === null) rec.f0 = v; return sv(v, t); }; fr.exponentialRampToValueAtTime = (v, t) => { rec.f1 = v; return ex(v, t); };
      const st = o.start.bind(o), sp = o.stop.bind(o); o.start = (t) => { rec.start = t; return st(t); }; o.stop = (t) => { rec.stop = t; return sp(t); };
      return o;
    }
    createGain() { const g = super.createGain(), p = g.gain, ex = p.exponentialRampToValueAtTime.bind(p); p.exponentialRampToValueAtTime = (v, t) => { window.__snd.peak = Math.max(window.__snd.peak, v); return ex(v, t); }; return g; }
  };
};
const BROKEN = {
  'constructeur qui échoue': () => { window.AudioContext = function () { throw new Error('audio indisponible'); }; window.webkitAudioContext = undefined; },
  'Web Audio absent': () => { delete window.AudioContext; delete window.webkitAudioContext; },
  'createOscillator qui échoue': () => { const R = window.AudioContext; window.AudioContext = class extends R { createOscillator() { throw new Error('boom'); } }; },
};

// regroupe les oscillateurs par « son » (écart > 150 ms entre deux programmations)
async function sounds(P) {
  const osc = await P.evaluate(() => window.__snd.osc.map((o) => ({ ...o })));
  const groups = []; for (const o of osc) { const g = groups.at(-1); if (g && o.t - g.last < 150) { g.osc.push(o); g.last = o.t; } else groups.push({ osc: [o], last: o.t }); }
  return groups.map((g) => {
    const by = [...g.osc].sort((a, b) => a.start - b.start), first = by[0], last = by.at(-1);
    return { n: g.osc.length, span: Math.max(...g.osc.map((o) => o.stop)) - Math.min(...g.osc.map((o) => o.start)), firstFreq: first.f0, lastFreq: last.f0, glide: [first.f0, first.f1] };
  });
}
const isGain = (s) => s.n === 4 && s.lastFreq > s.firstFreq * 1.3 && s.span > 1.0 && s.span < 1.6;   // 2 notes, montant (durée mesurée par le rendu hors ligne, cf. plus bas)
const isLoss = (s) => s.n === 1 && s.glide[1] < s.glide[0] * 0.8 && s.span > 0.5 && s.span < 1.0;       // 1 note qui descend

async function device(cookie, { init = [SPY], route } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 700 }, isMobile: true, hasTouch: true });
  await ctx.addCookies([{ name: 'ph_session', value: decodeURIComponent(cookie.split('=')[1]), url: S.base }]);
  for (const f of init) await ctx.addInitScript(f);
  const P = await ctx.newPage(); const errs = []; P.on('pageerror', (e) => errs.push(e.message));
  if (route) await P.route('**/api/**', route);
  await P.goto(S.base); await P.waitForSelector('.child.mini');
  return { ctx, P, errs };
}
const bal = (P) => P.locator('.child.mini:first-child .bal b').innerText().then(Number);
const plus = async (P, tab) => { await P.click('.child.mini:first-child [data-act=points][data-sign="+"]'); if (tab) await P.click(`.seg button:has-text("${tab}")`); };
const minus = async (P) => { await P.click('.child.mini:first-child [data-act=points][data-sign="-"]'); await P.click('.seg button:has-text("Libre")'); };
const gone = (P) => P.waitForSelector('.panel', { state: 'detached', timeout: 15000 });
const txs = async (kid) => Number((await S.query(`SELECT count(*) FROM transactions WHERE child_id=$1 AND reason <> 'départ'`, [kid])).rows[0].count);

{ // 1. aucun son à l'ouverture des fenêtres, aux onglets, au refus « Point non validé »
  const { parent, kids } = await newFamily(S.base, 'a'); await parent.post(`/api/children/${kids[0]}/points`, { value: 20, reason: 'départ' });
  const { ctx, P, errs } = await device(parent.cookie);
  await plus(P); for (const t of ['Bonne action', 'Bonus', 'Libre']) await P.click(`.seg button:has-text("${t}")`);
  await P.click('[data-act=notValidated]'); await P.waitForSelector('.declined'); await P.click('#decl-ok'); await P.waitForSelector('.declined', { state: 'detached' });
  await minus(P); await P.click('.seg button:has-text("Comportement")'); await P.keyboard.press('Escape');
  assert.deepEqual(await sounds(P), [], 'aucun son à l’ouverture de + / − ni pour « Point non validé »');
  ok('aucun son à l’ouverture de « + » et « − », aux changements d’onglet, ni pour « Point non validé »');

  // 2. gain (action) : ding-ding montant ≈ 1 s, après confirmation, une seule fois malgré 8 clics
  await plus(P, 'Bonne action'); await P.click('.row:has-text("Ranger ses jouets")');
  await P.route('**/points', async (r) => { const resp = await r.fetch(); await new Promise((x) => setTimeout(x, 1500)); await r.fulfill({ response: resp }); });  // réponse en retard
  const btn = P.locator('[data-act=pointsConfirm]'); await btn.click();
  for (let i = 0; i < 8; i++) await btn.click({ force: true, timeout: 100 }).catch(() => {});
  await P.waitForTimeout(700); assert.equal((await sounds(P)).length, 0, 'pas de son tant que le serveur n’a pas confirmé'); assert.equal(await txs(kids[0]), 1, 'déjà enregistré côté serveur');
  await gone(P); await P.waitForTimeout(300);
  let s = await sounds(P); assert.equal(s.length, 1); assert.ok(isGain(s[0]), JSON.stringify(s[0])); assert.equal(await bal(P), 22);
  assert.ok((await P.evaluate(() => window.__snd.peak)) <= 0.2, 'volume modéré');
  await P.unroute('**/points');
  ok(`gain confirmé : 1 seul « ding-ding » montant (${s[0].firstFreq}→${s[0].lastFreq} Hz, ${s[0].span.toFixed(2)} s), joué après la réponse du serveur malgré 8 clics répétés`);

  // 3. bonus
  await plus(P, 'Bonus'); await P.click('.quick button >> nth=0'); await btn.click(); await gone(P); await P.waitForTimeout(300);
  s = await sounds(P); assert.equal(s.length, 2); assert.ok(isGain(s[1])); assert.equal(await bal(P), 27);
  ok('bonus confirmé : un « ding-ding » (un seul son de plus)');

  // 4. retrait : dong descendant ≈ 0,5 s
  await minus(P); await P.fill('input[data-bind=value]', '-3'); await P.fill('input[data-bind=reason]', 'Dispute'); await btn.click(); await gone(P); await P.waitForTimeout(300);
  s = await sounds(P); assert.equal(s.length, 3); assert.ok(isLoss(s[2]), JSON.stringify(s[2])); assert.equal(await bal(P), 24);
  assert.ok(s[2].glide[0] > s[2].glide[1]); assert.ok((await P.evaluate(() => window.__snd.peak)) <= 0.2);
  ok(`retrait confirmé : 1 « dong » descendant (${s[2].glide[0]}→${s[2].glide[1]} Hz, ${s[2].span.toFixed(2)} s), doux`);

  // 5. annulation (Annuler) : silencieuse ; resynchronisations (sondage, retour au premier plan) : aucun son supplémentaire
  await P.waitForSelector('.toast button:has-text("Annuler")'); await P.click('.toast button:has-text("Annuler")');
  await P.waitForSelector('.toast:has-text("Annulé")'); assert.equal(await bal(P), 27, 'l’annulation du retrait a bien eu lieu');
  await P.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); });
  await P.waitForTimeout(4500);
  assert.equal((await sounds(P)).length, 3, 'annulation et resynchronisations silencieuses');
  assert.deepEqual(errs, []); await ctx.close();
  ok('annulation (« Annuler ») et resynchronisations (sondage, focus) : aucun son supplémentaire (toujours 3 sons pour 3 opérations)');
}

{ // 5b. défi validé = gain (1 son) ; annulation et échange de récompense : silencieux
  const { parent, kids } = await newFamily(S.base, 'f'); await parent.post(`/api/children/${kids[0]}/points`, { value: 30, reason: 'départ' });
  const st = await parent.state(), toys = st.actions.find((a) => a.title === 'Ranger ses jouets');
  await parent.post('/api/challenges', { title: 'Jouets', icon: '🧸', actionId: toys.id, childIds: [kids[0]], startsOn: st.today, endsOn: st.today, target: 3, frequency: 'any', bonus: 5 });
  const { ctx, P, errs } = await device(parent.cookie);
  await P.click('.tabs a:has-text("Défis")'); await P.waitForSelector('button:has-text("Valider")');
  await P.click('button:has-text("Valider")'); await P.waitForSelector('.toast:has-text("+2")'); await P.waitForTimeout(300);
  let s = await sounds(P); assert.equal(s.length, 1); assert.ok(isGain(s[0]));
  await P.click('.toast button:has-text("Annuler")'); await P.waitForSelector('.toast:has-text("Annulé")'); await P.waitForTimeout(300);
  assert.equal((await sounds(P)).length, 1, 'annulation d’une validation : silencieuse');
  await P.click('.tabs a:has-text("Récompenses")'); await P.click('.card:has-text("Choisir le jeu familial") button:has-text("Échanger")'); await P.click('button:has-text("Échanger 10 pts")');
  await P.waitForSelector('.toast:has-text("à réaliser")'); await P.waitForTimeout(300);
  assert.equal((await sounds(P)).length, 1, 'échange de récompense : silencieux'); assert.deepEqual(errs, []);
  ok('défi validé : 1 « ding-ding » ; annulation et échange de récompense : silencieux');
  await ctx.close();
}

{ // 6. erreurs : jamais de son ; réessai après erreur : 1 son ; réponse perdue : 1 son au réessai, 1 mouvement
  const { parent, kids } = await newFamily(S.base, 'b');
  let mode = 'error-first', n = 0;
  const { ctx, P } = await device(parent.cookie, { route: async (r) => {
    const isPts = r.request().method() === 'POST' && /\/points$/.test(r.request().url());
    if (isPts) n++;
    if (isPts && mode === 'error-first' && n === 1) return r.fulfill({ status: 500, contentType: 'application/json', body: '{"ok":false,"error":"Erreur serveur"}' });
    if (isPts && mode === 'drop-first' && n === 1) { await r.fetch(); return r.abort('failed'); }
    return r.continue();
  } });
  await plus(P, 'Bonus'); await P.click('.quick button >> nth=0'); const btn = P.locator('[data-act=pointsConfirm]'); await btn.click();
  await P.waitForSelector('#sheet-err .err'); await P.waitForTimeout(400);
  assert.equal((await sounds(P)).length, 0, 'aucun son pour une erreur serveur');
  await btn.click(); await gone(P); await P.waitForTimeout(300);
  let s = await sounds(P); assert.equal(s.length, 1); assert.ok(isGain(s[0])); assert.equal(await txs(kids[0]), 1);
  ok('erreur serveur : aucun son ; réessai réussi : exactement 1 son, 1 mouvement');
  // erreur métier (règle « une fois par nuit ») : aucun son
  mode = 'none';
  const night = async () => { await plus(P, 'Bonne action'); await P.click('.row:has-text("Faire une nuit complète")'); await btn.click(); };
  await night(); await gone(P); await P.waitForTimeout(300); assert.equal((await sounds(P)).length, 2);
  await night(); await P.waitForSelector('#sheet-err .err'); await P.waitForTimeout(400); assert.equal((await sounds(P)).length, 2, 'aucun son pour un refus métier'); await P.keyboard.press('Escape');
  ok('refus métier (déjà validé cette nuit) : aucun son supplémentaire');
  // réponse perdue
  mode = 'drop-first'; n = 0;
  await plus(P, 'Bonus'); await P.click('.quick button >> nth=0'); await btn.click();
  await P.waitForSelector('#sheet-err .err'); await P.waitForTimeout(400); assert.equal((await sounds(P)).length, 2, 'réponse perdue : pas de son (non confirmé)');
  await btn.click(); await gone(P); await P.waitForTimeout(300);
  assert.equal((await sounds(P)).length, 3); assert.equal(await txs(kids[0]), 3, 'réessai identique : un seul mouvement de plus');
  ok('réponse perdue après enregistrement : aucun son, puis un seul son au réessai confirmé (1 seul mouvement)');
  await ctx.close();
}

{ // 7. autre téléphone : synchronisation silencieuse
  const { parent, kids } = await newFamily(S.base, 'c');
  const A = await device(parent.cookie), B = await device(parent.cookie);
  await plus(A.P, 'Bonus'); await A.P.click('.quick button >> nth=0'); await A.P.locator('[data-act=pointsConfirm]').click(); await gone(A.P);
  await B.P.waitForFunction(() => document.querySelector('.child.mini:first-child .bal b').innerText === '5', null, { timeout: 6000 });
  await B.P.waitForTimeout(1500);
  assert.equal((await sounds(B.P)).length, 0, 'l’autre téléphone reste silencieux'); assert.equal((await sounds(A.P)).length, 1);
  assert.equal(await B.P.evaluate(() => window.__snd.ctx), 0, 'aucun contexte audio créé sur l’autre téléphone (aucun toucher)');
  ok('synchronisation sur l’autre téléphone : silencieuse (0 son), le téléphone qui enregistre en joue 1');
  await A.ctx.close(); await B.ctx.close();
}

{ // 8. réglage « Sons » : désactivation, mémoire par appareil, aucun son quand coupé
  const { parent, kids } = await newFamily(S.base, 'd');
  const A = await device(parent.cookie);
  await A.P.click('.tabs a:has-text("Famille")'); const row = A.P.locator('[data-act=toggleSound]');
  assert.match(await row.innerText(), /Sons[\s\S]*Activés[\s\S]*volume multimédia/); assert.equal(await row.getAttribute('aria-checked'), 'true');
  assert.deepEqual(await sounds(A.P), [], 'basculer le réglage ne joue aucun son');
  await row.click(); assert.match(await row.innerText(), /Désactivés/); assert.equal(await row.getAttribute('aria-checked'), 'false');
  assert.deepEqual(await sounds(A.P), []);
  await A.P.click('.tabs a:has-text("Enfants")');
  await plus(A.P, 'Bonus'); await A.P.click('.quick button >> nth=0'); await A.P.locator('[data-act=pointsConfirm]').click(); await gone(A.P);
  await minus(A.P).catch(() => {}); await A.P.keyboard.press('Escape');
  await A.P.waitForTimeout(300); assert.equal((await sounds(A.P)).length, 0, 'son coupé : aucun son'); assert.equal(await bal(A.P), 5, 'les points sont bien enregistrés');
  await A.P.reload(); await A.P.waitForSelector('.child.mini'); await A.P.click('.tabs a:has-text("Famille")');
  assert.equal(await A.P.locator('[data-act=toggleSound]').getAttribute('aria-checked'), 'false', 'réglage mémorisé après rechargement');
  assert.equal(JSON.parse(await A.P.evaluate(() => localStorage.getItem('ph_prefs'))).sound, false);
  const B = await device(parent.cookie); await B.P.click('.tabs a:has-text("Famille")');
  assert.equal(await B.P.locator('[data-act=toggleSound]').getAttribute('aria-checked'), 'true', 'réglage propre à chaque appareil');
  // réactivation : le son revient
  await A.P.locator('[data-act=toggleSound]').click(); await A.P.click('.tabs a:has-text("Enfants")');
  await plus(A.P, 'Bonus'); await A.P.click('.quick button >> nth=0'); await A.P.locator('[data-act=pointsConfirm]').click(); await gone(A.P); await A.P.waitForTimeout(300);
  assert.equal((await sounds(A.P)).length, 1);
  ok('réglage « Sons » : coupé = aucun son (points enregistrés), mémorisé après rechargement, propre à chaque appareil, réactivable (sans son de test)');
  await A.ctx.close(); await B.ctx.close();
}

// 9. panne audio : l'enregistrement des points n'est jamais empêché
for (const [name, init] of Object.entries(BROKEN)) {
  const { parent, kids } = await newFamily(S.base, 'e');
  const { ctx, P, errs } = await device(parent.cookie, { init: [init] });
  await plus(P, 'Bonus'); await P.click('.quick button >> nth=0'); await P.locator('[data-act=pointsConfirm]').click(); await gone(P);
  assert.equal(await bal(P), 5); assert.match(await P.innerText('.toast'), /\+5 → 5 pts/); assert.equal(await txs(kids[0]), 1); assert.deepEqual(errs, [], 'aucune erreur JS');
  await minus(P).catch(() => {}); await P.keyboard.press('Escape');
  await ctx.close();
}
ok('panne audio (constructeur qui échoue, Web Audio absent, createOscillator qui échoue) : points enregistrés, solde et message affichés, aucune erreur');

// 10. RENDU HORS LIGNE du vrai code (signal calculé, sans haut-parleur) : durée audible, niveau, fréquences
{
  const { parent } = await newFamily(S.base, 'g'); await parent.post(`/api/children/${(await parent.state()).children[0].id}/points`, { value: 20, reason: 'départ' });
  async function render(kind) {
    const ctx = await browser.newContext({ viewport: { width: 360, height: 700 }, isMobile: true, hasTouch: true });
    await ctx.addCookies([{ name: 'ph_session', value: decodeURIComponent(parent.cookie.split('=')[1]), url: S.base }]);
    await ctx.addInitScript(() => { window.__off = []; window.AudioContext = class extends OfflineAudioContext { constructor() { super(1, 44100 * 3, 44100); window.__off.push(this); } }; });
    const P = await ctx.newPage(); await P.goto(S.base); await P.waitForSelector('.child.mini');
    if (kind === 'gain') { await plus(P, 'Bonus'); await P.click('.quick button >> nth=0'); } else { await minus(P); await P.fill('input[data-bind=value]', '-3'); await P.fill('input[data-bind=reason]', 'x'); }
    await P.locator('[data-act=pointsConfirm]').click(); await gone(P); await P.waitForTimeout(200);
    const r = await P.evaluate(async () => {
      const buf = await window.__off[0].startRendering(), d = buf.getChannelData(0), sr = buf.sampleRate; let peak = 0, last = 0, first = -1;
      for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; if (a > 0.003) { last = i; if (first < 0) first = i; } }
      const win = 2205, f = []; for (let s = first; s + win < last; s += win * 2) { let zc = 0; for (let i = s + 1; i < s + win; i++) if ((d[i - 1] < 0) !== (d[i] < 0)) zc++; f.push(Math.round(zc / 2 / (win / sr))); }
      return { audible: (last - first) / sr, peak, f };
    });
    await ctx.close(); return r;
  }
  const g = await render('gain'), l = await render('loss');
  assert.ok(g.audible > 0.85 && g.audible < 1.3, `ding-ding audible ${g.audible.toFixed(2)} s`); assert.ok(g.peak <= 0.25 && g.peak < 0.99, 'volume modéré, sans saturation');
  assert.ok(g.f[0] < 850 && g.f.at(-1) > 1100 && g.f.at(-1) < 1250, 'deux notes montantes : ' + g.f); assert.ok(g.f.every((x, i) => i === 0 || x >= g.f[i - 1] - 15), 'jamais descendant');
  assert.ok(l.audible > 0.4 && l.audible < 0.75, `dong audible ${l.audible.toFixed(2)} s`); assert.ok(l.peak <= 0.25);
  assert.ok(l.f[0] > l.f.at(-1) && l.f[0] < 420 && l.f.at(-1) > 240, 'note qui descend : ' + l.f); assert.ok(l.f.every((x, i) => i === 0 || x <= l.f[i - 1] + 15), 'jamais montant');
  ok(`rendu hors ligne : ding-ding audible ${g.audible.toFixed(2)} s (notes ${g.f[0]}→${g.f.at(-1)} Hz, crête ${(20 * Math.log10(g.peak)).toFixed(1)} dBFS) ; dong audible ${l.audible.toFixed(2)} s (${l.f[0]}→${l.f.at(-1)} Hz, crête ${(20 * Math.log10(l.peak)).toFixed(1)} dBFS) ; ni saturation ni cri`);
}

await browser.close(); await S.close();
console.log('\nSons : tous les scénarios passent (Chromium, espionne Web Audio — pas d’écoute réelle).');
