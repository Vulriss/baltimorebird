"""Baltimore Bird - API pour l'Exploratory Data Analysis (lazy loading)."""

import threading
import uuid
from pathlib import Path

import numpy as np
from flask import Blueprint, g, jsonify, request
from werkzeug.utils import secure_filename

from api.auth import get_client_ip, optional_auth, rate_limiter
from config import (
    ALLOWED_EXTENSIONS,
    ANON_EDA_DIR_NAME,
    ANON_UPLOAD_MAX_PER_WINDOW,
    ANONYMOUS_USER_ID,
    BASE_DIR,
    TEMP_DIR,
)
from core import allowed_file, sanitize_session_id
from core.downsampling import lttb_downsample
from data_management import lazy_eda
from data_management.event_comments import serialize_event_comments

import logging

logger = logging.getLogger(__name__)

eda_bp = Blueprint("eda", __name__)


def _resolve_session(session_id: str):
    """Résout une session et vérifie les droits d'accès.

    Retourne (session, None) si l'accès est autorisé, (None, réponse_erreur) sinon.
    Les sessions anonymes sont éphémères et identifiées par un UUID non devinable :
    la connaissance de cet UUID vaut autorisation (modèle capability).
    Les sessions d'utilisateurs authentifiés exigent le token du propriétaire.
    """
    safe_id = sanitize_session_id(session_id)
    if not safe_id:
        return None, (jsonify({"error": "ID invalide"}), 400)

    session = lazy_eda.get_session(safe_id)
    if not session:
        return None, (jsonify({"error": "Session introuvable"}), 404)

    if session.user_id == ANONYMOUS_USER_ID:
        return session, None

    user = getattr(g, "current_user", None)
    if not user:
        return None, (jsonify({"error": "Authentification requise"}), 401)
    if session.user_id != user.id:
        return None, (jsonify({"error": "Accès non autorisé"}), 403)

    return session, None


def _decode_blf_to_mf4(blf_path: Path, database_upload, dest_dir: Path, session_id: str):
    """Décode un log BLF en MF4 physique via une base de communication ARXML ou DBC.

    La base est obligatoire. Les fichiers intermédiaires (BLF source et base brute) sont supprimés
    après décodage : le MF4 décodé devient l'unique artefact de la session, consommable tel quel par
    la chaîne d'analyse lazy. Retourne (chemin_mf4, rapport_ingestion).
    """
    from services.blf_ingest import convert_blf_to_mf4

    db_suffix = Path(secure_filename(database_upload.filename) or "db.dbc").suffix.lower()
    db_path = dest_dir / f"{session_id}_db{db_suffix}"
    database_upload.save(db_path)

    mf4_path = dest_dir / f"{session_id}.mf4"
    try:
        report = convert_blf_to_mf4(blf_path, db_path, mf4_path, cache_dir=dest_dir / ".arxml_cache")
    finally:
        blf_path.unlink(missing_ok=True)
        db_path.unlink(missing_ok=True)
    return mf4_path, report


def _decode_mat_to_mf4(mat_path: Path, dest_dir: Path, session_id: str):
    """Convertit un fichier MATLAB .mat de simulation en MF4 physique.

    Aucune base externe n'est requise : les variables temporelles du .mat sont directement traduites
    en signaux. Le .mat source est supprimé après conversion. Retourne (chemin_mf4, rapport).
    """
    from services.mat_ingest import convert_mat_to_mf4

    mf4_path = dest_dir / f"{session_id}.mf4"
    try:
        report = convert_mat_to_mf4(mat_path, mf4_path)
    finally:
        mat_path.unlink(missing_ok=True)
    return mf4_path, report


def _background_list_signals(session_id: str) -> None:
    """Exécute le listing d'une session en tâche de fond, sans propager les erreurs.

    En cas d'échec ici, la session reste non listée et l'appel client /list-signals
    retentera le listing lui-même avec la gestion d'erreur habituelle de la route.
    """
    try:
        lazy_eda.list_signals(session_id)
    except Exception:
        logger.warning("[EDA] Listing en arrière-plan échoué pour %s", session_id[:8], exc_info=True)


