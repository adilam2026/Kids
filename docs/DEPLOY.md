# Déployer sur Railway

> **État honnête** : au moment de la rédaction, **rien n'est déployé** et je n'ai **aucun accès** à votre compte Railway (ni CLI, ni jeton, ni réseau vers railway.com ni docs.railway.com depuis mon environnement). Tout ce qui suit est préparé et testé **en local** ; les étapes Railway sont à exécuter par vous, avec un script de vérification de l'URL publique à lancer ensuite. Les tarifs et limites Railway ne sont **pas vérifiés** : consultez les pages officielles (`pricing`, `pricing/plans`, `pricing/cost-control`, `guides/postgres-backups-restores`) et votre tableau de bord.

## 1. Avant de créer quoi que ce soit : réutiliser l'existant

Dans le tableau de bord Railway, regardez si vous avez déjà un projet avec un service **PostgreSQL** (et son volume).

* **Il existe déjà un Postgres** : ne créez pas un second Postgres (second volume = coût en plus). Ajoutez le service de l'application dans le **même projet** et utilisez une base dédiée dans l'instance existante :
  `CREATE DATABASE petits_heros;` (via l'onglet *Data* / `psql` avec `DATABASE_PUBLIC_URL`), puis `DATABASE_URL` = l'URL interne du service avec `/petits_heros` à la place du nom de base. N'utilisez jamais la base d'un autre usage sans la séparer : les migrations créent leurs tables dans le schéma `public`.
* **Aucun Postgres** : *New → Database → PostgreSQL* (crée service + volume persistant). C'est le seul stockage à créer.
* **Aucun service S3 ni autre stockage** n'est nécessaire (voir §5).

## 2. Créer le service applicatif

1. Poussez le dépôt sur GitHub (déjà fait pour cette branche) puis *New → GitHub Repo* ; Railway détecte `Dockerfile` et `railway.json` (1 réplique, healthcheck `/healthz`, redémarrage sur échec).
2. **Variables du service applicatif** (onglet *Variables*) :

| Variable | Valeur exacte | Obligatoire |
|---|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (adaptez `Postgres` au nom réel du service). C'est l'URL du **réseau privé** (`*.railway.internal`) : à confirmer dans l'onglet *Variables* du service Postgres. **Pas** `DATABASE_PUBLIC_URL`. | ✅ |
| `NODE_ENV` | `production` (cookies `Secure`, HSTS) | ✅ |
| `APP_URL` | `https://<domaine-généré>.up.railway.app` (après *Settings → Networking → Generate Domain*, puis redéployer si vous le saisissez après) | recommandé |
| `APP_TZ` | `Europe/Paris` (défaut identique) | non |
| `BREVO_API_KEY` (secrète), `BREVO_FROM_EMAIL`, `BREVO_FROM_NAME` | e-mails de récupération via l'API HTTPS Brevo (voir §6) | non |
| `PORT` | **fourni par Railway**, ne pas définir | — |
| `TEST_DATABASE_URL` | **ne jamais** définir sur Railway (réservé aux tests locaux) | — |

3. *Settings → Networking → Generate Domain* (HTTPS fourni par la plateforme).
4. Gardez **1 réplique** (limiteur de tentatives en mémoire ; la cohérence des points est assurée par PostgreSQL, pas par l'application).

## 3. Démarrage, migrations, santé

* `Dockerfile` : `npm ci --omit=dev`, exécution sous l'utilisateur `node`, `CMD node server/index.js`.
* Au démarrage : arrêt immédiat avec message clair si `DATABASE_URL` manque ; puis **migrations** (`migrations/*.sql`, appliquées une seule fois, sous verrou consultatif, chacune dans une transaction) ; puis écoute sur `0.0.0.0:$PORT`. Arrêt propre sur SIGTERM.
* `GET /healthz` : `200 {"ok":true,"db":true,"migrations":N}` seulement si la base répond **et** que toutes les migrations du code sont appliquées, sinon `503`. Railway l'utilise (`healthcheckPath`) avant de basculer le trafic.
* Ne modifiez jamais une migration déjà appliquée : ajoutez-en une.

## 4. Vérifier l'URL publique (obligatoire avant de dire « c'est en ligne »)

```bash
sh scripts/check-deploy.sh https://<domaine>.up.railway.app
```
Contrôle : santé + base + migrations, page, manifeste, service worker, icônes, API anonyme, refus 401 sans session, `no-store`, CSP, HSTS (donc `NODE_ENV=production`), `sw.js` non mis en cache. Testé en local (17 contrôles OK) ; **non exécuté sur Railway**.

### Ouvrir l'application sur les deux téléphones

1. **Parent 1** (Android : Chrome ; iPhone : **Safari**, obligatoire pour installer une PWA) ouvre l'URL → *Créer ma famille*.
2. **Écran des codes de secours** : noter les 8 codes (papier ou gestionnaire de mots de passe), cocher « conservés », continuer.
3. Ajouter les enfants. *Famille → Inviter l'autre parent* → un code `XXXX-XXXX-XXXX` (48 h, usage unique).
4. **Parent 2** ouvre l'URL → *J'ai un code d'invitation* → crée son compte, saisit le code, **note ses propres codes de secours**.
5. Parent 1 : *Famille → Approuver*. Le téléphone 2 affiche alors les mêmes enfants sans recharger.
6. **Installer** : Android : menu ⋮ → *Installer l'application* ; iPhone : Partager → *Sur l'écran d'accueil*.
7. Contrôle croisé : donner +1 sur un téléphone, vérifier qu'il apparaît sur l'autre en moins de 5 s ; couper le Wi-Fi d'un téléphone et constater le bandeau « Hors connexion ».

## 5. Sauvegardes : ce qui est configuré, documenté, testé

**Ordre de décision (volumes Railway d'abord, S3 en dernier recours).**

1. **Évaluer les sauvegardes de volume Railway** *(à faire par vous — je n'ai pas pu lire la documentation)* : service Postgres → onglet **Backups**. Notez : disponible sur votre offre ? fréquence quotidienne programmable ? durée de rétention ? où et comment restaurer ? limites de taille ? Une sauvegarde de volume est un instantané du disque (cohérence « après crash », restauration du volume entier) : utile et sans service supplémentaire, mais ce n'est pas un export logique portable.
2. Si elles sont disponibles et couvrent un jour de rétention suffisant : activez la planification **quotidienne** et faites **un essai de restauration** sur un volume/service de test avant de vous y fier.
3. **Complément sans nouveau service** (recommandé de toute façon, car portable) : `scripts/backup.sh` depuis votre poste (ou tout ordinateur de confiance) avec l'URL **publique** de la base (`DATABASE_PUBLIC_URL`, client `pg_dump` v16) — une fois par semaine ou avant chaque mise à jour importante ; plus l'**export JSON** de l'application (*Famille → Exporter*, propriétaire). Exposez le proxy TCP public de la base seulement le temps de la sauvegarde.
4. **N'ajoutez un service de sauvegarde automatique + stockage S3 (`Dockerfile.backup`) que si** les sauvegardes de volume sont indisponibles ET que vous voulez de l'automatique : cela crée un service et un bucket (coûts à vérifier). Rien n'est configuré par défaut.

| Élément | Statut |
|---|---|
| Sauvegardes de volume Railway | **Non évalué, non configuré** (accès Railway et documentation indisponibles pour moi) — à évaluer d'abord, §5.1 |
| `scripts/backup.sh` : dump `pg_dump -Fc` + vérification de l'archive + rotation locale | **Testé en local** (dump, `pg_restore --list`) |
| `scripts/restore.sh` : restauration transactionnelle | **Testé en local** (restauration dans une base vide ; comptes de lignes identiques ; marqueur de migrations conservé) |
| Export JSON propriétaire dans l'application | **Testé** (API : isolé à la famille, sans hachés de mots de passe) |
| Envoi S3 (`S3_BUCKET`…), purge distante, `Dockerfile.backup`, service cron Railway | **Documenté seulement — jamais exécuté** |
| Sauvegarde planifiée sur Railway | **Rien n'est configuré** |

### Restauration (à répéter à blanc une fois)

```bash
createdb restore_test
DATABASE_URL=postgres://…/restore_test sh scripts/restore.sh fichier.dump   # d'abord dans une base de TEST
# vérifier enfants / soldes ; puis en production : arrêter l'app, restaurer, relancer
```

## 6. Récupération de compte

* **Codes de secours** (par défaut, sans service externe) : 8 codes à usage unique, hachés en base, affichés **une seule fois** et **obligatoirement** à la création de chaque compte (le propriétaire comme les autres parents). *Mot de passe oublié → J'ai un code de secours* : e-mail + code + nouveau mot de passe ; toutes les sessions sont fermées. Régénérables (avec le mot de passe) dans *Famille → Codes de secours* ; une bannière avertit s'il n'en reste aucun. Limité à 5 essais/semaine par e-mail et 10 par IP.
* **Code du propriétaire** pour un autre parent : *Famille → ⋯ → Générer un code*.
* **E-mail** (Brevo, API HTTPS `POST /v3/smtp/email`, pas de SMTP) : variables `BREVO_API_KEY` (secrète), `BREVO_FROM_EMAIL` (expéditeur **validé chez Brevo**), `BREVO_FROM_NAME`, plus `APP_URL` (sinon le domaine public Railway est utilisé ; jamais l'en-tête Host).
  * Lien de récupération : valable **1 h**, **usage unique**, **un seul lien valide à la fois**, jeton haché en base, placé dans le fragment `#/reset/…` ; demandes limitées (**3/h par adresse, 5/h par IP**) ; réponse identique que le compte existe ou non ; envoi en arrière-plan avec **délai maximal** (10 s, `MAIL_TIMEOUT_MS`).
  * Journaux : jamais la clé, le lien, le jeton ni l'adresse. Succès journalisé seulement si Brevo **accepte** (HTTP 2xx + `messageId`) — c'est une acceptation, **pas une confirmation de réception** ; vérifier la livraison dans Brevo › Transactional › Logs. Échec certain (refus, réseau) : lien invalidé ; issue inconnue (délai dépassé) : message d'erreur journalisé, lien conservé jusqu'à expiration.
  * `/healthz` indique `"mail":"brevo"|"off"` et le commit déployé (`RAILWAY_GIT_COMMIT_SHA`) : permet de vérifier que Railway a pris en compte les variables et la bonne version.
* Perte de **tous** les codes et du mot de passe du propriétaire sans e-mail configuré : pas de récupération en libre-service (volontairement : c'est ce qui protège le compte).

## 7. Coûts : surveiller

* Facturation à l'usage ; serveur et base partagent l'enveloppe incluse ; l'offre n'est **pas illimitée**. Un coût de 5 USD/mois **n'est pas garanti** : relevez *Usage* par service après une semaine réelle.
* Réglez des **alertes**. Une **limite stricte arrête les services** (donc l'application) quand elle est atteinte.
* Leviers : une seule réplique, aucun service superflu (pas de S3, pas de cron tant que les sauvegardes de volume suffisent).
