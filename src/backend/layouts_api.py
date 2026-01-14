"""
Layouts API - Gestion des layouts de visualisation EDA.

Les layouts permettent de sauvegarder et réutiliser:
- Configuration des onglets (tabs)
- Plots avec signaux affichés (par nom, pas index)
- Styles des signaux (couleur, épaisseur, dash)
- Ratios des splitters
- Variables calculées (formules)

Usage dans server.py:
    from layouts_api import layouts_bp, init_layouts
    
    app.register_blueprint(layouts_bp)
    init_layouts(BASE_DIR)
"""

from __future__ import annotations

import json
import re
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from flask import Blueprint, g, jsonify, request
from flask.wrappers import Response

# Try to import auth decorators
try:
    from auth import login_required, optional_auth
except ImportError:
    # Fallback if auth module not available
    def login_required(f):
        return f
    def optional_auth(f):
        return f

# =============================================================================
# Blueprint & Module State
# =============================================================================

layouts_bp = Blueprint("layouts", __name__)

_base_dir: Optional[Path] = None
_layouts_dir: Optional[Path] = None
_demo_layouts_dir: Optional[Path] = None

# Version du format de layout (pour migrations futures)
LAYOUT_VERSION = 1


def init_layouts(base_dir: Path) -> None:
    """
    Initialise le module avec le répertoire de base.
    
    Args:
        base_dir: Répertoire racine de l'application
    """
    global _base_dir, _layouts_dir, _demo_layouts_dir
    _base_dir = base_dir
    _layouts_dir = base_dir / "data" / "layouts"
    _demo_layouts_dir = base_dir / "data" / "default" / "layouts"
    
    # Créer les répertoires si nécessaire
    _layouts_dir.mkdir(parents=True, exist_ok=True)
    _demo_layouts_dir.mkdir(parents=True, exist_ok=True)
    
    # Créer le layout de démo s'il n'existe pas
    _create_demo_layout_if_missing()
    
    print("  ✓ Layouts module initialized")


def _create_demo_layout_if_missing() -> None:
    """Crée un layout de démo par défaut."""
    if _demo_layouts_dir is None:
        return
    
    demo_file = _demo_layouts_dir / "demo_obd2.json"
    if demo_file.exists():
        return
    
    demo_layout = {
        "id": "demo_obd2",
        "name": "OBD2 Overview",
        "description": "Vue d'ensemble des données OBD2 avec vitesse, RPM et températures",
        "version": LAYOUT_VERSION,
        "created_at": datetime.utcnow().isoformat() + "Z",
        "updated_at": datetime.utcnow().isoformat() + "Z",
        "is_demo": True,
        "tabs": [
            {
                "name": "Moteur",
                "plots": [
                    {
                        "flex": 1.5,
                        "signals": [
                            {"name": "VehicleSpeed", "style": {"color": "#fab387", "width": 2, "dash": ""}},
                        ]
                    },
                    {
                        "flex": 1,
                        "signals": [
                            {"name": "EngineRPM", "style": {"color": "#89b4fa", "width": 1.5, "dash": ""}}
                        ]
                    },
                    {
                        "flex": 1,
                        "signals": [
                            {"name": "ThrottlePosition", "style": {"color": "#a6e3a1", "width": 1.5, "dash": ""}}
                        ]
                    }
                ]
            },
            {
                "name": "Températures",
                "plots": [
                    {
                        "flex": 1,
                        "signals": [
                            {"name": "CoolantTemp", "style": {"color": "#f38ba8", "width": 2, "dash": ""}},
                            {"name": "IntakeAirTemp", "style": {"color": "#94e2d5", "width": 1.5, "dash": ""}}
                        ]
                    },
                    {
                        "flex": 1,
                        "signals": [
                            {"name": "OilTemp", "style": {"color": "#f9e2af", "width": 1.5, "dash": ""}}
                        ]
                    }
                ]
            },
            {
                "name": "Carburant",
                "plots": [
                    {
                        "flex": 1,
                        "signals": [
                            {"name": "MAF", "style": {"color": "#cba6f7", "width": 1.5, "dash": ""}},
                            {"name": "FuelPressure", "style": {"color": "#74c7ec", "width": 1.5, "dash": ""}}
                        ]
                    },
                    {
                        "flex": 1,
                        "signals": [
                            {"name": "O2Voltage", "style": {"color": "#f5c2e7", "width": 1.5, "dash": ""}}
                        ]
                    }
                ]
            }
        ],
        "computed_variables": []
    }
    
    try:
        with open(demo_file, "w", encoding="utf-8") as f:
            json.dump(demo_layout, f, indent=2, ensure_ascii=False)
        print(f"  ✓ Created demo layout: {demo_file.name}")
    except Exception as e:
        print(f"  ⚠ Failed to create demo layout: {e}")


