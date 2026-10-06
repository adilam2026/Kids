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
export DATABASE_URL=postgres://postgres@localhost:5432/kids_test   # base JETABLE : le schéma est réinitialisé !
npm test                 # 20 tests API sur PostgreSQL réel (parcours, concurrence, isolation…)
npm run redeploy-test    # processus réel arrêté puis relancé : données conservées
npm run e2e              # 2 « téléphones » Chromium (Playwright requis) : tout le parcours dans l’interface
```

⚠️ Ces commandes **suppriment le schéma `public`** de la base ciblée : n’utilisez jamais la base de production.

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
