"""
Scripts API - Gestion des scripts d'analyse du Dashboard
"""

import os
import json
from datetime import datetime
from flask import Blueprint, jsonify, request
import uuid

# Import du sandbox pour la validation de sécurité
try:
    from sandbox import check_code_safety, safe_execute, validate_code
    SANDBOX_AVAILABLE = True
except ImportError:
    SANDBOX_AVAILABLE = False
    print("⚠ Sandbox not available - code validation disabled")

scripts_bp = Blueprint('scripts', __name__)

# Chemin vers le dossier des scripts
SCRIPTS_DIR = os.path.join(os.path.dirname(__file__), 'data', 'default', 'scripts')


def ensure_scripts_dir():
    """Crée le dossier scripts s'il n'existe pas"""
    if not os.path.exists(SCRIPTS_DIR):
        os.makedirs(SCRIPTS_DIR)


def load_script(script_id):
    """Charge un script depuis son fichier JSON"""
    filepath = os.path.join(SCRIPTS_DIR, f"{script_id}.json")
    if not os.path.exists(filepath):
        return None
    
    with open(filepath, 'r', encoding='utf-8') as f:
        return json.load(f)


def save_script(script_data):
    """Sauvegarde un script dans un fichier JSON"""
    ensure_scripts_dir()
    script_id = script_data.get('id')
    filepath = os.path.join(SCRIPTS_DIR, f"{script_id}.json")
    
    with open(filepath, 'w', encoding='utf-8') as f:
        json.dump(script_data, f, indent=2, ensure_ascii=False)
    
    return filepath


