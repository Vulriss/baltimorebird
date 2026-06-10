"""Baltimore Bird - API pour l'Exploratory Data Analysis (lazy loading)."""

import uuid
from pathlib import Path

import numpy as np
from flask import Blueprint, g, jsonify, request
from werkzeug.utils import secure_filename

from api.auth import login_required
from config import ALLOWED_EXTENSIONS, BASE_DIR
from core import allowed_file, sanitize_session_id
from core.downsampling import lttb_downsample
from data_management import lazy_eda

import logging

logger = logging.getLogger(__name__)

eda_bp = Blueprint("eda", __name__)


@eda_bp.route("/api/eda/upload", methods=["POST"])
@login_required
def upload_eda_file():
    """Upload un fichier MF4 pour l'EDA interactif."""
    if "file" not in request.files:
        return jsonify({"error": "Aucun fichier fourni"}), 400

    file = request.files["file"]
    if not file.filename:
        return jsonify({"error": "Nom de fichier vide"}), 400

    if not allowed_file(file.filename, ALLOWED_EXTENSIONS):
        return jsonify({"error": "Extension non supportée"}), 400

    user = g.current_user
    filename = secure_filename(file.filename)
    if not filename:
        return jsonify({"error": "Nom de fichier invalide"}), 400

    file_ext = Path(filename).suffix.lower()
    subdir = "mf4" if file_ext == ".mf4" else "dbc" if file_ext == ".dbc" else "other"
    dest_dir = BASE_DIR / "data" / "users" / user.id / subdir
    dest_dir.mkdir(parents=True, exist_ok=True)

    session_id = str(uuid.uuid4())
    file_path = dest_dir / f"{session_id}_{filename}"
    file.save(file_path)

    dbc_path = None
    if "dbc" in request.files:
        dbc_file = request.files["dbc"]
        if dbc_file.filename and dbc_file.filename.lower().endswith(".dbc"):
            dbc_filename = secure_filename(dbc_file.filename)
            if dbc_filename:
                dbc_dir = BASE_DIR / "data" / "users" / user.id / "dbc"
                dbc_dir.mkdir(parents=True, exist_ok=True)
                dbc_path = dbc_dir / f"{uuid.uuid4()}_{dbc_filename}"
                dbc_file.save(dbc_path)

    if not dbc_path:
        user_dbc_dir = BASE_DIR / "data" / "users" / user.id / "dbc"
        if user_dbc_dir.exists():
            dbc_files = list(user_dbc_dir.glob("*.dbc"))
            if dbc_files:
                dbc_path = dbc_files[0]

    lazy_eda.create_session(session_id=session_id, user_id=user.id, mf4_path=file_path, dbc_path=dbc_path)

    return jsonify({"success": True, "session_id": session_id, "filename": filename})


@eda_bp.route("/api/eda/list-signals/<session_id>")
@login_required
def list_eda_signals(session_id: str):
    """Liste tous les signaux d'un fichier MF4."""
    safe_id = sanitize_session_id(session_id)
    if not safe_id:
        return jsonify({"error": "ID invalide"}), 400

    session = lazy_eda.get_session(safe_id)
    if not session:
        return jsonify({"error": "Session introuvable"}), 404
    if session.user_id != g.current_user.id:
        return jsonify({"error": "Accès non autorisé"}), 403

    result = lazy_eda.list_signals(safe_id)
    return jsonify(result) if result else (jsonify({"error": "Erreur listing"}), 500)


@eda_bp.route("/api/eda/preload-signal/<session_id>/<int:signal_index>", methods=["POST"])
@login_required
def preload_eda_signal(session_id: str, signal_index: int):
    """Précharge les données d'un signal."""
    safe_id = sanitize_session_id(session_id)
    if not safe_id or signal_index < 0:
        return jsonify({"error": "Paramètres invalides"}), 400

    session = lazy_eda.get_session(safe_id)
    if not session:
        return jsonify({"error": "Session introuvable"}), 404
    if session.user_id != g.current_user.id:
        return jsonify({"error": "Accès non autorisé"}), 403

    if session.listed and signal_index >= session.n_signals:
        logger.warning(
            "[EDA] Preload rejeté: index %d hors limites (session %s, %d signaux)",
            signal_index, safe_id[:8], session.n_signals,
        )
        return jsonify({"error": "Signal introuvable"}), 404

    result = lazy_eda.preload_signal(safe_id, signal_index)
    return jsonify(result) if result else (jsonify({"error": "Signal introuvable"}), 404)


