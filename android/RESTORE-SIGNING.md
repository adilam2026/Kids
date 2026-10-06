# Restaurer la clé de signature depuis la sauvegarde chiffrée

Fichier : `petits-heros-signing-backup.enc` (chiffré en AES-256 avec la phrase secrète choisie par le propriétaire).

```bash
read -rs BACKUP_PASSPHRASE && export BACKUP_PASSPHRASE          # saisir la phrase secrète (non affichée)
openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass env:BACKUP_PASSPHRASE \
  -in petits-heros-signing-backup.enc | tar -xf -               # produit release.p12 et signing.env
```

- `release.p12` : la clé de signature (PKCS12). `signing.env` : alias, mots de passe, empreinte, version base64 (= valeurs des secrets GitHub).
- Pour remettre les secrets dans un dépôt : `gh secret set NOM < …` avec les valeurs de `signing.env`.
- Conserver **le fichier chiffré ET la phrase secrète**, à deux endroits distincts (ex. gestionnaire de mots de passe + disque/clé USB). Sans l'un des deux la sauvegarde est inutilisable ; sans clé, l'application ne peut plus être mise à jour.
- Supprimer les fichiers déchiffrés après usage.
