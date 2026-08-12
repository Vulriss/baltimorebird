"""Baltimore Bird - Endpoints systeme.

Banniere d'annonce temporaire: lue depuis un fichier JSON editable par ops (pas de
redeploiement). Absent ou "active": false => aucune banniere. Une fenetre temporelle
optionnelle (starts_at / ends_at, ISO 8601 UTC) borne l'affichage.

Schema du fichier banner.json:
    {
      "id": "maint-2026-07-01",
      "active": true,
      "severity": "warning",            # info | warning | critical
      "message": "Mise a jour prevue ce soir a 18h UTC. Service momentanement indisponible.",
      "dismissible": true,
      "starts_at": null,                 # optionnel, ISO 8601 UTC
      "ends_at": "2026-07-01T18:30:00Z"  # optionnel, ISO 8601 UTC
    }
"""

import json
import os
import tempfile
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from flask import Blueprint, jsonify, request

from api.auth import admin_required
from config import BANNER_CONFIG_PATH

system_bp = Blueprint("system", __name__)

_SEVERITIES = {"info", "warning", "critical"}
_MAX_MESSAGE_LEN = 500


def _parse_iso(value: Optional[str]) -> Optional[datetime]:
    """Parse une date ISO 8601 (UTC par defaut si naive). Renvoie None si invalide."""
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _load_banner() -> Optional[Dict[str, Any]]:
    """Charge et valide la banniere active, ou None."""
    path = BANNER_CONFIG_PATH
    if not path.exists():
        return None
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return None

    if not isinstance(data, dict) or not data.get("active"):
        return None

    now = datetime.now(timezone.utc)
    starts = _parse_iso(data.get("starts_at"))
    ends = _parse_iso(data.get("ends_at"))
    if starts and now < starts:
        return None
    if ends and now > ends:
        return None

    message = str(data.get("message", "")).strip()[:_MAX_MESSAGE_LEN]
    if not message:
        return None

    severity = data.get("severity", "info")
    if severity not in _SEVERITIES:
        severity = "info"

    return {
        "id": str(data.get("id", "banner")),
        "message": message,
        "severity": severity,
        "dismissible": bool(data.get("dismissible", True)),
        "ends_at": data.get("ends_at"),
    }


@system_bp.route("/api/banner", methods=["GET"])
def get_banner():
    """Renvoie la banniere active ({banner: null} si aucune)."""
    return jsonify({"banner": _load_banner()})


def _load_raw_banner() -> Dict[str, Any]:
    """Charge le fichier brut (tous les champs, sans filtrage temporel/actif).
    Sert l'admin: il doit voir/editer la config complete, pas seulement ce qui
    est affiche actuellement. Renvoie un squelette par defaut si absent/illisible.
    """
    default = {
        "id": "",
        "active": False,
        "severity": "info",
        "message": "",
        "dismissible": True,
        "starts_at": None,
        "ends_at": None,
    }
    if not BANNER_CONFIG_PATH.exists():
        return default
    try:
        with open(BANNER_CONFIG_PATH, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return default
    if not isinstance(data, dict):
        return default
    # Complete les champs manquants avec les valeurs par defaut
    return {**default, **{k: data.get(k, default[k]) for k in default}}


def _validate_banner_payload(data: Dict[str, Any]) -> tuple[Optional[Dict[str, Any]], Optional[str]]:
    """Valide et normalise une config de banniere recue de l'admin.
    Retourne (config_propre, None) ou (None, message_erreur)."""
    if not isinstance(data, dict):
        return None, "Corps de requete invalide"

    message = str(data.get("message", "")).strip()
    active = bool(data.get("active"))
    # Un message vide est tolere seulement si la banniere est desactivee.
    if active and not message:
        return None, "Le message est requis pour activer la banniere"
    if len(message) > _MAX_MESSAGE_LEN:
        return None, f"Message trop long (max {_MAX_MESSAGE_LEN} caracteres)"

    severity = data.get("severity", "info")
    if severity not in _SEVERITIES:
        return None, f"Severite invalide (attendu: {', '.join(sorted(_SEVERITIES))})"

    # Validation des dates optionnelles: doivent etre ISO 8601 si fournies.
    for field in ("starts_at", "ends_at"):
        val = data.get(field)
        if val not in (None, "") and _parse_iso(val) is None:
            return None, f"Date {field} invalide (format ISO 8601 attendu)"

    starts = _parse_iso(data.get("starts_at"))
    ends = _parse_iso(data.get("ends_at"))
    if starts and ends and ends <= starts:
        return None, "La date de fin doit etre posterieure a la date de debut"

    # id: genere si absent, pour que le rejet cote client (par id) fonctionne.
    # Change automatiquement si le message change et qu'aucun id explicite n'est
    # donne, afin qu'une nouvelle annonce reapparaisse meme apres un rejet.
    banner_id = str(data.get("id", "")).strip()
    if not banner_id:
        banner_id = "banner-" + datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")

    return {
        "id": banner_id,
        "active": active,
        "severity": severity,
        "message": message,
        "dismissible": bool(data.get("dismissible", True)),
        "starts_at": data.get("starts_at") or None,
        "ends_at": data.get("ends_at") or None,
    }, None


def _write_banner_atomic(config: Dict[str, Any]) -> None:
    """Ecrit banner.json de facon atomique (fichier temporaire + rename) pour
    qu'une lecture concurrente ne voie jamais un JSON partiel."""
    BANNER_CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(
        dir=str(BANNER_CONFIG_PATH.parent), prefix=".banner-", suffix=".tmp"
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(config, fh, ensure_ascii=False, indent=2)
        os.replace(tmp_path, BANNER_CONFIG_PATH)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


@system_bp.route("/api/admin/banner", methods=["GET"])
@admin_required
def admin_get_banner():
    """Config complete de la banniere pour l'admin (tous les champs bruts)."""
    return jsonify({"banner": _load_raw_banner()})


@system_bp.route("/api/admin/banner", methods=["PUT"])
@admin_required
def admin_put_banner():
    """Ecrit la config de la banniere (admin)."""
    payload = request.get_json(silent=True)
    config, error = _validate_banner_payload(payload or {})
    if error:
        return jsonify({"error": error}), 400
    try:
        _write_banner_atomic(config)
    except OSError:
        return jsonify({"error": "Ecriture impossible sur le serveur"}), 500
    return jsonify({"banner": config, "success": True})
