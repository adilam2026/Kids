import { config } from './config.js';

// Envoi d'e-mails transactionnels via l'API HTTPS de Brevo (https://developers.brevo.com) — pas de SMTP.
// Variables : BREVO_API_KEY (secrète, jamais journalisée), BREVO_FROM_EMAIL (expéditeur validé chez Brevo), BREVO_FROM_NAME.
export class MailError extends Error {
  // Le message ne contient JAMAIS la clé, l'adresse du destinataire, le contenu ni le corps de réponse de Brevo.
  constructor(kind, status, code) {
    super(`${kind}${status ? ` HTTP ${status}` : ''}${code ? ` (${code})` : ''}`);
    this.kind = kind; this.status = status; this.code = code;
  }
}
export const mailEnabled = () => !!(config.brevoKey && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.brevoFromEmail));

function endpoint() {
  const u = new URL(config.brevoUrl);
  const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !local) throw new MailError('configuration'); // la clé API ne circule qu'en HTTPS
  return u.toString();
}

// Résolu seulement si Brevo a ACCEPTÉ le message (HTTP 2xx avec un messageId). Toute autre issue lève une MailError :
//  - 'timeout'     : pas de réponse dans MAIL_TIMEOUT_MS (issue inconnue : le message est peut-être parti) ;
//  - 'network'     : connexion impossible ; 'http' : refus de Brevo (clé invalide, expéditeur non validé, quota…) ;
//  - 'unconfirmed' : réponse 2xx sans messageId (acceptation non démontrée).
export async function sendMail({ to, subject, text, html }) {
  if (!mailEnabled()) throw new MailError('disabled');
  const url = endpoint();
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), config.mailTimeoutMs);
  let status, raw;
  try {
    const r = await fetch(url, {
      method: 'POST', signal: ctl.signal, redirect: 'error',
      headers: { 'api-key': config.brevoKey, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ sender: { name: config.brevoFromName, email: config.brevoFromEmail }, to: [{ email: to }], subject, textContent: text, htmlContent: html }),
    });
    status = r.status; raw = await r.text();
  } catch (e) {
    throw new MailError(e?.name === 'AbortError' ? 'timeout' : 'network');
  } finally { clearTimeout(timer); }
  let j = null; try { j = JSON.parse(raw); } catch { /* corps non JSON */ }
  if (status < 200 || status >= 300) throw new MailError('http', status, typeof j?.code === 'string' && /^[a-z_]{3,40}$/.test(j.code) ? j.code : undefined);
  if (typeof j?.messageId !== 'string' || !j.messageId) throw new MailError('unconfirmed', status);
  return { messageId: j.messageId };
}
export const describeMailError = (e) => (e instanceof MailError ? e.message : 'erreur inattendue');
