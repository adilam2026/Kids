#!/bin/sh
# Crée UNE FOIS la clé de signature de Petits Héros. Cette clé définit l'identité de l'application :
# toute mise à jour future doit être signée avec la MÊME clé, sinon Android refuse de remplacer l'application.
#
# À exécuter sur votre ordinateur (Java requis : keytool). La clé n'est jamais écrite dans le dépôt.
#   sh android/scripts/generate-keystore.sh [dossier]      (défaut : ~/petits-heros-signing)
set -eu
command -v keytool >/dev/null || { echo "keytool introuvable : installez un JDK 17 ou 21."; exit 1; }
DIR="${1:-$HOME/petits-heros-signing}"
JKS="$DIR/petits-heros-release.p12"
[ ! -e "$JKS" ] || { echo "REFUS : $JKS existe déjà. Ne régénérez jamais la clé (les mises à jour cesseraient de fonctionner)."; exit 1; }
mkdir -p "$DIR"; chmod 700 "$DIR"
rand() { LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 32; }
PASS="$(rand)"; ALIAS="petitsheros"
keytool -genkeypair -v -storetype PKCS12 -keystore "$JKS" -storepass "$PASS" -keypass "$PASS" \
  -alias "$ALIAS" -keyalg RSA -keysize 4096 -validity 36500 \
  -dname "CN=Petits Heros, OU=Famille, O=Petits Heros, C=FR" >/dev/null 2>&1
chmod 600 "$JKS"
SHA="$(keytool -J-Duser.language=en -list -v -keystore "$JKS" -storepass "$PASS" -alias "$ALIAS" 2>/dev/null | grep -E 'SHA-?256:' | head -1 | sed 's/.*SHA-*256: *//' | tr -d ': ' | tr 'A-F' 'a-f')"
[ -n "$SHA" ] || { echo "ÉCHEC : empreinte du certificat introuvable"; exit 1; }
B64="$(base64 < "$JKS" | tr -d '\n')"
SECRETS="$DIR/github-secrets.txt"
umask 077
cat > "$SECRETS" <<EOT
# À COPIER dans GitHub : Settings > Secrets and variables > Actions > New repository secret.
# Puis SUPPRIMER ce fichier et conserver la sauvegarde de $JKS + le mot de passe dans un gestionnaire de mots de passe.
ANDROID_KEYSTORE_PASSWORD=$PASS
ANDROID_KEY_PASSWORD=$PASS
ANDROID_KEY_ALIAS=$ALIAS
ANDROID_CERT_SHA256=$SHA
ANDROID_KEYSTORE_BASE64=$B64
EOT
echo "Clé créée : $JKS"
echo "Empreinte SHA-256 du certificat (à noter) : $SHA"
echo "Secrets à créer dans GitHub, prêts à copier : $SECRETS"
echo
echo "IMPORTANT : sauvegardez $JKS et le mot de passe EN DEUX ENDROITS. Perdre cette clé = impossible de mettre à jour l'application"
echo "(il faudrait la désinstaller puis réinstaller une application différente). Ne la publiez jamais (GitHub, e-mail, chat)."