@eda_bp.route("/api/eda/upload", methods=["POST"])
@optional_auth
def upload_eda_file():
    """Upload un fichier MF4 pour l'EDA interactif.

    Utilisateur authentifié : le fichier est conservé dans son espace personnel.
    Utilisateur anonyme : le fichier est temporaire (session éphémère, supprimé
    à l'expiration de la session), avec rate limiting par IP.
    """
    user = getattr(g, "current_user", None)

    if user is None:
        rate_key = f"eda-anon:{get_client_ip()}"
        locked, remaining = rate_limiter.is_locked(rate_key)
        if locked:
            return jsonify({"error": f"Trop d'uploads. Réessayez dans {remaining // 60} minutes."}), 429
        allowed, _ = rate_limiter.record_attempt(rate_key, max_attempts=ANON_UPLOAD_MAX_PER_WINDOW)
        if not allowed:
            return jsonify({"error": "Trop d'uploads. Réessayez plus tard."}), 429

    if "file" not in request.files:
        return jsonify({"error": "Aucun fichier fourni"}), 400

    file = request.files["file"]
    if not file.filename:
        return jsonify({"error": "Nom de fichier vide"}), 400

    if not allowed_file(file.filename, ALLOWED_EXTENSIONS):
        return jsonify({"error": "Extension non supportée"}), 400

    filename = secure_filename(file.filename)
    if not filename:
        return jsonify({"error": "Nom de fichier invalide"}), 400

    session_id = str(uuid.uuid4())
    ephemeral = user is None

    if ephemeral:
        dest_dir = TEMP_DIR / ANON_EDA_DIR_NAME
        dbc_dir = dest_dir
        owner_id = ANONYMOUS_USER_ID
    else:
        file_ext = Path(filename).suffix.lower()
        subdir = "mf4" if file_ext in (".mf4", ".blf", ".mat") else "dbc" if file_ext == ".dbc" else "other"
        dest_dir = BASE_DIR / "data" / "users" / user.id / subdir
        dbc_dir = BASE_DIR / "data" / "users" / user.id / "dbc"
        owner_id = user.id

    dest_dir.mkdir(parents=True, exist_ok=True)
    # Nom disque court (UUID + extension): le nom original, potentiellement tres
    # long, reste le nom d'affichage de la session. Evite de depasser la limite
    # MAX_PATH de Windows (260 caracteres) sur les chemins profonds.
    file_path = dest_dir / f"{session_id}{Path(filename).suffix.lower()}"
    file.save(file_path)

    suffix = Path(filename).suffix.lower()
    session_mf4_path = file_path
    dbc_path = None
    blf_report = None
    mat_report = None

    if suffix == ".blf":
        database_upload = (request.files.get("arxml") or request.files.get("database")
                           or request.files.get("dbc"))
        if not database_upload or not database_upload.filename:
            file_path.unlink(missing_ok=True)
            return jsonify({"error": "Une base ARXML ou DBC est requise pour décoder un BLF"}), 400
        db_suffix = Path(database_upload.filename).suffix.lower()
        if db_suffix not in (".dbc", ".arxml"):
            file_path.unlink(missing_ok=True)
            return jsonify({"error": f"Base de communication non supportée : {db_suffix or 'sans extension'}"}), 400
        try:
            session_mf4_path, blf_report = _decode_blf_to_mf4(
                file_path, database_upload, dest_dir, session_id)
        except Exception:
            logger.error("[EDA] Échec du décodage BLF", exc_info=True)
            session_mf4_path.unlink(missing_ok=True)
            return jsonify({"error": "Échec du décodage du BLF avec la base fournie"}), 400
        if blf_report.signal_count == 0:
            session_mf4_path.unlink(missing_ok=True)
            return jsonify({"error": "Aucun signal décodé : la base ne correspond pas au BLF"}), 400

    elif suffix == ".mat":
        try:
            session_mf4_path, mat_report = _decode_mat_to_mf4(file_path, dest_dir, session_id)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        except Exception:
            logger.error("[EDA] Échec de la conversion .mat", exc_info=True)
            session_mf4_path.unlink(missing_ok=True)
            return jsonify({"error": "Échec de la lecture du fichier .mat"}), 400

    if suffix not in (".blf", ".mat") and "dbc" in request.files:
        dbc_file = request.files["dbc"]
        if dbc_file.filename and dbc_file.filename.lower().endswith(".dbc"):
            if secure_filename(dbc_file.filename):
                dbc_dir.mkdir(parents=True, exist_ok=True)
                dbc_path = dbc_dir / f"{uuid.uuid4()}.dbc"
                dbc_file.save(dbc_path)

    if suffix not in (".blf", ".mat") and not dbc_path and not ephemeral:
        user_dbc_dir = BASE_DIR / "data" / "users" / user.id / "dbc"
        if user_dbc_dir.exists():
            dbc_files = list(user_dbc_dir.glob("*.dbc"))
            if dbc_files:
                dbc_path = dbc_files[0]

    lazy_eda.create_session(
        session_id=session_id, user_id=owner_id,
        mf4_path=session_mf4_path, dbc_path=dbc_path, ephemeral=ephemeral,
    )

    # Listing lance en tache de fond des maintenant: le parsing MF4 (et le decodage DBC
    # eventuel) recouvre le retour de la reponse d'upload et l'aller-retour reseau du
    # client. list_signals est idempotent sous verrou de session: l'appel client
    # /list-signals qui suit attend la fin du meme travail ou le trouve deja fait.
    threading.Thread(
        target=_background_list_signals, args=(session_id,), daemon=True, name=f"eda-list-{session_id[:8]}",
    ).start()

    if ephemeral:
        logger.info("[EDA] Anonymous ephemeral session %s created (%s)", session_id[:8], filename)

    response = {
        "success": True,
        "session_id": session_id,
        "filename": filename,
        "ephemeral": ephemeral,
    }
    if blf_report is not None:
        response["blf"] = {
            "decoded_frames": blf_report.decoded_frames,
            "total_frames": blf_report.total_frames,
            "decoded_ratio": round(blf_report.decoded_ratio, 3),
            "signal_count": blf_report.signal_count,
            "unknown_frame_ids": len(blf_report.unknown_ids),
            "dropped_secured_pdus": blf_report.dropped_secured_pdus,
        }
    if mat_report is not None:
        response["mat"] = {
            "signal_count": mat_report.signal_count,
            "time_series_signals": mat_report.time_series_signals,
            "constant_signals": mat_report.constant_signals,
            "skipped_variables": len(mat_report.skipped_variables),
            "time_variable": mat_report.time_variable,
        }
    return jsonify(response)


