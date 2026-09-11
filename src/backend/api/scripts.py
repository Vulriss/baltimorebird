"""Baltimore Bird - API de gestion des scripts d'analyse Dashboard."""

import json
import uuid
from pathlib import Path
from typing import Dict, List, Optional

from flask import Blueprint, Response, g, jsonify, request

from api.auth import feature_required, login_required
from config import BASE_DIR
from core import utc_now_iso, is_safe_path, is_valid_uuid, sanitize_string, validate_script_id
from services.dashboard import (
    block_schema,
    build_html_report,
    compile_recipe,
    validate_generated_module_source,
    validate_recipe,
)
from services.dashboard.compiler import MODULE_RESULT_MARKER
from services.dashboard.formatting import FormattedModule, format_module

try:
    from services.sandbox import ALLOWED_BUILTINS, ALLOWED_MODULES, check_code_safety, safe_execute
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
    """Validate a recipe's block tree via the declarative compiler validator.

    Args:
        blocks: The list of top-level blocks (each may hold nested ``children``).

    Returns:
        A ``(is_valid, message)`` tuple; ``message`` is empty when valid.
    """
    if not isinstance(blocks, list):
        return False, "blocks doit être une liste"
    if _count_blocks(blocks) > MAX_BLOCKS:
        return False, f"Trop de blocs (max {MAX_BLOCKS})"

    errors = validate_recipe({"blocks": blocks})
    if errors:
        first = errors[0]
        return False, f"{first['block_id']}: {first['message']}"
    return True, ""


def _count_blocks(blocks: List[Dict]) -> int:
    total = 0
    for block in blocks:
        if isinstance(block, dict):
            total += 1
            children = block.get("children")
            if isinstance(children, list):
                total += _count_blocks(children)
    return total


def compile_and_format(script: Dict) -> FormattedModule:
    """Compile a script recipe and Ruff-format it before it is shown or executed.

    Every route that needs generated source calls this, never ``compile_recipe`` directly, so
    what the user sees and what the sandbox executes are guaranteed to be the same bytes for the
    same recipe state. A Ruff failure never raises: it falls back to the original, already-valid
    generated source with a warning (see ``services.dashboard.formatting``).

    Args:
        script: The persisted script/recipe document.

    Returns:
        The formatted (or original, on Ruff failure) module.

    Raises:
        ValueError: If the recipe is statically invalid.
    """
    return format_module(compile_recipe(script))


PLATFORM_VERSION = "poc"
RUN_TIMEOUT_SECONDS = 30
RUN_MAX_MEMORY_MB = 512
_BLOCK_STATUS_BY_KIND = {"error": "failed", "skipped": "skipped"}


class SafetyError(Exception):
    """Raised when the generated module fails the AST allowlist safety check."""

    def __init__(self, errors: List[str]) -> None:
        super().__init__("generated module failed the safety check")
        self.errors = errors


def _mapping_names(script: Dict) -> List[str]:
    """Collect the mapped data-source variable names declared in a recipe."""
    names: List[str] = []

    def _walk(blocks: List[Dict]) -> None:
        for block in blocks:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "synthetic_source":
                name = str(block.get("config", {}).get("name", "")).strip()
                if name:
                    names.append(name)
            children = block.get("children")
            if isinstance(children, list):
                _walk(children)

    _walk(script.get("blocks", []) or [])
    return names


def _parse_artefacts(output: str) -> Dict:
    """Extract the JSON artefact document printed by a generated module."""
    marker_index = output.rfind(MODULE_RESULT_MARKER)
    if marker_index == -1:
        return {"document": []}
    payload = output[marker_index + len(MODULE_RESULT_MARKER):]
    try:
        return json.loads(payload)
    except json.JSONDecodeError:
        return {"document": []}


def _execute_recipe(script: Dict, script_id: str) -> Dict:
    """Compile, safety-check and run a recipe in the confined runner.

    Args:
        script: The recipe document.
        script_id: The recipe identifier (used for provenance).

    Returns:
        A run outcome with document artefacts, per-block statuses and provenance.

    Raises:
        ValueError: If the recipe is statically invalid.
        SafetyError: If the generated module fails the safety check.
    """
    module = compile_and_format(script)
    safety = check_code_safety(module.source)
    if not safety["safe"]:
        raise SafetyError(safety["errors"])

    result = safe_execute(module.source, timeout_seconds=RUN_TIMEOUT_SECONDS, max_memory_mb=RUN_MAX_MEMORY_MB)
    artefacts = _parse_artefacts(result.output)
    document = artefacts.get("document", [])

    block_status = {
        item["block_id"]: _BLOCK_STATUS_BY_KIND.get(item.get("kind"), "succeeded")
        for item in document
        if isinstance(item, dict) and item.get("block_id")
    }
    block_errors = {
        item["block_id"]: str(item.get("message", "Erreur inconnue"))
        for item in document
        if isinstance(item, dict) and item.get("kind") in ("error", "skipped") and item.get("block_id")
    }
    has_failure = any(status != "succeeded" for status in block_status.values())
    if not result.success:
        status = "failed"
    elif has_failure:
        status = "partial"
    else:
        status = "succeeded"

    provenance = {
        "title": script.get("settings", {}).get("title", script.get("name", "Dashboard")),
        "recipe_id": script_id,
        "recipe_version": script.get("version", 1),
        "module_hash": module.provenance_hash,
        "platform_version": PLATFORM_VERSION,
        "generated_at": utc_now_iso(),
        "mapping": _mapping_names(script),
    }
    return {
        "status": status,
        "duration": round(result.execution_time, 3),
        "document": document,
        "block_status": block_status,
        "block_errors": block_errors,
        "output": result.output.split(MODULE_RESULT_MARKER)[0][-4000:],
        "error": result.error,
        "provenance": provenance,
        "format_warning": module.warning,
    }


