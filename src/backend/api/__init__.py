"""Baltimore Bird - API layer et enregistrement des blueprints."""

from flask import Flask

from api.auth import auth_bp
from api.sources import sources_bp
from api.eda import eda_bp
from api.reports import reports_bp
from api.conversion import conversion_bp
from api.metrics import metrics_api_bp
from api.scripts import scripts_bp
from api.layouts import layouts_bp
from api.computed import computed_vars_bp
from api.storage import storage_bp


def register_blueprints(app: Flask) -> None:
    """Enregistre tous les blueprints API sur l'application Flask."""
    app.register_blueprint(auth_bp)
    app.register_blueprint(sources_bp)
    app.register_blueprint(eda_bp)
    app.register_blueprint(reports_bp)
    app.register_blueprint(conversion_bp)
    app.register_blueprint(metrics_api_bp)
    app.register_blueprint(scripts_bp)
    app.register_blueprint(layouts_bp)
    app.register_blueprint(computed_vars_bp)
    app.register_blueprint(storage_bp)