def _get_user_layouts_dir(user_id: str) -> Path:
    """Retourne le répertoire de layouts d'un utilisateur."""
    if _base_dir is None:
        raise RuntimeError("Layouts module not initialized")
    user_dir = _base_dir / "data" / "users" / user_id / "layouts"
    user_dir.mkdir(parents=True, exist_ok=True)
    return user_dir


def _validate_layout(data: Dict[str, Any]) -> Tuple[bool, Optional[str]]:
    """
    Valide la structure d'un layout.
    
    Returns:
        Tuple (is_valid, error_message)
    """
    if not isinstance(data, dict):
        return False, "Le layout doit être un objet JSON"
    
    if not data.get("name"):
        return False, "Le nom du layout est requis"
    
    if len(data.get("name", "")) > 100:
        return False, "Le nom est trop long (max 100 caractères)"
    
    if not isinstance(data.get("tabs"), list):
        return False, "Le layout doit contenir un tableau 'tabs'"
    
    if len(data["tabs"]) == 0:
        return False, "Le layout doit contenir au moins un onglet"
    
    if len(data["tabs"]) > 20:
        return False, "Trop d'onglets (max 20)"
    
    for i, tab in enumerate(data["tabs"]):
        if not isinstance(tab, dict):
            return False, f"L'onglet {i + 1} doit être un objet"
        
        if not tab.get("name"):
            return False, f"L'onglet {i + 1} doit avoir un nom"
        
        if not isinstance(tab.get("plots"), list):
            return False, f"L'onglet '{tab.get('name')}' doit contenir un tableau 'plots'"
        
        if len(tab["plots"]) > 10:
            return False, f"Trop de plots dans l'onglet '{tab.get('name')}' (max 10)"
        
        for j, plot in enumerate(tab["plots"]):
            if not isinstance(plot, dict):
                return False, f"Le plot {j + 1} de '{tab.get('name')}' doit être un objet"
            
            if not isinstance(plot.get("signals"), list):
                return False, f"Le plot {j + 1} de '{tab.get('name')}' doit contenir 'signals'"
            
            if len(plot["signals"]) > 10:
                return False, f"Trop de signaux dans le plot {j + 1} (max 10)"
    
    # Valider les variables calculées si présentes
    computed = data.get("computed_variables", [])
    if not isinstance(computed, list):
        return False, "'computed_variables' doit être un tableau"
    
    for cv in computed:
        if not cv.get("name") or not cv.get("formula"):
            return False, "Chaque variable calculée doit avoir 'name' et 'formula'"
    
    return True, None


def _sanitize_filename(name: str) -> str:
    """Génère un nom de fichier sûr à partir du nom du layout."""
    # Garde seulement alphanumériques et underscores
    safe = re.sub(r"[^a-zA-Z0-9_]", "_", name)
    # Évite les noms trop longs
    return safe[:50].strip("_") or "layout"


# =============================================================================
# API Endpoints
# =============================================================================

