"""Baltimore Bird - API de gestion des rapports HTML."""

from flask import Blueprint, jsonify, request, send_file
from werkzeug.utils import secure_filename

from api.auth import feature_required, login_required
from config import REPORTS_DIR
from core import is_safe_path

reports_bp = Blueprint("reports", __name__)


@reports_bp.route("/api/reports")
def list_reports():
    """Liste tous les rapports HTML disponibles."""
    reports = []

    for f in REPORTS_DIR.glob("*.html"):
        try:
            stat = f.stat()
            name = f.stem.replace("_", " ").replace("-", " ").title()
            reports.append({
                "id": f.stem,
                "name": name,
                "filename": f.name,
                "size_kb": round(stat.st_size / 1024, 1),
                "created": stat.st_mtime,
            })
        except Exception:
            continue

    reports.sort(key=lambda x: x["created"], reverse=True)
    return jsonify({"reports": reports})


@reports_bp.route("/api/reports/<report_id>")
def get_report(report_id: str):
    """Retourne le contenu HTML d'un rapport."""
    safe_id = secure_filename(report_id)
    if not safe_id or safe_id != report_id:
        return jsonify({"error": "ID de rapport invalide"}), 400

    report_path = REPORTS_DIR / f"{safe_id}.html"

    if not is_safe_path(REPORTS_DIR, report_path):
        return jsonify({"error": "Accès non autorisé"}), 403

    if not report_path.exists():
        return jsonify({"error": "Rapport introuvable"}), 404

    return send_file(report_path, mimetype="text/html")


@reports_bp.route("/api/reports/<report_id>/download")
def download_report(report_id: str):
    """Télécharge un rapport."""
    safe_id = secure_filename(report_id)
    if not safe_id or safe_id != report_id:
        return jsonify({"error": "ID de rapport invalide"}), 400

    report_path = REPORTS_DIR / f"{safe_id}.html"

    if not is_safe_path(REPORTS_DIR, report_path):
        return jsonify({"error": "Accès non autorisé"}), 403

    if not report_path.exists():
        return jsonify({"error": "Rapport introuvable"}), 404

    return send_file(report_path, as_attachment=True, download_name=f"{safe_id}.html")


@reports_bp.route("/api/reports/<report_id>", methods=["DELETE"])
@feature_required("delete_reports")
def delete_report(report_id: str):
    """Supprime un rapport (admin uniquement)."""
    safe_id = secure_filename(report_id)
    if not safe_id or safe_id != report_id:
        return jsonify({"error": "ID de rapport invalide"}), 400

    report_path = REPORTS_DIR / f"{safe_id}.html"

    if not is_safe_path(REPORTS_DIR, report_path):
        return jsonify({"error": "Accès non autorisé"}), 403

    if not report_path.exists():
        return jsonify({"error": "Rapport introuvable"}), 404

    try:
        report_path.unlink()
        return jsonify({"success": True, "message": f"Rapport {safe_id} supprimé"})
    except Exception:
        return jsonify({"error": "Erreur lors de la suppression"}), 500


@reports_bp.route("/api/reports/upload", methods=["POST"])
@login_required
def upload_report():
    """Upload un rapport HTML externe."""
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

    report_path = REPORTS_DIR / filename

    if not is_safe_path(REPORTS_DIR, report_path):
        return jsonify({"error": "Nom de fichier non autorisé"}), 403

    if report_path.exists():
        base = report_path.stem
        counter = 1
        while report_path.exists() and counter < 100:
            report_path = REPORTS_DIR / f"{base}_{counter}.html"
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
