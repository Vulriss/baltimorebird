"""Baltimore Bird - API de gestion des layouts de visualisation EDA."""

import json
import re
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from flask import Blueprint, g, jsonify, request

from api.auth import login_required, optional_auth
from config import BASE_DIR
from core import is_safe_path

layouts_bp = Blueprint("layouts", __name__)

LAYOUT_VERSION = 1
_layouts_dir: Optional[Path] = None
_demo_layouts_dir: Optional[Path] = None


def init_layouts(base_dir: Path = BASE_DIR) -> None:
    global _layouts_dir, _demo_layouts_dir
    _layouts_dir = base_dir / "data" / "layouts"
    _demo_layouts_dir = base_dir / "data" / "default" / "layouts"
    _layouts_dir.mkdir(parents=True, exist_ok=True)
    _demo_layouts_dir.mkdir(parents=True, exist_ok=True)
    _create_demo_layout_if_missing()


def _create_demo_layout_if_missing() -> None:
    if _demo_layouts_dir is None:
        return
    demo_file = _demo_layouts_dir / "demo_obd2.json"
    if demo_file.exists():
        return

    demo_layout = {
        "id": "demo_obd2",
        "name": "OBD2 Overview",
        "description": "Vue d'ensemble des données OBD2",
        "version": LAYOUT_VERSION,
        "created_at": datetime.utcnow().isoformat() + "Z",
        "updated_at": datetime.utcnow().isoformat() + "Z",
        "is_demo": True,
        "tabs": [
            {
                "name": "Moteur",
                "plots": [
                    {"flex": 1.5, "signals": [{"name": "VehicleSpeed", "style": {"color": "#fab387", "width": 2, "dash": ""}}]},
                    {"flex": 1, "signals": [{"name": "EngineRPM", "style": {"color": "#89b4fa", "width": 1.5, "dash": ""}}]},
                ]
            }
        ],
        "computed_variables": []
    }

    try:
        with open(demo_file, "w", encoding="utf-8") as f:
            json.dump(demo_layout, f, indent=2, ensure_ascii=False)
    except Exception:
        pass


def _get_user_layouts_dir(user_id: str) -> Path:
    user_dir = BASE_DIR / "data" / "users" / user_id / "layouts"
    user_dir.mkdir(parents=True, exist_ok=True)
    return user_dir


def _sanitize_layout_id(name: str) -> str:
    safe = re.sub(r"[^a-zA-Z0-9_-]", "_", name.lower())
    return safe[:50] if safe else "layout"


def _validate_layout(data: Dict[str, Any]) -> Tuple[bool, Optional[str]]:
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

    computed = data.get("computed_variables", [])
    if not isinstance(computed, list):
        return False, "'computed_variables' doit être un tableau"

    for cv in computed:
        if not cv.get("name") or not cv.get("formula"):
            return False, "Chaque variable calculée doit avoir 'name' et 'formula'"

    return True, None


init_layouts()


@layouts_bp.route("/api/layouts")
@optional_auth
def list_layouts():
    layouts: List[Dict] = []

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

    layouts.sort(key=lambda x: (x.get("is_demo", False), x.get("created_at") or ""))
    return jsonify({"layouts": layouts})


@layouts_bp.route("/api/layouts/<layout_id>")
@optional_auth
def get_layout(layout_id: str):
    if not layout_id or len(layout_id) > 100:
        return jsonify({"error": "ID de layout invalide"}), 400

    safe_id = re.sub(r"[^a-zA-Z0-9_-]", "", layout_id)
    if safe_id != layout_id:
        return jsonify({"error": "ID de layout invalide"}), 400

    if _demo_layouts_dir:
        demo_file = _demo_layouts_dir / f"{layout_id}.json"
        if demo_file.exists() and is_safe_path(_demo_layouts_dir, demo_file):
            try:
                with open(demo_file, "r", encoding="utf-8") as f:
                    return jsonify(json.load(f))
            except Exception as e:
                return jsonify({"error": f"Erreur de lecture: {e}"}), 500

    user = getattr(g, "current_user", None)
    if user:
        user_dir = _get_user_layouts_dir(user.id)
        user_file = user_dir / f"{layout_id}.json"
        if user_file.exists() and is_safe_path(user_dir, user_file):
            try:
                with open(user_file, "r", encoding="utf-8") as f:
                    return jsonify(json.load(f))
            except Exception as e:
                return jsonify({"error": f"Erreur de lecture: {e}"}), 500

    return jsonify({"error": "Layout introuvable"}), 404


@layouts_bp.route("/api/layouts", methods=["POST"])
@login_required
def save_layout():
    user = g.current_user

    try:
        data = request.get_json()
        if not data:
            return jsonify({"error": "Données JSON requises"}), 400

        is_valid, error = _validate_layout(data)
        if not is_valid:
            return jsonify({"error": error}), 400

        layout_id = f"{_sanitize_layout_id(data['name'])}_{uuid.uuid4().hex[:8]}"
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

        user_dir = _get_user_layouts_dir(user.id)
        file_path = user_dir / f"{layout_id}.json"

        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(layout, f, indent=2, ensure_ascii=False)

        return jsonify({"success": True, "layout": {"id": layout_id, "name": layout["name"], "created_at": now}})

    except Exception as e:
        return jsonify({"error": f"Erreur de sauvegarde: {str(e)}"}), 500


@layouts_bp.route("/api/layouts/<layout_id>", methods=["PUT"])
@login_required
def update_layout(layout_id: str):
    user = g.current_user

    safe_id = re.sub(r"[^a-zA-Z0-9_-]", "", layout_id)
    if safe_id != layout_id or len(layout_id) > 100:
        return jsonify({"error": "ID de layout invalide"}), 400

    user_dir = _get_user_layouts_dir(user.id)
    file_path = user_dir / f"{layout_id}.json"

    if not file_path.exists() or not is_safe_path(user_dir, file_path):
        return jsonify({"error": "Layout introuvable ou accès non autorisé"}), 404

    try:
        data = request.get_json()
        if not data:
            return jsonify({"error": "Données JSON requises"}), 400

        is_valid, error = _validate_layout(data)
        if not is_valid:
            return jsonify({"error": error}), 400

        with open(file_path, "r", encoding="utf-8") as f:
            existing = json.load(f)

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

        return jsonify({"success": True, "updated_at": now})

    except Exception as e:
        return jsonify({"error": f"Erreur de mise à jour: {str(e)}"}), 500


@layouts_bp.route("/api/layouts/<layout_id>", methods=["DELETE"])
@login_required
def delete_layout(layout_id: str):
    user = g.current_user

    safe_id = re.sub(r"[^a-zA-Z0-9_-]", "", layout_id)
    if safe_id != layout_id or len(layout_id) > 100:
        return jsonify({"error": "ID de layout invalide"}), 400

    user_dir = _get_user_layouts_dir(user.id)
    file_path = user_dir / f"{layout_id}.json"

    if not file_path.exists() or not is_safe_path(user_dir, file_path):
        return jsonify({"error": "Layout introuvable ou accès non autorisé"}), 404

    try:
        file_path.unlink()
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"error": f"Erreur de suppression: {str(e)}"}), 500