@scripts_bp.route("/api/scripts")
@login_required
def list_scripts():
    user = g.current_user
    user_scripts = list_user_scripts(user.id)
    default_scripts = list_default_scripts()
    return jsonify({
        "scripts": user_scripts + default_scripts,
        "user_count": len(user_scripts),
        "default_count": len(default_scripts),
    })


@scripts_bp.route("/api/scripts/catalogue")
@login_required
def scripts_catalogue():
    """Return the declarative block catalogue for the editor palette."""
    return jsonify({"blocks": block_schema()})


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
    now = utc_now_iso()

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

    existing["modified"] = utc_now_iso()

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

    try:
        outcome = _execute_recipe(script, script_id)
    except ValueError as exc:
        return jsonify({"success": False, "error": str(exc)}), 400
    except SafetyError as exc:
        return jsonify({"success": False, "error": "Code généré non sécurisé", "safety_errors": exc.errors}), 400

    now = utc_now_iso()
    if not script.get("_readonly") and script.get("_owner") == user.id:
        script["lastRun"] = now
        script["lastRunStatus"] = outcome["status"]
        script["lastRunDuration"] = outcome["duration"]
        script["modified"] = now
        try:
            save_script(script, user.id)
        except ValueError:
            pass

    return jsonify({"success": True, "script_id": script_id, **outcome})


@scripts_bp.route("/api/scripts/<script_id>/compile", methods=["POST"])
@feature_required("create_scripts")
def compile_script(script_id: str):
    """Compile a script to its generated module without executing it (EXIT-03)."""
    if not validate_script_id(script_id):
        return jsonify({"error": "ID de script invalide"}), 400

    user = g.current_user
    script = load_script(script_id, user.id)
    if not script:
        return jsonify({"error": "Script non trouvé"}), 404

    errors = validate_recipe(script)
    if errors:
        return jsonify({"success": False, "errors": errors}), 400

    module = compile_and_format(script)
    safety = check_code_safety(module.source) if SANDBOX_AVAILABLE else {"safe": True, "errors": []}
    validation_errors = validate_generated_module_source(module.source)
    if validation_errors:
        return jsonify({"success": False, "errors": [{"block_id": "generated_module", "message": message} for message in validation_errors]}), 400
    return jsonify({
        "success": True,
        "source": module.source,
        "provenance_hash": module.provenance_hash,
        "safe": safety["safe"],
        "safety_errors": safety["errors"],
        "validation_errors": validation_errors,
        "format_warning": module.warning,
    })


@scripts_bp.route("/api/scripts/compile-preview", methods=["POST"])
@feature_required("create_scripts")
def compile_script_preview():
    """Compile an in-memory recipe draft without persisting it (live preview, EXIT-03)."""
    data = request.get_json(silent=True) or {}
    blocks = data.get("blocks", [])
    if not isinstance(blocks, list):
        return jsonify({"success": False, "errors": [{"block_id": "recipe", "message": "blocks doit être une liste"}]}), 400
    if _count_blocks(blocks) > MAX_BLOCKS:
        return jsonify({"success": False, "errors": [{"block_id": "recipe", "message": f"Trop de blocs (max {MAX_BLOCKS})"}]}), 400

    recipe = {
        "blocks": blocks,
        "settings": data.get("settings", {}),
        "name": data.get("name", ""),
    }

    errors = validate_recipe(recipe)
    if errors:
        return jsonify({"success": False, "errors": errors}), 400

    module = compile_and_format(recipe)
    safety = check_code_safety(module.source) if SANDBOX_AVAILABLE else {"safe": True, "errors": []}
    validation_errors = validate_generated_module_source(module.source)
    if validation_errors:
        return jsonify({"success": False, "errors": [{"block_id": "generated_module", "message": message} for message in validation_errors]}), 400
    return jsonify({
        "success": True,
        "source": module.source,
        "provenance_hash": module.provenance_hash,
        "safe": safety["safe"],
        "safety_errors": safety["errors"],
        "validation_errors": validation_errors,
        "format_warning": module.warning,
    })


@scripts_bp.route("/api/scripts/<script_id>/report", methods=["POST"])
@feature_required("run_scripts")
def report_script(script_id: str):
    """Compile, run and render a standalone HTML report (EXIT-06)."""
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

    try:
        outcome = _execute_recipe(script, script_id)
    except ValueError as exc:
        return jsonify({"success": False, "error": str(exc)}), 400
    except SafetyError as exc:
        return jsonify({"success": False, "error": "Code généré non sécurisé", "safety_errors": exc.errors}), 400

    html = build_html_report(script, outcome["document"], outcome["provenance"])
    filename = f"{sanitize_string(script.get('name', 'report'), 80) or 'report'}.html"
    # Served as a download from a non-application response so its content cannot reach the
    # authenticated session origin (SEC-16).
    return Response(
        html,
        mimetype="text/html",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "X-Content-Type-Options": "nosniff",
        },
    )




@scripts_bp.route("/api/scripts/<script_id>/preview")
@login_required
def preview_script_code(script_id: str):
    if not validate_script_id(script_id):
        return jsonify({"error": "ID de script invalide"}), 400

    user = g.current_user
    script = load_script(script_id, user.id)

    if not script:
        return jsonify({"error": "Script non trouvé"}), 404

    module = compile_and_format(script)
    safety_check = check_code_safety(module.source) if SANDBOX_AVAILABLE else None

    return jsonify({
        "script_id": script_id,
        "code": module.source,
        "safety": safety_check,
        "format_warning": module.warning,
    })


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
