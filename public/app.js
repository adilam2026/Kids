// Petits Héros — application mobile (PWA). Aucun build : modules ES natifs.
// Règle d'or : aucune opération n'est affichée comme réussie tant que le serveur ne l'a pas confirmée.

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`);

const AVATARS = ['🦊', '🐻', '🐰', '🐼', '🦁', '🐯', '🐸', '🐵', '🦄', '🐙', '🐧', '🐨', '🦉', '🐶', '🐱', '🐢', '🐘', '🦒', '🐬', '🦋'];
const COLORS = ['#FF8A3D', '#F5617A', '#8E6CEF', '#3BA4F5', '#2FBF9B', '#F2B705', '#E8590C', '#6C8E3A'];
const ICONS = ['⭐', '🧸', '🛏️', '🎒', '👕', '🛁', '🪥', '🍽️', '🤝', '🧺', '⏳', '💪', '💡', '🧹', '📚', '🎨', '🎵', '🐕', '🪴', '🚲', '⚽', '🎲', '📖', '🌳', '🍦', '🎬', '🏊', '🎂', '🎁', '🌈'];
const TYPE = {
  gain: { ic: '⭐', label: 'Gain' }, bonus: { ic: '🎁', label: 'Bonus' }, malus: { ic: '➖', label: 'Retrait' },
  reward: { ic: '🎟️', label: 'Récompense' }, cancel: { ic: '↩️', label: 'Annulation' },
};

// ---------- état ----------
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* stockage indisponible */ } };

// ---------- application Android (Capacitor) ----------
// Le WebView n'est pas de même origine que l'API : pas de cookies, mais un jeton Bearer conservé dans le
// stockage privé de l'application (@capacitor/preferences). Le navigateur garde le cookie HttpOnly.
const NATIVE = !!window.PHNative?.isNative;
const API_BASE = window.PH_API_BASE || '';
const APP_BUILD = Number(window.PH_BUILD || 0), APP_VERSION = window.PH_VERSION || 'web';

const S = {
  token: '', upgrade: false, me: null, st: null, offline: false, busy: false, sheet: null, pulse: null,
  prefs: { sound: true, ...load('ph_prefs', { anim: !matchMedia('(prefers-reduced-motion: reduce)').matches }) }, lock: load('ph_lock', { on: false }),
  rewardChild: null, hist: null, auth: { mode: 'login', error: '', info: '' }, libOpen: false,
};

// ---------- données locales ----------
const CACHE_MAX_AGE = 7 * 86400000; // une copie hors connexion plus vieille est ignorée
// Efface tout ce qui appartient à la famille sur cet appareil (déconnexion, session révoquée, autre compte).
function wipeLocal() {
  try { localStorage.removeItem('ph_cache'); } catch { /* indisponible */ }
  stopPolling();
  S.st = null; S.hist = null; S.rewardChild = null; S.sheet = null; S.undo = null; S.recovery = null; S.declined = false;
  intents.clear();
  if (NATIVE) { S.token = ''; window.PHNative.clearToken(); }
  const sh = document.getElementById('sheet'); if (sh) sh.innerHTML = '';
  const t = document.getElementById('toast'); if (t) t.innerHTML = '';
  document.body.classList.remove('sheet-open');
}
function readCache(userId) {
  const c = load('ph_cache', null);
  if (!c?.st || !c.userId || (userId && c.userId !== userId) || Date.now() - c.at > CACHE_MAX_AGE) return null;
  return c;
}

// ---------- API ----------
// Délai maximal d'une requête : au-delà, l'issue est INCONNUE (le serveur a peut-être enregistré) → on propose de réessayer avec le MÊME identifiant d'opération.
const REQUEST_TIMEOUT = Number(window.PH_TIMEOUT_MS) || 20000;
const intents = new Map(); // intention -> identifiant d'opération (conservé tant que la réponse du serveur est inconnue)
class ApiError extends Error { constructor(m, status, code) { super(m); this.status = status; this.code = code; } }

async function api(method, path, body, key) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (NATIVE) { headers['x-client'] = `native-android/${APP_BUILD}`; if (S.token) headers.authorization = `Bearer ${S.token}`; }
  if (method !== 'GET') {
    const k = key || uid();
    if (!intents.has(k)) intents.set(k, uid());
    headers['x-op-id'] = intents.get(k);
  }
  let r, j = null;
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT);
  try {
    r = await fetch(API_BASE + path, { method, headers, signal: ctl.signal, body: body === undefined ? undefined : JSON.stringify(body), credentials: NATIVE ? 'omit' : 'same-origin' });
    try { j = await r.json(); } catch { /* corps vide */ }
  } catch (e) {
    // L'intention (identifiant d'opération) est CONSERVÉE : réessayer ne peut pas créer de doublon.
    if (e?.name === 'AbortError') throw new ApiError(method === 'GET' ? 'Le serveur met trop de temps à répondre.' : 'Le serveur met trop de temps à répondre : l’enregistrement n’est pas confirmé. Réessaie : même si la première demande est passée, aucun doublon ne sera créé.', 0, 'timeout');
    markOffline(true);
    throw new ApiError(method === 'GET' ? 'Pas de connexion.' : 'Réponse non reçue (connexion perdue) : l’enregistrement n’est pas confirmé. Réessaie : même si la première demande est passée, aucun doublon ne sera créé.', 0, 'network');
  } finally { clearTimeout(timer); }
  markOffline(false);
  if (key) intents.delete(key); // réponse reçue : l'intention est réglée
  if (r.status === 426) { S.upgrade = true; render(); throw new ApiError(j?.error || 'Mise à jour nécessaire', 426, 'upgrade_required'); }
  if (NATIVE && j?.token) { S.token = j.token; await window.PHNative.setToken(j.token); }
  if (!r.ok) {
    if (r.status === 401 && S.me) { S.me = null; wipeLocal(); S.auth = { mode: 'login', error: '', info: 'Session terminée : reconnecte-toi.' }; go('#/'); render(); }
    throw new ApiError(j?.error || 'Erreur', r.status, j?.code);
  }
  return j;
}
function markOffline(v) {
  if (S.offline === v) return;
  S.offline = v;
  document.body.classList.toggle('offline', v);
  render();
}
const canEdit = () => !S.lock.on && S.st?.me;

// ---------- navigation ----------
const go = (h) => { if (location.hash !== h) location.hash = h; };
const route = () => {
  const h = location.hash.replace(/^#\/?/, '');
  const [a, b] = h.split('/');
  return { a: a || 'children', b };
};

// ---------- synchronisation ----------
let timer = null, polling = false;
function startPolling() {
  stopPolling();
  const tick = async () => {
    if (document.visibilityState === 'visible') await refresh();
    timer = setTimeout(tick, 3000);
  };
  timer = setTimeout(tick, 3000);
}
function stopPolling() { clearTimeout(timer); timer = null; }

async function refresh(force = false) {
  if (polling) { if (!force) return; while (polling) await new Promise((r) => setTimeout(r, 40)); }
  polling = true;
  try {
    const q = !force && S.st ? `?since=${S.st.rev}` : '';
    const r = await api('GET', `/api/family/state${q}`);
    if (r.changed) {
      S.st = r.state; save('ph_cache', { st: r.state, at: Date.now(), userId: r.state.me.id });
      if (!S.sheet) render(); else renderSheet(true);
      if (route().a === 'child') loadHistory(true);
    }
  } catch (e) {
    if (e.code === 'pending') setTimeout(boot, 0);
  } finally { polling = false; }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.st) refresh(); });
window.addEventListener('online', () => { if (S.st) refresh(); else boot(); });
window.addEventListener('offline', () => markOffline(true));
window.addEventListener('focus', () => { if (S.st) refresh(); });

// ---------- démarrage ----------
let pendingTimer = null;
async function boot() {
  clearTimeout(pendingTimer);
  try {
    const me = await api('GET', '/api/auth/me');
    S.me = me.user ? me : null;
    // autre compte (ou aucun) que celui des données locales : on les efface avant tout affichage
    const cached = load('ph_cache', null);
    if (!S.me || (cached && cached.userId !== S.me.user.id)) wipeLocal();
  } catch {
    const c = readCache();
    if (c) { S.me = { user: c.st.me, membership: { status: 'active', role: c.st.me.role }, recoveryRemaining: 99 }; S.st = c.st; render(); return; }
    S.me = null; render(); return;
  }
  if (S.me && S.me.membership?.status === 'active') {
    try { await refresh(true); startPolling(); } catch (e) { if (e.status === 0) { const c = readCache(S.me.user.id); if (c) S.st = c.st; } }
  } else if (S.me?.membership?.status === 'pending') {
    pendingTimer = setTimeout(boot, 4000);
  }
  const m = /^#\/reset\/(.+)$/.exec(location.hash);
  if (m && !S.me) { S.auth.mode = 'reset'; S.auth.token = decodeURIComponent(m[1]); }
  render();
}

// ---------- utilitaires d'affichage ----------
const kid = (id) => S.st.children.find((c) => c.id === id);
const activeKids = () => S.st.children.filter((c) => !c.archived);
const eligible = (item, childId) => !item.child_ids?.length || item.child_ids.includes(childId);
const eligibleReward = (rw, childId) => !rw.child_ids.length || rw.child_ids.includes(childId);
const pts = (n) => `${n} pt${Math.abs(n) > 1 ? 's' : ''}`;
const signed = (n) => (n > 0 ? `+${n}` : `−${Math.abs(n)}`);
const dday = (d) => new Date(`${d}T12:00:00`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
function fmtWhen(iso) {
  const d = new Date(iso), now = new Date();
  const t = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const days = Math.round((new Date(now.toDateString()) - new Date(d.toDateString())) / 86400000);
  if (days === 0) return `Aujourd’hui ${t}`;
  if (days === 1) return `Hier ${t}`;
  return `${d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })} ${t}`;
}
function nextReward(c) {
  const rws = S.st.rewards.filter((r) => !r.archived && eligibleReward(r, c.id)).sort((a, b) => a.cost - b.cost);
  const up = rws.find((r) => r.cost > c.balance);
  if (up) return { rw: up, pct: Math.min(100, Math.round((c.balance / up.cost) * 100)), left: up.cost - c.balance };
  const aff = rws.filter((r) => r.cost <= c.balance).pop();
  return aff ? { rw: aff, pct: 100, left: 0 } : null;
}
const activeChallenges = (c) => S.st.challenges.filter((ch) => ch.childIds.includes(c.id) && !ch.completed && !ch.expired && !ch.upcoming);
const nm = () => (S.offline ? ' needs-online' : '');

// ---------- installation (PWA) ----------
const isStandalone = () => NATIVE || matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
function platform() {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return /CriOS|FxiOS|EdgiOS|OPiOS|GSA\//.test(ua) ? 'ios-other' : 'ios';
  if (/Android/.test(ua)) return /SamsungBrowser/.test(ua) ? 'android-samsung' : 'android';
  return 'other';
}
const installCard = () => isStandalone()
  ? `<div class="card" style="text-align:center">✅ ${NATIVE ? `Application Android · version ${esc(APP_VERSION)} (build ${APP_BUILD})` : 'Application installée sur cet appareil'}</div>`
  : `<div class="card" style="background:var(--soft)"><div style="display:flex;gap:12px;align-items:center"><div style="font-size:2.2rem">📲</div>
      <div style="flex:1"><b>Installer l’application</b><div class="muted small">Icône sur l’écran d’accueil, plein écran</div></div></div>
      <button class="btn primary block" style="margin-top:10px" data-act="installApp">Installer l’application</button></div>`;

// ---------- sons ----------
// Générés localement avec Web Audio (aucun fichier, aucun téléchargement, aucun droit d'auteur).
//  • gain / bonus : « ding-ding » montant et joyeux (~1 s) ; retrait : « dong » descendant et doux (~0,5 s).
//  • joués UNIQUEMENT quand le serveur a confirmé l'enregistrement, au plus une fois par mouvement (clics répétés, réessai, resynchronisation : jamais de second son).
//  • le son ne doit JAMAIS gêner l'enregistrement : tout est protégé par try/catch et exécuté après la mise à jour de l'écran.
//  • volume modéré ; Android : suit le volume MULTIMÉDIA du téléphone (le comportement en mode silencieux n'est pas garanti).
let audioCtx = null;
const soundedOps = new Set();
function getAudio() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    audioCtx ||= new AC();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return audioCtx;
  } catch { return null; }
}
// « Amorçage » discret au premier toucher (politique de lecture automatique des navigateurs) : crée le contexte, n'émet aucun son.
document.addEventListener('pointerdown', () => { if (S.prefs.sound && !audioCtx) getAudio(); }, { passive: true });
function bell(ctx, t0, freq, dur, peak) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + 0.012);        // attaque courte
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);           // résonance qui s'éteint
  g.connect(ctx.destination);
  for (const [mult, amp] of [[1, 1], [2.01, 0.28]]) {            // fondamentale + harmonique (timbre de clochette)
    const o = ctx.createOscillator(), a = ctx.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(freq * mult, t0); a.gain.value = amp;
    o.connect(a); a.connect(g); o.start(t0); o.stop(t0 + dur + 0.05);
  }
}
function synth(kind) {
  const ctx = getAudio(); if (!ctx) return;
  const t = ctx.currentTime + 0.02;
  if (kind === 'gain') { bell(ctx, t, 784, 0.7, 0.16); bell(ctx, t + 0.3, 1175, 1.0, 0.16); }  // sol5 puis ré6 : deux « ding » montants, ≈ 1 s audible
  else {                                                                                            // « dong » : note qui descend doucement, ≈ 0,5 s
    const g = ctx.createGain(), o = ctx.createOscillator();
    g.gain.setValueAtTime(0.001, t); g.gain.exponentialRampToValueAtTime(0.17, t + 0.02); g.gain.exponentialRampToValueAtTime(0.001, t + 0.7);
    o.type = 'sine'; o.frequency.setValueAtTime(392, t); o.frequency.exponentialRampToValueAtTime(262, t + 0.55);
    o.connect(g); g.connect(ctx.destination); o.start(t); o.stop(t + 0.75);
  }
}
// opKey = identifiant du mouvement confirmé par le serveur (réponse rejouée = même clé = pas de second son)
function playSound(kind, opKey) {
  try {
    if (!S.prefs.sound || !opKey || soundedOps.has(opKey)) return;
    soundedOps.add(opKey);
    if (soundedOps.size > 200) soundedOps.delete(soundedOps.values().next().value);
    synth(kind);
  } catch { /* une panne audio ne doit jamais empêcher l'enregistrement */ }
}

// ---------- effets ----------
const animOn = () => S.prefs.anim && !matchMedia('(prefers-reduced-motion: reduce)').matches;
function celebrate(big) {
  if (!animOn()) return;
  const fx = $('#fx');
  const emojis = ['⭐', '✨', '💛'];
  const n = big ? 9 : 5;
  for (let i = 0; i < n; i++) {
    const s = document.createElement('span');
    s.className = 'fx';
    s.textContent = emojis[i % emojis.length];
    const a = Math.random() * Math.PI * 2, d = 70 + Math.random() * (big ? 110 : 70);
    s.style.cssText = `left:${innerWidth / 2}px;top:${innerHeight * 0.45}px;--dx:${Math.cos(a) * d}px;--dy:${Math.sin(a) * d - 40}px;--rot:${Math.random() * 360 - 180}deg`;
    fx.appendChild(s);
    setTimeout(() => s.remove(), 1200);
  }
}
let toastTimer;
function toast(html, { undo, error } = {}) {
  clearTimeout(toastTimer);
  const el = $('#toast');
  el.innerHTML = `<div class="toast ${error ? 'err' : ''}"><span>${html}</span>${undo ? '<button data-act="undo">Annuler</button>' : ''}</div>`;
  S.undo = undo || null;
  toastTimer = setTimeout(() => { el.innerHTML = ''; S.undo = null; }, error ? 6000 : 8000);
}

// ---------- rendu : coque ----------
function render() {
  const app = $('#app');
  if (S.upgrade) { app.innerHTML = '<div class="auth"><div class="logo"><div class="e">⬆️</div><h1>Mise à jour nécessaire</h1></div><div class="card"><p>Cette version de Petits Héros est trop ancienne pour le serveur. Installe la dernière version de l’application, puis rouvre-la.</p><p class="muted small">Tes données sont conservées sur le serveur.</p></div></div>'; return; }
  if (S.me && S.recovery) { app.innerHTML = recoveryView(); return; }
  if (!S.me) { app.innerHTML = authView(); return; }
  const m = S.me.membership;
  if (!m) { app.innerHTML = onboardView(); return; }
  if (m.status === 'pending') { app.innerHTML = pendingView(); return; }
  if (!S.st) { app.innerHTML = '<div class="empty"><div class="big">⏳</div>Chargement…</div>'; return; }
  const r = route();
  let view;
  if (r.a === 'child' && r.b && kid(r.b)) view = childView(kid(r.b));
  else if (r.a === 'challenges') view = challengesView();
  else if (r.a === 'rewards') view = rewardsView();
  else if (r.a === 'family' && !S.lock.on) view = familyView();
  else if (r.a === 'family') view = lockedFamilyView();
  else if (r.a === 'library' && !S.lock.on) view = libraryView();
  else view = childrenView();
  const tab = r.a === 'child' || r.a === 'children' ? 'children' : r.a === 'library' ? 'family' : r.a;
  app.innerHTML = `
    ${S.offline ? '<div class="banner">📡 Hors connexion — dernières données affichées. Modifications désactivées.</div>' : ''}
    ${S.lock.on ? '<div class="lock">🔒 Mode enfant : lecture seule</div>' : ''}
    ${!S.lock.on && S.me.recoveryRemaining === 0 ? '<a class="banner" href="#/family" style="display:block">⚠️ Aucun code de secours : génère-en dans Famille</a>' : ''}
    <div class="topbar"><div class="top"><div><h1>Petits Héros</h1><small><span class="dot"></span>${esc(S.st.family.name)}</small></div></div></div>
    <main class="wrap">${view}</main>
    <nav class="tabs">
      ${[['children', '🐾', 'Enfants'], ['challenges', '🎯', 'Défis'], ['rewards', '🎁', 'Récompenses'], ['family', '🏠', 'Famille']]
        .map(([k, i, l]) => `<a href="#/${k}" class="${tab === k ? 'on' : ''}"><span>${i}</span>${l}</a>`).join('')}
    </nav>`;
  S.pulse = null;
}

// ---------- rendu : authentification ----------
function authView() {
  const a = S.auth, mode = a.mode;
  const err = a.error ? `<div class="err">${esc(a.error)}</div>` : '';
  const info = a.info ? `<div class="ok">${esc(a.info)}</div>` : '';
  const logo = '<div class="logo"><div class="e">🦸</div><h1>Petits Héros</h1><p>Les bonnes actions comptent double.</p></div>';
  const pw = (lbl = 'Mot de passe', n = 'password', ac = 'current-password') => `<label class="f">${lbl}</label><input type="password" name="${n}" autocomplete="${ac}" required minlength="10">`;
  const forms = {
    login: `<form data-form="login"><label class="f">E-mail</label><input type="email" name="email" autocomplete="email" required>${pw()}
      <button class="btn primary block" style="margin-top:16px">Se connecter</button></form>
      <p style="text-align:center"><button class="link" data-act="auth" data-mode="forgot">Mot de passe oublié ?</button></p>
      <hr style="border:0;border-top:1px solid var(--line);margin:14px 0">
      <button class="btn block" data-act="auth" data-mode="register">Créer ma famille</button>
      <button class="btn ghost block" style="margin-top:10px" data-act="auth" data-mode="join">J’ai un code d’invitation</button>`,
    register: `<h2>Créer ma famille</h2><form data-form="register"><label class="f">Ton prénom</label><input type="text" name="name" required maxlength="40" autocomplete="given-name">
      <label class="f">E-mail</label><input type="email" name="email" autocomplete="email" required>${pw('Mot de passe (10 caractères minimum)', 'password', 'new-password')}
      <label class="f">Nom de la famille</label><input type="text" name="familyName" required maxlength="60" placeholder="Les Martin">
      <button class="btn primary block" style="margin-top:16px">Créer mon compte</button></form>
      <p style="text-align:center"><button class="link" data-act="auth" data-mode="login">J’ai déjà un compte</button></p>`,
    join: `<h2>Rejoindre ma famille</h2><p class="muted small">Crée ton compte, puis saisis le code reçu de l’autre parent. Il devra approuver ton accès.</p>
      <form data-form="join"><label class="f">Ton prénom</label><input type="text" name="name" required maxlength="40">
      <label class="f">E-mail</label><input type="email" name="email" autocomplete="email" required>${pw('Mot de passe (10 caractères minimum)', 'password', 'new-password')}
      <label class="f">Code d’invitation</label><input type="text" name="code" required autocapitalize="characters" autocomplete="off" placeholder="XXXX-XXXX-XXXX">
      <button class="btn primary block" style="margin-top:16px">Rejoindre</button></form>
      <p style="text-align:center"><button class="link" data-act="auth" data-mode="login">J’ai déjà un compte</button></p>`,
    forgot: `<h2>Mot de passe oublié</h2><p class="muted small">Si l’envoi d’e-mails est configuré, tu recevras un lien. Sinon, utilise un code de secours, ou demande au parent propriétaire un code de réinitialisation (onglet Famille).</p>
      <form data-form="forgot"><label class="f">E-mail</label><input type="email" name="email" required><button class="btn primary block" style="margin-top:16px">Envoyer le lien</button></form>
      <p style="text-align:center"><button class="link" data-act="auth" data-mode="recover">J’ai un code de secours</button><br><button class="link" data-act="auth" data-mode="reset">J’ai un lien / code du propriétaire</button><br><button class="link" data-act="auth" data-mode="login">Retour</button></p>`,
    recover: `<h2>Code de secours</h2><p class="muted small">Utilise un des codes reçus à la création du compte. Chaque code ne sert qu’une fois.</p>
      <form data-form="recover"><label class="f">E-mail</label><input type="email" name="email" required autocomplete="email"><label class="f">Code de secours</label>
      <input type="text" name="code" required autocapitalize="characters" autocomplete="off" placeholder="XXXX-XXXX-XXXX">${pw('Nouveau mot de passe (10 caractères minimum)', 'password', 'new-password')}
      <button class="btn primary block" style="margin-top:16px">Changer mon mot de passe</button></form>
      <p style="text-align:center"><button class="link" data-act="auth" data-mode="login">Retour</button></p>`,
    reset: `<h2>Nouveau mot de passe</h2><form data-form="reset"><label class="f">Code ou lien reçu</label>
      <input type="text" name="token" value="${esc(a.token || '')}" required autocomplete="off">${pw('Nouveau mot de passe (10 caractères minimum)', 'password', 'new-password')}
      <button class="btn primary block" style="margin-top:16px">Enregistrer</button></form>
      <p style="text-align:center"><button class="link" data-act="auth" data-mode="login">Retour</button></p>`,
  };
  return `<div class="auth">${logo}<div class="card">${info}${err}${forms[mode] || forms.login}</div>
    ${isStandalone() ? '' : '<p style="text-align:center"><button class="link" data-act="installApp">📲 Installer l’application</button></p>'}</div>`;
}
function recoveryView() {
  return `<div class="auth"><div class="logo"><div class="e">🔐</div><h1>Tes codes de secours</h1></div>
    <div class="card"><p><b>Note-les maintenant.</b> Ils ne seront plus jamais affichés.</p>
    <p class="muted small">Si tu oublies ton mot de passe${S.me.mailEnabled ? '' : ' (l’envoi d’e-mails n’est pas configuré)'}, chaque code, utilisable une seule fois, te permet de choisir un nouveau mot de passe. Garde-les hors de ton téléphone (papier, gestionnaire de mots de passe).</p>
    <div class="recovery">${S.recovery.map((c) => `<code>${esc(c)}</code>`).join('')}</div>
    <button class="btn block" data-act="copyRecovery">📋 Copier</button>
    <button class="btn block" style="margin-top:10px" data-act="saveRecovery">💾 Télécharger (.txt)</button>
    <label class="check" style="margin-top:16px"><input type="checkbox" id="ackRecovery" data-act="ackToggle">J’ai conservé ces codes en lieu sûr</label>
    <button class="btn primary block" id="ackBtn" data-act="ackRecovery" disabled>Continuer</button></div></div>`;
}
function onboardView() {
  const a = S.auth;
  return `<div class="auth"><div class="logo"><div class="e">🏠</div><h1>Bienvenue ${esc(S.me.user.name)}</h1></div>
    ${a.error ? `<div class="err">${esc(a.error)}</div>` : ''}
    <div class="card"><h2>Créer ma famille</h2><form data-form="newfamily"><label class="f">Nom de la famille</label><input type="text" name="familyName" required maxlength="60"><button class="btn primary block" style="margin-top:12px">Créer</button></form></div>
    <div class="card"><h2>Rejoindre une famille</h2><form data-form="joincode"><label class="f">Code d’invitation</label><input type="text" name="code" required autocapitalize="characters" placeholder="XXXX-XXXX-XXXX"><button class="btn block" style="margin-top:12px">Rejoindre</button></form></div>
    <p style="text-align:center"><button class="link" data-act="logout">Se déconnecter</button> · <button class="link small" data-act="delAcc">Supprimer mon compte</button></p><p class="muted small" style="text-align:center"><a class="link" href="${API_BASE}/confidentialite" target="_blank" rel="noopener">Politique de confidentialité</a> · <a class="link" href="${API_BASE}/suppression-compte" target="_blank" rel="noopener">Suppression de compte</a></p></div>`;
}
function pendingView() {
  return `<div class="auth"><div class="logo"><div class="e">⏳</div><h1>Presque prêt !</h1></div>
    <div class="card"><p>Ton code est accepté. Le parent propriétaire de la famille « ${esc(S.me.membership.familyName)} » doit maintenant <b>approuver ton accès</b> (onglet Famille).</p>
    <p class="muted small">Cette page se met à jour toute seule.</p></div>
    <p style="text-align:center"><button class="link" data-act="logout">Se déconnecter</button> · <button class="link small" data-act="delAcc">Supprimer mon compte</button></p><p class="muted small" style="text-align:center"><a class="link" href="${API_BASE}/confidentialite" target="_blank" rel="noopener">Politique de confidentialité</a> · <a class="link" href="${API_BASE}/suppression-compte" target="_blank" rel="noopener">Suppression de compte</a></p></div>`;
}

// ---------- rendu : enfants ----------
function childCard(c) {
  const nx = nextReward(c), ch = activeChallenges(c).length;
  // carte compacte (liste Enfants uniquement) : en-tête, une ligne de récompense, défi, boutons
  return `<article class="card child mini ${S.pulse === c.id ? 'pop' : ''}" style="--c:${c.color}">
    <a class="child-head" href="#/child/${c.id}">
      <div class="avatar">${c.avatar}</div>
      <div class="who-n"><h2>${esc(c.name)}</h2><div class="sub">${c.age != null ? `${c.age} an${c.age > 1 ? 's' : ''} · ` : ''}Profil ›</div></div>
      <div class="bal"><b>${c.balance}</b><span>points</span></div>
    </a>
    ${nx ? `<div class="next"><div class="nl"><span class="t">${nx.rw.icon} ${esc(nx.rw.title)}</span><span class="muted">${nx.left ? `encore ${nx.left}` : 'prêt ! 🎉'}</span></div>
      <div class="bar"><i style="width:${nx.pct}%"></i></div></div>` : ''}
    ${ch ? `<div class="chips"><span class="chip">🎯 ${ch} défi${ch > 1 ? 's' : ''} en cours</span></div>` : ''}
    ${canEdit() ? `<div class="pm"><button class="btn minus${nm()}" data-act="points" data-id="${c.id}" data-sign="-" aria-label="Retirer des points à ${esc(c.name)}">−</button>
      <button class="btn plus${nm()}" data-act="points" data-id="${c.id}" data-sign="+" aria-label="Donner des points à ${esc(c.name)}">+</button></div>` : ''}
  </article>`;
}
function childrenView() {
  const ks = activeKids();
  if (!ks.length) return `<div class="empty"><div class="big">🐣</div><p>Ajoute ton premier enfant pour commencer l’aventure !</p>
    ${canEdit() ? `<button class="btn primary${nm()}" data-act="childForm">Ajouter un enfant</button>` : ''}</div>`;
  return `${ks.map(childCard).join('')}
    ${canEdit() ? `<button class="btn ghost block${nm()}" data-act="childForm">＋ Ajouter un enfant</button>` : ''}
    ${isStandalone() ? '' : '<p style="text-align:center;margin:4px 0"><button class="link" data-act="installApp">📲 Installer l’application</button></p>'}`;
}

async function loadHistory(reset, more) {
  const r = route(); if (r.a !== 'child' || !r.b) return;
  const h = S.hist && S.hist.childId === r.b ? S.hist : (S.hist = { childId: r.b, type: '', items: [], more: false, offset: 0, week: null });
  try {
    const lim = reset ? Math.max(30, h.items.length) : 30;
    let q = `?limit=${lim}${h.type ? `&type=${h.type}` : ''}`;
    if (more && h.items.length) q += `&before=${encodeURIComponent(h.items.at(-1).created_at)}`;
    const [hist, week] = await Promise.all([api('GET', `/api/children/${r.b}/history${q}`), api('GET', `/api/children/${r.b}/week?offset=${h.offset}`)]);
    h.items = more ? h.items.concat(hist.items) : hist.items; h.more = hist.more; h.week = week;
    if (!S.sheet && route().b === r.b) render();
  } catch { /* hors connexion : on garde l'affichage précédent */ }
}

function childView(c) {
  if (!S.hist || S.hist.childId !== c.id) { S.hist = { childId: c.id, type: '', items: [], more: false, offset: 0, week: null }; loadHistory(true); }
  const h = S.hist, w = h.week, nx = nextReward(c);
  const chs = activeChallenges(c);
  const filters = [['', 'Tout'], ['gain', 'Gains'], ['bonus', 'Bonus'], ['malus', 'Retraits'], ['reward', 'Récompenses'], ['cancel', 'Annulations']];
  return `<a class="back" href="#/children">‹ Enfants</a>
  <article class="card child ${S.pulse === c.id ? 'pop' : ''}" style="--c:${c.color}">
    <div class="child-head"><div class="avatar lg">${c.avatar}</div>
      <div><h2>${esc(c.name)}</h2><div class="sub">${c.age != null ? `${c.age} ans` : ''}</div></div>
      <div class="bal"><b>${c.balance}</b><span>points disponibles</span></div></div>
    ${nx ? `<div class="next"><span class="t">${nx.rw.icon} ${esc(nx.rw.title)} (${nx.rw.cost} pts)</span><div class="bar"><i style="width:${nx.pct}%"></i></div>
      <span class="muted small">${nx.left ? `Encore ${pts(nx.left)}` : 'Prêt à échanger ! 🎉'}</span></div>` : ''}
    ${canEdit() ? `<div class="pm"><button class="btn minus${nm()}" data-act="points" data-id="${c.id}" data-sign="-">−</button><button class="btn plus${nm()}" data-act="points" data-id="${c.id}" data-sign="+">+</button></div>
      <div class="chips"><button class="chip${nm()}" data-act="childForm" data-id="${c.id}">✏️ Modifier</button></div>` : ''}
  </article>
  ${chs.length ? `<h2 class="sec">Défis en cours</h2>${chs.map((ch) => `<div class="card"><b>${ch.icon} ${esc(ch.title)}</b>
    <div class="stars">${starsHtml(ch, ch.progress[c.id])}</div><span class="muted small">${ch.progress[c.id]} / ${ch.target}</span></div>`).join('')}` : ''}
  <h2 class="sec">Bilan de la semaine</h2>
  <div class="card">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
      <button class="icon-btn" data-act="weekNav" data-d="-1" aria-label="Semaine précédente">‹</button>
      <b>${w ? `${dday(w.start_day)} – ${dday(w.end_day)}` : '…'}${h.offset === 0 ? ' <span class="tag">cette semaine</span>' : ''}</b>
      <button class="icon-btn" data-act="weekNav" data-d="1" ${h.offset >= 0 ? 'disabled style="opacity:.3"' : ''} aria-label="Semaine suivante">›</button></div>
    <div class="stats">
      <div class="stat"><b>${c.balance}</b><span>Disponibles</span></div>
      <div class="stat"><b style="color:#1f9a7c">+${w?.gained ?? 0}</b><span>Gagnés</span></div>
      <div class="stat"><b style="color:var(--rose)">−${w?.removed ?? 0}</b><span>Retirés</span></div>
      <div class="stat"><b>${w?.used ?? 0}</b><span>Utilisés (récompenses)</span></div></div>
    <p class="muted small" style="margin-bottom:0">Les points ne repartent jamais à zéro : le solde se conserve d’une semaine à l’autre.</p>
  </div>
  <h2 class="sec">Historique</h2>
  <div class="chips" style="margin:0 0 8px">${filters.map(([k, l]) => `<button class="chip ${h.type === k ? 'on' : ''}" data-act="histFilter" data-t="${k}">${l}</button>`).join('')}</div>
  <div class="card">${h.items.length ? h.items.map(histItem).join('') : '<div class="empty small">Rien à afficher pour l’instant.</div>'}
    ${h.more ? '<button class="btn block" data-act="histMore">Voir plus</button>' : ''}</div>
  ${canEdit() ? `<p style="text-align:center"><button class="link${nm()}" data-act="archiveChild" data-id="${c.id}">Archiver ce profil</button></p>` : ''}`;
}
function histItem(i) {
  const t = TYPE[i.type];
  return `<div class="hist ${i.reversed ? 'cx' : ''}"><div class="ic">${t.ic}</div>
    <div class="tx"><b>${esc(i.reason || t.label)}</b><span class="muted small">${t.label} · ${fmtWhen(i.created_at)}${i.author ? ` · ${esc(i.author)}` : ''}${i.reversed ? ' · annulé' : ''}</span></div>
    <div style="text-align:right"><span class="val ${i.value > 0 ? 'p' : 'n'}">${signed(i.value)}</span>
    ${canEdit() && i.type !== 'cancel' && !i.reversed ? `<br><button class="link small${nm()}" data-act="cancelTx" data-id="${i.id}">Annuler</button>` : ''}</div></div>`;
}
const starsHtml = (ch, n) => Array.from({ length: Math.min(ch.target, 30) }, (_, i) => `<span class="s ${i < n ? 'f' : ''}">⭐</span>`).join('');

// ---------- rendu : défis ----------
function challengeCard(ch) {
  const kids = ch.childIds.map(kid).filter(Boolean);
  const status = ch.completed ? '<span class="tag good">🎉 Terminé</span>' : ch.upcoming ? `<span class="tag">Dès le ${dday(ch.startsOn)}</span>` : ch.expired ? '<span class="tag">Période terminée</span>' : '';
  const freq = ch.frequency === 'daily' ? '1 fois par jour max' : 'Quand on veut';
  const live = !ch.completed && !ch.expired && !ch.upcoming;
  const valid = (childId, doneToday, done, label) => {
    if (!canEdit() || !live) return '';
    const dis = done || (ch.frequency === 'daily' && doneToday);
    return `<button class="btn sm primary${nm()}" ${dis ? 'disabled' : ''} data-act="complete" data-id="${ch.id}" data-child="${childId || ''}">${done ? '✓ Fait' : doneToday && ch.frequency === 'daily' ? '✓ Aujourd’hui' : label}</button>`;
  };
  let body;
  if (ch.collective) {
    const n = Object.values(ch.progress)[0] || 0;
    body = `<div class="who"><div class="grow"><div class="stars">${starsHtml(ch, n)}</div><span class="muted small">${n} / ${ch.target} ensemble</span></div>
      ${valid(null, Object.values(ch.doneToday)[0], n >= ch.target, 'Valider pour tous')}</div>`;
  } else {
    body = kids.map((k) => `<div class="who" style="--c:${k.color}"><div class="avatar sm">${k.avatar}</div>
      <div class="grow"><b>${esc(k.name)}</b><div class="stars" style="margin:2px 0;font-size:1.3rem">${starsHtml(ch, ch.progress[k.id])}</div>
      <span class="muted small">${ch.progress[k.id]} / ${ch.target}${ch.bonusGiven.includes(k.id) ? ` · bonus +${ch.bonus} reçu 🎁` : ''}</span></div>
      ${valid(k.id, ch.doneToday[k.id], ch.progress[k.id] >= ch.target, 'Valider')}</div>`).join('');
  }
  return `<article class="card"><div style="display:flex;gap:12px;align-items:center"><div style="font-size:2.2rem">${ch.icon}</div>
    <div style="flex:1;min-width:0"><h2 style="font-size:1.15rem">${esc(ch.title)} ${ch.collective ? '<span class="tag">En équipe</span>' : ''}</h2>
    <div class="muted small">${dday(ch.startsOn)} → ${dday(ch.endsOn)} · ${freq}${ch.bonus ? ` · bonus final +${ch.bonus}${ch.collective ? ' chacun' : ''}` : ''}</div></div>${status}</div>
    ${body}
    ${canEdit() ? `<div style="text-align:right;margin-top:8px"><button class="link small${nm()}" data-act="archiveChallenge" data-id="${ch.id}">Archiver</button></div>` : ''}
    ${ch.expired ? '<p class="muted small" style="margin-bottom:0">Pas de souci : aucun point n’est perdu. On peut relancer un défi quand on veut 💛</p>' : ''}</article>`;
}
function challengesView() {
  const all = S.st.challenges;
  const live = all.filter((c) => !c.completed && !c.expired), past = all.filter((c) => c.completed || c.expired);
  return `${live.length ? live.map(challengeCard).join('') : '<div class="empty"><div class="big">🎯</div><p>Aucun défi en cours.<br>Lance-en un : « Ranger ses jouets 5 jours sur 7 » ?</p></div>'}
    ${past.length ? `<h2 class="sec">Terminés</h2>${past.slice(0, 8).map(challengeCard).join('')}` : ''}
    <div class="fab-space"></div>
    ${canEdit() ? `<button class="btn primary fab${nm()}" data-act="challengeForm">＋ Nouveau défi</button>` : ''}`;
}

// ---------- rendu : récompenses ----------
function rewardsView() {
  const ks = activeKids();
  if (!S.rewardChild || !ks.some((k) => k.id === S.rewardChild)) S.rewardChild = ks[0]?.id;
  const c = S.rewardChild ? kid(S.rewardChild) : null;
  const rws = S.st.rewards.filter((r) => !r.archived && (!c || eligibleReward(r, c.id)));
  const todo = S.st.redemptions.filter((r) => r.status === 'todo'), done = S.st.redemptions.filter((r) => r.status === 'done').slice(0, 6);
  const redRow = (r, isTodo) => { const k = kid(r.child_id); return `<div class="row" style="cursor:default"><div class="ic">${r.icon}</div>
    <div class="tx">${esc(r.title)}<small>${k ? `${k.avatar} ${esc(k.name)} · ` : ''}${r.cost} pts · ${fmtWhen(r.created_at)}</small></div>
    ${isTodo && canEdit() ? `<div style="display:grid;gap:6px"><button class="btn sm primary${nm()}" data-act="redDone" data-id="${r.id}">Réalisée ✓</button><button class="btn sm danger${nm()}" data-act="redCancel" data-id="${r.id}">Annuler</button></div>` : isTodo ? '<span class="tag">À réaliser</span>' : '<span class="tag good">✓</span>'}</div>`; };
  return `<div class="chips" style="margin:0 0 12px">${ks.map((k) => `<button class="chip ${k.id === S.rewardChild ? 'sel' : ''}" style="--c:${k.color}" data-act="rewardChild" data-id="${k.id}">${k.avatar} ${esc(k.name)} · ${k.balance}</button>`).join('')}</div>
    ${todo.length ? `<h2 class="sec" style="margin-top:6px">À réaliser</h2>${todo.map((r) => redRow(r, true)).join('')}` : ''}
    <h2 class="sec">Catalogue</h2>
    ${rws.map((r) => {
      const can = c && c.balance >= r.cost, left = c ? r.cost - c.balance : 0, pct = c ? Math.min(100, Math.round((c.balance / r.cost) * 100)) : 0;
      return `<div class="card" ${c ? `style="--c:${c.color}"` : ''}><div style="display:flex;align-items:center;gap:12px"><div style="font-size:2.2rem">${r.icon}</div>
        <div style="flex:1"><b>${esc(r.title)}</b><div class="muted small">${r.cost} points</div></div>
        ${canEdit() ? `<button class="icon-btn${nm()}" data-act="rewardForm" data-id="${r.id}" aria-label="Modifier">✏️</button>` : ''}</div>
        ${c ? `<div class="bar"><i style="width:${pct}%"></i></div><div style="display:flex;justify-content:space-between;align-items:center">
        <span class="muted small">${can ? 'Assez de points !' : `Encore ${pts(left)}`}</span>
        ${canEdit() ? `<button class="btn sm ${can ? 'primary' : ''}${nm()}" ${can ? '' : 'disabled'} data-act="redeem" data-id="${r.id}">Échanger</button>` : ''}</div>` : ''}</div>`;
    }).join('') || '<div class="empty">Aucune récompense pour cet enfant.</div>'}
    ${done.length ? `<h2 class="sec">Déjà réalisées</h2>${done.map((r) => redRow(r, false)).join('')}` : ''}
    ${canEdit() ? `<button class="btn block${nm()}" data-act="suggest" style="margin-top:14px">✨ Ajouter les suggestions</button>` : ''}
    <p class="muted small" style="text-align:center;margin-top:20px">💛 Les câlins, les repas et les besoins essentiels ne s’échangent jamais contre des points.</p>
    <div class="fab-space"></div>
    ${canEdit() ? `<button class="btn primary fab${nm()}" data-act="rewardForm">＋ Récompense</button>` : ''}`;
}

// ---------- rendu : famille ----------
function lockedFamilyView() {
  return `<div class="card" style="text-align:center"><div style="font-size:3rem">🔒</div><h2>Mode enfant</h2>
    <p class="muted">Seuls les parents peuvent modifier les points, les défis et les récompenses.</p>
    <button class="btn primary block" data-act="unlock">Je suis un parent</button></div>`;
}
function familyView() {
  const st = S.st, owner = st.me.role === 'owner';
  const arch = st.children.filter((c) => c.archived);
  return `${installCard()}<div class="card"><h2>${esc(st.family.name)}</h2><p class="muted small" style="margin:4px 0 0">Connecté : ${esc(st.me.name)} · ${esc(st.me.email)}</p></div>
  <h2 class="sec">Parents</h2><div class="card">${st.members.map((m) => `<div class="who" style="border:0;margin:0;padding:6px 0"><div class="avatar sm" style="--c:#FF8A3D">🧑</div>
    <div class="grow"><b>${esc(m.name)}</b>${m.role === 'owner' ? '<span class="tag">Propriétaire</span>' : ''}${m.status === 'pending' ? '<span class="tag">En attente</span>' : ''}<div class="muted small">${esc(m.email)}</div></div>
    ${owner && m.status === 'pending' ? `<button class="btn sm primary${nm()}" data-act="approve" data-id="${m.id}">Approuver</button>` : ''}
    ${owner && m.id !== st.me.id ? `<button class="icon-btn${nm()}" data-act="memberMenu" data-id="${m.id}" aria-label="Gérer">⋯</button>` : ''}</div>`).join('')}
    ${owner ? `<button class="btn block${nm()}" style="margin-top:10px" data-act="invite">✉️ Inviter l’autre parent</button>
    ${st.invites.length ? `<p class="muted small">${st.invites.length} code(s) actif(s) — <button class="link small" data-act="invites">gérer</button></p>` : ''}` : ''}</div>
  <h2 class="sec">Personnaliser</h2>
  <button class="row${nm()}" data-act="suggest"><div class="ic">✨</div><div class="tx">Ajouter les suggestions<small>Actions, petits malus et récompenses : aperçu et choix</small></div>›</button>
  <a class="row" href="#/library"><div class="ic">📚</div><div class="tx">Bibliothèque d’actions<small>Créer, modifier, favoris</small></div>›</a>
  ${owner ? `<button class="row${nm()}" data-act="quickForm"><div class="ic">⚡</div><div class="tx">Valeurs rapides<small>+ ${st.family.quickPlus.join(', ')} · − ${st.family.quickMinus.join(', ')}</small></div>›</button>` : ''}
  <button class="row" data-act="toggleSound" role="switch" aria-checked="${S.prefs.sound}"><div class="ic">${S.prefs.sound ? '🔔' : '🔕'}</div><div class="tx">Sons<small>${S.prefs.sound ? 'Activés' : 'Désactivés'} · réglés par le volume multimédia du téléphone</small></div><b>${S.prefs.sound ? 'Oui' : 'Non'}</b></button>
  <button class="row" data-act="toggleAnim"><div class="ic">✨</div><div class="tx">Animations<small>${matchMedia('(prefers-reduced-motion: reduce)').matches ? 'Réduites (réglage de l’appareil)' : S.prefs.anim ? 'Activées' : 'Désactivées'}</small></div><b>${S.prefs.anim ? 'Oui' : 'Non'}</b></button>
  <button class="row" data-act="lockOn"><div class="ic">🔒</div><div class="tx">Mode enfant<small>Lecture seule, déverrouillage par code</small></div>›</button>
  ${arch.length ? `<h2 class="sec">Profils archivés</h2>${arch.map((c) => `<div class="row" style="cursor:default"><div class="ic">${c.avatar}</div><div class="tx">${esc(c.name)}<small>${c.balance} pts</small></div>
    <button class="btn sm${nm()}" data-act="unarchiveChild" data-id="${c.id}">Restaurer</button></div>`).join('')}` : ''}
  <h2 class="sec">Mes données</h2>
  ${owner ? `<button class="row${nm()}" data-act="exportData"><div class="ic">💾</div><div class="tx">Exporter les données<small>Fichier JSON complet de la famille</small></div>›</button>` : ''}
  <button class="row${nm()}" data-act="recoveryRegen"><div class="ic">🛟</div><div class="tx">Codes de secours<small>${S.me.recoveryRemaining} restant${S.me.recoveryRemaining > 1 ? 's' : ''} · en générer de nouveaux</small></div>›</button>
  <button class="row${nm()}" data-act="chpw"><div class="ic">🔑</div><div class="tx">Changer mon mot de passe</div>›</button>
  <button class="row" data-act="installHelp"><div class="ic">📲</div><div class="tx">Installer sur l’écran d’accueil</div>›</button>
  <button class="row" data-act="logout"><div class="ic">👋</div><div class="tx">Se déconnecter</div></button>
  ${!owner ? `<p style="text-align:center"><button class="link small${nm()}" data-act="leave">Quitter cette famille</button></p>` : ''}
  <h2 class="sec">Confidentialité</h2>
  <a class="row" href="${API_BASE}/confidentialite" target="_blank" rel="noopener"><div class="ic">📄</div><div class="tx">Politique de confidentialité<small>Données collectées, durées, droits</small></div>›</a>
  <button class="row${nm()}" data-act="delAcc"><div class="ic">🗑️</div><div class="tx">Supprimer mon compte<small>Définitif · les conséquences sont détaillées avant confirmation</small></div>›</button>
  <p class="muted small" style="text-align:center;margin-top:18px">Petits Héros collecte le minimum : prénom, avatar, couleur et âge facultatif. Pas de photo.</p>`;
}

function libraryView() {
  const acts = S.st.actions;
  const themes = [...new Set(acts.filter((a) => !a.archived).map((a) => a.theme))];
  const row = (a) => `<div class="row" style="cursor:default"><div class="ic">${a.icon}</div>
    <div class="tx">${esc(a.title)}<small>${a.child_ids.length ? a.child_ids.map((id) => kid(id)?.name).filter(Boolean).join(', ') : 'Tous les enfants'}${a.min_interval_hours ? ` · 1 validation / ${a.min_interval_hours} h` : ''}</small>${a.note ? `<small>${esc(a.note)}</small>` : ''}</div>
    <span class="val ${a.value > 0 ? 'p' : 'n'}">${signed(a.value)}</span>
    <button class="icon-btn${nm()}" data-act="favAction" data-id="${a.id}" aria-label="Favori">${a.favorite ? '⭐' : '☆'}</button>
    <button class="icon-btn${nm()}" data-act="actionForm" data-id="${a.id}" aria-label="Modifier">✏️</button></div>`;
  const arch = acts.filter((a) => a.archived);
  return `<a class="back" href="#/family">‹ Famille</a><h2>Bibliothèque d’actions</h2>
    <button class="btn block${nm()}" data-act="suggest" style="margin:8px 0">✨ Ajouter les suggestions</button>
    <p class="muted small">Ce sont des suggestions : tu peux tout changer, ajouter ou archiver.</p>
    ${themes.map((t) => `<div class="theme">${esc(t)}</div>${acts.filter((a) => !a.archived && a.theme === t).map(row).join('')}`).join('')}
    ${arch.length ? `<div class="theme">Archivées</div>${arch.map((a) => `<div class="row" style="cursor:default;opacity:.7"><div class="ic">${a.icon}</div><div class="tx">${esc(a.title)}</div>
      <button class="btn sm${nm()}" data-act="unarchiveAction" data-id="${a.id}">Restaurer</button></div>`).join('')}` : ''}
    <div class="fab-space"></div>
    <button class="btn primary fab${nm()}" data-act="actionForm">＋ Action</button>`;
}

// ---------- feuilles (fenêtres modales) ----------
function closeSheetQuiet() { S.sheet = null; document.body.classList.remove('sheet-open'); $('#sheet').innerHTML = ''; }
function clearToast() { clearTimeout(toastTimer); $('#toast').innerHTML = ''; S.undo = null; }
function openSheet(s) { clearToast(); S.sheet = { op: uid(), error: '', ...s }; document.body.classList.add('sheet-open'); renderSheet(); }
// Fermeture demandée par l'utilisateur (✕, fond, Échap, Retour) : refusée pendant un envoi. Les fermetures du code (après succès) restent libres.
const userClose = () => { if (S.sheet?.pending) return; closeSheet(); };
function closeSheet() { S.sheet = null; document.body.classList.remove('sheet-open'); $('#sheet').innerHTML = ''; render(); }
function renderSheet(fromPoll) {
  if (fromPoll) return; // on ne touche pas à une saisie en cours ; la vue se met à jour à la fermeture
  const s = S.sheet; if (!s) return;
  const bodies = { suggest: suggestSheet, regen: regenSheet, points: pointsSheet, childForm, actionForm, challengeForm, rewardForm, quickForm, invite: inviteSheet, invites: invitesSheet,
    memberMenu, chpw: chpwSheet, delacc: delAccSheet, install: installSheet, lockSet: () => pinSheet(true), unlock: () => pinSheet(false), confirm: confirmSheet, info: infoSheet };
  const [title, html] = bodies[s.kind](s);
  queueMicrotask(() => { if (S.sheet === s && s.sent) lockPanel(); });
  $('#sheet').innerHTML = `<div class="backdrop" data-act="closeBackdrop"><div class="panel" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="panel-head"><h2>${title}</h2><button class="icon-btn" data-act="closeSheet" aria-label="Fermer">✕</button></div>
    <div id="sheet-err">${s.error ? `<div class="err">${esc(s.error)}</div>` : ''}</div>${html}</div></div>`;
}
const sheetErr = (msg) => { if (S.sheet) S.sheet.error = msg; const el = $('#sheet-err'); if (el) el.innerHTML = msg ? `<div class="err">${esc(msg)}</div>` : ''; };

// -- « Point non validé » : simple retour visuel pour l'enfant. AUCUN appel au serveur : ni point, ni solde, ni transaction, ni malus.
function showDeclined() {
  closeSheetQuiet();                       // ferme « Donner des points » sans rien enregistrer
  clearToast();
  S.declined = true;
  document.body.classList.add('sheet-open');
  $('#sheet').innerHTML = `<div class="declined" role="alertdialog" aria-modal="true" aria-labelledby="decl-t" aria-describedby="decl-m">
    <div class="declined-in"><div class="big-x" aria-hidden="true">✕</div>
    <h2 id="decl-t">Point non validé</h2><p id="decl-m">Cette fois, cette action ne donne pas de point.</p>
    <button class="btn primary block" id="decl-ok" data-act="declinedOk">D’accord</button></div></div>`;
  $('#decl-ok')?.focus();
}
function closeDeclined() {
  if (!S.declined) return;
  S.declined = false; $('#sheet').innerHTML = ''; document.body.classList.remove('sheet-open');
  go('#/children'); render();              // retour à la liste des enfants
}

// -- points
const posActions = (c) => S.st.actions.filter((a) => !a.archived && a.value > 0 && eligible(a, c.id));
const negActions = (c) => S.st.actions.filter((a) => !a.archived && a.value < 0 && eligible(a, c.id));
function pointsValid(s) {
  const v = s.value;
  if (!Number.isInteger(v) || v === 0 || Math.abs(v) > 1000) return false;
  if (s.sign === '+' && v < 0) return false;
  if (s.sign === '-' && v > 0) return false;
  if (s.tab === 'action' || s.tab === 'behavior') return !!s.actionId;
  if (s.sign === '-' && s.tab === 'free') return !!(s.reason || '').trim();
  return true;
}
function confirmBar(s) {
  const c = kid(s.childId);
  if (s.sent) { // issue inconnue d'un envoi précédent : on ne peut renvoyer QUE la même demande (même identifiant d'opération)
    return `<div class="err">⚠️ Enregistrement non confirmé : ${signed(s.sent.value)} pour ${esc(c.name)}. Réessaie : même si la première demande est passée, aucun doublon ne sera créé.</div>
      <button class="btn primary block${nm()}" data-act="pointsConfirm" data-submit ${s.pending ? 'disabled' : ''}>${s.pending ? PENDING_LABEL : `Réessayer ${signed(s.sent.value)} pour ${esc(c.name)}`}</button>
      <button class="link small" data-act="discardSent">Abandonner cette tentative (seulement si l’historique n’affiche pas ce mouvement)</button>`;
  }
  const ok = pointsValid(s);
  const over = s.sign === '-' && Number.isInteger(s.value) && -s.value > c.balance;
  return `${over ? `<div class="err">${esc(c.name)} n’a que ${pts(c.balance)} : corrige le montant.</div>` : ''}
    <button class="btn primary block${nm()}" data-act="pointsConfirm" data-submit ${ok && !over && !s.pending ? '' : 'disabled'}>${s.pending ? PENDING_LABEL : ok ? `Enregistrer ${signed(s.value)} pour ${esc(c.name)}` : 'Choisis une valeur'}</button>`;
}
function pointsSheet(s) {
  const c = kid(s.childId), plus = s.sign === '+', st = S.st;
  const tabs = plus ? [['free', 'Libre'], ['action', 'Bonne action'], ['bonus', 'Bonus']] : [['behavior', 'Comportement'], ['free', 'Libre']];
  const quick = (vals, cls) => `<div class="quick ${cls}">${vals.map((v) => `<button data-act="quickVal" data-v="${v}" class="${s.value === v ? 'on' : ''}">${signed(v)}</button>`).join('')}</div>`;
  const custom = `<label class="f">Autre valeur</label><input type="number" inputmode="numeric" data-bind="value" value="${s.value ?? ''}" placeholder="${plus ? 'ex. 4' : 'ex. -2'}">`;
  const reason = (req) => `<label class="f">Motif${req ? ' (obligatoire)' : ' (facultatif)'}</label><input type="text" data-bind="reason" maxlength="120" value="${esc(s.reason || '')}" placeholder="${plus ? 'Bravo pour…' : 'Ce qui s’est passé…'}">`;
  const list = (acts) => {
    const fav = acts.filter((a) => a.favorite), themes = [...new Set(acts.map((a) => a.theme))];
    const r = (a) => `<button class="row ${s.actionId === a.id ? 'on' : ''}" data-act="pickAction" data-id="${a.id}"><div class="ic">${a.icon}</div><div class="tx">${esc(a.title)}${a.note ? `<small>${esc(a.note)}</small>` : ''}</div><span class="val ${a.value > 0 ? 'p' : 'n'}">${signed(a.value)}</span></button>`;
    return `${fav.length ? `<div class="theme">⭐ Favoris</div>${fav.map(r).join('')}` : ''}${themes.map((t) => `<div class="theme">${esc(t)}</div>${acts.filter((a) => a.theme === t).map(r).join('')}`).join('')}
      ${s.actionId ? `<div class="stepper"><button data-act="step" data-d="-1">−</button><b>${signed(s.value)}</b><button data-act="step" data-d="1">+</button></div>` : ''}
      ${acts.length ? '' : '<div class="empty small">Aucune action. Ajoute-en dans Famille › Bibliothèque.</div>'}`;
  };
  let body = '';
  if (s.tab === 'free' && plus) body = quick(st.family.quickPlus, 'pos') + custom + reason(false);
  else if (s.tab === 'bonus') body = `<p class="muted small">Pour un moment exceptionnel : un grand effort, une belle surprise…</p>${quick([5, 10, 15, 20], 'pos')}${custom}${reason(false)}`;
  else if (s.tab === 'action') body = list(posActions(c));
  else if (s.tab === 'behavior') body = `<p class="muted small">Des repères, pas des règles : seulement après un rappel clair, avec bienveillance. Jamais pour des pleurs, des réveils de nuit ou des besoins essentiels.</p>${list(negActions(c))}`;
  else body = quick(st.family.quickMinus.map((v) => -v), 'neg') + custom + reason(true);
  return [`<span style="font-size:1.6rem">${c.avatar}</span> ${plus ? 'Donner' : 'Retirer'} des points · ${esc(c.name)}`,
    `${plus && !s.sent ? '<div class="declined-row"><button class="btn ghost sm quiet" data-act="notValidated">Point non validé</button></div>' : ''}
     <div class="seg">${tabs.map(([k, l]) => `<button class="${s.tab === k ? 'on' : ''}" data-act="tab" data-t="${k}">${l}</button>`).join('')}</div>
     ${body}<div class="confirm-bar" id="cslot">${confirmBar(s)}</div>`];
}

// -- formulaires
const picker = (field, items, cur, cls = '') => `<div class="picker ${cls}" data-field="${field}">${items.map((v) =>
  `<button type="button" class="${v === cur ? 'on' : ''}" data-act="pick" data-field="${field}" data-val="${esc(v)}" ${cls === 'colors' ? `style="background:${v}"` : ''}>${cls === 'colors' ? '' : v}</button>`).join('')}</div>`;
const kidChecks = (sel) => `<div>${activeKids().map((k) => `<label class="check"><input type="checkbox" name="kids" value="${k.id}" ${sel.includes(k.id) ? 'checked' : ''}>${k.avatar} ${esc(k.name)}</label>`).join('')}</div>`;
const checkedKids = (f) => [...f.querySelectorAll('input[name=kids]:checked')].map((i) => i.value);

function childForm(s) {
  return [s.id ? 'Modifier le profil' : 'Nouvel enfant', `<form data-form="child"><label class="f">Prénom</label><input type="text" name="name" required maxlength="30" value="${esc(s.name || '')}">
    <label class="f">Âge (facultatif)</label><input type="number" name="age" min="0" max="18" inputmode="numeric" value="${s.age ?? ''}">
    <label class="f">Avatar</label>${picker('avatar', AVATARS, s.avatar)}<label class="f">Couleur</label>${picker('color', COLORS, s.color, 'colors')}
    <button class="btn primary block${nm()}" style="margin-top:18px">${s.id ? 'Enregistrer' : 'Ajouter'}</button></form>`];
}
function actionForm(s) {
  const themes = [...new Set(S.st.actions.map((a) => a.theme))];
  return [s.id ? 'Modifier l’action' : 'Nouvelle action', `<form data-form="action"><label class="f">Titre</label><input type="text" name="title" required maxlength="80" value="${esc(s.title || '')}">
    <label class="f">Thème</label><input type="text" name="theme" required maxlength="40" list="themes" value="${esc(s.theme || '')}"><datalist id="themes">${themes.map((t) => `<option value="${esc(t)}">`).join('')}</datalist>
    <label class="f">Icône</label>${picker('icon', ICONS, s.icon)}
    <label class="f">Valeur suggérée (négative = retrait)</label><input type="number" name="value" required inputmode="numeric" value="${s.value ?? 2}">
    <label class="f">Note pour les parents (facultatif)</label><input type="text" name="note" maxlength="160" value="${esc(s.note || '')}" placeholder="Ex. portion adaptée, sans forcer">
    <label class="f">Délai minimum entre deux validations, pour un même enfant (heures, facultatif)</label><input type="number" name="minIntervalHours" min="1" max="72" inputmode="numeric" value="${s.min_interval_hours ?? ''}" placeholder="aucun">
    <label class="check" style="margin-top:12px"><input type="checkbox" name="favorite" ${s.favorite ? 'checked' : ''}>⭐ Favori</label>
    <label class="f">Enfants concernés (aucun coché = tous)</label>${kidChecks(s.child_ids || [])}
    <button class="btn primary block${nm()}" style="margin-top:14px">Enregistrer</button>
    ${s.id ? `<button type="button" class="btn danger block${nm()}" style="margin-top:10px" data-act="archiveAction" data-id="${s.id}">Archiver cette action</button>` : ''}</form>`];
}
function rewardForm(s) {
  return [s.id ? 'Modifier la récompense' : 'Nouvelle récompense', `<form data-form="reward"><label class="f">Titre</label><input type="text" name="title" required maxlength="80" value="${esc(s.title || '')}">
    <label class="f">Icône</label>${picker('icon', ICONS, s.icon)}<label class="f">Coût en points</label><input type="number" name="cost" min="1" max="1000" required inputmode="numeric" value="${s.cost ?? 10}">
    <label class="f">Enfants concernés (aucun coché = tous)</label>${kidChecks(s.child_ids || [])}
    <p class="muted small">💛 Pas de points pour les câlins, les repas ou les besoins essentiels.</p>
    <button class="btn primary block${nm()}" style="margin-top:10px">Enregistrer</button>
    ${s.id ? `<button type="button" class="btn danger block${nm()}" style="margin-top:10px" data-act="archiveReward" data-id="${s.id}">Archiver cette récompense</button>` : ''}</form>`];
}
function challengeForm(s) {
  const acts = S.st.actions.filter((a) => !a.archived && a.value > 0);
  const toggle = `<label class="check" style="margin-top:12px"><input type="checkbox" name="collective" ${s.collective ? 'checked' : ''}>🤝 Défi collectif (tous ensemble)</label>`;
  return ['Nouveau défi', `<form data-form="challenge"><label class="f">Titre</label><input type="text" name="title" required maxlength="80" placeholder="Ranger ses jouets 5 jours sur 7" value="${esc(s.title || '')}">
    <label class="f">Icône</label>${picker('icon', ICONS, s.icon)}
    <label class="f">Action à réaliser (donne ses points habituels à chaque validation)</label>
    <select name="actionId"><option value="">— Aucune (seulement le bonus final) —</option>${acts.map((a) => `<option value="${a.id}" ${s.actionId === a.id ? 'selected' : ''}>${a.icon} ${esc(a.title)} (+${a.value})</option>`).join('')}</select>
    ${toggle}<label class="f">Participants</label>${kidChecks(s.childIds || [])}
    <div class="two"><div><label class="f">Début</label><input type="date" name="startsOn" required value="${s.startsOn}"></div>
    <div><label class="f">Fin</label><input type="date" name="endsOn" required value="${s.endsOn}"></div></div>
    <div class="two"><div><label class="f">Réalisations nécessaires</label><input type="number" name="target" min="1" max="100" required value="${s.target}"></div>
    <div><label class="f">Bonus final (chacun)</label><input type="number" name="bonus" min="0" max="500" required value="${s.bonus}"></div></div>
    <label class="f">Fréquence autorisée</label><select name="frequency"><option value="daily">1 fois par jour maximum</option><option value="any">Plusieurs fois par jour possible</option></select>
    <p class="muted small">Chaque réalisation est validée par un parent. Le bonus est versé une seule fois. Aucun point n’est perdu si le défi n’est pas terminé.</p>
    <button class="btn primary block${nm()}" style="margin-top:10px">Lancer le défi</button></form>`];
}
function quickForm() {
  const f = S.st.family;
  return ['Valeurs rapides', `<form data-form="quick"><label class="f">Boutons « + » (séparés par des virgules)</label><input type="text" name="plus" value="${f.quickPlus.join(', ')}" required>
    <label class="f">Boutons « − »</label><input type="text" name="minus" value="${f.quickMinus.join(', ')}" required>
    <p class="muted small">Maximum 8 valeurs positives (ex. 1, 2, 5, 10).</p><button class="btn primary block${nm()}">Enregistrer</button></form>`];
}

// -- invitations & membres
function inviteSheet(s) {
  if (!s.code) return ['Inviter l’autre parent', '<div class="empty">Création du code…</div>'];
  const exp = new Date(s.expiresAt).toLocaleString('fr-FR', { weekday: 'long', hour: '2-digit', minute: '2-digit' });
  return ['Code d’invitation', `<p>Donne ce code à l’autre parent. Il crée son compte, saisit le code, puis tu approuves son accès.</p>
    <div class="big-code">${esc(s.code)}</div>
    <p class="muted small">Valable jusqu’à ${esc(exp)} · utilisable une seule fois · ce code ne donne accès à rien tant que tu n’as pas approuvé. Il ne sera plus affiché après fermeture.</p>
    <button class="btn primary block" data-act="copyCode">📋 Copier le code</button>
    ${navigator.share ? '<button class="btn block" style="margin-top:10px" data-act="shareCode">Partager…</button>' : ''}`];
}
function invitesSheet() {
  return ['Codes actifs', `${S.st.invites.map((i) => `<div class="row" style="cursor:default"><div class="ic">✉️</div><div class="tx">Code en attente<small>Expire ${fmtWhen(i.expires_at)}</small></div>
    <button class="btn sm danger${nm()}" data-act="revoke" data-id="${i.id}">Révoquer</button></div>`).join('') || '<div class="empty">Aucun code actif.</div>'}`];
}
function memberMenu(s) {
  const m = S.st.members.find((x) => x.id === s.id);
  return [esc(m.name), `${s.resetCode ? `<div class="ok">Code à communiquer (valable 1 h, usage unique) :</div><div class="big-code">${esc(s.resetCode)}</div>` : ''}
    <button class="btn block${nm()}" data-act="resetCode" data-id="${m.id}">🔑 Générer un code de nouveau mot de passe</button>
    ${m.role === 'parent' && m.status === 'active' ? `<button class="btn block${nm()}" style="margin-top:10px" data-act="makeOwner" data-id="${m.id}">👑 Nommer propriétaire</button>` : ''}
    <button class="btn danger block${nm()}" style="margin-top:10px" data-act="removeMember" data-id="${m.id}">${m.status === 'pending' ? 'Refuser la demande' : 'Retirer de la famille'}</button>`];
}
function delAccSheet(s) {
  const sit = s.sit;
  if (!sit) return ['Supprimer mon compte', '<div class="empty">Chargement…</div>'];
  const k = sit.kind;
  const what = {
    no_family: '<p>Ton compte, tes sessions et tes codes de secours seront supprimés. Tu n’appartiens à aucune famille : aucune autre donnée n’est concernée.</p>',
    pending: '<p>Ta demande d’accès à la famille est annulée et ton compte, tes sessions et tes codes de secours sont supprimés. La famille n’est pas touchée.</p>',
    member: '<p>Ton compte, tes sessions et tes codes de secours seront supprimés et tu quitteras la famille. <b>La famille, les enfants, les points et les autres parents ne sont pas touchés.</b> Les mouvements que tu as saisis restent dans l’historique, sous la mention « Ancien parent ».</p>',
    owner_alone: '<p class="warn">Tu es le seul parent de la famille. <b>Supprimer ton compte supprime aussi la famille et toutes ses données</b> : profils des enfants, points, historique, défis, récompenses et invitations. Aucune récupération n’est possible. Pense à exporter les données avant (Famille › Exporter les données).</p>',
    owner_with_parents: `<p class="warn">Tu es propriétaire de la famille et ${sit.activeParents} autre${sit.activeParents > 1 ? 's' : ''} parent${sit.activeParents > 1 ? 's y ont' : ' y a'} accès. Pour ne pas bloquer la famille, la suppression est refusée tant que tu es propriétaire : nomme d’abord un autre propriétaire (Famille › ⋯ › Nommer propriétaire), puis reviens ici.</p>`,
  }[k];
  const form = k === 'owner_with_parents' ? '' : `<form data-form="delacc">
    ${k === 'owner_alone' ? '<label class="check"><input type="checkbox" name="deleteFamily" required>Je comprends que la famille et toutes ses données seront supprimées définitivement</label>' : ''}
    <label class="f">Mot de passe</label><input type="password" name="password" required autocomplete="current-password">
    <label class="f">Écris SUPPRIMER pour confirmer</label><input type="text" name="confirm" required autocapitalize="characters" autocomplete="off">
    <button class="btn danger block${nm()}" style="margin-top:14px">Supprimer définitivement mon compte</button></form>`;
  return ['Supprimer mon compte', `${what}${form}<p class="muted small"><a class="link" href="${API_BASE}/suppression-compte" target="_blank" rel="noopener">Plus de détails</a></p>`];
}
function chpwSheet() {
  return ['Changer mon mot de passe', `<form data-form="chpw"><label class="f">Mot de passe actuel</label><input type="password" name="current" required autocomplete="current-password">
    <label class="f">Nouveau (10 caractères minimum)</label><input type="password" name="password" required minlength="10" autocomplete="new-password">
    <button class="btn primary block${nm()}" style="margin-top:14px">Enregistrer</button></form>`];
}
function suggestSheet(s) {
  if (!s.data) return ['Ajouter les suggestions', `<div class="empty">${s.error ? '' : 'Chargement…'}</div>`];
  const row = (kind, it) => {
    const ex = it.existing, val = kind === 'r' ? `${it.cost} pts` : signed(it.value);
    const note = ex ? `<small>Déjà présent${ex.archived ? ' (archivé)' : ''}${(kind === 'r' ? ex.cost !== it.cost : ex.value !== it.value) ? ` · ta valeur : ${kind === 'r' ? `${ex.cost} pts` : signed(ex.value)}` : ''} — conservé tel quel</small>` : `<small>${esc(it.theme || 'Catalogue')}</small>`;
    return `<label class="check sg ${ex ? 'dim' : ''}"><input type="checkbox" data-act="sgToggle" data-id="${kind}${it.key}" ${ex ? 'disabled' : ''} ${s.sel[kind + it.key] ? 'checked' : ''}>
      <span class="ic">${it.icon}</span><span class="tx">${esc(it.title)}${note}${it.note && !ex ? `<small>${esc(it.note)}${it.minIntervalHours ? ` (1 validation / ${it.minIntervalHours} h)` : ''}</small>` : ''}</span><span class="val ${kind === 'r' ? '' : it.value > 0 ? 'p' : 'n'}">${val}</span></label>`;
  };
  const good = s.data.actions.filter((a) => !a.malus), mal = s.data.actions.filter((a) => a.malus);
  return ['Ajouter les suggestions', `<p class="muted small">Coche ce que tu veux ajouter. <b>Rien n’est modifié ni supprimé</b> : tes actions, récompenses, soldes et historique restent tels quels, et tu pourras tout changer ensuite.</p>
    <div style="display:flex;gap:8px;margin-bottom:6px"><button class="btn sm" data-act="sgAll" data-v="1">Tout cocher</button><button class="btn sm" data-act="sgAll" data-v="0">Tout décocher</button></div>
    <div class="theme">Bonnes actions</div>${good.map((x) => row('a', x)).join('')}
    <div class="theme">Petits malus — après un rappel clair</div>
    <p class="muted small" style="margin:0 4px 6px">Jamais de retrait pour des pleurs, du chagrin ou des réveils nocturnes.</p>${mal.map((x) => row('a', x)).join('')}
    <div class="theme">Récompenses</div>${s.data.rewards.map((x) => row('r', x)).join('')}
    <div class="confirm-bar" id="sgslot">${sgBar(s)}</div>`];
}
const sgCount = (s) => Object.values(s.sel).filter(Boolean).length;
const sgBar = (s) => `<button class="btn primary block${nm()}" data-act="sgApply" data-submit ${sgCount(s) && !s.pending ? '' : 'disabled'}>${s.pending ? PENDING_LABEL : sgCount(s) ? `Ajouter ${sgCount(s)} suggestion${sgCount(s) > 1 ? 's' : ''}` : 'Rien de sélectionné'}</button>`;
function regenSheet(s) {
  if (s.codes) return ['Nouveaux codes de secours', `<p><b>Note-les maintenant</b> : les anciens sont invalidés et ceux-ci ne seront plus affichés.</p><div class="recovery">${s.codes.map((c) => `<code>${esc(c)}</code>`).join('')}</div>
    <button class="btn block" data-act="copyRegen">📋 Copier</button><button class="btn primary block" style="margin-top:10px" data-act="closeSheet">J’ai noté mes codes</button>`];
  return ['Codes de secours', `<p class="muted">Génère 8 nouveaux codes à usage unique. Les codes actuels (${S.me.recoveryRemaining} restant${S.me.recoveryRemaining > 1 ? 's' : ''}) seront invalidés.</p>
    <form data-form="regen"><label class="f">Ton mot de passe</label><input type="password" name="password" required autocomplete="current-password">
    <button class="btn primary block${nm()}" style="margin-top:14px">Générer</button></form>`];
}
function installSheet() {
  const p = platform();
  const ios = ['<li>Ouvre ce lien dans <b>Safari</b>.</li>', '<li>Touche le bouton <b>Partager</b> ⬆️ (barre du bas).</li>', '<li>Choisis <b>« Sur l’écran d’accueil »</b>, puis <b>Ajouter</b>.</li>',
    '<li>Ouvre l’app depuis la nouvelle icône 🦸. <b>Sur iPhone, l’app installée a sa propre session</b> : connecte-toi une fois ; la connexion est ensuite conservée.</li>'];
  const guide = {
    ios: ['iPhone / iPad (Safari)', ios],
    'ios-other': ['iPhone / iPad', ['<li>Tu utilises un autre navigateur que Safari. Si <b>Partager › Sur l’écran d’accueil</b> n’apparaît pas, copie le lien ci-dessous et ouvre-le dans <b>Safari</b>.</li>', ...ios.slice(1)]],
    android: ['Android (Chrome)', ['<li>Touche le menu <b>⋮</b> en haut à droite.</li>', '<li>Choisis <b>« Installer l’application »</b> (ou « Ajouter à l’écran d’accueil »).</li>', '<li>Confirme : l’icône 🦸 apparaît sur l’écran d’accueil.</li>']],
    'android-samsung': ['Android (Samsung Internet)', ['<li>Touche le menu <b>≡</b> en bas.</li>', '<li>Choisis <b>« Ajouter la page à »</b> › <b>« Écran d’accueil »</b>.</li>', '<li>Pour une installation complète, Chrome est recommandé.</li>']],
    other: ['Ordinateur', ['<li>Chrome / Edge : icône <b>Installer</b> dans la barre d’adresse, ou menu › « Installer Petits Héros ».</li>', '<li>Pour un téléphone, ouvre ce lien sur le téléphone.</li>']],
  }[p];
  return ['Installer l’application', `<p><b>${guide[0]}</b></p><ol style="padding-left:22px;line-height:1.6">${guide[1].join('')}</ol>
    ${S.installEvt ? '<button class="btn primary block" data-act="doInstall">Installer maintenant</button>' : ''}
    <div class="theme">Les deux parents : le même lien</div>
    <div class="big-code" style="font-size:1.05rem;letter-spacing:0;white-space:normal;word-break:break-all">${esc(location.origin)}</div>
    <button class="btn block" data-act="copyLink">📋 Copier le lien</button>
    <p class="muted small">Même lien, mêmes données : chaque parent se connecte avec son propre compte.</p>`];
}
const infoSheet = (s) => [esc(s.title), `<p>${esc(s.text)}</p><button class="btn primary block" data-act="closeSheet">OK</button>`];
const confirmSheet = (s) => [esc(s.title), `<p>${esc(s.text)}</p><button class="btn ${s.danger ? 'danger' : 'primary'} block${nm()}" data-act="confirmYes">${esc(s.label)}</button>
  <button class="btn ghost block" style="margin-top:10px" data-act="closeSheet">Non, retour</button>`];
function pinSheet(setting) {
  return [setting ? 'Activer le mode enfant' : 'Déverrouiller', `<p class="muted">${setting ? 'Choisis un code à 4 chiffres. Il sera demandé pour repasser en mode parent sur cet appareil.' : 'Saisis le code parent.'}</p>
    <form data-form="${setting ? 'lockSet' : 'unlock'}"><input type="password" name="pin" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" required style="text-align:center;font-size:2rem;letter-spacing:.5em" autocomplete="off">
    <button class="btn primary block" style="margin-top:14px">${setting ? 'Activer' : 'Déverrouiller'}</button></form>
    ${setting ? '<p class="muted small">Ce verrou est local à cet appareil. La sécurité réelle reste assurée par les comptes parents côté serveur.</p>' : ''}`];
}

// ---------- actions ----------
// Enregistre / partage un fichier : navigateur → téléchargement ; Android → feuille de partage (le WebView ne télécharge pas les blobs)
async function saveFile(name, mime, text) {
  if (NATIVE) { await window.PHNative.saveFile(name, mime, text); return; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
const errMsg = (e) => e.message || 'Erreur';
// ---- Envoi en cours : un seul clic = une seule requête ; bouton désactivé « Enregistrement… » ; fenêtre figée ----
const PENDING_LABEL = 'Enregistrement…';
function lockPanel() {
  const panel = document.querySelector('#sheet .panel'); if (!panel) return;
  panel.classList.add('locked'); panel.querySelectorAll('input, select, textarea').forEach((i) => { i.disabled = true; });
}
function setPending(on) {
  const sh = S.sheet; if (!sh) return;
  sh.pending = on;
  const panel = document.querySelector('#sheet .panel'); if (!panel) return;
  panel.setAttribute('aria-busy', String(on));
  panel.querySelectorAll('.btn.primary, .btn.danger.block, [data-submit]').forEach((b) => {
    if (on) { if (b.dataset.label === undefined) { b.dataset.label = b.innerHTML; b.dataset.was = b.disabled ? '1' : ''; } b.disabled = true; b.textContent = PENDING_LABEL; }
    else if (b.dataset.label !== undefined) { b.innerHTML = b.dataset.label; b.disabled = !!b.dataset.was; delete b.dataset.label; delete b.dataset.was; }
  });
  if (!on) { if (sh.kind === 'points' && $('#cslot')) $('#cslot').innerHTML = confirmBar(sh); if (sh.kind === 'suggest' && $('#sgslot')) $('#sgslot').innerHTML = sgBar(sh); }
}
const setBusyBody = (on) => document.body.classList.toggle('busy', on);
async function run(fn) {
  if (S.busy) return;
  S.busy = true;
  const sheet = S.sheet;
  if (sheet) setPending(true); else setBusyBody(true);
  try { return await fn(); }
  catch (e) {
    if (sheet && S.sheet === sheet) { setPending(false); sheetErr(errMsg(e)); } else toast(esc(errMsg(e)), { error: true });
  } finally {
    S.busy = false; setBusyBody(false);
    if (S.sheet && S.sheet.pending) setPending(false);
  }
}
// Envoie une écriture. La fonction ne rend la main qu'après CONFIRMATION du serveur ; l'actualisation de l'état qui suit
// ne bloque jamais plus de 1,2 s (elle se poursuit en arrière-plan) : la fenêtre se ferme dès que le serveur a répondu.
async function write(method, path, body, key) {
  const r = await api(method, path, body, key ?? S.sheet?.op);
  await Promise.race([refresh(true), new Promise((res) => setTimeout(res, 1200))]);
  return r;
}
const sha = async (t) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)))].map((b) => b.toString(16).padStart(2, '0')).join('');
const todayPlus = (n) => { const d = new Date(`${S.st.today}T12:00:00`); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const ask = (title, text, label, onYes, danger = true) => openSheet({ kind: 'confirm', title, text, label, onYes, danger });
const act = (el) => el.dataset;

const A = {
  closeSheet: userClose,
  closeBackdrop: (d, el, ev) => { if (ev.target === el) userClose(); },
  auth: (d) => { S.auth = { mode: d.mode, error: '', info: '' }; render(); },
  logout: async () => { try { await api('POST', '/api/auth/logout', {}); } catch { /* déjà déconnecté */ } wipeLocal(); S.me = null; S.auth = { mode: 'login', error: '', info: '' }; go('#/'); render(); },

  // suggestions
  suggest: () => {
    openSheet({ kind: 'suggest', data: null, sel: {} });
    run(async () => {
      const r = await api('GET', '/api/family/suggestions');
      const s = S.sheet; if (!s || s.kind !== 'suggest') return;
      s.data = r;
      for (const a of r.actions) if (!a.existing) s.sel[`a${a.key}`] = true;
      for (const w of r.rewards) if (!w.existing) s.sel[`r${w.key}`] = true;
      renderSheet();
    });
  },
  sgToggle: (d, el) => { S.sheet.sel[d.id] = el.checked; $('#sgslot').innerHTML = sgBar(S.sheet); },
  sgAll: (d) => { document.querySelectorAll('[data-act=sgToggle]:not(:disabled)').forEach((i) => { i.checked = d.v === '1'; S.sheet.sel[i.dataset.id] = i.checked; }); $('#sgslot').innerHTML = sgBar(S.sheet); },
  sgApply: () => run(async () => {
    const s = S.sheet, on = (p) => Object.keys(s.sel).filter((k) => s.sel[k] && k[0] === p).map((k) => k.slice(1));
    const r = await write('POST', '/api/family/suggestions/apply', { actionKeys: on('a'), rewardKeys: on('r') });
    closeSheet();
    const n = r.addedActions + r.addedRewards;
    toast(n ? `<b>${n}</b> suggestion${n > 1 ? 's' : ''} ajoutée${n > 1 ? 's' : ''} ✓` : 'Rien à ajouter : déjà présent');
  }),

  // installation
  installApp: async () => {
    const ev = S.installEvt;
    if (!ev) { openSheet({ kind: 'install' }); return; }
    S.installEvt = null;
    try { await ev.prompt(); const c = await ev.userChoice; toast(c?.outcome === 'accepted' ? 'Installation lancée… cherche l’icône Petits Héros' : 'Installation annulée'); }
    catch { openSheet({ kind: 'install' }); }
  },
  copyLink: async () => { try { await navigator.clipboard.writeText(location.origin); toast('Lien copié'); } catch { toast('Copie impossible', { error: true }); } },

  // codes de secours
  copyRecovery: async () => { try { await navigator.clipboard.writeText(S.recovery.join('\n')); toast('Codes copiés'); } catch { toast('Copie impossible', { error: true }); } },
  copyRegen: async () => { try { await navigator.clipboard.writeText(S.sheet.codes.join('\n')); toast('Codes copiés'); } catch { toast('Copie impossible', { error: true }); } },
  saveRecovery: () => run(() => saveFile('petits-heros-codes-secours.txt', 'text/plain', `Petits Héros — codes de secours (usage unique)\n${S.me.user.email}\n\n${S.recovery.join('\n')}\n`)),
  ackToggle: () => { $('#ackBtn').disabled = !$('#ackRecovery').checked; },
  ackRecovery: async () => { if (!$('#ackRecovery').checked) return; S.recovery = null; await boot(); },
  recoveryRegen: () => openSheet({ kind: 'regen' }),

  // points
  notValidated: () => showDeclined(),
  declinedOk: () => closeDeclined(),
  points: (d) => {
    const plus = d.sign === '+', u = S.unresolved?.[d.id];
    if (u) { openSheet({ kind: 'points', childId: d.id, sign: u.body.value > 0 ? '+' : '-', tab: u.tab, op: u.op, sent: u.body, value: u.body.value, reason: u.body.reason || '', actionId: u.body.actionId || null }); return; }
    openSheet({ kind: 'points', childId: d.id, sign: d.sign, tab: plus ? 'free' : 'behavior', value: null, reason: '', actionId: null });
  },
  tab: (d) => { Object.assign(S.sheet, { tab: d.t, value: null, actionId: null, error: '' }); renderSheet(); },
  quickVal: (d) => { S.sheet.value = Number(d.v); renderSheet(); },
  pickAction: (d) => { const a = S.st.actions.find((x) => x.id === d.id); Object.assign(S.sheet, { actionId: a.id, value: a.value, reason: '' }); renderSheet(); },
  step: (d) => { const s = S.sheet; const n = s.value + Number(d.d) * (s.sign === '+' ? 1 : -1); if (Math.sign(n) === Math.sign(s.value) && n !== 0) { s.value = n; renderSheet(); } },
  discardSent: () => { const s = S.sheet; delete S.unresolved?.[s.childId]; s.sent = null; s.op = uid(); s.error = ''; renderSheet(); },
  pointsConfirm: () => run(async () => {
    const s = S.sheet; if (!s.sent && !pointsValid(s)) return;
    const c = kid(s.childId);
    const body = s.sent || { value: s.value, reason: s.reason || undefined, actionId: s.actionId || undefined, bonus: s.tab === 'bonus' || undefined };
    // 1) enregistrement : une seule requête, identifiant d'opération propre à CETTE fenêtre (réessai = même identifiant = jamais de doublon)
    let r;
    try { r = await api('POST', `/api/children/${s.childId}/points`, body, s.op); }
    catch (e) {
      if (e.status === 0) { // réseau perdu / délai dépassé : le serveur a peut-être enregistré → seul un réessai identique est permis
        s.sent = body; (S.unresolved ||= {})[s.childId] = { op: s.op, body, tab: s.tab }; lockPanel();
      } else { s.sent = null; delete S.unresolved?.[s.childId]; }
      throw e;
    }
    delete S.unresolved?.[s.childId];
    // 2) le serveur a confirmé : solde affiché tout de suite à partir de sa réponse, fenêtre fermée, message de réussite
    const known = S.st.children.find((x) => x.id === r.childId); if (known) known.balance = r.balance;
    closeSheetQuiet();
    const gain = r.value > 0;
    if (gain) S.pulse = c.id;
    render();
    if (gain) celebrate(r.type === 'bonus');
    toast(`<b>${esc(c.name)}</b> : ${signed(r.value)} → ${pts(r.balance)}`, { undo: () => undoPost(`/api/transactions/${r.txId}/cancel`) });
    playSound(r.value > 0 ? 'gain' : 'loss', r.txId);   // son seulement maintenant : le serveur a confirmé (jamais pour une erreur)
    // 3) resynchronisation complète en arrière-plan (jamais bloquante)
    refresh(true);
  }),
  undo: () => { const u = S.undo; $('#toast').innerHTML = ''; S.undo = null; if (u) run(u); },
  cancelTx: (d) => ask('Annuler ce mouvement ?', 'Une écriture inverse est ajoutée à l’historique ; le mouvement d’origine reste visible.', 'Oui, annuler', () => undoPost(`/api/transactions/${d.id}/cancel`)),

  // enfants
  childForm: (d) => { const c = d.id ? kid(d.id) : null; openSheet({ kind: 'childForm', id: c?.id, name: c?.name, age: c?.age, avatar: c?.avatar || AVATARS[Math.floor(Math.random() * AVATARS.length)], color: c?.color || COLORS[activeKids().length % COLORS.length] }); },
  pick: (d, el) => { S.sheet[d.field] = d.val; el.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === el)); },
  archiveChild: (d) => ask('Archiver ce profil ?', 'Le profil disparaît de l’écran principal. L’historique et les points sont conservés ; tu pourras le restaurer.', 'Archiver', () => run(async () => {
    await write('POST', `/api/children/${d.id}/archive`, {}, `a:${d.id}`); closeSheetQuiet(); go('#/children'); render(); })),
  unarchiveChild: (d) => run(async () => { await write('POST', `/api/children/${d.id}/unarchive`, {}, `u:${d.id}`); render(); }),
  histFilter: (d) => { S.hist.type = d.t; loadHistory(true); },
  histMore: () => loadHistory(false, true),
  weekNav: (d) => { S.hist.offset = Math.min(0, S.hist.offset + Number(d.d)); loadHistory(true); },

  // défis
  challengeForm: () => {
    const ks = activeKids();
    openSheet({ kind: 'challengeForm', icon: '⭐', startsOn: S.st.today, endsOn: todayPlus(6), target: 5, bonus: 5, childIds: ks.length === 1 ? [ks[0].id] : [] });
  },
  complete: (d) => run(async () => {
    const before = S.st, ch0 = before.challenges.find((c) => c.id === d.id);
    const ids = ch0.collective ? ch0.childIds : [d.child];
    const bal0 = Object.fromEntries(ids.map((i) => [i, kid(i).balance]));
    const r = await write('POST', `/api/challenges/${d.id}/complete`, d.child ? { childId: d.child } : {}, `c:${d.id}:${d.child}`);
    const ch1 = S.st.challenges.find((c) => c.id === d.id);
    const won = !ch0.completed && ch1.completed;
    const name = ch0.collective ? 'Toute l’équipe' : kid(d.child).name;
    const gained = ids.map((i) => kid(i).balance - bal0[i]);
    render(); celebrate(won);
    playSound('gain', r.eventId);     // validation de défi confirmée = gain (et bonus éventuel)
    toast(`<b>${esc(name)}</b> : ${ch0.collective ? '+' + gained[0] : signed(gained[0])}${won ? ' · défi réussi ! 🎉' : ''}`, { undo: () => undoPost(`/api/completions/${r.eventId}/cancel`) });
  }),
  archiveChallenge: (d) => ask('Archiver ce défi ?', 'Il disparaît de la liste. Les points déjà gagnés restent acquis.', 'Archiver', () => run(async () => { await write('POST', `/api/challenges/${d.id}/archive`, {}, `ac:${d.id}`); closeSheet(); })),

  // récompenses
  rewardChild: (d) => { S.rewardChild = d.id; render(); },
  rewardForm: (d) => { const r = d.id ? S.st.rewards.find((x) => x.id === d.id) : null; openSheet({ kind: 'rewardForm', ...(r || { icon: '🎁', cost: 10, child_ids: [] }), id: r?.id }); },
  archiveReward: (d) => run(async () => { await write('POST', `/api/rewards/${d.id}/archive`, {}); closeSheet(); }),
  redeem: (d) => {
    const c = kid(S.rewardChild), r = S.st.rewards.find((x) => x.id === d.id);
    ask(`${r.icon} ${r.title}`, `Échanger ${r.cost} points de ${c.name} contre cette récompense ? Elle passera « à réaliser ».`, `Échanger ${r.cost} pts`, () => run(async () => {
      const res = await api('POST', `/api/rewards/${r.id}/redeem`, { childId: c.id }, S.sheet.op);
      await refresh(true); closeSheetQuiet(); render(); celebrate(false);
      toast(`<b>${esc(c.name)}</b> : ${r.icon} à réaliser · ${pts(res.balance)} restants`, { undo: () => undoPost(`/api/redemptions/${res.redemptionId}/cancel`) });
    }), false);
  },
  redDone: (d) => run(async () => { await write('POST', `/api/redemptions/${d.id}/done`, {}, `rd:${d.id}`); render(); toast('Récompense réalisée ✓'); }),
  redCancel: (d) => ask('Annuler cet échange ?', 'Les points sont rendus à l’enfant (une seule fois).', 'Annuler et rembourser', () => run(async () => { await write('POST', `/api/redemptions/${d.id}/cancel`, {}, S.sheet.op); closeSheet(); toast('Échange annulé, points rendus'); })),
  confirmYes: () => { const f = S.sheet.onYes; f(); },

  // bibliothèque
  actionForm: (d) => { const a = d.id ? S.st.actions.find((x) => x.id === d.id) : null; openSheet({ kind: 'actionForm', ...(a || { icon: '⭐', value: 2, theme: '', child_ids: [] }), id: a?.id }); },
  favAction: (d) => run(async () => { const a = S.st.actions.find((x) => x.id === d.id); await write('PATCH', `/api/actions/${d.id}`, { favorite: !a.favorite }, `f:${d.id}:${!a.favorite}:${Date.now() >> 10}`); render(); }),
  archiveAction: (d) => run(async () => { await write('POST', `/api/actions/${d.id}/archive`, {}); closeSheet(); }),
  unarchiveAction: (d) => run(async () => { await write('POST', `/api/actions/${d.id}/unarchive`, {}, `ua:${d.id}`); render(); }),

  // famille
  invite: () => { openSheet({ kind: 'invite' }); run(async () => { const r = await api('POST', '/api/family/invites', {}, S.sheet.op); S.sheet.code = r.code; S.sheet.expiresAt = r.expiresAt; renderSheet(); await refresh(true); }); },
  invites: () => openSheet({ kind: 'invites' }),
  revoke: (d) => run(async () => { await api('DELETE', `/api/family/invites/${d.id}`); await refresh(true); if (S.st.invites.length) renderSheet(); else closeSheet(); }),
  copyCode: async () => { try { await navigator.clipboard.writeText(S.sheet.code); toast('Code copié'); } catch { toast('Copie impossible : sélectionne le code', { error: true }); } },
  shareCode: () => navigator.share({ text: `Rejoins notre famille sur Petits Héros avec ce code : ${S.sheet.code}` }).catch(() => {}),
  approve: (d) => run(async () => { await api('POST', `/api/family/members/${d.id}/approve`, {}); await refresh(true); render(); toast('Accès approuvé ✓'); }),
  memberMenu: (d) => openSheet({ kind: 'memberMenu', id: d.id }),
  resetCode: (d) => run(async () => { const r = await api('POST', `/api/family/members/${d.id}/reset-code`, {}); S.sheet.resetCode = r.code; renderSheet(); }),
  removeMember: (d) => run(async () => { await api('DELETE', `/api/family/members/${d.id}`); await refresh(true); closeSheet(); }),
  leave: () => ask('Quitter la famille ?', 'Tu n’auras plus accès aux données de cette famille.', 'Quitter', () => run(async () => { await api('POST', '/api/family/leave', {}); stopPolling(); S.st = null; closeSheet(); await boot(); })),
  quickForm: () => openSheet({ kind: 'quickForm' }),
  toggleSound: () => { S.prefs.sound = !S.prefs.sound; save('ph_prefs', S.prefs); render(); },  // mémorisé par appareil, sans aperçu sonore
  toggleAnim: () => { S.prefs.anim = !S.prefs.anim; save('ph_prefs', S.prefs); document.body.classList.toggle('noanim', !S.prefs.anim); render(); },
  lockOn: () => openSheet({ kind: 'lockSet' }),
  unlock: () => openSheet({ kind: 'unlock' }),
  chpw: () => openSheet({ kind: 'chpw' }),
  delAcc: () => {
    openSheet({ kind: 'delacc', sit: null });
    const sh = S.sheet;
    api('GET', '/api/auth/account-situation').then((r) => { if (S.sheet === sh) { sh.sit = r; renderSheet(); } }).catch((e) => { if (S.sheet === sh) { sh.error = errMsg(e); renderSheet(); } });
  },
  makeOwner: (d) => ask('Nommer propriétaire ?', 'Ce parent deviendra propriétaire (invitations, validations, export, suppression de la famille). Tu deviendras parent simple. Tu pourras ensuite supprimer ton compte si tu le souhaites.', 'Nommer propriétaire', () => run(async () => { await api('POST', `/api/family/members/${d.id}/make-owner`, {}); await refresh(true); closeSheet(); toast('Nouveau propriétaire nommé ✓'); }), false),
  installHelp: () => openSheet({ kind: 'install' }),
  doInstall: async () => { const ev = S.installEvt; S.installEvt = null; closeSheet(); try { await ev?.prompt(); } catch { /* refusé par le navigateur */ } },
  exportData: () => run(async () => {
    const r = await fetch(API_BASE + '/api/family/export', { credentials: NATIVE ? 'omit' : 'same-origin', headers: NATIVE ? { authorization: `Bearer ${S.token}`, 'x-client': `native-android/${APP_BUILD}` } : {} });
    if (!r.ok) throw new Error('Export impossible');
    await saveFile(`petits-heros-${new Date().toISOString().slice(0, 10)}.json`, 'application/json', await r.text());
  }),
};
async function undoPost(path) {
  const r = await api('POST', path, {});
  const known = r.childId && S.st?.children.find((x) => x.id === r.childId); if (known && Number.isInteger(r.balance)) known.balance = r.balance;
  render(); toast('Annulé ↩️');
  refresh(true);
}

// ---------- formulaires ----------
const csvInts = (v) => v.split(/[,;\s]+/).filter(Boolean).map(Number);
const F = {
  login: async (f) => { await api('POST', '/api/auth/login', { email: f.email.value, password: f.password.value }); await boot(); },
  register: async (f) => { const r = await api('POST', '/api/auth/register', { name: f.name.value, email: f.email.value, password: f.password.value, familyName: f.familyName.value }); S.recovery = r.recoveryCodes; await boot(); },
  join: async (f) => {
    const r = await api('POST', '/api/auth/register', { name: f.name.value, email: f.email.value, password: f.password.value });
    S.recovery = r.recoveryCodes;
    try { await api('POST', '/api/family/join', { code: f.code.value }); } catch (e) { S.auth.error = `${errMsg(e)} Tu peux réessayer ci-dessous.`; }
    await boot();
  },
  newfamily: async (f) => { await api('POST', '/api/auth/family', { familyName: f.familyName.value }); await boot(); },
  joincode: async (f) => { await api('POST', '/api/family/join', { code: f.code.value }); S.auth.error = ''; await boot(); },
  forgot: async (f) => { const r = await api('POST', '/api/auth/forgot', { email: f.email.value }); S.auth = { mode: 'forgot', error: '', info: r.mailEnabled ? 'Si un compte correspond à cette adresse, un e-mail va être envoyé (parfois après quelques minutes ; pense aux courriers indésirables). Le lien est valable 1 heure et ne sert qu’une fois.' : 'L’envoi d’e-mails n’est pas configuré. Utilise un code de secours, ou demande un code au parent propriétaire (onglet Famille › ⋯).' }; render(); },
  recover: async (f) => { await api('POST', '/api/auth/recover', { email: f.email.value, code: f.code.value, password: f.password.value }); S.auth = { mode: 'login', error: '', info: 'Mot de passe modifié. Connecte-toi (tes autres appareils ont été déconnectés).' }; render(); },
  regen: async (f) => { const r = await api('POST', '/api/auth/recovery-codes', { password: f.password.value }); S.sheet.codes = r.recoveryCodes; S.me.recoveryRemaining = r.recoveryCodes.length; renderSheet(); },
  reset: async (f) => { await api('POST', '/api/auth/reset', { token: f.token.value, password: f.password.value }); S.auth = { mode: 'login', error: '', info: 'Mot de passe modifié. Connecte-toi.' }; go('#/'); render(); },
  child: async (f) => {
    const s = S.sheet, body = { name: f.name.value, age: f.age.value === '' ? null : Number(f.age.value), avatar: s.avatar, color: s.color };
    await write(s.id ? 'PATCH' : 'POST', s.id ? `/api/children/${s.id}` : '/api/children', body); closeSheet();
  },
  action: async (f) => {
    const s = S.sheet, body = { title: f.title.value, theme: f.theme.value, icon: s.icon, value: Number(f.value.value), favorite: f.favorite.checked, childIds: checkedKids(f),
      note: f.note.value, minIntervalHours: f.minIntervalHours.value === '' ? null : Number(f.minIntervalHours.value) };
    await write(s.id ? 'PATCH' : 'POST', s.id ? `/api/actions/${s.id}` : '/api/actions', body); closeSheet();
  },
  reward: async (f) => {
    const s = S.sheet, body = { title: f.title.value, icon: s.icon, cost: Number(f.cost.value), childIds: checkedKids(f) };
    await write(s.id ? 'PATCH' : 'POST', s.id ? `/api/rewards/${s.id}` : '/api/rewards', body); closeSheet();
  },
  challenge: async (f) => {
    const s = S.sheet, body = { title: f.title.value, icon: s.icon, actionId: f.actionId.value || null, collective: f.collective.checked, childIds: checkedKids(f),
      startsOn: f.startsOn.value, endsOn: f.endsOn.value, target: Number(f.target.value), bonus: Number(f.bonus.value), frequency: f.frequency.value };
    await write('POST', '/api/challenges', body); closeSheet(); go('#/challenges');
  },
  quick: async (f) => { await write('PATCH', '/api/family/settings', { quickPlus: csvInts(f.plus.value), quickMinus: csvInts(f.minus.value) }); closeSheet(); },
  delacc: async (f) => {
    const body = { password: f.password.value, confirm: f.confirm.value, deleteFamily: !!f.deleteFamily?.checked };
    const r = await api('POST', '/api/auth/delete-account', body);
    stopPolling(); wipeLocal(); S.me = null; S.st = null; closeSheetQuiet();
    S.auth = { mode: 'login', error: '', info: r.familyDeleted ? 'Compte et famille supprimés.' : 'Compte supprimé.' }; go('#/'); render();
  },
  chpw: async (f) => { await api('POST', '/api/auth/change-password', { current: f.current.value, password: f.password.value }); closeSheet(); toast('Mot de passe modifié ✓'); },
  lockSet: async (f) => { if (!/^\d{4}$/.test(f.pin.value)) throw new Error('4 chiffres'); const salt = uid(); S.lock = { on: true, salt, hash: await sha(salt + f.pin.value) }; save('ph_lock', S.lock); closeSheetQuiet(); go('#/children'); render(); },
  unlock: async (f) => { if ((await sha(S.lock.salt + f.pin.value)) !== S.lock.hash) throw new Error('Code incorrect'); S.lock = { on: false }; save('ph_lock', S.lock); closeSheet(); },
};

// ---------- écouteurs ----------
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = A[el.dataset.act];
  if (fn) { if (el.dataset.act !== 'closeBackdrop' || e.target === el) fn(el.dataset, el, e); }
});
document.addEventListener('submit', (e) => {
  const f = e.target.closest('form[data-form]'); if (!f) return;
  e.preventDefault();
  const fn = F[f.dataset.form];
  if (!fn || S.busy) return;
  const auth = !S.sheet && ['login', 'register', 'join', 'forgot', 'reset', 'recover', 'newfamily', 'joincode'].includes(f.dataset.form);
  S.busy = true;
  const sheet = S.sheet, btns = [...f.querySelectorAll('button:not([type=button])')];
  if (sheet) setPending(true);
  else btns.forEach((b) => { b.dataset.label = b.innerHTML; b.disabled = true; b.textContent = auth ? 'Patientez…' : PENDING_LABEL; });
  fn(f).catch((err) => {
    if (sheet && S.sheet === sheet) { setPending(false); sheetErr(errMsg(err)); }
    else if (auth) { S.auth.error = errMsg(err); render(); } else toast(esc(errMsg(err)), { error: true });
  }).finally(() => {
    S.busy = false;
    if (S.sheet && S.sheet.pending) setPending(false);
    btns.forEach((b) => { if (b.isConnected && b.dataset.label !== undefined) { b.innerHTML = b.dataset.label; b.disabled = false; delete b.dataset.label; } });
  });
});
document.addEventListener('input', (e) => {
  const b = e.target.dataset?.bind; if (!b || !S.sheet) return;
  S.sheet[b] = b === 'value' ? (e.target.value === '' ? null : Number(e.target.value)) : e.target.value;
  if (b === 'value') S.sheet.actionId = S.sheet.tab === 'action' || S.sheet.tab === 'behavior' ? S.sheet.actionId : null;
  const slot = $('#cslot'); if (slot) slot.innerHTML = confirmBar(S.sheet);
  document.querySelectorAll('.quick button').forEach((q) => q.classList.toggle('on', Number(q.dataset.v) === S.sheet.value));
});
window.addEventListener('hashchange', () => { if (S.declined) { S.declined = false; $('#sheet').innerHTML = ''; document.body.classList.remove('sheet-open'); } clearToast(); S.hist = null; if (!S.sheet) render(); else userClose(); window.scrollTo(0, 0); });
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); S.installEvt = e; });
window.addEventListener('appinstalled', () => { S.installEvt = null; if (!S.sheet) render(); toast('Application installée ✓'); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && S.declined) closeDeclined();
  else if (e.key === 'Escape' && S.sheet) userClose();
  // Entrée dans un champ de saisie des points = enregistrer (un seul geste, sans viser le bouton)
  if (e.key === 'Enter' && S.sheet?.kind === 'points' && e.target.matches?.('input[data-bind]') && pointsValid(S.sheet)) { e.preventDefault(); A.pointsConfirm(); }
});
// Toucher le bouton d'envoi ne doit pas retirer le focus du champ : sinon le clavier se referme, la mise en page change
// sous le doigt et le premier appui est perdu (il fallait appuyer deux fois). Le clic est conservé.
document.addEventListener('pointerdown', (e) => {
  if (e.target.closest?.('.panel [data-submit], .panel form .btn.primary') && document.activeElement?.matches?.('input, textarea, select')) e.preventDefault();
});

// bouton Retour Android : ferme d'abord la fenêtre ouverte, remonte d'un niveau, puis quitte à la racine
function handleBack() {
  if (S.declined) { closeDeclined(); return; }
  if (S.sheet) { userClose(); return; }
  if (S.me && S.recovery) return; // codes de secours : il faut les valider
  if (!S.me) { if (S.auth.mode !== 'login') { S.auth = { mode: 'login', error: '', info: '' }; render(); } else window.PHNative.exit(); return; }
  if (!S.me.membership || S.me.membership.status !== 'active') { window.PHNative.exit(); return; }
  const r = route();
  if (r.a === 'library') { go('#/family'); return; }
  if (r.a !== 'children') { go('#/children'); return; }
  window.PHNative.exit();
}
if (NATIVE) {
  window.PHNative.onBack(handleBack);
  window.PHNative.onResume(() => { if (S.st) refresh(); else boot(); });
}
// clavier mobile : la fenêtre suit la zone réellement visible et le champ actif reste visible
if (window.visualViewport) {
  const vv = () => document.documentElement.style.setProperty('--vvh', `${Math.round(visualViewport.height)}px`);
  visualViewport.addEventListener('resize', vv); vv();
}
document.addEventListener('focusin', (e) => {
  if (S.sheet && e.target.matches('input, select, textarea')) setTimeout(() => e.target.scrollIntoView({ block: 'center', behavior: 'smooth' }), 300);
});
// retour arrière après déconnexion : jamais d'affichage depuis le cache de navigation
window.addEventListener('pageshow', (e) => { if (e.persisted) boot(); });
document.body.classList.toggle('noanim', !S.prefs.anim);
if ('serviceWorker' in navigator && !NATIVE) navigator.serviceWorker.register('/sw.js').catch(() => {});
(async () => { if (NATIVE) S.token = (await window.PHNative.getToken()) || ''; boot(); })();
