"""
Baltimore Bird - Application principale.

Point d'entrée de l'application Flask.
"""

import logging
import threading
import time

from flask import Flask, jsonify
from flask_cors import CORS

from config import ALLOWED_ORIGINS, MAX_CONTENT_LENGTH, TEMP_DIR
from middleware import register_metrics_middleware, register_security_middleware
from api import register_blueprints
from data_management import datastore
from services import conversion_manager, concatenation_manager, get_supported_conversions


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)


def create_app() -> Flask:
    """Factory function pour créer l'application Flask."""
    app = Flask(__name__)
    app.config["MAX_CONTENT_LENGTH"] = MAX_CONTENT_LENGTH

    CORS(app, origins=ALLOWED_ORIGINS, supports_credentials=True)

    register_security_middleware(app)
    register_metrics_middleware(app)
    register_blueprints(app)
    register_error_handlers(app)

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


def start_cleanup_thread() -> None:
    """Démarre le thread de nettoyage périodique."""
    def cleanup_loop():
        while True:
            time.sleep(600)
            try:
                deleted_conv = conversion_manager.cleanup_old_tasks(max_age_hours=1)
                deleted_concat = concatenation_manager.cleanup_old_tasks(max_age_hours=1)
                if deleted_conv > 0 or deleted_concat > 0:
                    print(f"  Cleanup: {deleted_conv} conversion(s), {deleted_concat} concatenation(s) deleted")
            except Exception as e:
                print(f"Cleanup error: {e}")

    thread = threading.Thread(target=cleanup_loop, daemon=True)
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

    start_cleanup_thread()

    try:
        datastore.load()
    except Exception as e:
        print(f"  Warning: {e}")

    print("\n  http://localhost:5000")
    print("=" * 60)
    app.run(debug=False, port=5000, host="0.0.0.0", threaded=True)
