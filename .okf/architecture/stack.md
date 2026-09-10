---
type: Architecture
title: Baltimorebird tech stack
description: Ce qui tourne où, comment le front est construit et servi, et où vivent les modules.
tags: [flask, vite, nginx, systemd]
status: stable
---

# Pile technique

Backend Python/Flask servi par gunicorn derrière nginx, sous le service systemd
`baltimorebird`. Frontend en JavaScript vanilla construit par Vite.

## Le front n'est pas servi depuis les sources

Vite écrit dans `src/frontend/dist/`, et c'est ce dossier que nginx sert. Toute
modification d'un fichier de `src/frontend/src/` reste invisible tant que
`npm run build` n'a pas tourné. Aucun message d'erreur ne le signale : la page se
charge simplement sans le code ajouté. Voir [Construire et déployer](/workflows/build-and-deploy.md).

## Organisation du front

- `src/frontend/src/core/` - modules transverses (navigation, thème, télémétrie,
  chargeur de vues, retours utilisateur). Style historique : IIFE avec exposition
  sur `window`.
- `src/frontend/src/eda/` - modules de la vue Interactive EDA, en modules ES.
- `src/frontend/src/views/` - logique par vue (paramètres, rapports, stockage…).
- `src/frontend/views/*.html` - fragments de vue injectés par `core/view-loader.js`
  via `innerHTML` dans un conteneur `.view-container` déjà présent dans `index.html`.
- `src/frontend/styles/` - SCSS avec `@use`, jetons Catppuccin legacy slightly adaptés dans
  `abstracts/_variables.scss`.

Conséquence pour un agent : un sélecteur qui vise un élément d'une vue ne peut
pas être résolu au chargement du document. La vue arrive plus tard, par mutation
du DOM.

## Organisation du back

- `src/backend/api/` - blueprints Flask, un fichier par domaine.
- `src/backend/services/` - logique métier (métriques, stockage, conversion,
  ingestion BLF et MAT, sandbox).
- `src/backend/middleware/security.py` - en-têtes et politique de sécurité de contenu.
- `src/backend/blf/` - décodage CAN.

Voir aussi [Invariants de sécurité](/policies/security-invariants.md).
