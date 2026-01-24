"""Baltimore Bird - API des métriques d'utilisation."""

import re
import time

from flask import Blueprint, jsonify

from services.metrics import metrics

metrics_api_bp = Blueprint("metrics_api", __name__)


@metrics_api_bp.route("/api/metrics/current")
def get_current_metrics():
    """Récupère les métriques temps réel."""
    return jsonify(metrics.get_current_stats())


@metrics_api_bp.route("/api/metrics/daily")
@metrics_api_bp.route("/api/metrics/daily/<date_str>")
def get_daily_metrics(date_str: str = None):
    """Récupère les métriques d'un jour spécifique."""
    if date_str:
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", date_str):
            return jsonify({"error": "Format de date invalide (YYYY-MM-DD)"}), 400
    return jsonify(metrics.get_daily_report(date_str))


@metrics_api_bp.route("/api/metrics/weekly")
def get_weekly_metrics():
    """Récupère le résumé hebdomadaire."""
    return jsonify(metrics.get_weekly_summary())


@metrics_api_bp.route("/api/metrics/health")
def health_check():
    """Endpoint de health check simple."""
    return jsonify({"status": "healthy", "timestamp": time.time()})
