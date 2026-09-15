---
type: Runbook
title: Local env setup
description: Backend en virtualenv, frontend en mode dev, variables d'environnement minimales.
tags: [developpement, setup, vite, flask]
status: stable
generated:
  by: human:Geo
  at: 2026-09-09
verified:
  by: human:Geo
  at: 2026-09-15
---

# Local env setup

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
prod. Les origines CORS sont validées au démarrage : une origine qui n'est
pas en `https` fait volontairement échouer le boot.

## Frontend

```bash
cd src/frontend
bun install          # npm install fonctionne aussi
bun run dev          # http://localhost:5173, proxy /api vers :5000
```

Le serveur de prod en externe utilise bun ; l'un ou l'autre est transparent.

En mode `dev`, Vite sert les sources directement : une modification est visible
au reload. Ce n'est pas le cas du mode servi par nginx, qui lit `dist/`.
Voir [Construire et déployer](/workflows/build-and-deploy.md).

## Comptes de test

Les comptes créés par le smoke test sont horodatés et jetables. Pour repartir
d'une base propre, supprimer `src/backend/data/auth/users.db`.
