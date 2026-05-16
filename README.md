# Melo Music App — Nouveau Compte Backblaze

Application de streaming musical connectée au bucket Backblaze B2 `melo-music-2026`.

## Structure

```
melo-nouveau/
├── api/
│   └── api.js        ← Backend Vercel (serverless function)
├── index.html        ← Frontend SPA
├── logo.png          ← Logo de l'app
├── vercel.json       ← Config Vercel
└── README.md
```

## Déploiement sur Vercel via GitHub

### 1. Créer le repo GitHub
```bash
git init
git add .
git commit -m "first commit"
git branch -M main
git remote add origin https://github.com/TON_USERNAME/melo-nouveau.git
git push -u origin main
```

### 2. Déployer sur Vercel
1. Aller sur [vercel.com](https://vercel.com) → **Add New Project**
2. Importer le repo GitHub `melo-nouveau`
3. Laisser les paramètres par défaut (Vercel détecte automatiquement)
4. Cliquer **Deploy**

### 3. C'est tout !
L'URL Vercel générée est ton application en ligne.

## Credentials Backblaze utilisées

- **Bucket** : `melo-music-2026`
- **Key ID** : `003ec0649a89f090000000001`
- **App Key** : `K003dwNhrjinpVEyi4VKsJxxZmL3LO4`
- **Endpoint** : `s3.eu-central-003.backblazeb2.com`