@layouts_bp.route("/api/layouts", methods=["GET"])
@optional_auth
def list_layouts() -> Response:
    """
    Liste tous les layouts disponibles (démo + utilisateur).
    
    Response:
        {
            "layouts": [
                {
                    "id": "demo_obd2",
                    "name": "OBD2 Overview",
                    "description": "...",
                    "is_demo": true,
                    "created_at": "...",
                    "tabs_count": 3
                }
            ]
        }
    """
    layouts: List[Dict[str, Any]] = []
    
    # Layouts de démo
    if _demo_layouts_dir and _demo_layouts_dir.exists():
        for file in _demo_layouts_dir.glob("*.json"):
            try:
                with open(file, "r", encoding="utf-8") as f:
                    data = json.load(f)
                layouts.append({
                    "id": data.get("id", file.stem),
                    "name": data.get("name", file.stem),
                    "description": data.get("description", ""),
                    "is_demo": True,
                    "created_at": data.get("created_at"),
                    "tabs_count": len(data.get("tabs", []))
                })
            except Exception:
                continue
    
    # Layouts utilisateur (si connecté)
    user = getattr(g, "current_user", None)
    if user:
        user_dir = _get_user_layouts_dir(user.id)
        for file in user_dir.glob("*.json"):
            try:
                with open(file, "r", encoding="utf-8") as f:
                    data = json.load(f)
                layouts.append({
                    "id": data.get("id", file.stem),
                    "name": data.get("name", file.stem),
                    "description": data.get("description", ""),
                    "is_demo": False,
                    "created_at": data.get("created_at"),
                    "updated_at": data.get("updated_at"),
                    "tabs_count": len(data.get("tabs", []))
                })
            except Exception:
                continue
    
    # Trier: utilisateur d'abord, puis démo, puis par date
    layouts.sort(key=lambda x: (x.get("is_demo", False), x.get("created_at") or ""))
    
    return jsonify({"layouts": layouts})


@layouts_bp.route("/api/layouts/<layout_id>", methods=["GET"])
@optional_auth
def get_layout(layout_id: str) -> Tuple[Response, int] | Response:
    """
    Récupère un layout complet par son ID.
    """
    # Valider l'ID
    if not layout_id or len(layout_id) > 100:
        return jsonify({"error": "ID de layout invalide"}), 400
    
    safe_id = re.sub(r"[^a-zA-Z0-9_-]", "", layout_id)
    if safe_id != layout_id:
        return jsonify({"error": "ID de layout invalide"}), 400
    
    # Chercher dans les layouts de démo
    if _demo_layouts_dir:
        demo_file = _demo_layouts_dir / f"{layout_id}.json"
        if demo_file.exists():
            try:
                with open(demo_file, "r", encoding="utf-8") as f:
                    return jsonify(json.load(f))
            except Exception as e:
                return jsonify({"error": f"Erreur de lecture: {e}"}), 500
    
    # Chercher dans les layouts utilisateur
    user = getattr(g, "current_user", None)
    if user:
        user_dir = _get_user_layouts_dir(user.id)
        user_file = user_dir / f"{layout_id}.json"
        if user_file.exists():
            try:
                with open(user_file, "r", encoding="utf-8") as f:
                    return jsonify(json.load(f))
            except Exception as e:
                return jsonify({"error": f"Erreur de lecture: {e}"}), 500
    
    return jsonify({"error": "Layout introuvable"}), 404


