# Scripts - Dashboard Analysis

Ce dossier contient les définitions des scripts d'analyse créés via l'éditeur de blocs du Dashboard.

## Principe

Les scripts sont stockés sous forme de **définition de blocs** (JSON), et le code Python est **généré à la volée** lors de l'exécution. Cela évite la duplication et garantit que le code est toujours synchronisé avec la définition visuelle.

## Format des fichiers

Les scripts sont stockés au format JSON avec l'extension `.json`.

### Structure d'un script

```json
{
  "id": "script_001",
  "name": "Analyse OBD2",
  "description": "Script d'exemple pour l'analyse des données OBD2",
  "created": "2024-01-15T10:30:00Z",
  "modified": "2024-01-15T14:45:00Z",
  "blocks": [
    {
      "id": "block_1",
      "type": "section",
      "config": { "title": "Introduction", "level": "H1" }
    },
    {
      "id": "block_2",
      "type": "text",
      "config": { "content": "Ce rapport présente une analyse..." }
    },
    {
      "id": "block_3",
      "type": "lineplot",
      "config": { 
        "signal": "VehicleSpeed", 
        "title": "Vitesse véhicule", 
        "color": "#6366f1" 
      }
    }
  ],
  "settings": {
    "title": "Rapport d'analyse",
    "author": "User",
    "mappingId": "mapping_obd2_standard"
  },
  "lastRun": "2024-01-15T14:50:00Z",
  "lastRunStatus": "success",
  "lastRunDuration": 2.34
}
```

## Types de blocs supportés

| Type | Description | Config |
|------|-------------|--------|
| `section` | Titre de section | `title`, `level` (H1/H2/H3) |
| `text` | Paragraphe Markdown | `content` |
| `callout` | Encadré info/warning | `content`, `type` |
| `metrics` | Cartes KPI | `columns` |
| `table` | Tableau de données | `caption`, `columns` |
| `lineplot` | Graphique linéaire | `signal`, `title`, `color` |
| `scatter` | Nuage de points | `x`, `y`, `title`, `color` |
| `histogram` | Histogramme | `signal`, `bins`, `title` |
| `stats` | Bloc statistiques | `signals` |
| `latex` | Équation LaTeX | `equation` |
| `code` | Code Python custom | `code` |

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