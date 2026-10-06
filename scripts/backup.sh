#!/bin/sh
# Sauvegarde logique complète (pg_dump, format custom) + envoi facultatif vers un stockage S3-compatible
# (Cloudflare R2, Backblaze B2, AWS S3…). Prévu pour un service Railway « cron » séparé (voir docs/DEPLOY.md).
#
# Variables : DATABASE_URL (obligatoire)
#   S3_BUCKET, S3_ENDPOINT (facultatif, ex. https://<id>.r2.cloudflarestorage.com), AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
#   BACKUP_DIR (défaut ./backups), RETENTION_DAYS (défaut 14, purge locale et S3 des anciens fichiers)
set -eu
: "${DATABASE_URL:?DATABASE_URL manquant}"
DIR="${BACKUP_DIR:-./backups}"; mkdir -p "$DIR"
FILE="$DIR/petits-heros-$(date -u +%Y%m%dT%H%M%SZ).dump"
pg_dump --format=custom --no-owner --no-privileges --file="$FILE" "$DATABASE_URL"
# vérification : l'archive doit être lisible
pg_restore --list "$FILE" > /dev/null
echo "sauvegarde OK : $FILE ($(wc -c < "$FILE") octets)"
if [ -n "${S3_BUCKET:-}" ]; then
  EP=""; [ -n "${S3_ENDPOINT:-}" ] && EP="--endpoint-url $S3_ENDPOINT"
  # shellcheck disable=SC2086
  aws $EP s3 cp "$FILE" "s3://$S3_BUCKET/$(basename "$FILE")"
  echo "envoyée vers s3://$S3_BUCKET"
  CUT=$(date -u -d "-${RETENTION_DAYS:-14} days" +%Y%m%d 2>/dev/null || true)
  if [ -n "$CUT" ]; then
    # shellcheck disable=SC2086
    aws $EP s3 ls "s3://$S3_BUCKET/" | awk '{print $4}' | grep '^petits-heros-' | while read -r f; do
      d=$(echo "$f" | sed 's/petits-heros-\([0-9]*\)T.*/\1/')
      [ "$d" -lt "$CUT" ] && aws $EP s3 rm "s3://$S3_BUCKET/$f" || true
    done
  fi
fi
find "$DIR" -name 'petits-heros-*.dump' -mtime +"${RETENTION_DAYS:-14}" -delete 2>/dev/null || true
