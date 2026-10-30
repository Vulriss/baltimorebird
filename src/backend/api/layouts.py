"""Baltimore Bird - API de gestion des layouts de visualisation EDA."""

import json
import os
import re
import tempfile
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from flask import Blueprint, g, jsonify, request

from api.auth import login_required, optional_auth
from api.computed import validate_formula
from config import (
    BASE_DIR,
    LAYOUT_MAX_COMPUTED_VARIABLES,
    LAYOUT_MAX_DESCRIPTION_LENGTH,
    LAYOUT_MAX_NAME_LENGTH,
    LAYOUT_MAX_TRANSFORM_WINDOW,
    LAYOUT_VERSION,
)
from core import utc_now_iso, is_safe_path
from mda.layout_import import parse_mda_layout

layouts_bp = Blueprint("layouts", __name__)

SIGNAL_TRANSFORM_MODES = frozenset({"savgol", "ddt", "integral"})
_FORMULA_LETTER = re.compile(r"[A-Z]")
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
        "created_at": utc_now_iso(),
        "updated_at": utc_now_iso(),
        "is_demo": True,
        "tabs": [
            {
                "name": "Moteur",
                "plots": [
                    {
                        "flex": 1.5,
                        "signals": [{"name": "VehicleSpeed", "style": {"color": "#fab387", "width": 2, "dash": ""}}],
                    },
                    {
                        "flex": 1,
                        "signals": [{"name": "EngineRPM", "style": {"color": "#89b4fa", "width": 1.5, "dash": ""}}],
                    },
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


def _is_bounded_str(value: Any, max_length: int) -> bool:
    return isinstance(value, str) and 0 < len(value) <= max_length


def _validate_signal_transform(transform: Any) -> Optional[str]:
    """Checks the optional quick mutator persisted on a plot signal.

    Returns:
        None when valid or absent, otherwise the reason in French.
    """
    if transform is None:
        return None
    if not isinstance(transform, dict):
        return "le mutateur doit être un objet"
    if transform.get("mode") not in SIGNAL_TRANSFORM_MODES:
        return "mode de mutateur inconnu"
    window = transform.get("window")
    if window is None:
        return None
    if isinstance(window, bool) or not isinstance(window, int) or not 1 <= window <= LAYOUT_MAX_TRANSFORM_WINDOW:
        return f"intensité de lissage invalide (1 à {LAYOUT_MAX_TRANSFORM_WINDOW})"
    return None


def _validate_plot_signals(signals: List[Any], where: str) -> Optional[str]:
    """Checks the signal entries of one plot. Returns the error message, or None."""
    for k, signal in enumerate(signals):
        if not isinstance(signal, dict) or not _is_bounded_str(signal.get("name"), LAYOUT_MAX_NAME_LENGTH):
            return f"Le signal {k + 1} {where} doit être un objet avec un nom valide"
        error = _validate_signal_transform(signal.get("transform"))
        if error:
            return f"Signal '{signal['name']}' {where}: {error}"
    return None


def _validate_computed_variable(cv: Dict[str, Any]) -> Optional[str]:
    """Checks one computed variable definition whose name is already validated."""
    formula = cv.get("formula")
    ok, error = validate_formula(formula if isinstance(formula, str) else "")
    if not ok:
        return error
    for key, max_length in (("unit", LAYOUT_MAX_NAME_LENGTH), ("description", LAYOUT_MAX_DESCRIPTION_LENGTH)):
        value = cv.get(key)
        if value is not None and (not isinstance(value, str) or len(value) > max_length):
            return f"'{key}' invalide (texte, max {max_length} caractères)"
    mapping = cv.get("mapping")
    if mapping is not None and not (
        isinstance(mapping, dict)
        and all(
            isinstance(letter, str) and _FORMULA_LETTER.fullmatch(letter)
            and _is_bounded_str(source, LAYOUT_MAX_NAME_LENGTH)
            for letter, source in mapping.items()
        )
    ):
        return "'mapping' doit associer des lettres A-Z à des noms de signaux"
    sources = cv.get("source_signals")
    if sources is not None and not (
        isinstance(sources, list)
        and len(sources) <= 26
        and all(_is_bounded_str(source, LAYOUT_MAX_NAME_LENGTH) for source in sources)
    ):
        return "'source_signals' doit être une liste de 26 noms de signaux au plus"
    return None


def _validate_computed_variables(computed: Any) -> Tuple[bool, Optional[str]]:
    """Validates the computed variable definitions carried by a layout.

    Legacy layouts (version 1) have no 'mapping' and remain valid.

    Returns:
        (True, None) when valid, otherwise (False, message in French).
    """
    if not isinstance(computed, list):
        return False, "'computed_variables' doit être un tableau"
    if len(computed) > LAYOUT_MAX_COMPUTED_VARIABLES:
        return False, f"Trop de variables calculées (max {LAYOUT_MAX_COMPUTED_VARIABLES})"
    for i, cv in enumerate(computed):
        if not isinstance(cv, dict):
            return False, f"La variable calculée {i + 1} doit être un objet"
        name = cv.get("name")
        if not _is_bounded_str(name, 100) or not name.strip():
            return False, f"La variable calculée {i + 1} doit avoir un nom (max 100 caractères)"
        error = _validate_computed_variable(cv)
        if error:
            return False, f"Variable calculée '{name}': {error}"
    return True, None


def validate_layout_content(content: Any) -> Tuple[bool, Optional[str]]:
    """Structural validation of an exported layout ({tabs, computed_variables}).

    Shared with the user storage API, which stores layouts without the name and count
    constraints of this blueprint.

    Returns:
        (True, None) when valid, otherwise (False, message in French).
    """
    if not isinstance(content, dict):
        return False, "Le layout doit être un objet JSON"
    tabs = content.get("tabs", [])
    if not isinstance(tabs, list):
        return False, "Le layout doit contenir un tableau 'tabs'"
    for i, tab in enumerate(tabs):
        if not isinstance(tab, dict) or not isinstance(tab.get("plots"), list):
            return False, f"L'onglet {i + 1} doit être un objet avec un tableau 'plots'"
        for j, plot in enumerate(tab["plots"]):
            if not isinstance(plot, dict) or not isinstance(plot.get("signals"), list):
                return False, f"Le plot {j + 1} de l'onglet {i + 1} doit contenir 'signals'"
            error = _validate_plot_signals(plot["signals"], f"du plot {j + 1} de l'onglet {i + 1}")
            if error:
                return False, error
    return _validate_computed_variables(content.get("computed_variables", []))


def _validate_layout(data: Dict[str, Any]) -> Tuple[bool, Optional[str]]:
    if not isinstance(data, dict):
        return False, "Le layout doit être un objet JSON"

    if not isinstance(data.get("name"), str) or not data["name"].strip():
        return False, "Le nom du layout est requis"

    if len(data["name"]) > 100:
        return False, "Le nom est trop long (max 100 caractères)"

    if not isinstance(data.get("description", ""), str):
        return False, "La description doit être un texte"

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

    return validate_layout_content(data)


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
        now = utc_now_iso()

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

        now = utc_now_iso()
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


@layouts_bp.route("/api/layouts/import-mda", methods=["POST"])
@optional_auth
def import_mda_layout():
    """Importe un layout ETAS MDA (.xdx) et renvoie le layout Baltimore Bird.

    Le fichier est parse en memoire et n'est pas sauvegarde cote serveur; c'est le
    frontend qui applique le layout (resolution des noms de signaux vers le fichier
    courant via applyLayout).
    """
    if "file" not in request.files:
        return jsonify({"error": "Fichier .xdx requis"}), 400

    upload = request.files["file"]
    if not upload.filename:
        return jsonify({"error": "Nom de fichier vide"}), 400
    if not upload.filename.lower().endswith(".xdx"):
        return jsonify({"error": "Extension .xdx attendue"}), 400

    tmp_path: Optional[str] = None
    try:
        fd, tmp_path = tempfile.mkstemp(suffix=".xdx")
        os.close(fd)
        upload.save(tmp_path)

        with open(tmp_path, "rb") as fh:
            if fh.read(16) != b"SQLite format 3\x00":
                return jsonify({"error": "Le fichier n'est pas une base MDA valide"}), 400

        layout = parse_mda_layout(tmp_path)
        n_plots = sum(len(t["plots"]) for t in layout["tabs"])
        n_sigs = sum(len(p["signals"]) for t in layout["tabs"] for p in t["plots"])
        return jsonify({
            "success": True,
            "layout": layout,
            "stats": {"tabs": len(layout["tabs"]), "plots": n_plots, "signals": n_sigs},
        })
    except Exception as e:  # noqa: BLE001 - on renvoie l'erreur au client
        return jsonify({"error": f"Import MDA echoue: {str(e)}"}), 400
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass
