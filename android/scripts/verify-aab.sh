#!/bin/sh
# Vérifie un Android App Bundle avant publication :
#   • signé (jarsigner) par LA bonne clé (empreinte SHA-256 = EXPECTED_CERT_SHA256, lue avec keytool) ;
#   • bundletool valide le bundle ; identité, versionCode, targetSdk, non débogable, permissions = INTERNET seule ;
#   • contenu embarqué : fonctions attendues présentes dans l'interface (suppression de compte, etc.).
#   EXPECTED_CERT_SHA256=<hex> EXPECTED_VERSION_CODE=<n> BUNDLETOOL=<jar> sh android/scripts/verify-aab.sh app.aab
set -eu
AAB="${1:?usage: verify-aab.sh fichier.aab}"
: "${EXPECTED_CERT_SHA256:?EXPECTED_CERT_SHA256 manquant}" "${EXPECTED_VERSION_CODE:?EXPECTED_VERSION_CODE manquant}" "${BUNDLETOOL:?BUNDLETOOL manquant (jar)}"
fail() { echo "ÉCHEC : $*"; exit 1; }
# 1. signature
jarsigner -verify "$AAB" >/tmp/js.txt 2>&1 || { cat /tmp/js.txt; fail "jarsigner : signature invalide"; }
grep -q "jar verified" /tmp/js.txt || fail "jarsigner n'a pas confirmé la signature"
GOT="$(keytool -printcert -jarfile "$AAB" 2>/dev/null | sed -n 's/^[[:space:]]*SHA256:[[:space:]]*//p' | head -1 | tr -d ':' | tr 'A-F' 'a-f')"
WANT="$(echo "$EXPECTED_CERT_SHA256" | tr -d ':' | tr 'A-F' 'a-f')"
[ -n "$GOT" ] || fail "empreinte du certificat introuvable"
[ "$GOT" = "$WANT" ] || fail "certificat de l'AAB ($GOT) ≠ clé attendue ($WANT)"
echo "signature OK, certificat $GOT"
# 2. structure et manifeste
java -jar "$BUNDLETOOL" validate --bundle="$AAB" >/dev/null || fail "bundletool validate"
echo "bundletool validate OK"
M="$(java -jar "$BUNDLETOOL" dump manifest --bundle="$AAB")"
echo "$M" | grep -q 'package="fr.petitsheros.app"' || fail "identité ≠ fr.petitsheros.app"
echo "$M" | grep -q "android:versionCode=\"$EXPECTED_VERSION_CODE\"" || fail "versionCode ≠ $EXPECTED_VERSION_CODE"
echo "$M" | grep -q 'android:targetSdkVersion="36"' || fail "targetSdk ≠ 36"
echo "$M" | grep -q 'android:debuggable' && fail "l'application est marquée débogable"
PERMS="$(echo "$M" | sed -n 's/.*<uses-permission[^>]*android:name="\([^"]*\)".*/\1/p' | sort -u | tr '\n' ' ')"
[ "$PERMS" = "android.permission.INTERNET " ] || fail "permissions inattendues : $PERMS"
echo "manifeste OK : fr.petitsheros.app, versionCode $EXPECTED_VERSION_CODE, targetSdk 36, non débogable, permissions : $PERMS"
# 3. contenu embarqué (fonctions annoncées réellement présentes)
has() { [ "$(unzip -p "$AAB" "$1" | grep -c -F -- "$2")" -ge 1 ] || fail "« $2 » introuvable dans $1"; }
APP=base/assets/public/app.js
has $APP "Supprimer mon compte"; has $APP 'data-form="delacc"'; has $APP "Nommer propriétaire"
has $APP "Point non validé"; has $APP "playSound"; has $APP "J’ai un code d’invitation"
has $APP "Politique de confidentialité"; has $APP "l’envoi d’e-mails n’est pas configuré"
has base/assets/public/config.js "https://petits-heros-production.up.railway.app"
unzip -l "$AAB" | grep -q "assets/public/legal/" && fail "les pages web légales ne doivent pas être embarquées"
unzip -p "$AAB" base/assets/public/index.html | grep -q "Content-Security-Policy" || fail "CSP absente"
echo "contenu embarqué OK"
