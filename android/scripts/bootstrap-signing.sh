#!/bin/sh
# Crée UNE FOIS la clé de signature définitive DANS GitHub Actions et l'enregistre dans les secrets du dépôt.
#  - aucune valeur secrète n'est affichée (ni sortie standard, ni journaux, ni arguments de commande) ;
#  - refuse d'écraser une clé existante (perdre/remplacer la clé = plus de mises à jour possibles) ;
#  - prépare une sauvegarde CHIFFRÉE avec la phrase secrète choisie par le propriétaire (jamais transmise par chat).
# Environnement : GH_TOKEN (jeton limité aux secrets du dépôt), GH_REPO (owner/repo), BACKUP_PASSPHRASE (≥ 20 caractères)
#   usage : bootstrap-signing.sh DOSSIER_DE_TRAVAIL
set -eu
umask 077
WORK="${1:?usage: bootstrap-signing.sh DOSSIER}"
: "${GH_TOKEN:?GH_TOKEN manquant}"; : "${GH_REPO:?GH_REPO manquant}"; : "${BACKUP_PASSPHRASE:?BACKUP_PASSPHRASE manquant}"
HERE="$(cd "$(dirname "$0")" && pwd)"
NAMES="ANDROID_KEYSTORE_BASE64 ANDROID_KEYSTORE_PASSWORD ANDROID_KEY_ALIAS ANDROID_KEY_PASSWORD ANDROID_CERT_SHA256"

[ "${#BACKUP_PASSPHRASE}" -ge 20 ] || { echo "ÉCHEC : la phrase secrète de sauvegarde doit faire au moins 20 caractères." >&2; exit 1; }
EXISTING="$(gh secret list --repo "$GH_REPO" --json name --jq '.[].name')" || { echo "ÉCHEC : le jeton ne peut pas lister les secrets (permission « Secrets : lecture et écriture » requise)." >&2; exit 1; }
for n in $NAMES; do
  if echo "$EXISTING" | grep -qx "$n"; then echo "REFUS : le secret $n existe déjà. Une clé de signature existe : elle n'est jamais écrasée. Aucune action effectuée." >&2; exit 1; fi
done

SHA="$(sh "$HERE/ci-make-keystore.sh" "$WORK/key")"
# 1) secrets du dépôt (valeurs lues sur l'entrée standard, jamais en argument)
for n in $NAMES; do
  sed -n "s/^$n=//p" "$WORK/key/signing.env" | tr -d '\n' | gh secret set "$n" --repo "$GH_REPO" >/dev/null
done
AFTER="$(gh secret list --repo "$GH_REPO" --json name --jq '.[].name')"
for n in $NAMES; do echo "$AFTER" | grep -qx "$n" || { echo "ÉCHEC : le secret $n n'a pas été enregistré." >&2; exit 1; }; done

# 2) sauvegarde chiffrée (AES-256, PBKDF2 600 000 itérations) + essai de déchiffrement
mkdir -p "$WORK/backup"
ENC="$WORK/backup/petits-heros-signing-backup.enc"
tar -C "$WORK/key" -cf - release.p12 signing.env | openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt -pass env:BACKUP_PASSPHRASE -out "$ENC"
mkdir -p "$WORK/check"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass env:BACKUP_PASSPHRASE -in "$ENC" | tar -C "$WORK/check" -xf -
cmp -s "$WORK/key/release.p12" "$WORK/check/release.p12" && cmp -s "$WORK/key/signing.env" "$WORK/check/signing.env" || { echo "ÉCHEC : la sauvegarde chiffrée ne se déchiffre pas correctement." >&2; exit 1; }
cp "$HERE/../RESTORE-SIGNING.md" "$WORK/backup/RESTORE-SIGNING.md"
rm -rf "$WORK/check" "$WORK/key"
echo "Clé créée et enregistrée dans les secrets : $NAMES"
echo "Empreinte SHA-256 du certificat (publique) : $SHA"
echo "Sauvegarde chiffrée (vérifiée) : $ENC"
