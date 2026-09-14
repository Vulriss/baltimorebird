# Scripts - Dashboard Analysis

Ce dossier contient les définitions des scripts d'analyse créés via l'éditeur de blocs du Dashboard.

## Principe

Les scripts sont stockés sous forme de **définition de blocs** (JSON), et le code Python est **généré à la volée** lors de l'exécution. Cela évite la duplication et garantit que le code est toujours synchronisé avec la définition visuelle.

## Format des fichiers

Les scripts sont stockés au format JSON avec l'extension `.json`.

### Structure d'un script

```json
{
  "id": "script_analyse_standard",
  "name": "Analyse standard (démo complète)",
  "description": "Rapport de référence couvrant tous les types de blocs",
  "created": "2026-09-11T00:00:00Z",
  "modified": "2026-09-11T00:00:00Z",
  "blocks": [
    {
      "id": "block_source",
      "type": "synthetic_source",
      "config": {
        "name": "df",
        "samples": 3000,
        "period": 0.02,
        "seed": 42,
        "signals": [
          {"name": "vehicle_speed", "unit": "km/h", "kind": "sine",
           "amplitude": 45.0, "frequency": 0.02, "offset": 55.0, "noise": 1.2}
        ]
      }
    },
    {
      "id": "block_sec",
      "type": "section",
      "config": { "title": "Dynamique véhicule", "level": 1 }
    },
    {
      "id": "block_plot",
      "type": "lineplot",
      "config": {
        "source": "df",
        "x": "time",
        "y": "vehicle_speed",
        "title": "Vitesse véhicule",
        "color": "#89b4fa",
        "unit": "km/h"
      }
    }
  ],
  "settings": {
    "title": "Analyse standard d'un essai de roulage",
    "author": "Baltimore Bird"
  },
  "lastRun": null,
  "lastRunStatus": null,
  "lastRunDuration": null
}
```

## Types de blocs supportés

Le catalogue fait foi : `services/dashboard/blocks.py` (`BLOCK_REGISTRY`). Chaque type ci-dessous
est présent au moins une fois dans le script par défaut `script_analyse_standard.json`, garanti
par le test `test_default_standard_recipe_covers_every_block_type`.

| Type | Catégorie | Description | Config |
|------|-----------|-------------|--------|
| `synthetic_source` | data | Source de données synthétique déterministe | `name`, `samples`, `period`, `seed`, `signals[]` |
| `title` | layout | Page de titre du rapport | `title`, `subtitle`, `author` |
| `section` | layout | Titre de section | `title`, `level` (1/2/3) |
| `text` | layout | Paragraphe | `content` |
| `callout` | layout | Encadré info/success/warning/danger | `type`, `title`, `content` |
| `metrics` | viz | Cartes KPI, une ligne `label: expression` par métrique | `source`, `metrics` |
| `table` | viz | Tableau de données | `source`, `caption`, `max_rows` |
| `lineplot` | viz | Courbe temporelle | `source`, `x`, `y`, `title`, `color`, `unit` |
| `python` | code | Code Python utilisateur, validé par la liste blanche AST | `code`, `inputs[]`, `output` (`figure`/`table`) |

Les expressions des blocs `metrics` et le code des blocs `python` s'exécutent dans le module
généré : ils passent la même analyse statique (liste blanche AST) que n'importe quel code
utilisateur, puis le sous-processus confiné.

## Workflow d'exécution

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Script    │ ──▶ │  Generate   │ ──▶ │   Execute   │ ──▶ │   Report    │
│   (JSON)    │     │   Python    │     │   Script    │     │   (HTML)    │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
```

1. **Load** - Charge la définition JSON du script
2. **Generate** - Génère le code Python à partir des blocs
3. **Execute** - Exécute le script avec les données
4. **Output** - Produit le rapport HTML

## API Endpoints

- `GET /api/scripts` - Liste tous les scripts
- `GET /api/scripts/{id}` - Récupère un script
- `POST /api/scripts` - Crée un nouveau script
- `PUT /api/scripts/{id}` - Met à jour un script
- `DELETE /api/scripts/{id}` - Supprime un script
- `POST /api/scripts/{id}/run` - Exécute un script
- `GET /api/scripts/{id}/preview` - Prévisualise le code Python généré