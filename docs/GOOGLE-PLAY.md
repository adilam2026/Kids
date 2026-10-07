# Publier Petits Héros sur Google Play — dossier et guide

> État : **préparé, non soumis**. Rien n’a été envoyé à Google. Rien n’est « accepté par Google » tant que la Play Console ne l’affiche pas.
> Textes de la fiche : [`store/listing-fr.md`](../store/listing-fr.md) · Visuels : `store/graphics/`, `store/screenshots/`.

## 0. Livraison (build 24, version 1.4.0, nouvelle icône mascotte)

Release : https://github.com/adilam2026/Kids/releases/tag/android-build-24

| Fichier | Lien direct | SHA-256 |
|---|---|---|
| **AAB signé (Play Console)** | https://github.com/adilam2026/Kids/releases/download/android-build-24/petits-heros-1.4.0-build24.aab | `fd1c1703fb2ae7cab152e1b7e8ef24731284b334c8d1a941038f21f266b66338` |
| APK de la même version | https://github.com/adilam2026/Kids/releases/download/android-build-24/petits-heros-1.4.0-build24.apk | `51f47af642fb8eae559a67d83b5b4f8ded13f82f3c370719c1adf9d3164cdec6` |
| Empreintes | https://github.com/adilam2026/Kids/releases/download/android-build-24/SHA256SUMS.txt | |

Vérifié après téléchargement : `fr.petitsheros.app`, versionCode 24 (> 23, le plus haut déjà utilisé), targetSdk 36, certificat SHA-256 `bbdde15c…93dd67` (clé définitive), 20/20 icônes identiques à celles du dépôt, aucune page légale embarquée.
Le build 19 (ancienne icône) et le build 23 (APK d’essai de l’icône) restent publiés ; **importer le build 24** dans la Play Console.
Visuels : `store/graphics/` (icône 512 = illustration mascotte, image de présentation 1024×500 refaite avec la mascotte) et `store/screenshots/` ; les six captures sont inchangées (elles montrent l’interface, pas l’icône).
Pages publiques (vérifiées sur le déploiement réel) : https://petits-heros-production.up.railway.app/confidentialite et https://petits-heros-production.up.railway.app/suppression-compte

## 1. Ce qui est prêt, vérifié, ou à faire

**Testé automatiquement (dans ce dépôt / GitHub Actions)**
- Suppression de compte (API + parcours navigateur) : parent simple, propriétaire seul, propriétaire avec autres parents (refusé), compte sans famille / en attente, page web publique, limitation de débit, effacement complet de la famille sans toucher les autres (`test/account.test.js`, `test/delete-account.mjs`).
- « Nommer propriétaire », historique « Ancien parent », pages légales sans balise non remplacée ni secret.
- Toute la suite existante (API 60 tests, parcours navigateur, interface Android embarquée émulée, réseau lent, cartes, sons, « Point non validé »).
- Fiche : longueurs imposées par Google, fonctions annoncées présentes dans le code, aucune permission autre qu `INTERNET`, aucune bibliothèque de publicité / mesure d’audience / achat (`test/store.test.js`).
- Chaîne de build AAB sur GitHub Actions (clé définitive depuis les secrets) : `bundleRelease`, `jarsigner` + empreinte SHA-256 du certificat, `bundletool validate`, manifeste (identité `fr.petitsheros.app`, versionCode, targetSdk 36, non débogable, permission d’accès INTERNET seule (plus la permission interne `…DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` ajoutée automatiquement par AndroidX, propre à l’application et sans accès)), contenu embarqué (suppression de compte, « Nommer propriétaire », « Point non validé », texte de récupération par e-mail, adresse du serveur).

**À vérifier sur votre téléphone** (non testable ici)
- Les liens « Politique de confidentialité » / « Suppression de compte » s’ouvrent dans le navigateur du téléphone (et non dans l’application).
- Parcours de suppression de compte dans l’APK/AAB installé, y compris retour à l’écran de connexion.
- Sons : volume multimédia / mode silencieux (comportement non garanti).
- Installation depuis la piste de test interne de Google Play.

