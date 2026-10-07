#!/bin/sh
# Vérifie une instance déployée (non destructif, aucun compte créé).
# Usage : scripts/check-deploy.sh https://mon-app.up.railway.app
set -u
BASE="${1:?usage: $0 https://url-publique}"; BASE="${BASE%/}"
FAIL=0
ok()   { echo "  ✓ $1"; }
bad()  { echo "  ✗ $1"; FAIL=1; }
code() { curl -sS -m 15 -o /dev/null -w '%{http_code}' "$@" 2>/dev/null; }
hdr()  { curl -sSI -m 15 "$1" 2>/dev/null | tr -d '\r'; }

echo "Vérification de $BASE"
[ "$(code "$BASE/healthz")" = 200 ] && ok "/healthz 200" || bad "/healthz ne répond pas 200"
curl -sS -m 15 "$BASE/healthz" 2>/dev/null | grep -q '"db":true' && ok "base de données joignable, migrations appliquées" || bad "healthz : base ou migrations KO"
[ "$(code "$BASE/")" = 200 ] && ok "page d'accueil" || bad "page d'accueil"
for p in /app.js /styles.css /manifest.webmanifest /sw.js /icons/icon-192.png /icons/icon-512.png /icons/apple-touch-icon.png; do
  [ "$(code "$BASE$p")" = 200 ] && ok "$p" || bad "$p"
done
curl -sS -m 15 "$BASE/api/auth/me" 2>/dev/null | grep -q '"user":null' && ok "API : anonyme reconnu" || bad "API /api/auth/me"
[ "$(code "$BASE/api/family/state")" = 401 ] && ok "données familiales refusées sans session (401)" || bad "/api/family/state devrait répondre 401"
H=$(hdr "$BASE/api/auth/me")
echo "$H" | grep -qi '^cache-control:.*no-store' && ok "API : Cache-Control no-store" || bad "API : no-store absent"
echo "$H" | grep -qi '^content-security-policy:' && ok "en-têtes de sécurité (CSP)" || bad "CSP absente"
echo "$H" | grep -qi '^x-content-type-options: nosniff' && ok "nosniff" || bad "nosniff absent"
case "$BASE" in
  https://*) echo "$H" | grep -qi '^strict-transport-security:' && ok "HSTS (NODE_ENV=production actif)" || bad "HSTS absent : NODE_ENV=production défini ?"
             [ "$(code "http://${BASE#https://}/healthz")" != 000 ] && ok "HTTP→HTTPS géré par la plateforme" ;;
  *) echo "  ! URL non HTTPS : cookies Secure / PWA installable seulement en HTTPS (hors localhost)" ;;
esac
hdr "$BASE/sw.js" | grep -qi '^cache-control:.*no-cache' && ok "sw.js non mis en cache (mises à jour immédiates)" || bad "sw.js : Cache-Control"
# pages légales publiques (exigées par Google Play) : accessibles sans connexion, sans balise non remplacée
for p in /confidentialite /suppression-compte; do
  T=$(curl -sS -m 15 -w '\n%{http_code}' "$BASE$p" 2>/dev/null); C=$(echo "$T" | tail -1)
  [ "$C" = 200 ] && ! echo "$T" | grep -q '{{' && echo "$T" | grep -qi 'petits h' && ok "$p (200, sans balise non remplacée)" || bad "$p"
done
[ "$(code -X POST -H 'content-type: application/json' --data '{"email":"x@example.com","password":"x","confirm":"SUPPRIMER"}' "$BASE/api/auth/delete-account-public")" = 401 ] && ok "suppression publique : refus sans identifiants valides (401)" || bad "suppression publique : réponse inattendue"
[ $FAIL = 0 ] && echo "=> OK" || { echo "=> ÉCHEC"; exit 1; }
