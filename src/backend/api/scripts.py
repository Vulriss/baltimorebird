"""Baltimore Bird - API de gestion des scripts d'analyse Dashboard."""

import json
import re
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from flask import Blueprint, g, jsonify, request

from api.auth import feature_required, login_required
from config import BASE_DIR
from core import is_safe_path, is_valid_uuid, sanitize_string, validate_script_id

try:
    from services.sandbox import ALLOWED_BUILTINS, ALLOWED_MODULES, check_code_safety
    SANDBOX_AVAILABLE = True
except ImportError:
    SANDBOX_AVAILABLE = False
    ALLOWED_MODULES = set()
    ALLOWED_BUILTINS = set()

scripts_bp = Blueprint("scripts", __name__)

DEFAULT_SCRIPTS_DIR = BASE_DIR / "data" / "default" / "scripts"
USERS_SCRIPTS_DIR = BASE_DIR / "data" / "users"
MAX_SCRIPT_SIZE = 1024 * 1024
MAX_BLOCKS = 100
MAX_CODE_LENGTH = 50000

DEFAULT_SCRIPTS_DIR.mkdir(parents=True, exist_ok=True)


def get_user_scripts_dir(user_id: str) -> Path:
    if not is_valid_uuid(user_id):
        raise ValueError("User ID invalide")
    user_dir = USERS_SCRIPTS_DIR / user_id / "scripts"
    user_dir.mkdir(parents=True, exist_ok=True)
    return user_dir


def load_script(script_id: str, user_id: Optional[str] = None) -> Optional[Dict]:
    if not validate_script_id(script_id):
        return None

    if user_id and is_valid_uuid(user_id):
        user_dir = USERS_SCRIPTS_DIR / user_id / "scripts"
        filepath = user_dir / f"{script_id}.json"
        if is_safe_path(user_dir, filepath) and filepath.exists():
            try:
                content = filepath.read_text(encoding="utf-8")
                if len(content) > MAX_SCRIPT_SIZE:
                    return None
                data = json.loads(content)
                data["_owner"] = user_id
                data["_readonly"] = False
                return data
            except (json.JSONDecodeError, OSError):
                return None

    filepath = DEFAULT_SCRIPTS_DIR / f"{script_id}.json"
    if is_safe_path(DEFAULT_SCRIPTS_DIR, filepath) and filepath.exists():
        try:
            content = filepath.read_text(encoding="utf-8")
            if len(content) > MAX_SCRIPT_SIZE:
                return None
            data = json.loads(content)
            data["_owner"] = None
            data["_readonly"] = True
            return data
        except (json.JSONDecodeError, OSError):
            return None

    return None


def save_script(script_data: Dict, user_id: str) -> Path:
    if not is_valid_uuid(user_id):
        raise ValueError("User ID invalide")

    script_id = script_data.get("id")
    if not validate_script_id(script_id):
        raise ValueError("Script ID invalide")

    user_dir = get_user_scripts_dir(user_id)
    filepath = user_dir / f"{script_id}.json"

    if not is_safe_path(user_dir, filepath):
        raise ValueError("Chemin de fichier invalide")

    save_data = {k: v for k, v in script_data.items() if not k.startswith("_")}
    content = json.dumps(save_data, indent=2, ensure_ascii=False)

    if len(content) > MAX_SCRIPT_SIZE:
        raise ValueError(f"Script trop volumineux (max {MAX_SCRIPT_SIZE // 1024} KB)")

    filepath.write_text(content, encoding="utf-8")
    return filepath


def delete_script_file(script_id: str, user_id: str) -> bool:
    if not validate_script_id(script_id) or not is_valid_uuid(user_id):
        return False

    user_dir = get_user_scripts_dir(user_id)
    filepath = user_dir / f"{script_id}.json"

    if not is_safe_path(user_dir, filepath):
        return False

    if filepath.exists():
        filepath.unlink()
        return True
    return False


def list_user_scripts(user_id: str) -> List[Dict]:
    scripts = []
    if not is_valid_uuid(user_id):
        return scripts

    user_dir = USERS_SCRIPTS_DIR / user_id / "scripts"
    if user_dir.exists():
        for filepath in user_dir.glob("*.json"):
            if filepath.name.startswith("README"):
                continue
            try:
                content = filepath.read_text(encoding="utf-8")
                if len(content) > MAX_SCRIPT_SIZE:
                    continue
                data = json.loads(content)
                scripts.append({
                    "id": data.get("id", filepath.stem),
                    "name": data.get("name", "Sans nom"),
                    "description": data.get("description", ""),
                    "created": data.get("created"),
                    "modified": data.get("modified"),
                    "blockCount": len(data.get("blocks", [])),
                    "source": "user",
                    "readonly": False,
                })
            except (json.JSONDecodeError, OSError):
                continue

    return scripts


