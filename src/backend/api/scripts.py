"""Baltimore Bird - API de gestion des scripts d'analyse Dashboard."""

import json
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd
from flask import Blueprint, g, jsonify, request

from api.auth import feature_required, login_required
from api.reports import get_user_reports_dir 
from config import BASE_DIR, DATA_SOURCES, REPORTS_DIR
from core import utc_now_iso, is_safe_path, is_valid_uuid, sanitize_string, validate_script_id
from data_management import datastore
from data_management.loaders import load_synthetic_data
from reports.builder import ReportBuilder
from reports.components import Callout, Histogram, LaTeX, LinePlot, Metrics, ScatterPlot, Section, StatsTable, Table, Text
from services.storage import storage

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

VALID_BLOCK_TYPES = (
    "section", "text", "callout", "metrics", "table",
    "lineplot", "scatter", "histogram", "stats", "latex", "code",
)

def validate_blocks(blocks: List[Dict]) -> tuple[bool, str]:
    if not isinstance(blocks, list):
        return False, "blocks doit être une liste"
    if len(blocks) > MAX_BLOCKS:
        return False, f"Trop de blocs (max {MAX_BLOCKS})"

    for i, block in enumerate(blocks):
        if not isinstance(block, dict):
            return False, f"Block {i} invalide"
        block_type = block.get("type")
        if block_type not in VALID_BLOCK_TYPES:
            return False, f"Type de bloc invalide: {block_type}"
        if not isinstance(block.get("config"), dict):
            return False, f"Block {i} ('{block_type}') doit avoir un objet 'config'"

    return True, ""


def generate_exec_code(script: Dict) -> str:
    lines: List[str] = []

    for block in script.get("blocks", []):
        block_type = block.get("type")
        config = block.get("config", {}) if isinstance(block.get("config"), dict) else {}

        if block_type == "section":
            title = sanitize_string(config.get("title", "Nouvelle Section"), 200)
            level = config.get("level", "H1")
            level_value = 1 if level == "H1" else 2 if level == "H2" else 3
            lines.append(f'report.add(Section({json.dumps(title)}, level={level_value}))')
        elif block_type == "text":
            content = sanitize_string(config.get("content", ""), 10000)
            lines.append(f'report.add(Text({json.dumps(content)}))')
        elif block_type == "callout":
            callout_type = sanitize_string(config.get("type", "info"), 20)
            title = sanitize_string(config.get("title", "Information"), 200)
            content = sanitize_string(config.get("content", ""), 10000)
            lines.append(
                f'report.add(Callout({json.dumps(callout_type)}, {json.dumps(title)}, {json.dumps(content)}))'
            )
        elif block_type == "metrics":
            metrics_text = str(config.get("metrics", "")).strip()
            if not metrics_text:
                lines.append("report.add(Metrics([]))")
            else:
                metric_lines = []
                for raw_line in metrics_text.splitlines():
                    if ":" not in raw_line:
                        continue
                    metric_name, metric_expr = raw_line.split(":", 1)
                    metric_lines.append(f'({json.dumps(metric_name.strip())}, {metric_expr.strip()})')
                if metric_lines:
                    lines.append(f'report.add(Metrics([\n    {",\n    ".join(metric_lines)}\n]))')
                else:
                    lines.append("report.add(Metrics([]))")
        elif block_type == "table":
            data_ref = str(config.get("data", "df") or "df")
            caption = sanitize_string(config.get("caption", "Tableau de données"), 200)
            max_rows = int(config.get("max_rows", 20) or 20)
            lines.append(
                f'report.add(Table({data_ref}, caption={json.dumps(caption)}, max_rows={max_rows}))'
            )
        elif block_type == "lineplot":
            signal = sanitize_string(config.get("signal", ""), 200)
            title = sanitize_string(config.get("title", "Graphique"), 200)
            color = sanitize_string(config.get("color", "#6366f1"), 50)
            lines.append(
                f'report.add(LinePlot(df, x="time", y={json.dumps(signal)}, title={json.dumps(title)}, color={json.dumps(color)}))'
            )
        elif block_type == "scatter":
            x = sanitize_string(config.get("x", ""), 200)
            y = sanitize_string(config.get("y", ""), 200)
            title = sanitize_string(config.get("title", "Scatter Plot"), 200)
            color_by = sanitize_string(config.get("color_by", ""), 200)
            color_arg = f', color={json.dumps(color_by)}' if color_by else ''
            lines.append(
                f'report.add(ScatterPlot(df, x={json.dumps(x)}, y={json.dumps(y)}{color_arg}, title={json.dumps(title)}))'
            )
        elif block_type == "histogram":
            signal = sanitize_string(config.get("signal", ""), 200)
            bins = int(config.get("bins", 30) or 30)
            title = sanitize_string(config.get("title", "Distribution"), 200)
            lines.append(
                f'report.add(Histogram(df, column={json.dumps(signal)}, bins={bins}, title={json.dumps(title)}))'
            )
        elif block_type == "stats":
            signals = sanitize_string(config.get("signals", "*"), 500)
            caption = sanitize_string(config.get("caption", "Statistiques"), 200)
            lines.append(
                f'report.add(StatsTable(df, signals={json.dumps(signals)}, caption={json.dumps(caption)}))'
            )
        elif block_type == "latex":
            expression = sanitize_string(config.get("expression", ""), 10000)
            lines.append(f'report.add(LaTeX(r{json.dumps(expression)}))')
        elif block_type == "code":
            code = str(config.get("code", "")).strip()
            if code:
                lines.append(code)

    return "\n".join(lines)


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
    exec_code = sanitize_string(data.get("exec_code", ""), MAX_CODE_LENGTH)
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
        "exec_code": exec_code,
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

    if "exec_code" in data: 
        existing["exec_code"] = sanitize_string(data["exec_code"], MAX_CODE_LENGTH)

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