@eda_bp.route("/api/eda/view/<session_id>")
@login_required
def get_lazy_eda_view(session_id: str):
    """Récupère une vue downsamplée des signaux."""
    safe_id = sanitize_session_id(session_id)
    if not safe_id:
        return jsonify({"error": "ID invalide"}), 400

    session = lazy_eda.get_session(safe_id)
    if not session:
        return jsonify({"error": "Session introuvable"}), 404
    if session.user_id != g.current_user.id:
        return jsonify({"error": "Accès non autorisé"}), 403

    try:
        signal_indices = [int(x) for x in request.args.get("signals", "0").split(",") if x.strip()][:50]
        start = float(request.args.get("start", session.t_min))
        end = float(request.args.get("end", session.t_max))
        max_points = max(100, min(int(request.args.get("max_points", 2000)), 10000))
    except (ValueError, TypeError):
        return jsonify({"error": "Paramètres invalides"}), 400

    result = {"view": {"start": start, "end": end, "original_points": 0, "returned_points": 0}, "signals": []}

    for sig_idx in signal_indices:
        lazy_signal = lazy_eda.get_signal_data(safe_id, sig_idx)
        if not lazy_signal or not lazy_signal.is_loaded:
            continue

        mask = (lazy_signal.timestamps >= start) & (lazy_signal.timestamps <= end)
        view_ts, view_vals = lazy_signal.timestamps[mask], lazy_signal.values[mask]
        if len(view_ts) == 0:
            continue

        result["view"]["original_points"] += len(view_ts)
        if len(view_ts) > max_points:
            ds_ts, ds_vals = lttb_downsample(view_ts, view_vals, max_points)
        else:
            ds_ts, ds_vals = view_ts, view_vals
        result["view"]["returned_points"] += len(ds_ts)

        result["signals"].append({
            "index": sig_idx, "name": lazy_signal.metadata.name, "unit": lazy_signal.metadata.unit,
            "color": lazy_signal.metadata.color, "timestamps": ds_ts.tolist(), "values": ds_vals.tolist(),
            "is_complete": len(view_ts) <= max_points,
            "stats": {"min": float(np.min(view_vals)), "max": float(np.max(view_vals))}
        })

    return jsonify(result) if result["signals"] else (jsonify({"error": "No data"}), 404)


@eda_bp.route("/api/eda/session/<session_id>")
@login_required
def get_eda_session_info(session_id: str):
    """Récupère les informations sur une session EDA."""
    safe_id = sanitize_session_id(session_id)
    if not safe_id:
        return jsonify({"error": "ID invalide"}), 400

    session = lazy_eda.get_session(safe_id)
    if not session:
        return jsonify({"error": "Session introuvable"}), 404
    if session.user_id != g.current_user.id:
        return jsonify({"error": "Accès non autorisé"}), 403

    return jsonify({
        "session_id": session.session_id, "filename": session.filename, "listed": session.listed,
        "n_signals": session.n_signals, "loaded_signals": sum(1 for s in session.signals.values() if s.is_loaded),
        "time_range": {"min": session.t_min, "max": session.t_max}, "duration": session.t_max - session.t_min
    })


@eda_bp.route("/api/eda/session/<session_id>", methods=["DELETE"])
@login_required
def close_eda_session(session_id: str):
    """Ferme une session EDA."""
    safe_id = sanitize_session_id(session_id)
    if not safe_id:
        return jsonify({"error": "ID invalide"}), 400

    session = lazy_eda.get_session(safe_id)
    if not session:
        return jsonify({"error": "Session introuvable"}), 404
    if session.user_id != g.current_user.id:
        return jsonify({"error": "Accès non autorisé"}), 403

    lazy_eda.close_session(safe_id)
    return jsonify({"success": True})
