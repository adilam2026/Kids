#!/bin/sh
# Contrôles d'un APK : contenu embarqué, identité, version, et (en production) débogage désactivé.
#   MODE=release|debug  EXPECTED_VERSION_CODE=<n>  sh android/scripts/check-apk-content.sh app.apk
set -eu
APK="${1:?usage: check-apk-content.sh fichier.apk}"
MODE="${MODE:-debug}"
has() { [ "$(unzip -p "$APK" "$1" | grep -c -F -- "$2")" -ge 1 ] || { echo "ÉCHEC : « $2 » introuvable dans $1"; exit 1; }; }
has assets/public/app.js "J’ai un code d’invitation"     # rejoindre une famille avec un code
has assets/public/app.js 'data-form="join"'
has assets/public/app.js 'data-form="joincode"'
has assets/public/app.js "Enregistrement…"                 # état d'envoi
has assets/public/index.html native-bridge.js
has assets/public/config.js "https://petits-heros-production.up.railway.app"
echo "contenu embarqué OK"
find_tool() { command -v "$1" 2>/dev/null && return 0; for r in "${ANDROID_HOME:-}" "${ANDROID_SDK_ROOT:-}"; do [ -n "$r" ] && ls -d "$r"/build-tools/*/"$1" 2>/dev/null | sort -V | tail -1 | grep . && return 0; done; return 1; }
if AAPT2="$(find_tool aapt2)"; then
  BADGE="$("$AAPT2" dump badging "$APK")"
  PKG="$(echo "$BADGE" | sed -n 's/^package: //p')"; echo "$PKG"
  echo "$PKG" | grep -q "name='fr.petitsheros.app'" || { echo "ÉCHEC : mauvaise identité"; exit 1; }
  if [ -n "${EXPECTED_VERSION_CODE:-}" ]; then echo "$PKG" | grep -q "versionCode='$EXPECTED_VERSION_CODE'" || { echo "ÉCHEC : versionCode ≠ $EXPECTED_VERSION_CODE"; exit 1; }; fi
  if [ "$MODE" = release ]; then
    if echo "$BADGE" | grep -q "application-debuggable"; then echo "ÉCHEC : l'APK de production est marqué débogable"; exit 1; fi
    echo "production : débogage désactivé (non débogable)"
  fi
else
  echo "(aapt2 absent : identité, version et débogage non vérifiés)"
fi
