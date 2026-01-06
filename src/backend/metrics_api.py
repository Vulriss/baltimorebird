"""
Metrics API - Endpoints pour accéder aux métriques d'utilisation
"""

from flask import Blueprint, jsonify, request
from functools import wraps

# Import du module metrics existant
try:
    from metrics import metrics
except ImportError:
    metrics = None

metrics_bp = Blueprint('metrics_api', __name__)


def admin_required(f):
    """Décorateur pour vérifier que l'utilisateur est admin"""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        # Pour l'instant, on laisse passer - à intégrer avec auth.py
        # En production, vérifier le token et le rôle admin
        return f(*args, **kwargs)
    return decorated_function


@metrics_bp.route('/api/metrics/current', methods=['GET'])
@admin_required
def get_current_metrics():
    """Retourne les métriques temps réel"""
    if not metrics:
        return jsonify({'error': 'Metrics not available'}), 503
    
    try:
        stats = metrics.get_current_stats()
        return jsonify(stats)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@metrics_bp.route('/api/metrics/daily', methods=['GET'])
@admin_required
def get_daily_metrics():
    """Retourne les métriques d'un jour spécifique"""
    if not metrics:
        return jsonify({'error': 'Metrics not available'}), 503
    
    date_str = request.args.get('date')  # Format: YYYY-MM-DD
    
    try:
        report = metrics.get_daily_report(date_str)
        return jsonify(report)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@metrics_bp.route('/api/metrics/weekly', methods=['GET'])
@admin_required
def get_weekly_metrics():
    """Retourne le résumé des 7 derniers jours"""
    if not metrics:
        return jsonify({'error': 'Metrics not available'}), 503
    
    try:
        summary = metrics.get_weekly_summary()
        return jsonify(summary)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@metrics_bp.route('/api/metrics/cleanup', methods=['POST'])
@admin_required
def cleanup_metrics():
    """Nettoie les anciennes données"""
    if not metrics:
        return jsonify({'error': 'Metrics not available'}), 503
    
    keep_days = request.json.get('keep_days', 30) if request.json else 30
    
    try:
        metrics.cleanup_old_data(keep_days=keep_days)
        return jsonify({'success': True, 'message': f'Cleaned data older than {keep_days} days'})
    except Exception as e:
        return jsonify({'error': str(e)}), 500