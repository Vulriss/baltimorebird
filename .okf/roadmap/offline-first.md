---
type: Roadmap
title: Mode hors ligne
description: Bundle local PyInstaller avec repli distant, et la question CORS qui commande tout le reste.
tags: [hors-ligne, pyinstaller, cors, distribution]
status: draft
generated:
  by: claude/sonnet-5
  at: 2026-09-15T00:00:00Z
---

# Mode hors ligne

Conception terminée, implémentation non démarrée.

L'usage cible est l'ingénieur en déplacement ou sur un réseau d'essais isolé :
un exécutable local qui embarque le backend et le frontend, avec repli sur
l'instance distante quand elle est joignable.

## Forme

- Bundle PyInstaller distribuable, servant l'application sur un port local.
- Stockage local sous `~/.baltimorebird/`.
- Endpoint `/version` pour notifier qu'une mise à jour existe.

## Le point dur

CORS. Un frontend servi en local qui parle à une API distante, ou l'inverse,
traverse une frontière d'origine. La politique de sécurité de contenu du
backend, dans `middleware/security.py`, est aujourd'hui écrite pour un
déploiement mono-origine, et la validation des origines CORS refuse au démarrage
tout ce qui n'est pas en `https`.

Ce n'est pas un détail d'intégration à traiter en fin de chantier. C'est la
contrainte qui décide de l'architecture : ou bien le bundle local est autonome
et ne parle à rien, ou bien la politique d'origines devient configurable, avec
ce que cela implique de surface d'attaque. Voir
[Invariants de sécurité](/policies/security-invariants.md).

## Articulation avec le datalake

Le mode hors ligne et [la chaîne datalake](/roadmap/datalake-pipeline.md) tirent
en sens inverse : l'un veut tout en local, l'autre tout en cloud. Le point de
rencontre est le cas A du flux datalake, la lecture directe du MF4 brut, qui ne
dépend ni de l'ODS ni du cache Parquet et fonctionne donc à l'identique dans les
deux modes.
