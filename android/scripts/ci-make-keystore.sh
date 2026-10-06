#!/bin/sh
# Génère un keystore (PKCS12) + signing.env dans le dossier donné, avec des mots de passe aléatoires.
# N'AFFICHE JAMAIS de secret : seule l'empreinte SHA-256 du certificat (information publique) est écrite sur la sortie standard.
#   usage : ci-make-keystore.sh DOSSIER
set -eu
umask 077
DIR="${1:?usage: ci-make-keystore.sh DOSSIER}"
mkdir -p "$DIR"
JKS="$DIR/release.p12"
[ ! -e "$JKS" ] || { echo "REFUS : $JKS existe déjà" >&2; exit 1; }
PASS="$(LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 40)"
ALIAS="petitsheros"
keytool -genkeypair -storetype PKCS12 -keystore "$JKS" -storepass "$PASS" -keypass "$PASS" \
  -alias "$ALIAS" -keyalg RSA -keysize 4096 -validity 36500 \
  -dname "CN=Petits Heros, OU=Famille, O=Petits Heros, C=FR" >/dev/null 2>&1
SHA="$(keytool -J-Duser.language=en -list -v -keystore "$JKS" -storepass "$PASS" -alias "$ALIAS" 2>/dev/null | grep -E 'SHA-?256:' | head -1 | sed 's/.*SHA-*256: *//' | tr -d ': ' | tr 'A-F' 'a-f')"
[ -n "$SHA" ] || { echo "ÉCHEC : empreinte introuvable" >&2; exit 1; }
{
  echo "ANDROID_KEYSTORE_PASSWORD=$PASS"
  echo "ANDROID_KEY_PASSWORD=$PASS"
  echo "ANDROID_KEY_ALIAS=$ALIAS"
  echo "ANDROID_CERT_SHA256=$SHA"
  echo "ANDROID_KEYSTORE_BASE64=$(base64 < "$JKS" | tr -d '\n')"
} > "$DIR/signing.env"
echo "$SHA"
