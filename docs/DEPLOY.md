# Déployer sur Railway

> ⚠️ **Tarifs et limites** : je n’ai **pas pu consulter** les pages Railway (réseau du sandbox bloqué). Vous m’avez indiqué une offre Hobby à 5 USD/mois avec 5 USD de consommation incluse ; je n’en déduis rien d’autre. **Vérifiez vous-même** (pages `pricing`, `pricing/plans`, `pricing/cost-control`, `guides/postgres-backups-restores`) et ce que votre compte affiche dans *Settings → Usage / Billing*. Rien ci-dessous ne garantit un coût mensuel.

## 1. Créer le projet

1. Poussez ce dépôt sur GitHub.
2. Railway → **New Project → Deploy from GitHub repo** : le `Dockerfile` et `railway.json` sont détectés (1 réplique, healthcheck `/healthz`).
3. Dans le projet : **+ New → Database → PostgreSQL** (volume persistant créé avec le service).
4. Service applicatif → **Variables** :

| Variable | Valeur |
|---|---|
| `DATABASE_URL` | référence `${{Postgres.DATABASE_URL}}` — utiliser l’URL **interne** (`postgres.railway.internal`) = réseau privé, pas l’URL publique. À vérifier dans l’onglet *Variables* du service Postgres. |
| `NODE_ENV` | `production` (cookies `Secure`, HSTS) |
| `APP_URL` | `https://<votre-domaine>.up.railway.app` (après **Settings → Networking → Generate Domain**) |
| `APP_TZ` | `Europe/Paris` |
| `RESEND_API_KEY`, `MAIL_FROM` | *facultatif*, voir §4 |

5. Déployez. Au démarrage l’application applique les migrations (`migrations/*.sql`, une seule fois, avec verrou) puis écoute sur `$PORT`.
6. Ouvrez l’URL, **Créer ma famille**, puis installez l’app (Partager › Sur l’écran d’accueil / menu Chrome › Installer).

Garder **une seule instance** : le limiteur de tentatives est en mémoire (la cohérence des points, elle, est garantie par PostgreSQL).

## 2. Surveiller la consommation (et ses limites)

* Railway facture à l’usage (CPU, RAM, stockage du volume, trafic sortant). Le serveur et la base **partagent** l’enveloppe incluse ; l’offre n’est **pas illimitée**.
* Regardez régulièrement *Usage* dans le tableau de bord (par service) et l’estimation de fin de mois. Faites un relevé après 1 semaine réelle avant de conclure quoi que ce soit.
* Réglez des **alertes d’utilisation** et, si vous le souhaitez, une **limite stricte** (*Settings → Usage / Cost control*). ⚠️ **Une limite stricte arrête les services (donc l’application) lorsqu’elle est atteinte** : l’app devient indisponible jusqu’au changement de limite ou au cycle suivant. Préférez des alertes si la disponibilité compte.
* Leviers : une seule réplique, pas de service superflu, sauvegardes d’une taille raisonnable (la base d’une famille pèse quelques Mo).

## 3. Sauvegardes quotidiennes et restauration

Trois niveaux, du plus simple au plus complet :

**a) Export applicatif (immédiat)** — Famille › *Exporter les données* (propriétaire) : JSON complet de la famille (enfants, mouvements, défis, récompenses). Utile pour archiver ou migrer, pas pour restaurer automatiquement.

**b) Sauvegardes Railway du volume** — Railway propose des sauvegardes de volume dans l’interface (*service Postgres → Backups*) ; leur disponibilité, fréquence et rétention **dépendent de votre offre : à vérifier** dans `guides/postgres-backups-restores`. Si elles sont disponibles, activez la planification quotidienne.

**c) `pg_dump` quotidien hors Railway (recommandé, testé en local)** — `scripts/backup.sh` produit un dump `pg_dump -Fc`, vérifie qu’il est lisible, puis l’envoie facultativement vers un stockage S3-compatible (Cloudflare R2, Backblaze B2, AWS S3…) et purge au-delà de `RETENTION_DAYS` (14 par défaut).

Mise en place : nouveau service Railway depuis le même dépôt, **Dockerfile path `Dockerfile.backup`**, **Cron Schedule** `0 3 * * *` (UTC), variables :
`DATABASE_URL` (même référence interne), `S3_BUCKET`, `S3_ENDPOINT`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`. Ce service ne tourne que quelques secondes par jour (coût marginal ; à mesurer). Le stockage externe peut avoir son propre coût (R2/B2 ont des paliers gratuits à vérifier).
*Je n’ai pas testé l’envoi S3 ni le service cron sur Railway* ; la création du dump, sa vérification et sa restauration ont été testées en local.

### Restauration (à répéter à blanc au moins une fois)

```bash
# 1. Récupérer le dump (depuis le bucket)  2. Restaurer d'abord dans une base de TEST :
createdb restore_test
DATABASE_URL=postgres://…/restore_test sh scripts/restore.sh petits-heros-AAAAMMJJTHHMMSSZ.dump
# 3. Vérifier (nombre d'enfants, soldes…), puis seulement restaurer en production
#    (arrêter l'app, restaurer sur DATABASE_URL de prod, relancer).
```
Depuis votre poste, utilisez l’URL **publique** de la base (`DATABASE_PUBLIC_URL`) et un client `pg_restore` v16 ; ne la laissez pas exposée plus longtemps que nécessaire.

## 4. Récupération du mot de passe et e-mails

* **Sans service externe** (par défaut) : le parent **propriétaire** génère un code à usage unique (1 h) pour l’autre parent (Famille › ⋯ › *Générer un code*). Le parent saisit « Mot de passe oublié › J’ai un code ».
* **Avec e-mail** : service externe **Resend** (https://resend.com, offre gratuite limitée — vérifiez les quotas actuels). Variables : `RESEND_API_KEY` et `MAIL_FROM` (adresse d’un domaine vérifié chez Resend), plus `APP_URL`. Non testé contre l’API réelle Resend (pas d’accès réseau/compte ici).
* Si le **propriétaire** perd son mot de passe sans e-mail configuré, il n’y a pas de procédure en self-service : réinitialisation manuelle en base (hors V1) — configurez Resend pour éviter ce cas.

## 5. Mises à jour

Chaque `git push` redéploie ; les nouvelles migrations (`migrations/00N_*.sql`) s’appliquent au démarrage. Ne modifiez jamais une migration déjà appliquée : ajoutez-en une nouvelle.

## 6. Sécurité : rappel

Secrets uniquement dans les variables Railway (jamais dans le dépôt). Mots de passe hachés (scrypt), sessions révocables (déconnexion, changement de mot de passe, retrait d’un membre), invitations à usage unique expirant sous 48 h, limitation des tentatives de connexion / d’invitation / de réinitialisation.