**Nécessite votre compte développeur Play Console** : création de l’application, déclarations (voir §3), choix de la signature (§4), téléversement, comptes testeurs, demande de production. Seule la page web et l’application sont de mon ressort ; **les réponses ci-dessous sont des propositions à relire**, c’est vous qui engagez votre déclaration.

## 2. Exigences Google Play vérifiées (sources officielles)

| Exigence | État | Source |
|---|---|---|
| API cible : Android 16 (API 36) pour les mises à jour à partir du 31 août 2026 | Respectée (`targetSdk 36`, `compileSdk 36`) | developer.android.com/google/play/requirements/target-sdk |
| Format de publication : Android App Bundle (.aab) | Produit par la CI | developer.android.com/guide/app-bundle |
| Signature Play App Signing | À configurer (§4) | support.google.com/googleplay/android-developer/answer/9842756 |
| Suppression de compte : chemin dans l’application **et** lien web, déclaré dans la section Sécurité des données | Faits (« Famille › Supprimer mon compte » ; `/suppression-compte`) | support.google.com/googleplay/android-developer/answer/13327111 |
| Politique de confidentialité : URL publique, active, hors PDF | Faite (`/confidentialite`) | Politique « Données utilisateur » |
| Section Sécurité des données remplie à partir du comportement réel | Réponses proposées §3.5 | idem |
| Comptes développeur personnels récents : test fermé avec **≥ 12 testeurs pendant ≥ 14 jours** avant la production | À faire si votre compte est concerné (la Play Console l’indique) | support.google.com/googleplay/android-developer/answer/14151465 |

Limites : les pages `support.google.com` n’étaient pas lisibles directement depuis l’environnement de travail (accès réseau restreint) ; leur contenu a été confirmé par les extraits de recherche et par la documentation Android. Relisez-les dans la Play Console, qui fait foi et évolue.

## 3. Champs de la Play Console et réponses proposées

### 3.1 Création de l’application
| Champ | Réponse |
|---|---|
| Nom | Petits Héros |
| Langue par défaut | Français (France) – fr-FR |
| Application ou jeu | Application |
| Gratuite ou payante | Gratuite (⚠ non modifiable ensuite) |
| Déclarations (règles, export) | À cocher après lecture |

### 3.2 Fiche principale
Titre, description courte/complète, notes de version : voir `store/listing-fr.md`. Icône 512 × 512, image de présentation 1024 × 500, 2 à 8 captures téléphone (6 fournies). Coordonnées : e-mail public, site web facultatif.
URL de la politique de confidentialité : `https://petits-heros-production.up.railway.app/confidentialite`.

### 3.3 Contenu de l’application
| Rubrique | Proposition | Pourquoi |
|---|---|---|
| Accès à l’application | « Toutes les fonctionnalités ne sont pas accessibles sans identifiants » → fournir un compte de démonstration (§5) | Connexion obligatoire |
| Publicités | **Non**, l’application ne contient pas de publicités | Aucune bibliothèque publicitaire (testé) |
| Questionnaire de classification | Application utilitaire/référence familiale ; **aucune** violence, contenu sexuel, jeu d’argent, drogue, langage cru, achat, partage de position ; contenu généré par l’utilisateur : texte saisi par les parents, visible **uniquement** par les membres de la famille (pas de partage public) ; pas de communication entre utilisateurs inconnus | À répondre vous-même ; résultat attendu : tous publics |
| Public cible | **Adultes (18 ans et plus)** — les parents sont les seuls titulaires de comptes ; les enfants sont des profils saisis par les parents (prénom, avatar, âge facultatif) | ⚠ Décision à confirmer : cocher des tranches d’âge < 13 ans ferait entrer l’application dans la politique « Famille » (obligations supplémentaires). L’application n’est pas conçue pour que les enfants créent un compte |
| Application d’actualités / santé / finance / gouvernement | Non / Non / Non / Non | |
| ID de publicité | **Non** (l’application ne l’utilise pas, aucune permission `AD_ID`) | |
| Fonctions de santé, VPN, SMS/appels, accessibilité | Non | Permissions : INTERNET seule (testé) |
| Suppression de compte | Oui : dans l’application (Famille › Supprimer mon compte) et sur le web `…/suppression-compte` | §3.6 |

