import { config } from './config.js';

// Envoi d'e-mails via Resend (https://resend.com) si RESEND_API_KEY et MAIL_FROM sont définis.
export const mailEnabled = () => !!(config.resendKey && config.mailFrom);

export async function sendMail({ to, subject, text }) {
  if (!mailEnabled()) return false;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: config.mailFrom, to: [to], subject, text }),
  });
  if (!r.ok) throw new Error(`Resend ${r.status}`);
  return true;
}
