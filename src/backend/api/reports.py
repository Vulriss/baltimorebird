"""Baltimore Bird - API de gestion des rapports HTML."""

from pathlib import Path
from typing import Optional

from flask import Blueprint, g, jsonify, request, send_file
from werkzeug.utils import secure_filename

from api.auth import feature_required, login_required
from config import BASE_DIR, REPORTS_DIR  # REPORTS_DIR = rapports partagés/démo, lecture seule
from core import is_safe_path, is_valid_uuid

reports_bp = Blueprint("reports", __name__)

USERS_DIR = BASE_DIR / "data" / "users"


def get_user_reports_dir(user_id: str) -> Path:
    if not is_valid_uuid(user_id):
        raise ValueError("User ID invalide")
    user_dir = USERS_DIR / user_id / "reports"
    user_dir.mkdir(parents=True, exist_ok=True)
    return user_dir


def _report_info(f: Path, source: str, readonly: bool) -> dict:
    stat = f.stat()
    name = f.stem.replace("_", " ").replace("-", " ").title()
    return {
        "id": f.stem,
        "name": name,
        "filename": f.name,
        "size_kb": round(stat.st_size / 1024, 1),
        "created": stat.st_mtime,
        "source": source,
        "readonly": readonly,
    }


def _find_report_path(report_id: str, user_id: str) -> Optional[tuple[Path, bool]]:
    """Cherche le rapport dans le dossier privé de l'utilisateur, puis dans le dossier partagé.
    Retourne (path, readonly) ou None.
    """
    safe_id = secure_filename(report_id)
    if not safe_id or safe_id != report_id:
        return None

    if is_valid_uuid(user_id):
        user_dir = USERS_DIR / user_id / "reports"
        user_path = user_dir / f"{safe_id}.html"
        if is_safe_path(user_dir, user_path) and user_path.exists():
            return user_path, False

    default_path = REPORTS_DIR / f"{safe_id}.html"
    if is_safe_path(REPORTS_DIR, default_path) and default_path.exists():
        return default_path, True

    return None


@reports_bp.route("/api/reports")
@login_required
def list_reports():
    """Liste les rapports de l'utilisateur + les rapports partagés (démo)."""
    user = g.current_user
    reports = []

    user_dir = get_user_reports_dir(user.id)
    for f in user_dir.glob("*.html"):
        try:
            reports.append(_report_info(f, source="user", readonly=False))
        except Exception:
            continue

    if REPORTS_DIR.exists():
        for f in REPORTS_DIR.glob("*.html"):
            try:
                reports.append(_report_info(f, source="default", readonly=True))
            except Exception:
                continue

    reports.sort(key=lambda x: x["created"], reverse=True)
    return jsonify({"reports": reports})


@reports_bp.route("/api/reports/<report_id>")
@login_required
def get_report(report_id: str):
    """Retourne le contenu HTML d'un rapport (privé à l'utilisateur ou partagé)."""
    user = g.current_user
    found = _find_report_path(report_id, user.id)
    if not found:
        return jsonify({"error": "Rapport introuvable"}), 404

    report_path, _ = found
    return send_file(report_path, mimetype="text/html")


@reports_bp.route("/api/reports/<report_id>/download")
@login_required
def download_report(report_id: str):
    """Télécharge un rapport (privé à l'utilisateur ou partagé)."""
    user = g.current_user
    found = _find_report_path(report_id, user.id)
    if not found:
        return jsonify({"error": "Rapport introuvable"}), 404

    report_path, _ = found
    safe_id = secure_filename(report_id)
    return send_file(report_path, as_attachment=True, download_name=f"{safe_id}.html")


@reports_bp.route("/api/reports/<report_id>", methods=["DELETE"])
@login_required
def delete_report(report_id: str):
    """Supprime un rapport appartenant à l'utilisateur. Les rapports partagés/démo ne sont pas supprimables ici."""
    user = g.current_user
    found = _find_report_path(report_id, user.id)
    if not found:
        return jsonify({"error": "Rapport introuvable"}), 404

    report_path, readonly = found
    if readonly:
        return jsonify({"error": "Impossible de supprimer un rapport partagé/démo"}), 403

    try:
        report_path.unlink()
        return jsonify({"success": True, "message": f"Rapport {report_id} supprimé"})
    except Exception:
        return jsonify({"error": "Erreur lors de la suppression"}), 500


@reports_bp.route("/api/reports/upload", methods=["POST"])
@login_required
def upload_report():
    """Upload un rapport HTML externe dans l'espace privé de l'utilisateur."""
    user = g.current_user

    if "file" not in request.files:
        return jsonify({"error": "Aucun fichier fourni"}), 400

    file = request.files["file"]
    if not file.filename:
        return jsonify({"error": "Nom de fichier vide"}), 400

    if not file.filename.lower().endswith(".html"):
        return jsonify({"error": "Seuls les fichiers HTML sont acceptés"}), 400

    filename = secure_filename(file.filename)
    if not filename:
        return jsonify({"error": "Nom de fichier invalide"}), 400

    user_dir = get_user_reports_dir(user.id)
    report_path = user_dir / filename

    if not is_safe_path(user_dir, report_path):
        return jsonify({"error": "Nom de fichier non autorisé"}), 403

    if report_path.exists():
        base = report_path.stem
        counter = 1
        while report_path.exists() and counter < 100:
            report_path = user_dir / f"{base}_{counter}.html"
            counter += 1
        if counter >= 100:
            return jsonify({"error": "Trop de fichiers avec ce nom"}), 400

    file.save(report_path)

    return jsonify({
        "success": True,
        "id": report_path.stem,
        "filename": report_path.name,
        "size_kb": round(report_path.stat().st_size / 1024, 1),
    })