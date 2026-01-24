"""Baltimore Bird - API REST du stockage utilisateur."""

import json
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from flask import Blueprint, g, jsonify, request, send_file
from werkzeug.utils import secure_filename

from api.auth import admin_required, login_required
from config import BASE_DIR, DEFAULT_QUOTA_BYTES, MAX_JSON_DEPTH, MAX_JSON_SIZE_BYTES
from core import is_safe_path, validate_json_depth
from services.storage import CATEGORIES, StoredFile, storage

storage_bp = Blueprint("storage", __name__)

DEFAULT_ROOT = BASE_DIR / "data" / "default"
USERS_ROOT = BASE_DIR / "data" / "users"


def format_size(size_bytes: int) -> str:
    size = float(size_bytes)
    for unit in ["B", "KB", "MB", "GB"]:
        if size < 1024:
            return f"{size:.1f} {unit}"
        size /= 1024
    return f"{size:.1f} TB"


@storage_bp.route("/api/storage/info")
@login_required
def get_storage_info():
    user = g.current_user
    try:
        info = storage.get_storage_info(user.id)
        info["categories"] = {cat: data["description"] for cat, data in CATEGORIES.items()}
        return jsonify(info)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400


@storage_bp.route("/api/storage/files")
@login_required
def list_files():
    user = g.current_user
    category = request.args.get("category")
    include_default = request.args.get("include_default", "true").lower() == "true"

    if category and category not in CATEGORIES:
        return jsonify({"error": "Catégorie invalide"}), 400

    files = storage.list_files(user.id, category=category, include_default=include_default)

    return jsonify({
        "files": [f.to_dict() for f in files],
        "count": len(files),
    })


@storage_bp.route("/api/storage/files/<category>", methods=["POST"])
@login_required
def upload_file(category: str):
    if category not in CATEGORIES:
        return jsonify({"error": "Catégorie invalide"}), 400

    user = g.current_user

    if "file" not in request.files:
        return jsonify({"error": "Aucun fichier fourni"}), 400

    file = request.files["file"]
    if not file.filename:
        return jsonify({"error": "Nom de fichier vide"}), 400

    filename = secure_filename(file.filename)
    if not filename:
        return jsonify({"error": "Nom de fichier invalide"}), 400

    ext = "." + Path(filename).suffix.lower().lstrip(".")
    if ext not in CATEGORIES[category]["extensions"]:
        return jsonify({"error": f"Extension {ext} non autorisée pour la catégorie {category}"}), 400

    description = request.form.get("description", "")[:500]

    try:
        file_data = file.read()
        stored_file = storage.store_file(
            user_id=user.id,
            file_data=file_data,
            original_name=filename,
            category=category,
            description=description
        )

        return jsonify({"success": True, "file": stored_file.to_dict()}), 201

    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        return jsonify({"error": f"Erreur lors de l'upload: {str(e)}"}), 500


@storage_bp.route("/api/storage/json/<category>", methods=["POST"])
@login_required
def upload_json(category: str):
    if category not in CATEGORIES:
        return jsonify({"error": "Catégorie invalide"}), 400

    if "json" not in CATEGORIES[category]["extensions"]:
        return jsonify({"error": "Cette catégorie n'accepte pas les fichiers JSON"}), 400

    user = g.current_user

    try:
        data = request.get_json()
        if not data:
            return jsonify({"error": "Données JSON requises"}), 400

        content = data.get("content")
        name = data.get("name", "").strip()
        description = data.get("description", "").strip()[:500]

        if not content:
            return jsonify({"error": "Contenu JSON requis"}), 400

        if not name:
            return jsonify({"error": "Nom requis"}), 400

        stored_file = storage.store_json(
            user_id=user.id,
            data=content,
            name=name,
            category=category,
            description=description
        )

        return jsonify({"success": True, "file": stored_file.to_dict()}), 201

    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        return jsonify({"error": f"Erreur lors de la sauvegarde: {str(e)}"}), 500


@storage_bp.route("/api/storage/files/<file_id>")
@login_required
def get_file_info(file_id: str):
    user = g.current_user

    try:
        uuid.UUID(file_id)
    except ValueError:
        return jsonify({"error": "ID de fichier invalide"}), 400

    stored_file = storage.get_file(file_id, user.id)

    if not stored_file:
        return jsonify({"error": "Fichier introuvable"}), 404

    return jsonify({"file": stored_file.to_dict()})


@storage_bp.route("/api/storage/files/<file_id>/download")
@login_required
def download_file(file_id: str):
    user = g.current_user

    try:
        uuid.UUID(file_id)
    except ValueError:
        return jsonify({"error": "ID de fichier invalide"}), 400

    stored_file = storage.get_file(file_id, user.id)
    if not stored_file:
        return jsonify({"error": "Fichier introuvable"}), 404

    file_path = storage.get_file_path(file_id, user.id)
    if not file_path:
        return jsonify({"error": "Fichier introuvable sur le disque"}), 404

    return send_file(file_path, as_attachment=True, download_name=stored_file.original_name)


