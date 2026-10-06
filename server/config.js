// Configuration lue depuis l'environnement (aucun secret dans le code source).
export const config = {
  get databaseUrl() { return process.env.DATABASE_URL; },
  get port() { return Number(process.env.PORT || 3000); },
  get isProd() { return process.env.NODE_ENV === 'production'; },
  get appUrl() { return (process.env.APP_URL || '').replace(/\/$/, ''); },
  get timezone() { return process.env.APP_TZ || 'Europe/Paris'; },
  get resendKey() { return process.env.RESEND_API_KEY || ''; },
  get mailFrom() { return process.env.MAIL_FROM || ''; },
  get pgSsl() { return process.env.PGSSL === 'true'; },
};
