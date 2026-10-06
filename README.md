# Petits Héros 🦸

Application familiale de points, défis et récompenses — **PWA** installable (iPhone / Android), **API Node.js** et **PostgreSQL** partagé entre les parents.

## Architecture

| Couche | Choix | Pourquoi |
|---|---|---|
| Interface | PWA en JavaScript natif (ES modules, **aucun build**), service worker | Maintenable sans outillage, installable, mobile d’abord |
| Serveur | Node 22 + Express 5, un seul processus | Léger : sert l’interface et l’API, une instance suffit |
| Base | PostgreSQL (`pg`), migrations SQL versionnées dans `migrations/` | Transactions, verrous et index uniques = intégrité des points |
| Auth | Comptes parents (e-mail + mot de passe **scrypt**), sessions opaques en base (cookie `HttpOnly`, `SameSite=Lax`, `Secure` en prod) | Aucune dépendance externe |
| Synchro | Compteur de révision par famille, interrogé toutes les 3 s (+ à la réouverture / au retour réseau) | Simple et robuste ; < 5 s entre deux téléphones |
| Pas de | Redis, microservices, IA, stockage de photos | Inutiles en V1 |

Dépendances de production : `express`, `pg` (rien d’autre).

### Garanties d’intégrité (côté serveur)

* **Isolation** : l’appartenance à la famille est lue en base à chaque requête (jamais fournie par le client) ; chaque requête SQL filtre sur `family_id`.
* **Écritures sérialisées par famille** (`SELECT … FOR UPDATE` sur la famille) dans une transaction ; le solde est modifié par `UPDATE … SET balance = balance + $1 WHERE balance + $1 >= 0` : +2 et +3 simultanés = +5, jamais de solde négatif (contrainte `CHECK` en plus).
* **Idempotence** : chaque écriture exige un en-tête `X-Op-Id` ; la réponse est mémorisée dans la table `operations`. Double clic ou nouvel essai réseau = même réponse, aucune seconde attribution.
* **Annulations** : un mouvement n’est jamais effacé ; une compensation liée (`reverses_id`, **index unique**) est ajoutée → pas de double remboursement.
* **Bonus de défi** : index unique partiel `(challenge_id, child_id) WHERE cancelled_at IS NULL` → versé une seule fois.

### Règles métier choisies

* Solde jamais négatif (retrait trop élevé → message « Corrige le montant »). Pas de remise à zéro hebdomadaire.
* Annuler un mouvement dont les points ont déjà été dépensés est **refusé** (le solde deviendrait négatif) ; le parent peut faire un retrait libre ≤ solde.
* Annuler une validation de défi annule aussi ses points et, si l’objectif n’est plus atteint, le **bonus final** (qui pourra être regagné, une seule fois).
* Une récompense **réalisée** ne peut plus être annulée ; avant cela, l’annulation rembourse une seule fois.
* Défi individuel : progression par enfant, bonus à chacun. Défi collectif : une validation = les points de l’action pour chaque participant, progression partagée, bonus définis dès le départ pour chaque enfant. Aucun classement, aucune perte de points si le défi n’est pas terminé.
* Bilan hebdomadaire (lundi→dimanche, fuseau `APP_TZ`) : les compensations sont rattachées au type du mouvement annulé.
* Mode enfant : verrou **local** à l’appareil (code 4 chiffres). Il masque les commandes ; la vraie protection reste les comptes parents côté serveur.

## Lancer en local

```bash
npm install
# PostgreSQL local requis
export DATABASE_URL=postgres://postgres@localhost:5432/petits_heros
createdb petits_heros
npm start            # applique les migrations puis écoute sur http://localhost:3000
```

Variables : voir `.env.example`.

## Tests

```bash
# Base de test DÉDIÉE, jamais DATABASE_URL (les tests ne la lisent pas) :
createdb kids_test
export TEST_DATABASE_URL=postgres://postgres@localhost:5432/kids_test
npm test                 # 28 tests : API sur PostgreSQL réel + garde-fous
npm run redeploy-test    # processus réel arrêté puis relancé : données conservées
npm run e2e              # « téléphones » Chromium (Playwright requis) : interface, mobile, PWA, sécurité locale
```

