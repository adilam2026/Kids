// Configuration injectée au chargement. Version web : même origine que l'API (valeurs vides).
// Le build Android (scripts/build-www.mjs) génère un autre config.js avec l'adresse HTTPS du serveur.
window.PH_API_BASE = '';
window.PH_BUILD = 0;
window.PH_VERSION = 'web';
