# Mappings - Signal Name Correspondences

Ce dossier contient les fichiers de mapping entre les noms de variables internes et les signaux sources.

## Format des fichiers

Les mappings sont stockés au format JSON avec l'extension `.json`.

### Structure d'un fichier de mapping

```json
{
  "id": "mapping_default",
  "name": "Default Mapping",
  "description": "Mapping standard pour les données OBD2",
  "created": "2024-01-15T10:30:00Z",
  "modified": "2024-01-15T14:45:00Z",
  "variables": [
    {
      "id": "mapping_1",
      "name": "VehicleSpeed",
      "description": "Vitesse véhicule en km/h",
      "unit": "km/h",
      "aliases": [
        "Vxx_vh_spd",
        "Vxx_vs",
        "Vxx_vh_spd_20ms",
        "Vxx_vh_spd_10ms",
        "OBD_VehicleSpeed"
      ]
    },
    {
      "id": "mapping_2",
      "name": "EngineRPM",
      "description": "Régime moteur",
      "unit": "rpm",
      "aliases": [
        "Vxx_eng_rpm",
        "Vxx_n_mot",
        "OBD_EngineRPM",
        "Engine_Speed"
      ]
    },
    {
      "id": "mapping_3",
      "name": "CoolantTemp",
      "description": "Température liquide de refroidissement",
      "unit": "°C",
      "aliases": [
        "Vxx_t_cool",
        "Vxx_eng_coolant_temp",
        "OBD_CoolantTemp",
        "Engine_Coolant_Temperature"
      ]
    }
  ]
}
```

## Utilisation

Le système de mapping permet de :

1. **Abstraction des noms** - Utiliser des noms internes cohérents dans les scripts
2. **Résolution automatique** - Le système trouve le bon signal dans les données source
3. **Portabilité** - Les scripts fonctionnent avec différentes sources de données

### Exemple de résolution

```python
# Le script utilise le nom interne
signal = resolve_signal("VehicleSpeed", available_signals)
# Retourne "Vxx_vh_spd" si présent dans available_signals
# Ou "OBD_VehicleSpeed" si c'est celui qui est disponible
```

## API Endpoints

- `GET /api/mappings` - Liste tous les fichiers de mapping
- `GET /api/mappings/{id}` - Récupère un mapping
- `POST /api/mappings` - Crée un nouveau mapping
- `PUT /api/mappings/{id}` - Met à jour un mapping
- `DELETE /api/mappings/{id}` - Supprime un mapping
- `GET /api/mappings/{id}/resolve?signal=X&available=A,B,C` - Résout un signal