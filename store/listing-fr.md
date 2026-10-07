# Fiche Google Play — Petits Héros (français)

Textes prêts à copier. Limites Google : titre 30 caractères, description courte 80, description complète 4000 (vérifiées par `npm test`, fichier `test/store.test.js`).

## Titre
```
Petits Héros
```

## Description courte (≤ 80)
```
Points, défis et récompenses pour les petites réussites de toute la famille
```

## Description complète
```
Petits Héros accompagne les parents dans les petites réussites du quotidien.

Créez un profil pour chaque enfant, attribuez des points pour les bonnes actions et choisissez ensemble des récompenses simples. Personnalisez les actions, les bonus et les valeurs selon les habitudes de votre famille.

• Plusieurs profils enfants avec des avatars.
• Attribution et retrait de points avec un historique.
• Bonnes actions prédéfinies et bonus personnalisés.
• Défis individuels ou collectifs.
• Récompenses à échanger contre des points.
• Invitation d’un autre parent par code.
• Synchronisation entre les parents d’une même famille.
• Petits sons de confirmation (désactivables).
• Suppression du compte et des données depuis l’application.

Les parents gardent le contrôle des validations. Une connexion Internet est nécessaire pour enregistrer les changements et synchroniser les appareils.

Aucun malus n’est prévu pour les pleurs, les besoins essentiels ou l’apprentissage, et l’application ne conditionne jamais les câlins ni les repas aux points.

Pas de publicité, pas de pistage publicitaire, pas d’achat intégré.
```

## Notes de version (« Nouveautés », ≤ 500 caractères)
```
• Suppression du compte et des données depuis l’application, ou depuis une page web.
• Nouveau : « Nommer propriétaire » pour transmettre la gestion de la famille à un autre parent.
• Récupération du mot de passe par e-mail (lien valable 1 heure).
• Sons de confirmation lors des gains et des retraits (désactivables).
• Écran « Point non validé », calme et sans effet sur les points.
• Actions « nuit complète » et « finir son assiette ».
```

## Visuels (dossier `store/`)
| Élément | Fichier | Taille |
|---|---|---|
| Icône de l’application | `graphics/icon-512.png` | 512 × 512, PNG sans transparence |
| Image de présentation | `graphics/feature-graphic-1024x500.png` | 1024 × 500 |
| Captures téléphone (1 à 6) | `screenshots/01…06-*.png` | 1080 × 1920 (9:16) |

Les captures montrent la vraie interface avec une famille fictive (« Famille Exemple », adresse `@example.com`). Régénération : `node scripts/make-store-assets.mjs`.
Aucune capture tablette n’est fournie : ne pas déclarer de support tablette optimisé dans la Play Console.

## Coordonnées et liens
- Politique de confidentialité : `https://petits-heros-production.up.railway.app/confidentialite`
- Suppression de compte (lien web exigé par Google) : `https://petits-heros-production.up.railway.app/suppression-compte`
- E-mail de contact public : celui défini par `CONTACT_EMAIL` sur Railway (à confirmer : par défaut, voir `server/config.js`).
- Catégorie suggérée : **Parentalité** (alternative : Style de vie). Étiquettes : à votre choix.
