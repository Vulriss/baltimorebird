"""
Baltimore Bird - Application principale.

Point d'entrée de l'application Flask.
"""

import logging
import threading
import time
from pathlib import Path

from flask import Flask, jsonify
from flask_cors import CORS

from config import (
    ALLOWED_ORIGINS,
    ANON_EDA_DIR_NAME,
    LAZY_EDA_SESSION_TIMEOUT,
    MAX_CONTENT_LENGTH,
    TEMP_DIR,
)
from middleware import register_metrics_middleware, register_security_middleware
from api import register_blueprints
from data_management import datastore, lazy_eda, purge_orphan_files
from services import conversion_manager, concatenation_manager, get_supported_conversions


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)

logger = logging.getLogger(__name__)

MAINTENANCE_INTERVAL_SECONDS = 600

_maintenance_started = False
_maintenance_lock = threading.Lock()


def create_app() -> Flask:
    """Factory function pour créer l'application Flask."""
    app = Flask(__name__)
    app.config["MAX_CONTENT_LENGTH"] = MAX_CONTENT_LENGTH

    CORS(app, origins=ALLOWED_ORIGINS, supports_credentials=True)

    register_security_middleware(app)
    register_metrics_middleware(app)
    register_blueprints(app)
    register_error_handlers(app)

    start_maintenance()

    return app


def register_error_handlers(app: Flask) -> None:
    """Enregistre les gestionnaires d'erreurs HTTP."""

    @app.errorhandler(400)
    def bad_request(e):
        return jsonify({"error": "Requête invalide"}), 400

    @app.errorhandler(401)
    def unauthorized(e):
        return jsonify({"error": "Authentification requise"}), 401

    @app.errorhandler(403)
    def forbidden(e):
        return jsonify({"error": "Accès interdit"}), 403

    @app.errorhandler(404)
    def not_found(e):
        return jsonify({"error": "Ressource introuvable"}), 404

    @app.errorhandler(413)
    def request_entity_too_large(e):
        return jsonify({"error": "Fichier trop volumineux (max 1500 MB)"}), 413

    @app.errorhandler(500)
    def internal_error(e):
        app.logger.error(f"Internal error: {e}")
        return jsonify({"error": "Erreur interne du serveur"}), 500


def _anon_eda_dir() -> Path:
    """Répertoire des fichiers uploadés par les sessions EDA anonymes (éphémères)."""
    return TEMP_DIR / ANON_EDA_DIR_NAME


def run_maintenance_cycle() -> None:
    """Exécute un cycle de maintenance complet.

    Couvre les tâches de conversion/concaténation, l'éviction des sessions EDA expirées (avec
    suppression de leurs fichiers éphémères) et le balayage des fichiers orphelins laissés sur
    disque par un processus arrêté ou redémarré.
    """
    try:
        deleted_conv = conversion_manager.cleanup_old_tasks(max_age_hours=1)
        deleted_concat = concatenation_manager.cleanup_old_tasks(max_age_hours=1)
        evicted_sessions = lazy_eda.cleanup_expired()
        lazy_eda.refresh_ephemeral_file_mtimes()
        orphan_files = purge_orphan_files(
            _anon_eda_dir(),
            max_age_seconds=LAZY_EDA_SESSION_TIMEOUT,
            protected=lazy_eda.active_file_paths(),
        )
        if any((deleted_conv, deleted_concat, evicted_sessions, orphan_files)):
            logger.info(
                "Maintenance: %d conversion(s), %d concaténation(s), %d session(s) EDA, %d orphelin(s)",
                deleted_conv, deleted_concat, evicted_sessions, orphan_files,
            )
    except Exception:
        logger.error("Erreur durant le cycle de maintenance", exc_info=True)


def start_maintenance() -> None:
    """Démarre le thread de maintenance périodique (idempotent par processus).

    Appelé depuis ``create_app`` afin de fonctionner aussi sous gunicorn, où le bloc ``__main__``
    n'est jamais exécuté. Un balayage initial est lancé immédiatement pour purger les fichiers
    éphémères orphelins subsistant après un redémarrage.
    """
    global _maintenance_started
    with _maintenance_lock:
        if _maintenance_started:
            return
        _maintenance_started = True

    run_maintenance_cycle()

    def maintenance_loop() -> None:
        while True:
            time.sleep(MAINTENANCE_INTERVAL_SECONDS)
            run_maintenance_cycle()

    thread = threading.Thread(target=maintenance_loop, daemon=True, name="bb-maintenance")
    thread.start()


app = create_app()


if __name__ == "__main__":
    print("=" * 60)
    print("  BALTIMORE BIRD - Automotive Time Series Viewer")
    print("=" * 60)
    print(f"\n  TEMP directory: {TEMP_DIR}")
    print(f"  CORS origins: {ALLOWED_ORIGINS}")
    print("\n  Available data sources:")
    for src in datastore.get_available_sources():
        status = "+" if src["available"] else "-"
        print(f"    {status} {src['id']:12s} - {src['name']}")
    print("\n  Supported conversions:")
    for input_fmt, output_fmts in get_supported_conversions().items():
        print(f"    .{input_fmt} -> {', '.join('.' + f for f in output_fmts)}")
    print()

    try:
        datastore.load()
    except Exception as e:
        print(f"  Warning: {e}")

    print("\n  http://localhost:5000")
    print("=" * 60)
    app.run(debug=False, port=5000, host="0.0.0.0", threaded=True)