@eda_bp.route("/api/eda/list-signals/<session_id>")
@optional_auth
def list_eda_signals(session_id: str):
    """Liste tous les signaux d'un fichier MF4."""
    session, error = _resolve_session(session_id)
    if error:
        return error
    safe_id = session.session_id

    result = lazy_eda.list_signals(safe_id)
    return jsonify(result) if result else (jsonify({"error": "Erreur listing"}), 500)


@eda_bp.route("/api/eda/events")
@optional_auth
def get_eda_events():
    """Points de commentaire INCA (Ctrl+K) d'une session, pour le strip commentaires.

    Le listing des signaux doit avoir eu lieu (l'extraction s'y fait); on le declenche au
    besoin, de facon idempotente. Reponse: {"events": [{t, text, date, time}, ...]}.
    """
    session, error = _resolve_session(request.args.get("session_id", ""))
    if error:
        return error
    if not session.listed:
        lazy_eda.list_signals(session.session_id)
    return jsonify({"events": serialize_event_comments(session.event_comments)})


@eda_bp.route("/api/eda/preload-signal/<session_id>/<int:signal_index>", methods=["POST"])
@optional_auth
def preload_eda_signal(session_id: str, signal_index: int):
    """Précharge les données d'un signal."""
    if signal_index < 0:
        return jsonify({"error": "Paramètres invalides"}), 400

    session, error = _resolve_session(session_id)
    if error:
        return error
    safe_id = session.session_id

    if session.listed and signal_index >= session.n_signals:
        logger.warning(
            "[EDA] Preload rejeté: index %d hors limites (session %s, %d signaux)",
            signal_index, safe_id[:8], session.n_signals,
        )
        return jsonify({"error": "Signal introuvable"}), 404

    result = lazy_eda.preload_signal(safe_id, signal_index)
    return jsonify(result) if result else (jsonify({"error": "Signal introuvable"}), 404)


