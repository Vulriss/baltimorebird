# Layouts - Interactive EDA

Ce dossier contient les layouts sauvegardés de l'interface Interactive EDA.

## Format des fichiers

Les layouts sont stockés au format JSON avec l'extension `.json`.

### Structure d'un layout

```json
{
  "id": "layout_001",
  "name": "Mon Layout",
  "created": "2024-01-15T10:30:00Z",
  "modified": "2024-01-15T14:45:00Z",
  "tabs": [
    {
      "id": "tab_1",
      "name": "Vitesse",
      "plots": [
        {
          "id": "plot_1",
          "signals": ["VehicleSpeed", "WheelSpeed_FL"],
          "yAxis": { "min": 0, "max": 200 },
          "color": "#6366f1"
        }
      ]
    }
  ],
  "cursors": {
    "cursor1": { "enabled": true, "position": null },
    "cursor2": { "enabled": false, "position": null }
  },
  "zoom": {
    "xMin": null,
    "xMax": null
  }
}
```

## API Endpoints

- `GET /api/layouts` - Liste tous les layouts
- `GET /api/layouts/{id}` - Récupère un layout
- `POST /api/layouts` - Crée un nouveau layout
- `PUT /api/layouts/{id}` - Met à jour un layout
- `DELETE /api/layouts/{id}` - Supprime un layout