@storage_bp.route("/api/storage/files/<file_id>/content")
@login_required
def get_file_content(file_id: str):
    user = g.current_user

    try:
        uuid.UUID(file_id)
    except ValueError:
        return jsonify({"error": "ID de fichier invalide"}), 400

    stored_file = storage.get_file(file_id, user.id)
    if not stored_file:
        return jsonify({"error": "Fichier introuvable"}), 404

    if stored_file.category not in ("layouts", "mappings", "analyses"):
        return jsonify({"error": "Contenu non disponible pour cette catégorie"}), 400

    content = storage.load_json(file_id, user.id)
    if content is None:
        return jsonify({"error": "Erreur de lecture du contenu"}), 500

    return jsonify({"file": stored_file.to_dict(), "content": content})


@storage_bp.route("/api/storage/files/<file_id>", methods=["PUT"])
@login_required
def update_file(file_id: str):
    user = g.current_user

    try:
        uuid.UUID(file_id)
    except ValueError:
        return jsonify({"error": "ID de fichier invalide"}), 400

    stored_file = storage.get_file(file_id, user.id)
    if not stored_file:
        return jsonify({"error": "Fichier introuvable"}), 404

    data = request.get_json()
    if not data:
        return jsonify({"error": "Données JSON requises"}), 400

    return jsonify({"success": True, "message": "Mise à jour non implémentée pour le moment"})


@storage_bp.route("/api/storage/files/<file_id>", methods=["DELETE"])
@login_required
def delete_file(file_id: str):
    user = g.current_user

    try:
        uuid.UUID(file_id)
    except ValueError:
        return jsonify({"error": "ID de fichier invalide"}), 400

    if storage.delete_file(file_id, user.id):
        return jsonify({"success": True})

    return jsonify({"error": "Fichier introuvable"}), 404


@storage_bp.route("/api/storage/default")
def list_default_files():
    category = request.args.get("category")
    files: List[Dict[str, Any]] = []

    categories_to_scan = [category] if category and category in CATEGORIES else list(CATEGORIES.keys())

    for cat in categories_to_scan:
        cat_dir = DEFAULT_ROOT / cat
        if not cat_dir.exists():
            continue

        for filepath in cat_dir.glob("*"):
            if filepath.is_file() and not filepath.name.startswith("."):
                try:
                    stat = filepath.stat()
                    files.append({
                        "id": f"default_{filepath.stem}",
                        "name": filepath.name,
                        "category": cat,
                        "size": stat.st_size,
                        "size_human": format_size(stat.st_size),
                        "is_default": True,
                    })
                except Exception:
                    continue

    return jsonify({"files": files, "count": len(files)})


@storage_bp.route("/api/storage/default/<file_id>/download")
def download_default_file(file_id: str):
    if not file_id.startswith("default_"):
        return jsonify({"error": "ID de fichier invalide"}), 400

    filename = file_id.replace("default_", "", 1)

    for cat in CATEGORIES:
        cat_dir = DEFAULT_ROOT / cat
        for ext in CATEGORIES[cat]["extensions"]:
            filepath = cat_dir / f"{filename}.{ext}"
            if filepath.exists() and is_safe_path(DEFAULT_ROOT, filepath):
                return send_file(filepath, as_attachment=True, download_name=filepath.name)

    return jsonify({"error": "Fichier introuvable"}), 404


@storage_bp.route("/api/admin/storage/stats")
@admin_required
def get_storage_stats():
    stats = {
        "total_users": 0,
        "total_files": 0,
        "total_size": 0,
        "by_category": {},
    }

    if USERS_ROOT.exists():
        for user_dir in USERS_ROOT.iterdir():
            if not user_dir.is_dir():
                continue
            stats["total_users"] += 1

            for cat in CATEGORIES:
                cat_dir = user_dir / cat
                if cat_dir.exists():
                    for f in cat_dir.glob("*"):
                        if f.is_file():
                            stats["total_files"] += 1
                            size = f.stat().st_size
                            stats["total_size"] += size

                            if cat not in stats["by_category"]:
                                stats["by_category"][cat] = {"count": 0, "size": 0}
                            stats["by_category"][cat]["count"] += 1
                            stats["by_category"][cat]["size"] += size

    stats["total_size_human"] = format_size(stats["total_size"])
    for cat in stats["by_category"]:
        stats["by_category"][cat]["size_human"] = format_size(stats["by_category"][cat]["size"])

    return jsonify(stats)


@storage_bp.route("/api/admin/storage/users/<user_id>/quota", methods=["PUT"])
@admin_required
def update_user_quota(user_id: str):
    try:
        uuid.UUID(user_id)
    except ValueError:
        return jsonify({"error": "ID utilisateur invalide"}), 400

    return jsonify({"success": True, "message": "Quota update non implémenté pour le moment"})