@eda_bp.route("/api/eda/view/<session_id>")
@optional_auth
def get_lazy_eda_view(session_id: str):
    """Récupère une vue downsamplée des signaux."""
    session, error = _resolve_session(session_id)
    if error:
        return error
    safe_id = session.session_id

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

        ts, vs = lazy_signal.timestamps, lazy_signal.values
        # Timestamps monotones: bornage O(log n) au lieu d'un masque O(n).
        i0 = int(np.searchsorted(ts, start, side="left"))
        i1 = int(np.searchsorted(ts, end, side="right"))
        view_ts, view_vals = ts[i0:i1], vs[i0:i1]
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
@optional_auth
def get_eda_session_info(session_id: str):
    """Récupère les informations sur une session EDA."""
    session, error = _resolve_session(session_id)
    if error:
        return error

    return jsonify({
        "session_id": session.session_id, "filename": session.filename, "listed": session.listed,
        "n_signals": session.n_signals, "loaded_signals": sum(1 for s in session.signals.values() if s.is_loaded),
        "time_range": {"min": session.t_min, "max": session.t_max}, "duration": session.t_max - session.t_min
    })


@eda_bp.route("/api/eda/session/<session_id>", methods=["DELETE"])
@optional_auth
def close_eda_session(session_id: str):
    """Ferme une session EDA."""
    session, error = _resolve_session(session_id)
    if error:
        return error
    safe_id = session.session_id

    lazy_eda.close_session(safe_id)
    return jsonify({"success": True})


