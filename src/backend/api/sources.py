"""Baltimore Bird - API des sources de données et visualisation."""

import json
import struct

import numpy as np
from flask import Blueprint, Response, g, jsonify, request

from api.auth import optional_auth
from config import BASE_DIR, DATA_SOURCES
from core import is_safe_path
from data_management import datastore, lazy_eda

sources_bp = Blueprint("sources", __name__)


@sources_bp.route("/api/sources")
@optional_auth
def get_sources():
    """Liste toutes les sources disponibles, incluant les fichiers utilisateur."""
    from services.storage import storage

    sources = datastore.get_available_sources()

    user = getattr(g, "current_user", None)
    if user:
        user_files = storage.list_files(user.id, category="mf4", include_default=False)
        user_dbc_dir = BASE_DIR / "data" / "users" / user.id / "dbc"
        has_dbc = user_dbc_dir.exists() and any(user_dbc_dir.glob("*.dbc"))

        for f in user_files:
            file_path = storage.get_file_path(f.id, user.id)
            if file_path and file_path.exists():
                source_id = f"user_mf4_{file_path.stem}"
                sources.append({
                    "id": source_id,
                    "name": f.original_name,
                    "description": f.description or "Fichier personnel",
                    "available": True,
                    "category": "user",
                    "file_id": f.id,
                    "has_dbc": has_dbc,
                    "size_human": f.to_dict()["size_human"],
                })

    return jsonify({"sources": sources, "current": datastore.current_source})


@sources_bp.route("/api/source/<source_id>", methods=["POST"])
@optional_auth
def set_source(source_id: str):
    """Change la source de données active - utilise lazy loading pour les fichiers utilisateur."""
    try:
        if source_id.startswith("user_mf4_"):
            user = getattr(g, "current_user", None)
            if not user:
                return jsonify({"error": "Authentification requise"}), 401

            user_id = user.id
            file_stem = source_id.replace("user_mf4_", "")

            if not all(c.isalnum() or c in "-_" for c in file_stem):
                return jsonify({"error": "ID de fichier invalide"}), 400

            user_mf4_dir = BASE_DIR / "data" / "users" / user_id / "mf4"

            mf4_path = None
            for f in user_mf4_dir.glob("*.mf4"):
                if f.stem == file_stem:
                    mf4_path = f
                    break

            if not mf4_path or not mf4_path.exists():
                return jsonify({"error": "Fichier introuvable"}), 404

            if not is_safe_path(user_mf4_dir, mf4_path):
                return jsonify({"error": "Accès non autorisé"}), 403

            dbc_path = None
            user_dbc_dir = BASE_DIR / "data" / "users" / user_id / "dbc"
            if user_dbc_dir.exists():
                dbc_files = list(user_dbc_dir.glob("*.dbc"))
                if dbc_files:
                    dbc_path = dbc_files[0]

            session_id = file_stem

            session = lazy_eda.get_session(session_id)
            if not session:
                session = lazy_eda.create_session(
                    session_id=session_id,
                    user_id=user_id,
                    mf4_path=mf4_path,
                    dbc_path=dbc_path
                )

            result = lazy_eda.list_signals(session_id)

            if not result:
                return jsonify({"error": "Erreur lors du listing des signaux"}), 500

            return jsonify({
                "success": True,
                "source": source_id,
                "session_id": session_id,
                "lazy": True,
                "n_signals": result["n_signals"],
                "time_range": result["time_range"],
                "duration": result["duration"],
                "signals": result["signals"]
            })

        else:
            if source_id not in DATA_SOURCES and not source_id.startswith("session_"):
                return jsonify({"error": "Source inconnue"}), 404
            datastore.reload(source_id)

            return jsonify({
                "success": True,
                "source": source_id,
                "lazy": False,
                "n_signals": len(datastore.signals),
                "time_range": {"min": datastore.t_min, "max": datastore.t_max},
            })

    except FileNotFoundError:
        return jsonify({"error": "Fichier introuvable"}), 404
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception:
        return jsonify({"error": "Erreur lors du chargement de la source"}), 500


@sources_bp.route("/api/info")
def get_info():
    """Récupère les informations sur les données actuelles."""
    try:
        datastore.load()
    except Exception:
        return jsonify({"error": "Erreur de chargement des données"}), 500

    signals_list = []
    for i, m in enumerate(datastore.metadata):
        signal_info = {
            "index": i,
            "name": m["name"],
            "unit": m["unit"],
            "color": m["color"]
        }
        if m.get("computed"):
            signal_info["computed"] = True
            signal_info["formula"] = m.get("formula", "")
            signal_info["description"] = m.get("description", "")
            signal_info["source_signals"] = m.get("source_signals", [])

        signals_list.append(signal_info)

    return jsonify({
        "source": datastore.current_source,
        "n_signals": len(datastore.signals),
        "duration": datastore.t_max - datastore.t_min,
        "time_range": {"min": datastore.t_min, "max": datastore.t_max},
        "signals": signals_list,
    })


