// Configuration lue depuis l'environnement (aucun secret dans le code source).
export const config = {
  get databaseUrl() { return process.env.DATABASE_URL; },
  get port() { return Number(process.env.PORT || 3000); },
  get isProd() { return process.env.NODE_ENV === 'production'; },
  get appUrl() { return (process.env.APP_URL || '').replace(/\/$/, ''); },
  get timezone() { return process.env.APP_TZ || 'Europe/Paris'; },
  get resendKey() { return process.env.RESEND_API_KEY || ''; },
  get mailFrom() { return process.env.MAIL_FROM || ''; },
  // Origines autorisées à appeler l'API depuis l'application Android (WebView Capacitor : https://localhost).
  get corsOrigins() { return ['https://localhost', ...(process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)]; },
  // Build Android minimal accepté (versionCode). 0 = pas de contrainte. Permet de forcer une mise à jour si l'API change de façon incompatible.
  get minNativeBuild() { return Number(process.env.MIN_NATIVE_BUILD || 0); },
  get pgSsl() { return process.env.PGSSL === 'true'; },
};