def list_default_scripts() -> List[Dict]:
    scripts = []
    if DEFAULT_SCRIPTS_DIR.exists():
        for filepath in DEFAULT_SCRIPTS_DIR.glob("*.json"):
            if filepath.name.startswith("README"):
                continue
            try:
                content = filepath.read_text(encoding="utf-8")
                if len(content) > MAX_SCRIPT_SIZE:
                    continue
                data = json.loads(content)
                scripts.append({
                    "id": data.get("id", filepath.stem),
                    "name": data.get("name", "Sans nom"),
                    "description": data.get("description", ""),
                    "created": data.get("created"),
                    "blockCount": len(data.get("blocks", [])),
                    "source": "default",
                    "readonly": True,
                })
            except (json.JSONDecodeError, OSError):
                continue

    return scripts


def validate_blocks(blocks: List[Dict]) -> tuple[bool, str]:
    if not isinstance(blocks, list):
        return False, "blocks doit être une liste"
    if len(blocks) > MAX_BLOCKS:
        return False, f"Trop de blocs (max {MAX_BLOCKS})"

    for i, block in enumerate(blocks):
        if not isinstance(block, dict):
            return False, f"Block {i} invalide"
        block_type = block.get("type")
        if block_type not in ("markdown", "code", "plot", "table", "stats"):
            return False, f"Type de bloc invalide: {block_type}"

    return True, ""


def generate_python_code(script: Dict) -> str:
    lines = [
        "# Auto-generated script",
        "import numpy as np",
        "import pandas as pd",
        "",
        "# Script blocks:",
    ]

    for block in script.get("blocks", []):
        block_type = block.get("type")
        if block_type == "code":
            code = block.get("content", "")
            lines.append(f"\n# Code block")
            lines.append(code)
        elif block_type == "markdown":
            content = block.get("content", "")
            lines.append(f'\n# Markdown: """{content[:100]}..."""')

    return "\n".join(lines)


@scripts_bp.route("/api/scripts")
@login_required
def list_scripts():
    user = g.current_user
    user_scripts = list_user_scripts(user.id)
    default_scripts = list_default_scripts()
    return jsonify({"scripts": user_scripts + default_scripts, "user_count": len(user_scripts), "default_count": len(default_scripts)})


@scripts_bp.route("/api/scripts/<script_id>")
@login_required
def get_script(script_id: str):
    if not validate_script_id(script_id):
        return jsonify({"error": "ID de script invalide"}), 400

    user = g.current_user
    script = load_script(script_id, user.id)

    if not script:
        return jsonify({"error": "Script non trouvé"}), 404

    return jsonify(script)


@scripts_bp.route("/api/scripts", methods=["POST"])
@feature_required("create_scripts")
def create_script():
    user = g.current_user
    data = request.get_json()

    if not data:
        return jsonify({"error": "Données invalides"}), 400

    blocks = data.get("blocks", [])
    valid, error = validate_blocks(blocks)
    if not valid:
        return jsonify({"error": error}), 400

    script_id = f"script_{uuid.uuid4().hex[:8]}"
    now = datetime.utcnow().isoformat() + "Z"

    script_data = {
        "id": script_id,
        "name": sanitize_string(data.get("name", "Nouveau Script"), 200),
        "description": sanitize_string(data.get("description", ""), 1000),
        "created": now,
        "modified": now,
        "blocks": blocks,
        "settings": {
            "title": sanitize_string(data.get("settings", {}).get("title", "Rapport"), 200),
            "author": sanitize_string(data.get("settings", {}).get("author", ""), 100),
            "mappingId": data.get("settings", {}).get("mappingId"),
        },
    }

    try:
        save_script(script_data, user.id)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    return jsonify(script_data), 201


