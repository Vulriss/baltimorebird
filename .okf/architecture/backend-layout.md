---
type: Architecture
title: Organisation du backend
description: Carte des modules Python, et la règle qui dit où une logique doit atterrir.
tags: [flask, backend, modules]
status: stable
---

# Organisation du backend

`server.py` porte la fabrique d'application (`create_app`) : CORS, middlewares,
blueprints, gestionnaires d'erreurs, puis démarrage d'un thread de maintenance
en daemon qui tourne toutes les dix minutes (`MAINTENANCE_INTERVAL_SECONDS`).

`config.py` porte toute la configuration : chemins, quotas, limites de sandbox,
CORS, authentification, le tout chargé depuis `.env` via `python-dotenv`. Il n'y
a pas de second endroit où lire une constante de configuration. Une valeur codée
en dur ailleurs est un défaut, pas un raccourci.

## Couches

| Répertoire | Rôle | Règle |
| --- | --- | --- |
| `api/` | Blueprints Flask, un par domaine, enregistrés dans `api/__init__.py` | Les handlers restent minces : validation d'entrée, appel, sérialisation |
| `services/` | Logique métier et entrées/sorties : stockage, conversion, ingestion BLF et MAT, métriques, sandbox | Aucune dépendance à l'objet `request` |
| `data_management/` | Couche de données EDA : registre de sources, sessions paresseuses, lecture MF4, chargeurs, commentaires d'événements, maintenance | Voir [Sessions EDA](/architecture/eda-sessions.md) et [Lecture MF4](/architecture/mf4-reading.md) |
| `core/` | Utilitaires transverses : `downsampling`, `security`, `timeutils`, `exceptions` | On importe depuis `core`, on ne réimplémente pas une désinfection de chemin |
| `middleware/` | En-têtes de sécurité et métriques de requête | Enregistré une fois dans `server.py` |
| `mda/` | Import de layouts ETAS MDA | Frontière avec un format tiers, isolée |

## Pièges de nommage

`api/scripts.py` n'est pas un gestionnaire de bouts de code. C'est le Dashboard
Builder : création et édition de recettes par blocs, compilation en Python,
exécution confinée, export HTML. Le nom du blueprint est historique. Voir
[Dashboard Builder](/architecture/dashboard-builder.md).

`api/computed.py` porte l'analyseur statique sur liste blanche qui sert de
référence à tout le reste du projet, y compris à la sandbox du Dashboard
Builder. Voir [Variables calculées](/architecture/computed-variables.md).

## Où atterrit une nouvelle logique

Une règle métier va dans `services/` ou `data_management/`, jamais dans un
handler de route. Un handler qui dépasse une trentaine de lignes signale
presque toujours qu'une fonction de service n'a pas été écrite. Voir
[Conventions de code](/policies/code-conventions.md).
