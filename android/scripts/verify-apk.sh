#!/bin/sh
# Vérifie un APK avant publication : signé (v2+), empreinte du certificat = clé attendue, bonne identité, bonne version.
#   EXPECTED_CERT_SHA256=<hex> EXPECTED_VERSION_CODE=<n> sh android/scripts/verify-apk.sh app-release.apk
set -eu
APK="${1:?usage: verify-apk.sh fichier.apk}"
: "${EXPECTED_CERT_SHA256:?EXPECTED_CERT_SHA256 manquant}"
APP_ID="fr.petitsheros.app"
find_tool() { # outil dans le PATH ou dans le dernier build-tools du SDK
  command -v "$1" 2>/dev/null && return 0
  for r in "${ANDROID_HOME:-}" "${ANDROID_SDK_ROOT:-}"; do [ -n "$r" ] && ls -d "$r"/build-tools/*/"$1" 2>/dev/null | sort -V | tail -1 | grep . && return 0; done
  return 1
}
APKSIGNER="$(find_tool apksigner)" || { echo "apksigner introuvable"; exit 1; }
OUT="$("$APKSIGNER" verify --verbose --print-certs "$APK" 2>&1)" || { echo "$OUT"; echo "ÉCHEC : signature invalide ou absente"; exit 1; }
echo "$OUT" | grep -Eq 'Verified using v(2|3)[^:]*: true' || { echo "$OUT"; echo "ÉCHEC : ni schéma v2 ni v3"; exit 1; }
GOT="$(echo "$OUT" | sed -n 's/.*certificate SHA-256 digest: *//p' | head -1 | tr -d ':' | tr 'A-F' 'a-f')"
WANT="$(echo "$EXPECTED_CERT_SHA256" | tr -d ':' | tr 'A-F' 'a-f')"
[ -n "$GOT" ] || { echo "ÉCHEC : empreinte du certificat introuvable"; exit 1; }
[ "$GOT" = "$WANT" ] || { echo "ÉCHEC : le certificat de l'APK ($GOT) n'est PAS la clé attendue ($WANT). Une mise à jour signée autrement ne remplacerait pas l'application installée."; exit 1; }
echo "signature OK, certificat $GOT"
if AAPT2="$(find_tool aapt2)"; then
  B="$("$AAPT2" dump badging "$APK" 2>/dev/null | sed -n 's/^package: //p')"
  echo "$B" | grep -q "name='$APP_ID'" || { echo "ÉCHEC : identité $B (attendu $APP_ID)"; exit 1; }
  if [ -n "${EXPECTED_VERSION_CODE:-}" ]; then echo "$B" | grep -q "versionCode='$EXPECTED_VERSION_CODE'" || { echo "ÉCHEC : versionCode ≠ $EXPECTED_VERSION_CODE ($B)"; exit 1; }; fi
  echo "identité OK : $B"
else
  echo "(aapt2 absent : identité non vérifiée)"
fi
