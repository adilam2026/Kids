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

## Étape 1 — Créer la clé de signature (une seule fois, sur votre ordinateur)

La clé **est** l'identité de l'application : toute mise à jour doit être signée par la même clé, sinon Android refuse de remplacer l'application (il faudrait la désinstaller). Elle ne doit **jamais** être publiée ni dans GitHub, ni dans un message.

```bash
# Java (JDK 17 ou 21) requis pour keytool
sh android/scripts/generate-keystore.sh          # crée ~/petits-heros-signing/
```
Le script affiche l'**empreinte SHA-256** et crée `~/petits-heros-signing/github-secrets.txt` avec les valeurs à copier. Puis :

1. GitHub → dépôt → **Settings → Secrets and variables → Actions → New repository secret**, créer **5 secrets** (noms exacts) :
   `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`, `ANDROID_CERT_SHA256`.
2. **Supprimer** `github-secrets.txt`. Sauvegarder `petits-heros-release.p12` **et** son mot de passe à deux endroits sûrs (gestionnaire de mots de passe + disque externe). **Perdre la clé = ne plus pouvoir mettre à jour l'application.**
3. Dans GitHub : Settings → Actions → General : *Allow all actions* (ou au minimum `actions/*` et `gradle/actions/*`) et **Workflow permissions : Read and write** (pour publier la Release).

Pas d'ordinateur avec Java ? Utilisez GitHub Codespaces (terminal sur le dépôt) ou tout PC emprunté ; la clé n'est jamais stockée par GitHub autrement que dans les secrets chiffrés.

## Étape 2 — Fabriquer l'APK signé

GitHub → **Actions → Android APK → Run workflow** (branche `claude/petits-heros-app-cukdzu`, laisser « publier » coché). Le workflow :

1. refuse de démarrer s'il manque un secret (message explicite) ;
2. construit l'interface, synchronise Capacitor, compile `assembleRelease`, signe avec votre clé ;
3. **vérifie** (`android/scripts/verify-apk.sh`) : signature v2/v3, **empreinte du certificat = `ANDROID_CERT_SHA256`**, identité `fr.petitsheros.app`, `versionCode` attendu ;
4. publie une **Release GitHub** avec l'APK et `SHA256SUMS.txt` (et l'archive d'artefacts, 90 jours).

`versionCode` = numéro d'exécution du workflow (croît à chaque APK). Si vous recréez un jour le dépôt, fixez la variable `ANDROID_VERSION_CODE_OFFSET` (Settings → Variables) au-dessus du dernier build publié.

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
| **Compilation Gradle de l'APK** | **Non exécutable dans mon environnement** → voir le résultat du workflow « Compilation de contrôle » sur GitHub |
| APK signé | **Pas encore produit** (nécessite l'étape 1) |
| Installation, icône, Retour, clavier, zones de sécurité, partage de fichier, reprise sur un **vrai téléphone Android** | **Non testé** — à faire après installation (liste dans le bilan) |
