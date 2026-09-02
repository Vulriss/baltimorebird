"""Baltimore Bird - API de gestion des mappings de signaux."""

import json
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from flask import Blueprint, g, jsonify, request

from api.auth import feature_required, login_required
from config import BASE_DIR
from core import utc_now_iso, is_safe_path, is_valid_uuid, sanitize_string

mappings_bp = Blueprint("mappings", __name__)

DEFAULT_MAPPINGS_DIR = BASE_DIR / "data" / "default" / "mappings"
USERS_MAPPINGS_DIR = BASE_DIR / "data" / "users"
MAX_MAPPING_SIZE = 1024 * 1024  # 1 MB
MAX_VARIABLES = 1000
MAX_ALIASES_PER_VARIABLE = 50

DEFAULT_MAPPINGS_DIR.mkdir(parents=True, exist_ok=True)

def get_user_mappings_dir(user_id: str) -> Path:
    if not is_valid_uuid(user_id):
        raise ValueError("User ID invalide")
    user_dir = USERS_MAPPINGS_DIR / user_id / "mappings"
    user_dir.mkdir(parents=True, exist_ok=True)
    return user_dir


def load_mapping(mapping_id: str, user_id: Optional[str] = None) -> Optional[Dict]:
    """Load a mapping by ID. Checks user mappings first, then default mappings."""
    if not mapping_id or not isinstance(mapping_id, str):
        return None

    if user_id and is_valid_uuid(user_id):
        user_dir = USERS_MAPPINGS_DIR / user_id / "mappings"
        filepath = user_dir / f"{mapping_id}.json"
        if is_safe_path(user_dir, filepath) and filepath.exists():
            try:
                content = filepath.read_text(encoding="utf-8")
                if len(content) > MAX_MAPPING_SIZE:
                    return None
                data = json.loads(content)
                data["_owner"] = user_id
                data["_readonly"] = False
                return data
            except (json.JSONDecodeError, OSError):
                return None

    filepath = DEFAULT_MAPPINGS_DIR / f"{mapping_id}.json"
    if is_safe_path(DEFAULT_MAPPINGS_DIR, filepath) and filepath.exists():
        try:
            content = filepath.read_text(encoding="utf-8")
            if len(content) > MAX_MAPPING_SIZE:
                return None
            data = json.loads(content)
            data["_owner"] = None
            data["_readonly"] = True
            return data
        except (json.JSONDecodeError, OSError):
            return None

    return None

def save_mapping(mapping_data: Dict, user_id: str) -> Path:
    if not is_valid_uuid(user_id):
        raise ValueError("User ID invalide")

    mapping_id = mapping_data.get("id")
    if not mapping_id or not isinstance(mapping_id, str):
        raise ValueError("Mapping ID invalide")

    user_dir = get_user_mappings_dir(user_id)
    filepath = user_dir / f"{mapping_id}.json"

    if not is_safe_path(user_dir, filepath):
        raise ValueError("Chemin de fichier invalide")

    save_data = {k: v for k, v in mapping_data.items() if not k.startswith("_")}
    content = json.dumps(save_data, indent=2, ensure_ascii=False)

    if len(content) > MAX_MAPPING_SIZE:
        raise ValueError(f"Mapping trop volumineux (max {MAX_MAPPING_SIZE // 1024} KB)")

    filepath.write_text(content, encoding="utf-8")
    return filepath

def delete_mapping_file(mapping_id: str, user_id: str) -> bool:
    if not is_valid_uuid(user_id):
        return False

    user_dir = get_user_mappings_dir(user_id)
    filepath = user_dir / f"{mapping_id}.json"

    if not is_safe_path(user_dir, filepath):
        return False

    if filepath.exists():
        filepath.unlink()
        return True
    return False

def list_user_mappings(user_id: str) -> List[Dict]:
    mappings = []
    if not is_valid_uuid(user_id):
        return mappings

    user_dir = USERS_MAPPINGS_DIR / user_id / "mappings"
    if user_dir.exists():
        for filepath in user_dir.glob("*.json"):
            if filepath.name.startswith("README"):
                continue
            try:
                content = filepath.read_text(encoding="utf-8")
                if len(content) > MAX_MAPPING_SIZE:
                    continue
                data = json.loads(content)
                mappings.append({
                    "id": data.get("id", filepath.stem),
                    "name": data.get("name", "Sans nom"),
                    "description": data.get("description", ""),
                    "created": data.get("created"),
                    "modified": data.get("modified"),
                    "variableCount": len(data.get("variables", [])),
                    "source": "user",
                    "readonly": False,
                })
            except (json.JSONDecodeError, OSError):
                continue

    return mappings

