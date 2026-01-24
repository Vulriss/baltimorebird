"""Baltimore Bird - API de conversion et concaténation de fichiers."""

import uuid

from flask import Blueprint, g, jsonify, request, send_file
from werkzeug.utils import secure_filename

from api.auth import admin_required, optional_auth
from config import ALLOWED_EXTENSIONS, TEMP_DIR
from core import allowed_file, is_safe_path, sanitize_task_id
from services import (
    ConversionStatus,
    concatenation_manager,
    conversion_manager,
    get_supported_conversions,
    is_conversion_supported,
)
from services.metrics import metrics

conversion_bp = Blueprint("conversion", __name__)


def validate_temp_file_path(file_path: str):
    """Valide qu'un chemin de fichier est dans TEMP_DIR et existe."""
    if not file_path:
        return None
    from pathlib import Path
    path = Path(file_path)
    if not is_safe_path(TEMP_DIR, path):
        return None
    if not path.exists():
        return None
    return path


@conversion_bp.route("/api/convert/formats")
def get_conversion_formats():
    """Retourne les formats de conversion supportés."""
    return jsonify({
        "supported": get_supported_conversions(),
        "input_extensions": list(ALLOWED_EXTENSIONS - {".dbc"}),
        "dbc_supported": True,
    })


@conversion_bp.route("/api/convert/upload", methods=["POST"])
@optional_auth
def upload_for_conversion():
    """Upload un fichier pour conversion."""
    if "file" not in request.files:
        return jsonify({"error": "Aucun fichier fourni"}), 400

    file = request.files["file"]
    if not file.filename:
        return jsonify({"error": "Nom de fichier vide"}), 400

    if not allowed_file(file.filename, ALLOWED_EXTENSIONS):
        return jsonify({"error": f"Extension non supportée. Extensions autorisées: {ALLOWED_EXTENSIONS}"}), 400

    unique_id = str(uuid.uuid4())
    filename = secure_filename(file.filename)
    if not filename:
        return jsonify({"error": "Nom de fichier invalide"}), 400

    input_path = TEMP_DIR / f"{unique_id}_{filename}"
    file.save(input_path)

    print(f"  Uploaded: {input_path} ({input_path.stat().st_size / 1024 / 1024:.2f} MB)")

    dbc_path = None
    if "dbc" in request.files:
        dbc_file = request.files["dbc"]
        if dbc_file.filename and dbc_file.filename.lower().endswith(".dbc"):
            dbc_filename = secure_filename(dbc_file.filename)
            if dbc_filename:
                dbc_path = TEMP_DIR / f"{unique_id}_{dbc_filename}"
                dbc_file.save(dbc_path)
                print(f"  Uploaded DBC: {dbc_path}")

    return jsonify({
        "success": True,
        "file_id": unique_id,
        "filename": filename,
        "file_path": str(input_path),
        "dbc_path": str(dbc_path) if dbc_path else None,
        "size_mb": round(input_path.stat().st_size / 1024 / 1024, 2),
    })


@conversion_bp.route("/api/convert/start", methods=["POST"])
@optional_auth
def start_conversion():
    """Démarre une tâche de conversion."""
    data = request.get_json()

    if not data:
        return jsonify({"error": "Données JSON requises"}), 400

    file_path = data.get("file_path")
    output_format = data.get("output_format", "").lower()
    dbc_path = data.get("dbc_path")
    resample_raster = data.get("resample_raster")

    if not file_path or not output_format:
        return jsonify({"error": "file_path et output_format requis"}), 400

    if not output_format.isalnum() or len(output_format) > 10:
        return jsonify({"error": "Format de sortie invalide"}), 400

    input_path = validate_temp_file_path(file_path)
    if not input_path:
        return jsonify({"error": "Fichier introuvable ou accès non autorisé"}), 404

    input_ext = input_path.suffix.lower().lstrip(".")
    if not is_conversion_supported(input_ext, output_format):
        return jsonify({
            "error": f"Conversion .{input_ext} vers .{output_format} non supportée",
            "supported": get_supported_conversions(),
        }), 400

    dbc = None
    if dbc_path:
        dbc = validate_temp_file_path(dbc_path)

    task = conversion_manager.create_task(input_path, output_format, dbc, resample_raster)
    conversion_manager.run_conversion(task.id)

    if hasattr(g, "session_id"):
        metrics.record_action(g.session_id, "conversion_started")

    print(f"  Conversion started: {task.id} ({input_path.name} -> .{output_format})")

    return jsonify({
        "success": True,
        "task_id": task.id,
        "status": task.status.value,
        "message": "Conversion démarrée"
    })


@conversion_bp.route("/api/convert/status/<task_id>")
def get_conversion_status(task_id: str):
    """Récupère le statut d'une tâche de conversion."""
    safe_task_id = sanitize_task_id(task_id)
    if not safe_task_id:
        return jsonify({"error": "ID de tâche invalide"}), 400

    task = conversion_manager.get_task(safe_task_id)

    if not task:
        return jsonify({"error": "Tâche introuvable"}), 404

    response = {
        "task_id": task.id,
        "status": task.status.value,
        "progress": round(task.progress, 1),
        "message": task.message,
    }

    if task.status == ConversionStatus.COMPLETED:
        response["output_file"] = task.output_file.name if task.output_file else None
        response["download_url"] = f"/api/convert/download/{task.id}"

    if task.status == ConversionStatus.FAILED:
        response["error"] = "La conversion a échoué"

    return jsonify(response)