### 3.4 Catégorie, tags
Catégorie : Parentalité. Aucune autre déclaration obligatoire.

### 3.5 Sécurité des données (réponses d’après le code)
- **Collecte de données** : Oui. **Chiffrement en transit** : Oui (HTTPS ; `usesCleartextTraffic=false`). **Possibilité de demander la suppression** : Oui.
- Partage avec des tiers : **Non** au sens Google pour l’hébergeur Railway (sous-traitant qui traite pour notre compte). Brevo reçoit l’adresse e-mail uniquement lors d’une récupération de mot de passe, comme prestataire d’envoi (même logique de sous-traitance). ⚠ Si vous préférez une lecture prudente, déclarez-le en « partage » pour « Adresse e-mail » : à votre appréciation.
| Type Google | Donnée réelle | Obligatoire ? | Finalité |
|---|---|---|---|
| Infos personnelles › Nom | Prénom du parent et des enfants | Oui | Fonctionnalité de l’application |
| Infos personnelles › Adresse e-mail | E-mail du parent | Oui | Fonctionnalité, gestion du compte (récupération) |
| Infos personnelles › Autres infos | Âge facultatif de l’enfant ; avatar et couleur | Non (âge) | Fonctionnalité |
| Activité dans l’appli › Autre contenu généré | Actions, notes, récompenses, défis, historique des points | Oui | Fonctionnalité |
| Identifiants de l’appareil ou autres | Aucun | — | — |
| Localisation, photos, contacts, finances, santé, messages, audio | **Aucune** | — | — |
| Infos et performances de l’appli (plantages, diagnostics) | **Aucune** (aucun outil de mesure) ; le serveur écrit des journaux techniques sans donnée personnelle | — | — |
Les données sont sur le serveur Railway ; l’application garde un cache local (7 jours) effaçable à la déconnexion.

### 3.6 Suppression de compte (rubrique « Suppression des données »)
- Chemin dans l’application : Famille › « Supprimer mon compte » (aussi sur l’écran de création/attente de famille).
- URL web : `https://petits-heros-production.up.railway.app/suppression-compte`.
- Conséquences expliquées avant confirmation : parent simple (la famille continue ; ses saisies restent sous « Ancien parent ») ; propriétaire avec d’autres parents (refusé : nommer un autre propriétaire d’abord) ; seul parent (la famille et toutes ses données sont supprimées, avec case à cocher explicite). Mot de passe + saisie de « SUPPRIMER » exigés.
- Données conservées après suppression : aucune dans la base ; sauvegardes Railway éventuelles selon le réglage de votre projet (⚠ à compléter par vous si vous activez des sauvegardes : la page `/confidentialite` ne promet pas de délai précis).

## 4. Signature : Play App Signing et APK déjà distribués

Les APK déjà installés sont signés par votre clé définitive (certificat SHA-256 `bbdde15cec72b1fec4b07fcc13d89f81f93bd81606709ccec91c82cc1a93dd67`). Pour publier un AAB, Google exige **Play App Signing** : Google conserve la « clé de signature de l’application » ; vous gardez une « clé d’importation » pour envoyer vos fichiers. Android n’accepte une mise à jour que si la signature est identique.

| Option | Effet sur les APK déjà installés | Votre action |
|---|---|---|
| **A — Importer votre clé existante comme clé de signature** (recommandée) | Les téléphones qui ont l’APK actuel **peuvent recevoir les mises à jour Google Play sans désinstaller** (même signature) | Au premier envoi : « Exporter et importer une clé à partir d’un keystore Java », avec l’outil Google **PEPK** (`pepk.jar`) qui chiffre la clé avant envoi. Il faut restaurer `release.p12` depuis la sauvegarde chiffrée (`android/RESTORE-SIGNING.md`) sur **votre** ordinateur ; je n’ai pas accès à la clé privée et ne la manipule pas. ⚠ À confirmer dans la Console que l’option est proposée pour votre application. **Irréversible** : cette clé devient celle de l’application |
| **B — Laisser Google générer la clé de signature** | Les APK actuels (signés autrement) **ne pourront pas être mis à jour** par Google Play : désinstaller puis réinstaller depuis le Play Store. Les données restent sur le serveur (connexion avec le même compte) ; seul le cache local est perdu | Aucune manipulation de clé ; votre clé définitive sert de clé d’importation |