def list_default_mappings() -> List[Dict]:
    mappings = []
    if DEFAULT_MAPPINGS_DIR.exists():
        for filepath in DEFAULT_MAPPINGS_DIR.glob("*.json"):
            if filepath.name.startswith("README"):
                continue
            try:
                content = filepath.read_text(encoding="utf-8")
                if len(content) > MAX_MAPPING_SIZE:
                    continue
                data = json.loads(content)
                mappings.append({
                    "id": data.get("id", filepath.stem),
                    "name": data.get("name", "Sans nom"),
                    "description": data.get("description", ""),
                    "created": data.get("created"),
                    "variableCount": len(data.get("variables", [])),
                    "source": "default",
                    "readonly": True,
                })
            except (json.JSONDecodeError, OSError):
                continue

    return mappings

def validate_mapping_structure(mapping: Dict) -> tuple[bool, str]:
    """Validate mapping structure."""
    if not isinstance(mapping, dict):
        return False, "Le mapping doit être un objet JSON"
    
    variables = mapping.get("variables", [])
    if not isinstance(variables, list):
        return False, "variables doit être une liste"
    
    if len(variables) > MAX_VARIABLES:
        return False, f"Trop de variables (max {MAX_VARIABLES})"
    
    seen_ids = set()
    seen_names = set()
    
    for i, var in enumerate(variables):
        if not isinstance(var, dict):
            return False, f"Variable {i} invalide"
        
        var_id = var.get("id")
        if not var_id or not isinstance(var_id, str):
            return False, f"Variable {i}: id requis"
        if var_id in seen_ids:
            return False, f"Variable {i}: id dupliqué '{var_id}'"
        seen_ids.add(var_id)

        var_name = var.get("name")
        if not var_name or not isinstance(var_name, str):
            return False, f"Variable {i} ('{var_id}'): nom requis"
        if var_name in seen_names:
            return False, f"Variable {i}: nom dupliqué '{var_name}'"
        seen_names.add(var_name)

        aliases = var.get("aliases", [])
        if not isinstance(aliases, list):
            return False, f"Variable {i} ('{var_id}'): aliases doit être une liste"
        if len(aliases) > MAX_ALIASES_PER_VARIABLE:
            return False, f"Variable {i} ('{var_id}'): trop d'aliases (max {MAX_ALIASES_PER_VARIABLE})"
        
        for alias in aliases:
            if not isinstance(alias, str) or not alias:
                return False, f"Variable {i} ('{var_id}'): alias invalide"
    
    return True, ""

def resolve_signal_in_mapping(mapping: Dict, signal_name: str, available_signals: List[str]) -> Optional[str]:
    if not isinstance(available_signals, list):
        available_signals = []
 
    available_set = set(available_signals)

    for variable in mapping.get("variables", []):
        if variable.get("name") == signal_name:
            if signal_name in available_set:
                return signal_name
            
            for alias in variable.get("aliases", []):
                if alias in available_set:
                    return alias
            
            return None
    
    return None

@mappings_bp.route("/api/mappings")
@login_required
def list_mappings():
    user = g.current_user
    user_mappings = list_user_mappings(user.id)
    default_mappings = list_default_mappings()
    
    merged = {}
    for mapping in default_mappings:
        merged[mapping["id"]] = mapping
    for mapping in user_mappings:
        merged[mapping["id"]] = mapping
    
    all_mappings = list(merged.values())
    
    return jsonify({
        "mappings": all_mappings,
        "user_count": len(user_mappings),
        "default_count": len(default_mappings),
    })

@mappings_bp.route("/api/mappings/<mapping_id>")
@login_required
def get_mapping(mapping_id: str):
    user = g.current_user
    mapping = load_mapping(mapping_id, user.id)
    
    if not mapping:
        return jsonify({"error": "Mapping non trouvé"}), 404
    
    return jsonify(mapping)

