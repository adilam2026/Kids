// Pont entre l'interface web (public/app.js) et les plugins Capacitor. Empaqueté par esbuild en www/native-bridge.js.
// Défini uniquement dans l'application Android : dans le navigateur, window.PHNative n'existe pas.
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Preferences } from '@capacitor/preferences';
import { Share } from '@capacitor/share';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';

/* global __PH_TEST_NATIVE__ */
const TEST = typeof __PH_TEST_NATIVE__ !== 'undefined' && __PH_TEST_NATIVE__; // vrai seulement pour le build de test Chromium
const KEY = 'ph_token';

if (TEST || Capacitor.isNativePlatform()) {
  const backCbs = [], resumeCbs = [];
  window.PHNative = {
    isNative: true,
    // Jeton de session : stockage privé de l'application (SharedPreferences), jamais dans le code ni dans la sauvegarde Android
    getToken: async () => (await Preferences.get({ key: KEY })).value,
    setToken: (v) => Preferences.set({ key: KEY, value: v }),
    clearToken: () => Preferences.remove({ key: KEY }),
    onBack: (cb) => { backCbs.push(cb); if (!TEST) App.addListener('backButton', () => cb()); },
    onResume: (cb) => { resumeCbs.push(cb); if (!TEST) App.addListener('resume', () => cb()); },
    exit: () => { if (TEST) { window.__exited = (window.__exited || 0) + 1; return; } return App.exitApp(); },
    async saveFile(name, mime, text) {
      if (TEST) { window.__saved = { name, mime, text }; return; }
      const f = await Filesystem.writeFile({ path: name, data: text, directory: Directory.Cache, encoding: Encoding.UTF8 });
      await Share.share({ title: name, url: f.uri, dialogTitle: 'Enregistrer ou partager' });
    },
  };
  if (TEST) window.PHNative._test = { back: () => backCbs.forEach((cb) => cb()), resume: () => resumeCbs.forEach((cb) => cb()) };
}