@sources_bp.route("/api/view")
@optional_auth
def get_view():
    """Récupère une vue downsamplée des signaux (lazy EDA avec contrôle d'accès, ou datastore démo)."""
    session_id = request.args.get("session_id")

    if session_id:
        from api.eda import _resolve_session

        session, error = _resolve_session(session_id)
        if error:
            return error

        return _get_lazy_view(session.session_id)

    try:
        datastore.load()
    except Exception:
        return jsonify({"error": "Erreur de chargement des données"}), 500

    if not datastore.loaded or not datastore.signals:
        return jsonify({"error": "Aucune donnée chargée"}), 404

    signals_param = request.args.get("signals", "0")
    try:
        if signals_param == "all":
            signal_indices = list(range(len(datastore.signals)))
        else:
            signal_indices = [int(x) for x in signals_param.split(",") if x.strip()]
            if len(signal_indices) > 50:
                signal_indices = signal_indices[:50]
    except ValueError:
        return jsonify({"error": "Paramètre signals invalide"}), 400

    try:
        start = float(request.args.get("start", datastore.t_min))
        end = float(request.args.get("end", datastore.t_max))
    except (ValueError, TypeError):
        return jsonify({"error": "Paramètres start/end invalides"}), 400

    try:
        max_points = int(request.args.get("max_points", 2000))
        max_points = max(100, min(max_points, 10000))
    except (ValueError, TypeError):
        max_points = 2000

    result = datastore.get_view(signal_indices, start, end, max_points)
    return jsonify(result) if result else (jsonify({"error": "No data in range"}), 404)


def _get_lazy_view(session_id: str):
    """Vue pour les sessions lazy EDA."""
    signals_param = request.args.get("signals", "0")
    try:
        if signals_param == "all":
            session = lazy_eda.get_session(session_id)
            n_signals = session.n_signals if session else 0
            signal_indices = list(range(min(n_signals, 50)))
        else:
            signal_indices = [int(x) for x in signals_param.split(",") if x.strip()]
            if len(signal_indices) > 50:
                signal_indices = signal_indices[:50]
    except ValueError:
        return jsonify({"error": "Paramètre signals invalide"}), 400

    try:
        start = float(request.args.get("start", 0))
        end = float(request.args.get("end", 0))
    except (ValueError, TypeError):
        return jsonify({"error": "Paramètres start/end invalides"}), 400

    try:
        max_points = int(request.args.get("max_points", 2000))
        max_points = max(100, min(max_points, 10000))
    except (ValueError, TypeError):
        max_points = 2000

    result = lazy_eda.get_view(session_id, signal_indices, start, end, max_points)
    return jsonify(result) if result else (jsonify({"error": "No data in range"}), 404)


@sources_bp.route("/api/raw")
@optional_auth
def get_raw():
    """Renvoie les signaux demandés en pleine résolution, encodés en binaire.

    Destiné au rendu et au panning entièrement côté client : une fois ces données rapatriées, le
    zoom/pan ne nécessite plus aucun aller-retour serveur. Réservé aux sessions lazy EDA.
    """
    session_id = request.args.get("session_id")
    if not session_id:
        return jsonify({"error": "session_id requis"}), 400

    from api.eda import _resolve_session

    session, error = _resolve_session(session_id)
    if error:
        return error
    return _get_lazy_raw(session.session_id)


def _get_lazy_raw(session_id: str):
    """Encode en binaire les signaux pleine résolution d'une session lazy.

    Format : [uint32 little-endian = longueur d'entête][entête JSON UTF-8][blocs binaires]. L'entête
    décrit chaque signal et le nombre d'échantillons ; les blocs suivent dans le même ordre, chacun
    composé des horodatages (float64) puis des valeurs (float32).
    """
    try:
        indices = [int(x) for x in request.args.get("signals", "").split(",") if x.strip()][:50]
    except ValueError:
        return jsonify({"error": "Paramètre signals invalide"}), 400
    if not indices:
        return jsonify({"error": "Aucun signal demandé"}), 400

    header_signals = []
    chunks: list[bytes] = []
    for index in indices:
        signal = lazy_eda.get_signal_data(session_id, index)
        if not signal or not signal.is_loaded:
            continue
        timestamps = np.ascontiguousarray(signal.timestamps, dtype="<f8")
        values = np.ascontiguousarray(signal.values, dtype="<f4")
        meta = signal.metadata
        header_signals.append({
            "index": index,
            "name": meta.name,
            "unit": meta.unit,
            "color": meta.color,
            "n": int(timestamps.size),
            "is_categorical": signal.string_map is not None,
            "string_map": signal.string_map or None,
        })
        chunks.append(timestamps.tobytes())
        chunks.append(values.tobytes())

    if not header_signals:
        return jsonify({"error": "No data"}), 404

    header = json.dumps({"signals": header_signals}, ensure_ascii=False).encode("utf-8")
    body = b"".join([struct.pack("<I", len(header)), header, *chunks])
    return Response(body, mimetype="application/octet-stream")


@sources_bp.route("/health")
def health():
    """Endpoint de health check."""
    return jsonify({
        "status": "ok",
        "source": datastore.current_source,
        "loaded": datastore.loaded,
        "n_signals": len(datastore.signals) if datastore.loaded else 0,
    })