@scripts_bp.route('/api/scripts', methods=['GET'])
def list_scripts():
    """Liste tous les scripts disponibles"""
    ensure_scripts_dir()
    scripts = []
    
    for filename in os.listdir(SCRIPTS_DIR):
        if filename.endswith('.json') and not filename.startswith('README'):
            filepath = os.path.join(SCRIPTS_DIR, filename)
            try:
                with open(filepath, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                    
                # Extraire les infos essentielles pour la liste
                scripts.append({
                    'id': data.get('id', filename.replace('.json', '')),
                    'name': data.get('name', 'Sans nom'),
                    'description': data.get('description', ''),
                    'created': data.get('created'),
                    'modified': data.get('modified'),
                    'blockCount': len(data.get('blocks', [])),
                    'lastRun': data.get('lastRun'),
                    'lastRunStatus': data.get('lastRunStatus')
                })
            except (json.JSONDecodeError, IOError) as e:
                print(f"Error loading script {filename}: {e}")
                continue
    
    # Trier par date de modification (plus récent en premier)
    scripts.sort(key=lambda x: x.get('modified') or '', reverse=True)
    
    return jsonify({
        'scripts': scripts,
        'count': len(scripts)
    })


@scripts_bp.route('/api/scripts/<script_id>', methods=['GET'])
def get_script(script_id):
    """Récupère un script complet"""
    script = load_script(script_id)
    
    if not script:
        return jsonify({'error': 'Script non trouvé'}), 404
    
    return jsonify(script)


@scripts_bp.route('/api/scripts', methods=['POST'])
def create_script():
    """Crée un nouveau script"""
    data = request.get_json()
    
    if not data:
        return jsonify({'error': 'Données invalides'}), 400
    
    # Générer un ID unique
    script_id = f"script_{uuid.uuid4().hex[:8]}"
    now = datetime.utcnow().isoformat() + 'Z'
    
    script_data = {
        'id': script_id,
        'name': data.get('name', 'Nouveau Script'),
        'description': data.get('description', ''),
        'created': now,
        'modified': now,
        'blocks': data.get('blocks', []),
        'settings': data.get('settings', {
            'title': 'Rapport',
            'author': '',
            'mappingId': None
        }),
        'lastRun': None,
        'lastRunStatus': None,
        'lastRunDuration': None
    }
    
    save_script(script_data)
    
    return jsonify(script_data), 201


@scripts_bp.route('/api/scripts/<script_id>', methods=['PUT'])
def update_script(script_id):
    """Met à jour un script existant"""
    existing = load_script(script_id)
    
    if not existing:
        return jsonify({'error': 'Script non trouvé'}), 404
    
    data = request.get_json()
    if not data:
        return jsonify({'error': 'Données invalides'}), 400
    
    # Mettre à jour les champs modifiables
    existing['name'] = data.get('name', existing['name'])
    existing['description'] = data.get('description', existing.get('description', ''))
    existing['blocks'] = data.get('blocks', existing['blocks'])
    existing['settings'] = data.get('settings', existing.get('settings', {}))
    existing['modified'] = datetime.utcnow().isoformat() + 'Z'
    
    save_script(existing)
    
    return jsonify(existing)


@scripts_bp.route('/api/scripts/<script_id>', methods=['DELETE'])
def delete_script(script_id):
    """Supprime un script"""
    filepath = os.path.join(SCRIPTS_DIR, f"{script_id}.json")
    
    if not os.path.exists(filepath):
        return jsonify({'error': 'Script non trouvé'}), 404
    
    os.remove(filepath)
    
    return jsonify({'success': True, 'deleted': script_id})


@scripts_bp.route('/api/scripts/<script_id>/run', methods=['POST'])
def run_script(script_id):
    """Exécute un script et génère un rapport"""
    script = load_script(script_id)
    
    if not script:
        return jsonify({'error': 'Script non trouvé'}), 404
    
    # Générer le code Python
    code = generate_python_code(script)
    
    # Valider la sécurité avant exécution
    if SANDBOX_AVAILABLE:
        safety = check_code_safety(code)
        if not safety['safe']:
            return jsonify({
                'success': False,
                'error': 'Code non sécurisé',
                'safety_errors': safety['errors']
            }), 400
    
    # TODO: Implémenter l'exécution réelle avec safe_execute()
    # Pour l'instant, simuler l'exécution
    # 
    # Exemple d'exécution réelle:
    # result = safe_execute(code, df=dataframe, timeout_seconds=60)
    # if not result.success:
    #     return jsonify({'error': result.error}), 500
    
    import time
    start_time = time.time()
    
    # Simulation
    time.sleep(0.5)
    
    duration = time.time() - start_time
    now = datetime.utcnow().isoformat() + 'Z'
    
    script['lastRun'] = now
    script['lastRunStatus'] = 'success'
    script['lastRunDuration'] = round(duration, 2)
    script['modified'] = now
    
    save_script(script)
    
    return jsonify({
        'success': True,
        'script_id': script_id,
        'status': 'success',
        'duration': round(duration, 2),
        'report_id': f"report_{uuid.uuid4().hex[:8]}"
    })


@scripts_bp.route('/api/scripts/<script_id>/preview', methods=['GET'])
def preview_script_code(script_id):
    """Génère et retourne le code Python du script (sans l'exécuter)"""
    script = load_script(script_id)
    
    if not script:
        return jsonify({'error': 'Script non trouvé'}), 404
    
    # Générer le code Python
    code = generate_python_code(script)
    
    # Valider la sécurité si le sandbox est disponible
    safety_check = None
    if SANDBOX_AVAILABLE:
        safety_check = check_code_safety(code)
    
    return jsonify({
        'script_id': script_id,
        'code': code,
        'safety': safety_check
    })


@scripts_bp.route('/api/scripts/validate', methods=['POST'])
def validate_script_code():
    """
    Valide la sécurité d'un bloc de code Python.
    Utilisé pour valider le code custom avant sauvegarde.
    """
    if not SANDBOX_AVAILABLE:
        return jsonify({
            'error': 'Sandbox non disponible',
            'safe': False
        }), 503
    
    data = request.get_json()
    if not data or 'code' not in data:
        return jsonify({'error': 'Code requis'}), 400
    
    code = data['code']
    result = check_code_safety(code)
    
    return jsonify(result)


@scripts_bp.route('/api/scripts/allowed-modules', methods=['GET'])
def get_allowed_modules():
    """Retourne la liste des modules autorisés pour le code custom"""
    if SANDBOX_AVAILABLE:
        from sandbox import ALLOWED_MODULES, ALLOWED_BUILTINS
        return jsonify({
            'modules': sorted(list(ALLOWED_MODULES)),
            'builtins': sorted(list(ALLOWED_BUILTINS))
        })
    else:
        return jsonify({
            'error': 'Sandbox non disponible',
            'modules': [],
            'builtins': []
        })


def generate_python_code(script):
    """Génère le code Python à partir de la définition des blocs"""
    settings = script.get('settings', {})
    blocks = script.get('blocks', [])
    
    lines = [
        '#!/usr/bin/env python3',
        '# -*- coding: utf-8 -*-',
        '"""',
        f"Script: {script.get('name', 'Sans nom')}",
        f"Généré par Baltimore Bird Dashboard",
        f"Date: {datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S')}",
        '"""',
        '',
        'from report_builder import ReportBuilder, Section, Text, Callout, LinePlot, Table, Metrics',
        '',
        '',
        'def generate_report(df, output_path):',
        f'    report = ReportBuilder(title="{settings.get("title", "Rapport")}", author="{settings.get("author", "")}")',
        ''
    ]
    
    for block in blocks:
        block_type = block.get('type')
        config = block.get('config', {})
        
        if block_type == 'section':
            level = {'H1': 1, 'H2': 2, 'H3': 3}.get(config.get('level', 'H1'), 1)
            lines.append(f'    report.add(Section("{config.get("title", "")}", level={level}))')
        
        elif block_type == 'text':
            content = config.get('content', '').replace('"', '\\"').replace('\n', '\\n')
            lines.append(f'    report.add(Text("{content}"))')
        
        elif block_type == 'callout':
            content = config.get('content', '').replace('"', '\\"')
            ctype = config.get('type', 'info')
            lines.append(f'    report.add(Callout("{content}", type="{ctype}"))')
        
        elif block_type == 'lineplot':
            signal = config.get('signal', '')
            title = config.get('title', '')
            color = config.get('color', '#6366f1')
            lines.append(f'    report.add(LinePlot(df, x="time", y="{signal}", title="{title}", color="{color}"))')
        
        elif block_type == 'table':
            caption = config.get('caption', '')
            lines.append(f'    report.add(Table(df, caption="{caption}"))')
        
        elif block_type == 'metrics':
            cols = config.get('columns', 4)
            lines.append(f'    report.add(Metrics(df, columns={cols}))')
        
        elif block_type == 'histogram':
            signal = config.get('signal', '')
            bins = config.get('bins', 20)
            title = config.get('title', '')
            lines.append(f'    report.add(Histogram(df, y="{signal}", bins={bins}, title="{title}"))')
        
        elif block_type == 'scatter':
            x = config.get('x', '')
            y = config.get('y', '')
            title = config.get('title', '')
            color = config.get('color', '#6366f1')
            lines.append(f'    report.add(Scatter(df, x="{x}", y="{y}", title="{title}", color="{color}"))')
        
        elif block_type == 'code':
            custom_code = config.get('code', '')
            for code_line in custom_code.split('\n'):
                lines.append(f'    {code_line}')
    
    lines.extend([
        '',
        '    report.save(output_path)',
        '    return output_path',
        '',
        '',
        'if __name__ == "__main__":',
        '    import pandas as pd',
        '    import sys',
        '    ',
        '    if len(sys.argv) < 3:',
        '        print("Usage: python script.py <input.csv> <output.html>")',
        '        sys.exit(1)',
        '    ',
        '    df = pd.read_csv(sys.argv[1])',
        '    generate_report(df, sys.argv[2])',
    ])
    
    return '\n'.join(lines)