Recommandation : **A** si des proches utilisent déjà l’APK et que vous voulez éviter la réinstallation ; **B** sinon (plus simple, la clé privée n’est jamais exportée). Dans les deux cas : le fichier `.aab` publié est signé avec votre clé définitive (clé d’importation) et Google le re-signe pour la distribution. Les APK publiés en parallèle sur GitHub restent signés par votre clé : ils ne se mettent à jour par-dessus l’installation Play que dans l’option A.

## 5. Accès pour les relecteurs Google (sans exposer d’identifiants dans le dépôt)

Le dépôt est public : **ne mettez aucun identifiant dedans**. Procédure :
1. Dans l’application (production), créez vous-même un compte dédié (ex. adresse jetable) avec une famille fictive (3 enfants, quelques points, un défi, une récompense).
2. Play Console › Contenu de l’application › **Accès à l’application** › « Ajouter des instructions » : saisissez l’e-mail, le mot de passe et ces explications :
   « Connexion avec e-mail et mot de passe (écran d’accueil). Le compte est propriétaire d’une famille fictive : onglet Enfants (+/−), Défis, Récompenses, Famille. La suppression du compte est dans Famille › Supprimer mon compte (ne l’exécutez pas : compte de démonstration) ; elle est aussi disponible sur la page web indiquée. »
3. Ne réutilisez pas votre mot de passe personnel. Conservez ce compte tant que Google peut vérifier l’application.

## 6. Guide pas à pas : test interne puis production

1. **Récupérer le .aab** : GitHub › Releases › dernière version « Petits Héros … (build N) » → fichier `.aab` (+ `SHA256SUMS.txt`). Contrôlez l’empreinte (`sha256sum`).
2. **Play Console** (compte développeur payant, identité vérifiée) › Créer une application (§3.1).
3. **Configurer les déclarations** (§3.3 à 3.6) et la fiche (`store/`).
4. **Test › Test interne › Créer une release** : choisir la signature (§4), importer le `.aab`, notes de version, **Enregistrer puis publier**. Ajouter une liste de testeurs (adresses Google) ; ils reçoivent un lien d’opt-in. Délai de mise à disposition : de quelques minutes à quelques heures.
5. **Vérifier sur téléphone** les points « à vérifier » du §1 depuis l’installation Play.
6. **Test fermé** : si la Console l’exige pour votre compte (nouveau compte personnel), réunir ≥ 12 testeurs pendant ≥ 14 jours consécutifs.
7. **Production › Demander l’accès / Créer une release** : même `.aab` (ou plus récent, versionCode supérieur), envoyer en examen. Google peut prendre plusieurs jours ; ne communiquez « publié » qu’après l’affichage « Disponible sur Google Play ».
8. À chaque nouvelle version : lancer le workflow « Android APK » (mode release) → nouveau `.aab` avec un versionCode plus grand.

## 7. À faire de votre côté (rappels)
- Révoquer le jeton `BOOTSTRAP_TOKEN` et supprimer ce secret GitHub (plus nécessaire).
- Définir sur Railway `CONTACT_EMAIL` et `PUBLISHER_NAME` si l’adresse/nom par défaut ne vous conviennent pas (ils apparaissent dans la politique) : sans variable, le contact affiché est `adilam.pro@gmail.com`.
- Relire `/confidentialite` : la phrase sur les transferts hors Union européenne est volontairement prudente (région d’hébergement non vérifiée).
- Créer le compte de démonstration (§5).