@layouts_bp.route("/api/layouts", methods=["POST"])
@login_required
def save_layout() -> Tuple[Response, int] | Response:
    """
    Sauvegarde un nouveau layout (utilisateurs connectés uniquement).
    
    Request body:
        {
            "name": "Mon Layout",
            "description": "Description optionnelle",
            "tabs": [...],
            "computed_variables": [...]
        }
    """
    user = g.current_user
    
    try:
        data = request.get_json()
        if not data:
            return jsonify({"error": "Données JSON requises"}), 400
        
        # Valider le layout
        is_valid, error = _validate_layout(data)
        if not is_valid:
            return jsonify({"error": error}), 400
        
        # Générer l'ID et les métadonnées
        layout_id = f"{_sanitize_filename(data['name'])}_{uuid.uuid4().hex[:8]}"
        now = datetime.utcnow().isoformat() + "Z"
        
        layout = {
            "id": layout_id,
            "name": data["name"].strip(),
            "description": data.get("description", "").strip()[:500],
            "version": LAYOUT_VERSION,
            "created_at": now,
            "updated_at": now,
            "is_demo": False,
            "tabs": data["tabs"],
            "computed_variables": data.get("computed_variables", [])
        }
        
        # Sauvegarder
        user_dir = _get_user_layouts_dir(user.id)
        file_path = user_dir / f"{layout_id}.json"
        
        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(layout, f, indent=2, ensure_ascii=False)
        
        print(f"  ✓ Layout saved: {layout_id} for user {user.id}")
        
        return jsonify({
            "success": True,
            "layout": {
                "id": layout_id,
                "name": layout["name"],
                "created_at": now
            }
        })
        
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": f"Erreur de sauvegarde: {str(e)}"}), 500


@layouts_bp.route("/api/layouts/<layout_id>", methods=["PUT"])
@login_required
def update_layout(layout_id: str) -> Tuple[Response, int] | Response:
    """
    Met à jour un layout existant (utilisateurs connectés, leurs propres layouts uniquement).
    """
    user = g.current_user
    
    # Valider l'ID
    safe_id = re.sub(r"[^a-zA-Z0-9_-]", "", layout_id)
    if safe_id != layout_id or len(layout_id) > 100:
        return jsonify({"error": "ID de layout invalide"}), 400
    
    user_dir = _get_user_layouts_dir(user.id)
    file_path = user_dir / f"{layout_id}.json"
    
    if not file_path.exists():
        return jsonify({"error": "Layout introuvable ou accès non autorisé"}), 404
    
    try:
        data = request.get_json()
        if not data:
            return jsonify({"error": "Données JSON requises"}), 400
        
        # Valider
        is_valid, error = _validate_layout(data)
        if not is_valid:
            return jsonify({"error": error}), 400
        
        # Charger l'existant pour garder les métadonnées
        with open(file_path, "r", encoding="utf-8") as f:
            existing = json.load(f)
        
        # Mettre à jour
        now = datetime.utcnow().isoformat() + "Z"
        existing.update({
            "name": data["name"].strip(),
            "description": data.get("description", "").strip()[:500],
            "updated_at": now,
            "tabs": data["tabs"],
            "computed_variables": data.get("computed_variables", [])
        })
        
        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(existing, f, indent=2, ensure_ascii=False)
        
        print(f"  ✓ Layout updated: {layout_id}")
        
        return jsonify({"success": True, "updated_at": now})
        
    except Exception as e:
        return jsonify({"error": f"Erreur de mise à jour: {str(e)}"}), 500


@layouts_bp.route("/api/layouts/<layout_id>", methods=["DELETE"])
@login_required
def delete_layout(layout_id: str) -> Tuple[Response, int] | Response:
    """
    Supprime un layout (utilisateurs connectés, leurs propres layouts uniquement).
    """
    user = g.current_user
    
    # Valider l'ID
    safe_id = re.sub(r"[^a-zA-Z0-9_-]", "", layout_id)
    if safe_id != layout_id or len(layout_id) > 100:
        return jsonify({"error": "ID de layout invalide"}), 400
    
    user_dir = _get_user_layouts_dir(user.id)
    file_path = user_dir / f"{layout_id}.json"
    
    if not file_path.exists():
        return jsonify({"error": "Layout introuvable ou accès non autorisé"}), 404
    
    try:
        file_path.unlink()
        print(f"  ✗ Layout deleted: {layout_id}")
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"error": f"Erreur de suppression: {str(e)}"}), 500