def _build_dataframe_from_synthetic() -> pd.DataFrame:
    """Convertit le format (signals, metadata, t_min, t_max) en DataFrame plat."""
    signals, metadata, t_min, t_max = load_synthetic_data()

    # On aligne tout sur le timestamp du premier signal (même longueur/pas ici,
    # car load_synthetic_data génère tous les signaux sur le même axe temps).
    data = {"time": signals[0]["timestamps"]}
    for sig, meta in zip(signals, metadata):
        data[meta["name"]] = sig["values"]

    return pd.DataFrame(data)

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

    exec_code = sanitize_string(script.get("exec_code", ""), MAX_CODE_LENGTH)
    if not exec_code.strip():
        exec_code = generate_exec_code(script)
    if not exec_code.strip():
        return jsonify({"success": False, "error": "Script vide, rien à exécuter"}), 400

    safety = check_code_safety(exec_code)
    if not safety["safe"]:
        return jsonify({
            "success": False,
            "error": "Code généré non sécurisé",
            "safety_errors": safety["errors"],
        }), 400

    # --- Données : synthétiques pour l'instant, upload réel viendra plus tard ---
    try:
        df = _build_dataframe_from_synthetic()
    except Exception as e:
        return jsonify({"success": False, "error": f"Erreur de génération des données: {e}"}), 500

    report_id = f"report_{uuid.uuid4().hex[:8]}"
    output_path = get_user_reports_dir(user.id) / f"{report_id}.html"

    report = ReportBuilder(
        title=script.get("settings", {}).get("title") or script.get("name"),
        author=script.get("settings", {}).get("author", ""),
        source="synthetic_data (test)",
    )

    full_exec_code = exec_code + "\nreport.save(output_path)\n"

    exec_globals = {
        "df": df,
        "report": report,
        "output_path": str(output_path),
        "Section": Section, "Text": Text, "Callout": Callout, "Metrics": Metrics,
        "Table": Table, "LinePlot": LinePlot, "ScatterPlot": ScatterPlot,
        "Histogram": Histogram, "StatsTable": StatsTable, "LaTeX": LaTeX,
    }

    result = safe_execute(full_exec_code, data=exec_globals, timeout_seconds=60, max_memory_mb=512)

    now = utc_now_iso()
    if not script.get("_readonly") and script.get("_owner") == user.id:
        script["lastRun"] = now
        script["lastRunStatus"] = "success" if result.success else "error"
        if result.success:
            script["lastRunDuration"] = round(result.execution_time, 2)
        script["modified"] = now
        try:
            save_script(script, user.id)
        except ValueError:
            pass

    if not result.success:
        return jsonify({"success": False, "error": result.error}), 400
    
    if not output_path.exists():
        return jsonify({
            "success": False,
            "error": "Le rapport n'a pas été écrit sur le disque malgré une exécution signalée comme réussie.",
            "sandbox_output": result.output,   # ce que le code exécuté a produit sur stdout/stderr
            "expected_path": str(output_path),
        }), 500

    return jsonify({
        "success": True,
        "script_id": script_id,
        "duration": round(result.execution_time, 2),
        "report_id": report_id,
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

    code = sanitize_string(script.get("exec_code", ""), MAX_CODE_LENGTH) or generate_exec_code(script)
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
