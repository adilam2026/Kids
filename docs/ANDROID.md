# Application Android « Petits Héros » (APK)

> **État** : le projet Android (Capacitor), l'adaptation client/serveur et le workflow de compilation sont dans le dépôt. **Aucun APK signé n'existe encore** : il se fabrique sur GitHub Actions avec *votre* clé de signature (étape 1), que je ne peux ni créer pour vous ni connaître. L'environnement où j'ai travaillé ne peut pas compiler Android (le SDK et le plugin Gradle Android sont servis par `dl.google.com`, bloqué par la politique réseau).

## Architecture

| Élément | Choix |
|---|---|
| Application | Capacitor 8 (WebView Android) ; l'interface (`public/` → `www/`) est **embarquée dans l'APK** |
| Identité | `applicationId` = **`fr.petitsheros.app`** — ne jamais la changer |
| Serveur / base | Inchangés : API Express + PostgreSQL sur Railway (`https://petits-heros-production.up.railway.app`) |
| Connexion | **Jeton Bearer** (le WebView n'a pas la même origine que l'API : on ne compte pas sur les cookies). Le jeton est renvoyé à la connexion, stocké dans le stockage privé de l'application (`@capacitor/preferences`), envoyé en `Authorization: Bearer …`, révoqué à la déconnexion / au retrait du membre. Le navigateur garde son cookie `HttpOnly`. |
| Sécurité | HTTPS seul (`usesCleartextTraffic=false`, `network_security_config`), CORS limité à l'origine de l'application (`https://localhost`), pas de CSRF possible avec un jeton, **aucune clé secrète embarquée** (l'APK ne contient que l'URL publique du serveur), pas de sauvegarde Android des données (`allowBackup=false`, règles d'extraction vides) |
| Synchronisation | Même API que le web : mêmes données, interrogation toutes les 3 s + à la reprise de l'application (événement `resume`) |
| Retour / clavier / bords | Bouton Retour géré (ferme la fenêtre → remonte → quitte à la racine) ; `adjustResize` + `visualViewport` ; zones de sécurité via les variables `--safe-area-inset-*` injectées par Capacitor et `env()` |
| Fichiers | Export JSON et codes de secours : feuille de partage Android (le WebView ne télécharge pas les blobs) |
| Mises à jour | L'interface est dans l'APK : une évolution de l'interface = nouvel APK. L'API reste compatible ; `MIN_NATIVE_BUILD` (variable Railway) force une mise à jour (écran « Mise à jour nécessaire ») si un jour l'API devient incompatible |

## Étape 1 — Créer la clé de signature (parcours sans ordinateur, une seule fois)

La clé **est** l'identité de l'application : toute mise à jour doit être signée par la même clé, sinon Android refuse de remplacer l'application. Elle est générée **dans GitHub Actions** (jamais dans la conversation ni dans un journal), enregistrée dans les **secrets Actions** du dépôt, et sauvegardée **chiffrée**. Le dépôt est public : aucune clé, même chiffrée, n'est commitée.

**A. Jeton temporaire (nécessaire parce que GitHub interdit à un workflow d'écrire des secrets sans jeton dédié)**
1. GitHub → photo de profil → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. Nom : `petits-heros-bootstrap` ; **Expiration : 7 jours** ; **Repository access : Only select repositories → `Kids`** ; **Repository permissions → Secrets : Read and write** (Metadata : Read-only s'ajoute seul) ; rien d'autre.
3. **Generate token**, copier la valeur (elle n'est montrée qu'une fois ; ne l'envoyez à personne).
4. Dépôt `Kids` → **Settings → Secrets and variables → Actions → New repository secret** : nom `BOOTSTRAP_TOKEN`, valeur = le jeton.

**B. Phrase secrète de sauvegarde**
Choisir une phrase d'au moins 20 caractères et la noter **d'abord** dans votre gestionnaire de mots de passe, puis créer le secret `ANDROID_BACKUP_PASSPHRASE` (même écran) avec cette phrase.

**C. Lancement** (je peux le faire pour vous, ou vous-même : Actions → *Android signing bootstrap* → Run workflow → saisir `CREER`). Le workflow : génère la clé, crée les 5 secrets (`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`, `ANDROID_CERT_SHA256`) sans rien afficher, **refuse d'écraser** une clé existante, produit une sauvegarde chiffrée (AES-256, vérifiée par déchiffrement) et la publie comme artefact `sauvegarde-cle-signature-CHIFFREE` valable **24 h**.

**D. Après le workflow**
1. Télécharger l'artefact (page du run → *Artifacts*) et le ranger **avec** la phrase secrète, à **deux endroits distincts** (gestionnaire de mots de passe + disque/clé USB). Restauration : `android/RESTORE-SIGNING.md`. Les secrets GitHub ne peuvent pas être relus : cette sauvegarde est le seul moyen de retrouver la clé si le dépôt disparaît.
2. **Révoquer le jeton** (Developer settings → le jeton → Delete) et supprimer le secret `BOOTSTRAP_TOKEN`. Les builds suivants n'en ont pas besoin.

*(Variante avec ordinateur : `sh android/scripts/generate-keystore.sh`, puis créer les 5 secrets à la main.)*

## Étape 2 — Fabriquer l'APK signé

GitHub → **Actions → Android APK → Run workflow** (branche `claude/petits-heros-app-cukdzu`, **mode : release**, « publier » coché). Le mode **dry-run** fait le même parcours avec une clé jetable (rien n'est publié) : utile pour contrôler la chaîne. Le workflow :

1. refuse de démarrer s'il manque un secret (message explicite) ;
2. construit l'interface, synchronise Capacitor, compile `assembleRelease`, signe avec votre clé ;
3. **vérifie** (`android/scripts/verify-apk.sh`) : signature v2/v3, **empreinte du certificat = `ANDROID_CERT_SHA256`**, identité `fr.petitsheros.app`, `versionCode` attendu ;
4. publie une **Release GitHub** avec l'APK et `SHA256SUMS.txt` (et l'archive d'artefacts, 90 jours).

`versionCode` = numéro d'exécution du workflow (croît à chaque APK). Si vous recréez un jour le dépôt, fixez la variable `ANDROID_VERSION_CODE_OFFSET` (Settings → Variables) au-dessus du dernier build publié.

## Passage à l'APK de production (final)

* **Désinstaller l'APK de test avant d'installer l'APK de production** : leur signature est différente (clé de débogage vs clé définitive), Android refuse de remplacer l'un par l'autre. C'est la seule fois : toutes les mises à jour suivantes se feront par-dessus, avec la même clé.
* **Les données familiales ne sont pas touchées** : enfants, points, historique, défis, récompenses et comptes sont sur le serveur Railway. Après installation, se reconnecter avec son e-mail et son mot de passe (c'est le jeton local qui est perdu à la désinstallation, pas les données).
* L'APK de production est compilé en `release` (non débogable, vérifié avec `aapt2`), signé avec la clé définitive stockée dans les secrets GitHub (jamais dans le cache), avec un `versionCode` supérieur à celui du test.
* **Lien direct du fichier** (dépôt public, sans connexion GitHub) : `https://github.com/adilam2026/Kids/releases/download/android-build-<versionCode>/petits-heros-<version>-build<versionCode>.apk`.

## APK de test (signature de débogage) — mises à jour

L'artefact `petits-heros-test-android` (workflow *Android APK*, job « Compilation de contrôle ») est un APK **de test** signé avec une clé de **débogage**.

* La clé de débogage est conservée dans le **cache GitHub Actions** (clé `android-debug-keystore-v1`) : les builds de test suivants ont **la même signature** et se mettent à jour **par-dessus** l'ancien. Le cache peut être supprimé par GitHub après 7 jours sans usage : dans ce cas la signature change et il faut désinstaller avant de réinstaller (le résumé du run l'indique : « clé créée à neuf » ou « restaurée »).
* `versionCode` = numéro d'exécution du workflow : il augmente à chaque build (Android refuse de « rétrograder »).
* Le **premier** APK de test (run n° 4, `versionCode` 1) était signé par une clé éphémère du runner, aujourd'hui perdue : il faut le **désinstaller une fois**. Idem pour passer plus tard à l'APK de production (clé définitive, autre signature).
* Désinstaller l'application ne supprime aucune donnée familiale (elles sont sur le serveur) ; il faut seulement se reconnecter.

## Étape 3 — Installer sur chaque téléphone Android

1. Sur le téléphone, ouvrir la page **Releases** du dépôt (connexion GitHub requise si le dépôt est privé) et télécharger le fichier `petits-heros-….apk`.
2. L'ouvrir ; Android demande d'autoriser **« Installer des applications inconnues »** pour le navigateur/gestionnaire de fichiers utilisé → autoriser, puis **Installer**.
3. Ouvrir **Petits Héros**, se connecter avec son compte (les deux parents utilisent le même serveur et les mêmes données).
4. *(Facultatif)* comparer la somme SHA-256 du fichier avec `SHA256SUMS.txt`.

## Mises à jour futures

1. Modifier le code, incrémenter `version` dans `package.json` si souhaité.
2. Relancer **Run workflow** : nouvel APK avec un `versionCode` supérieur, **même clé** (vérifiée par empreinte).
3. Installer le nouvel APK **par-dessus** l'ancien : l'application est remplacée, la connexion est conservée (le jeton vit dans le stockage de l'application, qui n'est pas effacé par une mise à jour).

## Côté serveur (Railway)

* La branche déployée doit contenir le code serveur de cette version (jetons Bearer + CORS) : **l'APK ne fonctionne pas contre un serveur plus ancien**. Vérifier que le déploiement Railway de `claude/petits-heros-app-cukdzu` est actif.
* Variables facultatives : `CORS_ORIGINS` (origines supplémentaires, ex. pour un test local), `MIN_NATIVE_BUILD` (voir plus haut). Rien d'autre à créer : pas de nouvelle base, pas de service payant.

## Compiler soi-même (Android Studio / ligne de commande)

```bash
npm ci
VERSION_CODE=50 npm run android:web          # construit www/ et synchronise android/
cd android && ./gradlew assembleDebug        # APK de débogage (clé de débogage : ne pas distribuer)
# APK signé : définir PH_KEYSTORE_FILE, PH_KEYSTORE_PASSWORD, PH_KEY_ALIAS, PH_KEY_PASSWORD puis ./gradlew assembleRelease
```
Icônes : `npm run android:icons` (Playwright requis ; les PNG sont versionnés).

## Ce qui a été vérifié / ce qui ne l'a pas été

| Vérification | Statut |
|---|---|
| Serveur : jetons Bearer, CORS, CSRF, révocation, version minimale | **Testé** (7 tests API sur PostgreSQL) |
| Interface embarquée (build `www`) dans **Chromium mobile**, origine ≠ API : connexion, jeton stocké, aucun cookie, reconnexion après fermeture, synchro app ↔ web, retrait de membre, hors ligne, Retour (via le pont), zones de sécurité, clavier simulé, export, 2ᵉ parent | **Testé** (`npm run native-test`) — plugins natifs **simulés** |
| Génération de la clé, extraction de l'empreinte, vérification d'APK (signature/identité/version, cas d'échec) | **Testé en local** (avec un faux `apksigner`/`aapt2`) |
| Synchronisation Capacitor (`cap sync`), YAML du workflow | **Exécuté / validé** |
| **Compilation Gradle de l’APK** | **Réussie sur GitHub Actions** (workflow « Compilation de contrôle »). L’APK de TEST (clé de débogage) est conservé 7 jours dans l’artefact `petits-heros-test-android` : installable pour essayer ; le passage à l’APK de production (autre clé) exigera de désinstaller le test. |
| **Chaîne de signature complète sur GitHub avec les vrais `apksigner`/`aapt2`** | **Exécutée avec succès en mode dry-run** (run n° 3, clé jetable détruite, contre-épreuve : une mauvaise empreinte est refusée) |
| APK signé avec la clé définitive | **Pas encore produit** (nécessite l'étape 1) |
| Installation, icône, Retour, clavier, zones de sécurité, partage de fichier, reprise sur un **vrai téléphone Android** | **Non testé** — à faire après installation (liste dans le bilan) |