@mappings_bp.route("/api/mappings", methods=["POST"])
@feature_required("create_scripts") 
def create_mapping():
    user = g.current_user
    data = request.get_json()
    
    if not data:
        return jsonify({"error": "Données invalides"}), 400
    
    valid, error = validate_mapping_structure(data)
    if not valid:
        return jsonify({"error": error}), 400
    
    mapping_id = data.get("id") or f"mapping_{uuid.uuid4().hex[:8]}"
    now = utc_now_iso()
    
    mapping_data = {
        "id": mapping_id,
        "name": sanitize_string(data.get("name", "Nouveau Mapping"), 200),
        "description": sanitize_string(data.get("description", ""), 1000),
        "created": now,
        "modified": now,
        "variables": data.get("variables", []),
    }
    
    try:
        save_mapping(mapping_data, user.id)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    
    mapping_data["_owner"] = user.id
    mapping_data["_readonly"] = False
    
    return jsonify(mapping_data), 201

@mappings_bp.route("/api/mappings/<mapping_id>", methods=["PUT"])
@feature_required("create_scripts")
def update_mapping(mapping_id: str):
    user = g.current_user
    
    existing = load_mapping(mapping_id, user.id)
    if not existing:
        return jsonify({"error": "Mapping non trouvé"}), 404
    
    data = request.get_json()
    if not data:
        return jsonify({"error": "Données invalides"}), 400
    
    if existing.get("_readonly"):
        mapping_data = {
            "id": mapping_id,
            "name": sanitize_string(data.get("name", existing.get("name", "")), 200),
            "description": sanitize_string(data.get("description", existing.get("description", "")), 1000),
            "created": existing.get("created", utc_now_iso()),
            "modified": utc_now_iso(),
            "variables": data.get("variables", existing.get("variables", [])),
        }
    else:
        if existing.get("_owner") != user.id:
            return jsonify({"error": "Accès non autorisé"}), 403
        
        mapping_data = existing.copy()
        if "name" in data:
            mapping_data["name"] = sanitize_string(data["name"], 200)
        if "description" in data:
            mapping_data["description"] = sanitize_string(data["description"], 1000)
        if "variables" in data:
            mapping_data["variables"] = data["variables"]
        mapping_data["modified"] = utc_now_iso()
    
    valid, error = validate_mapping_structure(mapping_data)
    if not valid:
        return jsonify({"error": error}), 400
    
    try:
        save_mapping(mapping_data, user.id)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    
    mapping_data["_owner"] = user.id
    mapping_data["_readonly"] = False
    
    return jsonify(mapping_data)

@mappings_bp.route("/api/mappings/<mapping_id>", methods=["DELETE"])
@feature_required("create_scripts")
def delete_mapping(mapping_id: str):
    user = g.current_user
    existing = load_mapping(mapping_id, user.id)
    
    if not existing:
        return jsonify({"error": "Mapping non trouvé"}), 404
    
    if existing.get("_readonly"):
        return jsonify({"error": "Impossible de supprimer un mapping par défaut"}), 403
    
    if existing.get("_owner") != user.id:
        return jsonify({"error": "Accès non autorisé"}), 403
    
    if delete_mapping_file(mapping_id, user.id):
        return jsonify({"success": True, "deleted": mapping_id})
    
    return jsonify({"error": "Erreur lors de la suppression"}), 500

@mappings_bp.route("/api/mappings/<mapping_id>/resolve")
@login_required
def resolve_signal(mapping_id: str):
    signal_name = request.args.get("signal")
    available_param = request.args.get("available", "")
    
    if not signal_name:
        return jsonify({"error": "Paramètre 'signal' requis"}), 400
    
    available_signals = [s.strip() for s in available_param.split(",") if s.strip()]
    
    user = g.current_user
    mapping = load_mapping(mapping_id, user.id)
    
    if not mapping:
        return jsonify({"error": "Mapping non trouvé"}), 404
    
    resolved = resolve_signal_in_mapping(mapping, signal_name, available_signals)
    
    return jsonify({
        "mapping_id": mapping_id,
        "signal": signal_name,
        "resolved": resolved,
        "available_signals": available_signals,
    })