// Configuration lue depuis l'environnement (aucun secret dans le code source).
export const config = {
  get databaseUrl() { return process.env.DATABASE_URL; },
  get port() { return Number(process.env.PORT || 3000); },
  get isProd() { return process.env.NODE_ENV === 'production'; },
  // URL publique : APP_URL, sinon le domaine fourni par Railway. JAMAIS déduite de l'en-tête Host (empoisonnement des liens de récupération).
  get appUrl() {
    const u = process.env.APP_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '');
    return u.replace(/\/$/, '');
  },
  get timezone() { return process.env.APP_TZ || 'Europe/Paris'; },
  get brevoKey() { return process.env.BREVO_API_KEY || ''; },
  get brevoFromEmail() { return process.env.BREVO_FROM_EMAIL || ''; },
  get brevoFromName() { return process.env.BREVO_FROM_NAME || 'Petits Héros'; },
  get brevoUrl() { return process.env.BREVO_API_URL || 'https://api.brevo.com/v3/smtp/email'; }, // surcharge réservée aux tests
  get mailTimeoutMs() { return Number(process.env.MAIL_TIMEOUT_MS) || 10000; },
  // Origines autorisées à appeler l'API depuis l'application Android (WebView Capacitor : https://localhost).
  get corsOrigins() { return ['https://localhost', ...(process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)]; },
  // Build Android minimal accepté (versionCode). 0 = pas de contrainte. Permet de forcer une mise à jour si l'API change de façon incompatible.
  get minNativeBuild() { return Number(process.env.MIN_NATIVE_BUILD || 0); },
  get pgSsl() { return process.env.PGSSL === 'true'; },
};
