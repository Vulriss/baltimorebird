---
type: Runbook
title: Monter l'environnement local
description: Backend en virtualenv, frontend en mode dev, variables d'environnement minimales.
tags: [developpement, setup, vite, flask]
status: stable
---

# Monter l'environnement local

## Backend

```bash
cd src/backend
python -m venv venv && source venv/bin/activate   # Windows : venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
python server.py
```

Le serveur écoute sur `http://localhost:5000` et démarre avec deux sources de
démonstration. `.env` doit porter `AUTH_SECRET_KEY`, et `CORS_ORIGINS` en
production. Les origines CORS sont validées au démarrage : une origine qui n'est
pas en `https` fait échouer le boot, volontairement.

## Frontend

```bash
cd src/frontend
bun install          # npm install fonctionne aussi
bun run dev          # http://localhost:5173, proxy /api vers :5000
```

Le serveur de production externe utilise bun ; l'un ou l'autre est transparent.

En mode `dev`, Vite sert les sources directement : une modification est visible
au rechargement. Ce n'est pas le cas du mode servi par nginx, qui lit `dist/`.
C'est la confusion la plus coûteuse du projet. Voir
[Construire et déployer](/workflows/build-and-deploy.md).

## Comptes de test

Les comptes créés par le smoke test sont horodatés et jetables. Pour repartir
d'une base propre, supprimer `src/backend/data/auth/users.db`.
