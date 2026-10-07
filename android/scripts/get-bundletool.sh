#!/bin/sh
# Télécharge bundletool (outil officiel Google, utilisé pour valider l'AAB). Affiche le chemin du jar ; son SHA-256 va sur stderr.
set -eu
V="${BUNDLETOOL_VERSION:-1.18.1}"
D="${1:-${RUNNER_TEMP:-/tmp}}"
curl -fsSL --retry 3 -o "$D/bundletool.jar" "https://github.com/google/bundletool/releases/download/$V/bundletool-all-$V.jar"
echo "bundletool $V sha256 $(sha256sum "$D/bundletool.jar" | cut -d' ' -f1)" >&2
echo "$D/bundletool.jar"