@eda_bp.route("/api/eda/zone-stats/<session_id>", methods=["POST"])
@optional_auth
def eda_zone_stats(session_id: str):
    """Statistiques par zone booleenne.

    Une voie booleenne (bool_index) decoupe le temps en zones HIGH (> 0.5, meme
    regle que le front). Pour chaque zone, on calcule les stats (min/max/moyenne/
    n echantillons) des voies cibles (target_indices) sur LEURS propres
    echantillons dans la zone - les rasters peuvent differer, aucun alignement
    n'est necessaire pour des agregats.

    Deux modes:
    - "at": t donne -> uniquement la zone contenant t, non tronquee (tooltip).
      Cache tres efficace cote front: les stats d'une zone ne dependent pas de
      la fenetre de visualisation.
    - fenetre [t0, t1] -> zones intersectant la fenetre, TRONQUEES a celle-ci
      (semantique "fenetre visible"), plus l'agregat exact sur toutes ces zones.
      La liste par zone est plafonnee (bool bavard = milliers de zones) mais
      l'agregat reste calcule sur l'integralite.
    """
    import numpy as np

    session, error = _resolve_session(session_id)
    if error:
        return error
    safe_id = session.session_id

    data = request.get_json(silent=True) or {}
    bool_index = data.get("bool_index")
    target_indices = data.get("target_indices") or []
    if not isinstance(bool_index, int) or bool_index < 0:
        return jsonify({"error": "bool_index invalide"}), 400
    if not isinstance(target_indices, list) or len(target_indices) > 16 \
            or any((not isinstance(i, int)) or i < 0 for i in target_indices):
        return jsonify({"error": "target_indices invalide (max 16)"}), 400

    # Chargement (batch: une seule passe sous le verrou de session)
    needed = [bool_index] + [i for i in target_indices if i != bool_index]
    lazy_eda.preload_signals(safe_id, needed)

    bool_sig = lazy_eda.get_signal_data(safe_id, bool_index)
    if not bool_sig or not bool_sig.is_loaded:
        logger.warning("[zone-stats] bool %d non chargeable (session %s, present=%s)",
                       bool_index, safe_id[:8], bool_sig is not None)
        return jsonify({"error": "Voie booleenne non chargeable"}), 404
    logger.info("[zone-stats] session %s bool=%d cibles=%s mode=%s",
                safe_id[:8], bool_index, target_indices,
                "at" if data.get("at") is not None else "fenetre")
    bts = np.asarray(bool_sig.timestamps, dtype=np.float64)
    bvs = np.asarray(bool_sig.values, dtype=np.float64)
    if bts.size == 0:
        return jsonify({"zones": [], "aggregate": None})

    # Zones HIGH: transitions du seuil 0.5 (portage exact de extractBoolHighRanges)
    high = bvs > 0.5
    starts = np.flatnonzero(high & ~np.roll(high, 1))
    ends = np.flatnonzero(~high & np.roll(high, 1))
    if high.size and high[0]:
        starts = np.concatenate(([0], starts[starts != 0]))
    ranges = []
    ei = 0
    for s in starts:
        while ei < len(ends) and ends[ei] <= s:
            ei += 1
        e = ends[ei] if ei < len(ends) else None
        ranges.append((float(bts[s]), float(bts[e]) if e is not None else float(bts[-1])))

    targets = {}
    for idx in target_indices:
        sig = lazy_eda.get_signal_data(safe_id, idx)
        if sig and sig.is_loaded:
            targets[idx] = (
                np.asarray(sig.timestamps, dtype=np.float64),
                np.asarray(sig.values, dtype=np.float64),
            )

    def zone_stats(z0: float, z1: float):
        out = {}
        for idx, (ts, vs) in targets.items():
            a = int(np.searchsorted(ts, z0, side="left"))
            b = int(np.searchsorted(ts, z1, side="right"))
            if b <= a:
                out[str(idx)] = None
                continue
            seg = vs[a:b]
            out[str(idx)] = {
                "min": float(np.min(seg)), "max": float(np.max(seg)),
                "mean": float(np.mean(seg)), "count": int(b - a),
            }
        return out

    # --- Mode "at": la zone contenant t, entiere ---
    if data.get("at") is not None:
        t = float(data["at"])
        for k, (z0, z1) in enumerate(ranges):
            if z0 <= t <= z1:
                return jsonify({
                    "zone": {"start": z0, "end": z1, "duration": z1 - z0,
                             "index": k, "total_zones": len(ranges),
                             "stats": zone_stats(z0, z1)},
                })
        return jsonify({"zone": None, "total_zones": len(ranges)})

    # --- Mode fenetre: zones tronquees a [t0, t1] + agregat exact ---
    t0 = float(data["t0"]) if data.get("t0") is not None else float(bts[0])
    t1 = float(data["t1"]) if data.get("t1") is not None else float(bts[-1])
    if t1 <= t0:
        return jsonify({"error": "Fenetre invalide"}), 400

    MAX_ZONES = 400
    zones_out = []
    total_duration = 0.0
    agg = {str(i): {"min": None, "max": None, "sum": 0.0, "count": 0} for i in targets}
    n_zones = 0
    for (z0, z1) in ranges:
        c0, c1 = max(z0, t0), min(z1, t1)
        if c1 <= c0:
            continue
        n_zones += 1
        total_duration += c1 - c0
        st = zone_stats(c0, c1)
        for k, s in st.items():
            if s is None:
                continue
            a = agg[k]
            a["min"] = s["min"] if a["min"] is None else min(a["min"], s["min"])
            a["max"] = s["max"] if a["max"] is None else max(a["max"], s["max"])
            a["sum"] += s["mean"] * s["count"]
            a["count"] += s["count"]
        if len(zones_out) < MAX_ZONES:
            zones_out.append({
                "start": c0, "end": c1, "duration": c1 - c0,
                "partial": bool(c0 > z0 or c1 < z1),
                "stats": st,
            })

    agg_stats = {}
    for k, a in agg.items():
        agg_stats[k] = None if a["count"] == 0 else {
            "min": a["min"], "max": a["max"],
            "mean": a["sum"] / a["count"], "count": a["count"],
        }

    return jsonify({
        "zones": zones_out,
        "zones_truncated": n_zones > len(zones_out),
        "aggregate": {
            "count": n_zones,
            "total_duration": total_duration,
            "coverage": total_duration / (t1 - t0),
            "stats": agg_stats,
        },
        "window": [t0, t1],
    })