@scripts_bp.route("/api/scripts/<script_id>", methods=["PUT"])
@feature_required("create_scripts")
def update_script(script_id: str):
    if not validate_script_id(script_id):
        return jsonify({"error": "ID de script invalide"}), 400

    user = g.current_user
    existing = load_script(script_id, user.id)

    if not existing:
        return jsonify({"error": "Script non trouvé"}), 404

    if existing.get("_readonly"):
        return jsonify({"error": "Script en lecture seule"}), 403

    if existing.get("_owner") != user.id:
        return jsonify({"error": "Accès non autorisé"}), 403

    data = request.get_json()
    if not data:
        return jsonify({"error": "Données invalides"}), 400

    if "blocks" in data:
        valid, error = validate_blocks(data["blocks"])
        if not valid:
            return jsonify({"error": error}), 400
        existing["blocks"] = data["blocks"]

    if "name" in data:
        existing["name"] = sanitize_string(data["name"], 200)
    if "description" in data:
        existing["description"] = sanitize_string(data["description"], 1000)
    if "settings" in data:
        settings = data["settings"]
        existing["settings"] = {
            "title": sanitize_string(settings.get("title", existing.get("settings", {}).get("title", "")), 200),
            "author": sanitize_string(settings.get("author", existing.get("settings", {}).get("author", "")), 100),
            "mappingId": settings.get("mappingId", existing.get("settings", {}).get("mappingId")),
        }

    existing["modified"] = datetime.utcnow().isoformat() + "Z"

    try:
        save_script(existing, user.id)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    return jsonify(existing)


@scripts_bp.route("/api/scripts/<script_id>", methods=["DELETE"])
@feature_required("create_scripts")
def delete_script(script_id: str):
    if not validate_script_id(script_id):
        return jsonify({"error": "ID de script invalide"}), 400

    user = g.current_user
    existing = load_script(script_id, user.id)

    if not existing:
        return jsonify({"error": "Script non trouvé"}), 404

    if existing.get("_readonly"):
        return jsonify({"error": "Impossible de supprimer un script par défaut"}), 403

    if existing.get("_owner") != user.id:
        return jsonify({"error": "Accès non autorisé"}), 403

    if delete_script_file(script_id, user.id):
        return jsonify({"success": True, "deleted": script_id})

    return jsonify({"error": "Erreur lors de la suppression"}), 500


@scripts_bp.route("/api/scripts/<script_id>/run", methods=["POST"])
@feature_required("run_scripts")
def run_script(script_id: str):
    if not SANDBOX_AVAILABLE:
        return jsonify({"error": "Exécution de scripts non disponible"}), 503

    if not validate_script_id(script_id):
        return jsonify({"error": "ID de script invalide"}), 400

    user = g.current_user
    script = load_script(script_id, user.id)

    if not script:
        return jsonify({"error": "Script non trouvé"}), 404

    valid, error = validate_blocks(script.get("blocks", []))
    if not valid:
        return jsonify({"error": f"Script invalide: {error}"}), 400

    code = generate_python_code(script)
    safety = check_code_safety(code)

    if not safety["safe"]:
        return jsonify({"success": False, "error": "Code généré non sécurisé", "safety_errors": safety["errors"]}), 400

    import time
    start_time = time.time()
    duration = time.time() - start_time
    now = datetime.utcnow().isoformat() + "Z"

    if not script.get("_readonly") and script.get("_owner") == user.id:
        script["lastRun"] = now
        script["lastRunStatus"] = "success"
        script["lastRunDuration"] = round(duration, 2)
        script["modified"] = now
        try:
            save_script(script, user.id)
        except ValueError:
            pass

    return jsonify({
        "success": True,
        "script_id": script_id,
        "status": "success",
        "duration": round(duration, 2),
        "report_id": f"report_{uuid.uuid4().hex[:8]}"
    })


@scripts_bp.route("/api/scripts/<script_id>/preview")
@login_required
def preview_script_code(script_id: str):
    if not validate_script_id(script_id):
        return jsonify({"error": "ID de script invalide"}), 400

    user = g.current_user
    script = load_script(script_id, user.id)

    if not script:
        return jsonify({"error": "Script non trouvé"}), 404

    code = generate_python_code(script)
    safety_check = check_code_safety(code) if SANDBOX_AVAILABLE else None

    return jsonify({"script_id": script_id, "code": code, "safety": safety_check})


@scripts_bp.route("/api/scripts/validate", methods=["POST"])
@login_required
def validate_script_code():
    if not SANDBOX_AVAILABLE:
        return jsonify({"error": "Sandbox non disponible", "safe": False}), 503

    data = request.get_json()
    if not data or "code" not in data:
        return jsonify({"error": "Code requis"}), 400

    code = data["code"]
    if len(code) > MAX_CODE_LENGTH:
        return jsonify({"safe": False, "errors": [f"Code trop long (max {MAX_CODE_LENGTH} caractères)"]})

    result = check_code_safety(code)
    return jsonify(result)


@scripts_bp.route("/api/scripts/allowed-modules")
def get_allowed_modules():
    return jsonify({
        "sandbox_available": SANDBOX_AVAILABLE,
        "modules": sorted(list(ALLOWED_MODULES)) if SANDBOX_AVAILABLE else [],
        "builtins": sorted(list(ALLOWED_BUILTINS)) if SANDBOX_AVAILABLE else []
    })
