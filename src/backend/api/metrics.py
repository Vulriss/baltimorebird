"""Baltimore Bird - API des metriques d'utilisation."""

import re
import time
from typing import Optional, Tuple

from flask import Blueprint, Response, jsonify, request

from api.auth import admin_required
from services.metrics import metrics

metrics_api_bp = Blueprint("metrics_api", __name__)

_EVENT_NAME_RE = re.compile(r"^[a-z][a-z0-9_]{1,39}$")
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


@metrics_api_bp.route("/api/metrics/current")
@admin_required
def get_current_metrics() -> Response:
    """Metriques temps reel (admin)."""
    return jsonify(metrics.get_current_stats())


@metrics_api_bp.route("/api/metrics/daily")
@metrics_api_bp.route("/api/metrics/daily/<date_str>")
@admin_required
def get_daily_metrics(date_str: Optional[str] = None) -> Response | Tuple[Response, int]:
    """Metriques d'un jour donne, ou du jour courant si non precise (admin)."""
    if date_str and not _DATE_RE.match(date_str):
        return jsonify({"error": "Format de date invalide (YYYY-MM-DD)"}), 400
    return jsonify(metrics.get_daily_report(date_str))


@metrics_api_bp.route("/api/metrics/weekly")
@admin_required
def get_weekly_metrics() -> Response:
    """Resume hebdomadaire (admin)."""
    return jsonify(metrics.get_weekly_summary())


@metrics_api_bp.route("/api/metrics/health")
def health_check() -> Response:
    """Health check public pour la supervision."""
    return jsonify({"status": "healthy", "timestamp": time.time()})


@metrics_api_bp.route("/api/metrics/event", methods=["POST"])
def record_usage_event() -> Tuple[Response, int]:
    """Enregistre un evenement d'usage anonyme (public, emis aussi par les invites)."""
    payload = request.get_json(silent=True) or {}
    event = payload.get("event")
    if not isinstance(event, str) or not _EVENT_NAME_RE.match(event):
        return jsonify({"error": "Nom d'evenement invalide"}), 400

    metrics.record_event(event)
    return jsonify({"success": True}), 202