**Garde-fous des tests destructifs** (`test/guard.js`, testés dans `test/guard.test.js`) : la réinitialisation du schéma est **refusée** si `NODE_ENV=production`, si l'hôte n'est pas local (sauf `PH_TEST_ALLOW_REMOTE=1`) ou est Railway, si le nom de base ne se termine pas par `_test`, si c'est la même base que `DATABASE_URL`, ou si la base contient des tables sans le marqueur `_ph_test_marker` posé par un précédent reset de test (une base `*_test` « précieuse » n'est donc jamais effacée).

## Données locales sur l'appareil

| Situation | Ce qui reste consultable |
|---|---|
| Connecté, hors ligne | Dernier état reçu (lecture seule, bandeau « Hors connexion », boutons inertes), **7 jours maximum** |
| Déconnexion, session révoquée (401), connexion d'un autre compte | **Rien** : copie locale, historique et état mémoire effacés ; retour arrière (bfcache) → rechargement |
| Membre **retiré** alors que son téléphone est **en ligne** | Sessions supprimées côté serveur : au plus tard au prochain échange (≤ 3 s, ou à la réouverture) → écran de connexion + copie locale effacée |
| Membre retiré alors que son téléphone est **hors ligne** | Il peut **encore lire** la copie locale (jamais modifier) jusqu'à la reconnexion ou 7 jours ; le serveur lui refuse tout dès qu'il se reconnecte |
| Service worker | Ne met en cache que la coquille (`/`, JS, CSS, icônes) ; **jamais** `/api/*` (`Cache-Control: no-store` côté serveur) |

## Suggestions et installation

* **Ajouter les suggestions** (Famille, Bibliothèque ou Récompenses) : aperçu avec cases à cocher, doublons détectés (titre normalisé ou ancien intitulé) et grisés, jamais de remplacement d'une action ou récompense existante (même personnalisée), aucun solde ni historique modifié. Le catalogue est dans `server/seed.js` ; l'ajout est atomique et idempotent. Aucun malus pour pleurs, chagrin ou réveils nocturnes (vérifié par test).
* **Installer l'application** : bouton visible (Famille, liste Enfants, écran de connexion). Il déclenche l'installation native quand le navigateur l'autorise, sinon affiche les instructions Android (Chrome / Samsung Internet) ou iPhone (Safari / autre navigateur) et le lien commun aux deux parents.
* **Connexion** : cookie persistant 90 jours, prolongé à l'usage. ⚠️ Sur **iPhone**, l'app installée ne partage pas la session de Safari : il faut s'y connecter une fois. Sur Android (Chrome) la session est normalement partagée — à confirmer sur le téléphone.

## Vérification mobile

| Vérifié par test automatique (Chromium émulé mobile, 390×780 et 320×568) | À vérifier sur appareils réels |
|---|---|
| Manifeste + icônes, service worker actif, **installabilité Chromium sans erreur**, bouton « Installer » (événement `beforeinstallprompt` simulé), instructions Android/iPhone (user-agents simulés), mode application (requête média simulée), cookie persistant | Installation réelle Android (Chrome) et iPhone (Safari › Sur l'écran d'accueil), icône sur l'écran d'accueil, plein écran, barre d'état, session conservée après installation (Android) / reconnexion unique (iPhone) |
| Aucun débordement horizontal, cibles ≥ 44 px, texte ≥ 13,5 px, 4 onglets | Rendu réel des polices système, encoche / barre d'accueil iPhone (`safe-area`) |
| Fenêtres : défilement interne, fond figé, bouton Confirmer atteignable | **Vrai clavier** iOS/Android (ici : viewport réduit simulé + `visualViewport`) |
| Notifications contenues dans l'en-tête fixe, confettis ≤ 5, `prefers-reduced-motion` respecté | Réglage « réduire les animations » réel d'iOS/Android |
| Session persistante, reconnexion, hors ligne ↔ en ligne | Reprise de l'app installée après longue mise en veille, notifications système (non utilisées) |

## Déploiement, sauvegardes, coûts

Voir [`docs/DEPLOY.md`](docs/DEPLOY.md).

## Structure

```
server/        app Express, auth, règles de points (points.js), routes/
migrations/    SQL versionné (appliqué au démarrage, verrou consultatif)
public/        PWA (index.html, app.js, styles.css, sw.js, manifest, icônes)
scripts/       backup.sh, restore.sh, make-icons.mjs
test/          tests API, redéploiement, navigateur
```