@conversion_bp.route("/api/convert/download/<task_id>")
def download_converted_file(task_id: str):
    """Télécharge le fichier converti."""
    safe_task_id = sanitize_task_id(task_id)
    if not safe_task_id:
        return jsonify({"error": "ID de tâche invalide"}), 400

    task = conversion_manager.get_task(safe_task_id)

    if not task:
        return jsonify({"error": "Tâche introuvable"}), 404

    if task.status != ConversionStatus.COMPLETED:
        return jsonify({"error": "Conversion non terminée"}), 400

    if not task.output_file or not task.output_file.exists():
        return jsonify({"error": "Fichier de sortie introuvable"}), 404

    if not is_safe_path(TEMP_DIR, task.output_file):
        return jsonify({"error": "Accès non autorisé"}), 403

    return send_file(task.output_file, as_attachment=True, download_name=task.output_file.name)


@conversion_bp.route("/api/convert/cleanup", methods=["POST"])
@admin_required
def cleanup_conversions():
    """Nettoie les anciennes tâches de conversion (admin uniquement)."""
    max_age = request.args.get("max_age_hours", 24, type=int)
    max_age = max(1, min(max_age, 168))
    deleted = conversion_manager.cleanup_old_tasks(max_age)
    return jsonify({"success": True, "deleted_tasks": deleted})


@conversion_bp.route("/api/concat/upload-single", methods=["POST"])
@optional_auth
def upload_concat_single_file():
    """Upload un fichier MF4 pour concaténation."""
    if "file" not in request.files:
        return jsonify({"error": "Aucun fichier fourni"}), 400

    file = request.files["file"]
    index = request.form.get("index", "0")

    try:
        index_int = int(index)
        if index_int < 0 or index_int > 100:
            return jsonify({"error": "Index invalide"}), 400
    except ValueError:
        return jsonify({"error": "Index invalide"}), 400

    if not file.filename:
        return jsonify({"error": "Nom de fichier vide"}), 400

    if not file.filename.lower().endswith(".mf4"):
        return jsonify({"error": "Seuls les fichiers MF4 sont acceptés"}), 400

    file_id = str(uuid.uuid4())
    filename = secure_filename(file.filename)
    if not filename:
        return jsonify({"error": "Nom de fichier invalide"}), 400

    file_path = TEMP_DIR / f"concat_{file_id}_{index}_{filename}"
    file.save(file_path)

    print(f"  Concat upload single [{index}]: {filename} ({file_path.stat().st_size / 1024 / 1024:.1f} MB)")

    return jsonify({
        "success": True,
        "file_id": file_id,
        "file_path": str(file_path),
        "filename": filename,
        "index": index,
    })


@conversion_bp.route("/api/concat/start", methods=["POST"])
@optional_auth
def start_concatenation():
    """Démarre une tâche de concaténation."""
    data = request.get_json()

    if not data:
        return jsonify({"error": "Données JSON requises"}), 400

    file_paths = data.get("file_paths", [])

    if not isinstance(file_paths, list):
        return jsonify({"error": "file_paths doit être une liste"}), 400

    if len(file_paths) < 2:
        return jsonify({"error": "Au moins 2 fichiers requis"}), 400

    if len(file_paths) > 20:
        return jsonify({"error": "Maximum 20 fichiers autorisés"}), 400

    input_paths = []
    for fp in file_paths:
        validated = validate_temp_file_path(fp)
        if not validated:
            return jsonify({"error": "Fichier introuvable ou accès non autorisé"}), 404
        input_paths.append(validated)

    task = concatenation_manager.create_task(input_paths)
    concatenation_manager.run_concatenation(task.id)

    if hasattr(g, "session_id"):
        metrics.record_action(g.session_id, "concatenation_started")

    print(f"  Concatenation started: {task.id} ({len(input_paths)} files)")

    return jsonify({
        "success": True,
        "task_id": task.id,
        "status": task.status.value,
        "message": "Concaténation démarrée"
    })


@conversion_bp.route("/api/concat/status/<task_id>")
def get_concat_status(task_id: str):
    """Récupère le statut d'une tâche de concaténation."""
    safe_task_id = sanitize_task_id(task_id)
    if not safe_task_id:
        return jsonify({"error": "ID de tâche invalide"}), 400

    task = concatenation_manager.get_task(safe_task_id)

    if not task:
        return jsonify({"error": "Tâche introuvable"}), 404

    response = {
        "task_id": task.id,
        "status": task.status.value,
        "progress": round(task.progress, 1),
        "message": task.message,
    }

    if task.status == ConversionStatus.COMPLETED:
        response["output_file"] = task.output_file.name if task.output_file else None
        response["download_url"] = f"/api/concat/download/{task.id}"
        response["stats"] = task.stats

    if task.status == ConversionStatus.FAILED:
        response["error"] = "La concaténation a échoué"

    return jsonify(response)


@conversion_bp.route("/api/concat/download/<task_id>")
def download_concat_file(task_id: str):
    """Télécharge le fichier concaténé."""
    safe_task_id = sanitize_task_id(task_id)
    if not safe_task_id:
        return jsonify({"error": "ID de tâche invalide"}), 400

    task = concatenation_manager.get_task(safe_task_id)

    if not task:
        return jsonify({"error": "Tâche introuvable"}), 404

    if task.status != ConversionStatus.COMPLETED:
        return jsonify({"error": "Concaténation non terminée"}), 400

    if not task.output_file or not task.output_file.exists():
        return jsonify({"error": "Fichier de sortie introuvable"}), 404

    if not is_safe_path(TEMP_DIR, task.output_file):
        return jsonify({"error": "Accès non autorisé"}), 403

    return send_file(task.output_file, as_attachment=True, download_name=task.output_file.name)
