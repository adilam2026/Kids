#!/bin/sh
# Restaure une sauvegarde dans la base CIBLE (écrase les tables existantes).
# Usage : DATABASE_URL=<base cible> scripts/restore.sh fichier.dump
# Conseil : restaurer d'abord dans une base vide de test, vérifier, puis seulement dans la production.
set -eu
: "${DATABASE_URL:?DATABASE_URL manquant}"
[ $# -eq 1 ] || { echo "usage: $0 fichier.dump"; exit 1; }
pg_restore --clean --if-exists --no-owner --no-privileges --single-transaction --dbname="$DATABASE_URL" "$1"
echo "restauration terminée"
