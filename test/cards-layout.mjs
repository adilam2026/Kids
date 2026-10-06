// Mise en page des cartes de la liste Enfants (360×600) : deux cartes avec défi en cours, au-dessus de la navigation.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { resetTestDatabase } from './guard.js';
import { createApp } from '../server/app.js';
import { migrate } from '../server/migrate.js';
import { closePool } from '../server/db.js';
import { Client, newFamily } from './helpers.js';

await resetTestDatabase(); await migrate(() => {});
const server = createApp().listen(0); await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
const { parent, kids } = await newFamily(base);
const st = (await parent.state()); const toys = st.actions.find((a) => a.title.startsWith('Ranger ses jouets'));
for (const k of kids.slice(0, 2)) await parent.post('/api/challenges', { title: 'Jouets', icon: '🧸', actionId: toys.id, childIds: [k], startsOn: st.today, endsOn: st.today, target: 3, frequency: 'any', bonus: 5 });
await parent.post(`/api/children/${kids[0]}/points`, { value: 4 });

const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 360, height: 600 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'fr-FR' });
await ctx.addCookies([{ name: 'ph_session', value: decodeURIComponent(parent.cookie.split('=')[1]), url: base }]);
const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
await p.goto(base); await p.waitForSelector('.child.mini'); await p.waitForTimeout(500);

const m = await p.evaluate(() => {
  const cards = [...document.querySelectorAll('.child.mini')].slice(0, 2);
  const tabs = document.querySelector('.tabs').getBoundingClientRect();
  const top = document.querySelector('.topbar').getBoundingClientRect();
  const px = (el, prop) => parseFloat(getComputedStyle(el)[prop]);
  return {
    scrollY: scrollY, tabsTop: tabs.top, headerBottom: top.bottom,
    cards: cards.map((c) => { const r = c.getBoundingClientRect(); const b = c.querySelectorAll('.pm .btn');
      return { top: r.top, bottom: r.bottom, h: r.height, hasChallenge: !!c.querySelector('.chip'), avatar: c.querySelector('.avatar').getBoundingClientRect().width,
        name: px(c.querySelector('h2'), 'fontSize'), pts: px(c.querySelector('.bal b'), 'fontSize'), bar: c.querySelector('.bar').getBoundingClientRect().height,
        rewardLines: Math.round(c.querySelector('.nl .t').getBoundingClientRect().height / px(c.querySelector('.nl .t'), 'lineHeight')),
        btnH: [...b].map((x) => x.getBoundingClientRect().height), btnBottom: Math.max(...[...b].map((x) => x.getBoundingClientRect().bottom)) }; }),
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
});
console.log(JSON.stringify(m, null, 1));
for (const c of m.cards) {
  assert.ok(c.hasChallenge, 'chaque carte porte un défi en cours');
  assert.equal(c.avatar, 48); assert.equal(c.name, 20); assert.equal(c.pts, 32); assert.ok(c.bar <= 6.5);
  assert.ok(c.h <= 206 && c.h >= 180, `hauteur de carte ${c.h}`);
  assert.ok(c.btnH.every((h) => h >= 44), 'boutons ≥ 44 px');
  assert.ok(c.btnBottom <= m.tabsTop - 4, `boutons masqués par la navigation (${c.btnBottom} > ${m.tabsTop})`);
  assert.ok(c.rewardLines <= 1.2, 'récompense sur une ligne');
}
assert.equal(m.scrollY, 0); assert.ok(m.cards[0].top >= m.headerBottom && m.cards[1].bottom <= m.tabsTop, 'deux cartes entières entre l’en-tête et la navigation');
assert.ok(m.overflowX <= 0);
await p.screenshot({ path: '/tmp/ph-shots/cards-360x600.png' });

// les actions fonctionnent toujours depuis la carte compacte
await p.click('.child.mini:first-child [data-act=points][data-sign="+"]'); await p.waitForSelector('.panel');
const panel = await p.evaluate(() => ({ title: getComputedStyle(document.querySelector('.panel-head h2')).fontSize, q: document.querySelector('.quick button').getBoundingClientRect().height }));
assert.ok(parseFloat(panel.title) >= 20 && panel.q >= 56, 'fenêtre de saisie inchangée ' + JSON.stringify(panel));
await p.keyboard.press('Escape');
await p.click('.child.mini:first-child .child-head'); await p.waitForSelector('.avatar.lg');
const prof = await p.evaluate(() => ({ av: document.querySelector('.avatar.lg').getBoundingClientRect().width, pts: parseFloat(getComputedStyle(document.querySelector('.child .bal b')).fontSize) }));
assert.equal(prof.av, 88); assert.equal(prof.pts, 36, 'page enfant inchangée (règle ≤360 px existante : 2rem) ' + JSON.stringify(prof));
assert.deepEqual(errs, []);
await browser.close(); server.close(); await closePool();
console.log('OK : 2 cartes avec défi tiennent au-dessus de la navigation (360×600) ; fenêtres et page enfant inchangées');
