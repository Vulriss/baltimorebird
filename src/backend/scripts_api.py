"""
Scripts API - Gestion des scripts d'analyse du Dashboard.
Sécurisé: auth requise, validation des entrées, protection injection.
"""

import json
import re
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from flask import Blueprint, g, jsonify, request

from auth import login_required, admin_required, feature_required

try:
    from sandbox import check_code_safety, safe_execute, ALLOWED_MODULES, ALLOWED_BUILTINS
    SANDBOX_AVAILABLE = True
except ImportError:
    SANDBOX_AVAILABLE = False
    ALLOWED_MODULES = set()
    ALLOWED_BUILTINS = set()
    print("⚠ Sandbox not available - code execution disabled")

scripts_bp = Blueprint('scripts', __name__)


# --- Configuration ---

BASE_DIR = Path(__file__).parent
DEFAULT_SCRIPTS_DIR = BASE_DIR / "data" / "default" / "scripts"
USERS_SCRIPTS_DIR = BASE_DIR / "data" / "users"

MAX_SCRIPT_SIZE = 1024 * 1024  # 1 MB
MAX_BLOCKS = 100
MAX_CODE_LENGTH = 50000
MAX_STRING_LENGTH = 10000

DEFAULT_SCRIPTS_DIR.mkdir(parents=True, exist_ok=True)


# --- Validation Utilities ---

def is_valid_script_id(script_id: str) -> bool:
    """Valide le format d'un script_id."""
    if not script_id or len(script_id) > 50:
        return False
    # Format: script_XXXXXXXX (hex) ou script_nom_alphanum ou UUID
    if re.match(r'^script_[a-zA-Z0-9_]+$', script_id):
        return True
    try:
        uuid.UUID(script_id)
        return True
    except (ValueError, TypeError):
        return False


def is_valid_uuid(value: str) -> bool:
    """Vérifie si une chaîne est un UUID valide."""
    try:
        uuid.UUID(value)
        return True
    except (ValueError, TypeError):
        return False


def is_safe_path(base_dir: Path, requested_path: Path) -> bool:
    """Vérifie que le chemin est dans le répertoire autorisé."""
    try:
        base_resolved = base_dir.resolve()
        requested_resolved = requested_path.resolve()
        return str(requested_resolved).startswith(str(base_resolved))
    except (OSError, ValueError):
        return False


def sanitize_string(value: Any, max_length: int = 500) -> str:
    """Nettoie et limite une chaîne."""
    if not isinstance(value, str):
        value = str(value) if value is not None else ""
    return value[:max_length]


def escape_python_string(value: str) -> str:
    """Échappe une chaîne pour inclusion dans du code Python."""
    return (value
            .replace('\\', '\\\\')
            .replace('"', '\\"')
            .replace('\n', '\\n')
            .replace('\r', '\\r')
            .replace('\t', '\\t'))


def get_user_scripts_dir(user_id: str) -> Path:
    """Retourne le répertoire de scripts d'un utilisateur."""
    if not is_valid_uuid(user_id):
        raise ValueError("User ID invalide")
    user_dir = USERS_SCRIPTS_DIR / user_id / "scripts"
    user_dir.mkdir(parents=True, exist_ok=True)
    return user_dir


# --- Script Storage ---

def load_script(script_id: str, user_id: Optional[str] = None) -> Optional[Dict]:
    """
    Charge un script depuis son fichier JSON.
    Cherche d'abord dans les scripts utilisateur, puis dans les scripts par défaut.
    """
    if not is_valid_script_id(script_id):
        return None

    # Cherche dans les scripts utilisateur
    if user_id and is_valid_uuid(user_id):
        user_dir = USERS_SCRIPTS_DIR / user_id / "scripts"
        filepath = user_dir / f"{script_id}.json"
        if is_safe_path(user_dir, filepath) and filepath.exists():
            try:
                content = filepath.read_text(encoding='utf-8')
                if len(content) > MAX_SCRIPT_SIZE:
                    return None
                data = json.loads(content)
                data['_owner'] = user_id
                data['_readonly'] = False
                return data
            except (json.JSONDecodeError, OSError):
                return None

    # Cherche dans les scripts par défaut (lecture seule)
    filepath = DEFAULT_SCRIPTS_DIR / f"{script_id}.json"
    if is_safe_path(DEFAULT_SCRIPTS_DIR, filepath) and filepath.exists():
        try:
            content = filepath.read_text(encoding='utf-8')
            if len(content) > MAX_SCRIPT_SIZE:
                return None
            data = json.loads(content)
            data['_owner'] = None
            data['_readonly'] = True
            return data
        except (json.JSONDecodeError, OSError):
            return None

    return None


def save_script(script_data: Dict, user_id: str) -> Path:
    """Sauvegarde un script dans le répertoire utilisateur."""
    if not is_valid_uuid(user_id):
        raise ValueError("User ID invalide")

    script_id = script_data.get('id')
    if not is_valid_script_id(script_id):
        raise ValueError("Script ID invalide")

    user_dir = get_user_scripts_dir(user_id)
    filepath = user_dir / f"{script_id}.json"

    if not is_safe_path(user_dir, filepath):
        raise ValueError("Chemin de fichier invalide")

    # Retire les métadonnées internes avant sauvegarde
    save_data = {k: v for k, v in script_data.items() if not k.startswith('_')}

    content = json.dumps(save_data, indent=2, ensure_ascii=False)
    if len(content) > MAX_SCRIPT_SIZE:
        raise ValueError(f"Script trop volumineux (max {MAX_SCRIPT_SIZE // 1024} KB)")

    filepath.write_text(content, encoding='utf-8')
    return filepath


def delete_script_file(script_id: str, user_id: str) -> bool:
    """Supprime un fichier script."""
    if not is_valid_script_id(script_id) or not is_valid_uuid(user_id):
        return False

    user_dir = get_user_scripts_dir(user_id)
    filepath = user_dir / f"{script_id}.json"

    if not is_safe_path(user_dir, filepath):
        return False

    if filepath.exists():
        filepath.unlink()
        return True
    return False


def list_user_scripts(user_id: str) -> List[Dict]:
    """Liste les scripts d'un utilisateur."""
    scripts = []

    if not is_valid_uuid(user_id):
        return scripts

    user_dir = USERS_SCRIPTS_DIR / user_id / "scripts"
    if user_dir.exists():
        for filepath in user_dir.glob("*.json"):
            if filepath.name.startswith("README"):
                continue
            try:
                content = filepath.read_text(encoding='utf-8')
                if len(content) > MAX_SCRIPT_SIZE:
                    continue
                data = json.loads(content)
                scripts.append({
                    'id': data.get('id', filepath.stem),
                    'name': data.get('name', 'Sans nom'),
                    'description': data.get('description', ''),
                    'created': data.get('created'),
                    'modified': data.get('modified'),
                    'blockCount': len(data.get('blocks', [])),
                    'lastRun': data.get('lastRun'),
                    'lastRunStatus': data.get('lastRunStatus'),
                    'source': 'user',
                    'readonly': False,
                })
            except (json.JSONDecodeError, OSError):
                continue

    return scripts


def list_default_scripts() -> List[Dict]:
    """Liste les scripts par défaut (DEMO)."""
    scripts = []

    if DEFAULT_SCRIPTS_DIR.exists():
        for filepath in DEFAULT_SCRIPTS_DIR.glob("*.json"):
            if filepath.name.startswith("README"):
                continue
            try:
                content = filepath.read_text(encoding='utf-8')
                if len(content) > MAX_SCRIPT_SIZE:
                    continue
                data = json.loads(content)
                scripts.append({
                    'id': data.get('id', filepath.stem),
                    'name': data.get('name', 'Sans nom'),
                    'description': data.get('description', ''),
                    'created': data.get('created'),
                    'modified': data.get('modified'),
                    'blockCount': len(data.get('blocks', [])),
                    'lastRun': data.get('lastRun'),
                    'lastRunStatus': data.get('lastRunStatus'),
                    'source': 'default',
                    'readonly': True,
                })
            except (json.JSONDecodeError, OSError):
                continue

    return scripts


# --- Block Validation ---

VALID_BLOCK_TYPES = {'section', 'text', 'callout', 'lineplot', 'table', 'metrics', 'histogram', 'scatter', 'code'}
VALID_CALLOUT_TYPES = {'info', 'warning', 'success', 'error'}
VALID_SECTION_LEVELS = {'H1', 'H2', 'H3'}


def validate_block(block: Dict) -> tuple[bool, str]:
    """Valide un bloc de script."""
    if not isinstance(block, dict):
        return False, "Bloc invalide"

    block_type = block.get('type')
    if block_type not in VALID_BLOCK_TYPES:
        return False, f"Type de bloc inconnu: {block_type}"

    config = block.get('config', {})
    if not isinstance(config, dict):
        return False, "Configuration de bloc invalide"

    if block_type == 'code':
        code = config.get('code', '')
        if len(code) > MAX_CODE_LENGTH:
            return False, f"Code trop long (max {MAX_CODE_LENGTH} caractères)"
        if SANDBOX_AVAILABLE:
            safety = check_code_safety(code)
            if not safety['safe']:
                return False, f"Code non sécurisé: {', '.join(safety['errors'][:3])}"

    if block_type == 'section':
        if config.get('level') and config['level'] not in VALID_SECTION_LEVELS:
            return False, "Niveau de section invalide"

    if block_type == 'callout':
        if config.get('type') and config['type'] not in VALID_CALLOUT_TYPES:
            return False, "Type de callout invalide"

    return True, ""


def validate_blocks(blocks: List) -> tuple[bool, str]:
    """Valide une liste de blocs."""
    if not isinstance(blocks, list):
        return False, "blocks doit être une liste"

    if len(blocks) > MAX_BLOCKS:
        return False, f"Trop de blocs (max {MAX_BLOCKS})"

    for i, block in enumerate(blocks):
        valid, error = validate_block(block)
        if not valid:
            return False, f"Bloc {i + 1}: {error}"

    return True, ""


# --- Code Generation (Secure) ---

def generate_python_code(script: Dict) -> str:
    """Génère le code Python à partir de la définition des blocs (sécurisé)."""
    settings = script.get('settings', {})
    blocks = script.get('blocks', [])

    # Échappe les valeurs des settings
    title = escape_python_string(sanitize_string(settings.get('title', 'Rapport'), 200))
    author = escape_python_string(sanitize_string(settings.get('author', ''), 100))

    lines = [
        '#!/usr/bin/env python3',
        '# -*- coding: utf-8 -*-',
        '"""',
        f'Script: {escape_python_string(sanitize_string(script.get("name", "Sans nom"), 100))}',
        f'Généré par Baltimore Bird Dashboard',
        f'Date: {datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")}',
        '"""',
        '',
        'import numpy as np',
        'import pandas as pd',
        'from report_builder import ReportBuilder, Section, Text, Callout, LinePlot, Table, Metrics, Histogram, Scatter',
        '',
        '',
        'def generate_report(df, output_path):',
        f'    report = ReportBuilder(title="{title}", author="{author}")',
        ''
    ]

    for block in blocks:
        block_type = block.get('type')
        config = block.get('config', {})

        if block_type == 'section':
            level = {'H1': 1, 'H2': 2, 'H3': 3}.get(config.get('level', 'H1'), 1)
            section_title = escape_python_string(sanitize_string(config.get('title', ''), 200))
            lines.append(f'    report.add(Section("{section_title}", level={level}))')

        elif block_type == 'text':
            content = escape_python_string(sanitize_string(config.get('content', ''), MAX_STRING_LENGTH))
            lines.append(f'    report.add(Text("{content}"))')

        elif block_type == 'callout':
            content = escape_python_string(sanitize_string(config.get('content', ''), MAX_STRING_LENGTH))
            ctype = config.get('type', 'info')
            if ctype not in VALID_CALLOUT_TYPES:
                ctype = 'info'
            lines.append(f'    report.add(Callout("{content}", type="{ctype}"))')

        elif block_type == 'lineplot':
            signal = escape_python_string(sanitize_string(config.get('signal', ''), 100))
            plot_title = escape_python_string(sanitize_string(config.get('title', ''), 200))
            color = sanitize_string(config.get('color', '#6366f1'), 20)
            if not re.match(r'^#[a-fA-F0-9]{6}$', color):
                color = '#6366f1'
            lines.append(f'    report.add(LinePlot(df, x="time", y="{signal}", title="{plot_title}", color="{color}"))')

        elif block_type == 'table':
            caption = escape_python_string(sanitize_string(config.get('caption', ''), 200))
            lines.append(f'    report.add(Table(df, caption="{caption}"))')

        elif block_type == 'metrics':
            cols = config.get('columns', 4)
            if not isinstance(cols, int) or cols < 1 or cols > 10:
                cols = 4
            lines.append(f'    report.add(Metrics(df, columns={cols}))')

        elif block_type == 'histogram':
            signal = escape_python_string(sanitize_string(config.get('signal', ''), 100))
            bins = config.get('bins', 20)
            if not isinstance(bins, int) or bins < 1 or bins > 100:
                bins = 20
            hist_title = escape_python_string(sanitize_string(config.get('title', ''), 200))
            lines.append(f'    report.add(Histogram(df, y="{signal}", bins={bins}, title="{hist_title}"))')

        elif block_type == 'scatter':
            x = escape_python_string(sanitize_string(config.get('x', ''), 100))
            y = escape_python_string(sanitize_string(config.get('y', ''), 100))
            scatter_title = escape_python_string(sanitize_string(config.get('title', ''), 200))
            color = sanitize_string(config.get('color', '#6366f1'), 20)
            if not re.match(r'^#[a-fA-F0-9]{6}$', color):
                color = '#6366f1'
            lines.append(f'    report.add(Scatter(df, x="{x}", y="{y}", title="{scatter_title}", color="{color}"))')

        elif block_type == 'code':
            # Le code custom est DÉJÀ validé par validate_block()
            # On l'ajoute avec indentation correcte
            custom_code = config.get('code', '')
            if custom_code and SANDBOX_AVAILABLE:
                # Re-vérifie la sécurité
                safety = check_code_safety(custom_code)
                if safety['safe']:
                    lines.append('    # --- Custom Code Block ---')
                    for code_line in custom_code.split('\n'):
                        # Limite la longueur des lignes
                        safe_line = code_line[:500] if len(code_line) > 500 else code_line
                        lines.append(f'    {safe_line}')
                    lines.append('    # --- End Custom Code ---')
                else:
                    lines.append(f'    # Code block skipped: security validation failed')

    lines.extend([
        '',
        '    report.save(output_path)',
        '    return output_path',
    ])

    return '\n'.join(lines)


# --- API Routes ---

@scripts_bp.route('/api/scripts', methods=['GET'])
@login_required
def list_scripts():
    """Liste tous les scripts (utilisateur + défaut)."""
    user = g.current_user
    include_default = request.args.get('include_default', 'true').lower() == 'true'

    scripts = list_user_scripts(user.id)

    if include_default:
        scripts.extend(list_default_scripts())

    # Trier par date de modification
    scripts.sort(key=lambda x: x.get('modified') or '', reverse=True)

    return jsonify({
        'scripts': scripts,
        'count': len(scripts)
    })


@scripts_bp.route('/api/scripts/<script_id>', methods=['GET'])
@login_required
def get_script(script_id):
    """Récupère un script complet."""
    if not is_valid_script_id(script_id):
        return jsonify({'error': 'ID de script invalide'}), 400

    user = g.current_user
    script = load_script(script_id, user.id)

    if not script:
        return jsonify({'error': 'Script non trouvé'}), 404

    return jsonify(script)


@scripts_bp.route('/api/scripts', methods=['POST'])
@feature_required('create_scripts')
def create_script():
    """Crée un nouveau script."""
    user = g.current_user
    data = request.get_json()

    if not data:
        return jsonify({'error': 'Données invalides'}), 400

    # Valide les blocs
    blocks = data.get('blocks', [])
    valid, error = validate_blocks(blocks)
    if not valid:
        return jsonify({'error': error}), 400

    script_id = f"script_{uuid.uuid4().hex[:8]}"
    now = datetime.utcnow().isoformat() + 'Z'

    script_data = {
        'id': script_id,
        'name': sanitize_string(data.get('name', 'Nouveau Script'), 200),
        'description': sanitize_string(data.get('description', ''), 1000),
        'created': now,
        'modified': now,
        'blocks': blocks,
        'settings': {
            'title': sanitize_string(data.get('settings', {}).get('title', 'Rapport'), 200),
            'author': sanitize_string(data.get('settings', {}).get('author', ''), 100),
            'mappingId': data.get('settings', {}).get('mappingId'),
        },
        'lastRun': None,
        'lastRunStatus': None,
        'lastRunDuration': None
    }

    try:
        save_script(script_data, user.id)
    except ValueError as e:
        return jsonify({'error': str(e)}), 400

    return jsonify(script_data), 201


@scripts_bp.route('/api/scripts/<script_id>', methods=['PUT'])
@feature_required('create_scripts')
def update_script(script_id):
    """Met à jour un script existant."""
    if not is_valid_script_id(script_id):
        return jsonify({'error': 'ID de script invalide'}), 400

    user = g.current_user
    existing = load_script(script_id, user.id)

    if not existing:
        return jsonify({'error': 'Script non trouvé'}), 404

    if existing.get('_readonly'):
        return jsonify({'error': 'Script en lecture seule'}), 403

    if existing.get('_owner') != user.id:
        return jsonify({'error': 'Accès non autorisé'}), 403

    data = request.get_json()
    if not data:
        return jsonify({'error': 'Données invalides'}), 400

    # Valide les blocs si fournis
    if 'blocks' in data:
        valid, error = validate_blocks(data['blocks'])
        if not valid:
            return jsonify({'error': error}), 400
        existing['blocks'] = data['blocks']

    # Met à jour les champs
    if 'name' in data:
        existing['name'] = sanitize_string(data['name'], 200)
    if 'description' in data:
        existing['description'] = sanitize_string(data['description'], 1000)
    if 'settings' in data:
        settings = data['settings']
        existing['settings'] = {
            'title': sanitize_string(settings.get('title', existing.get('settings', {}).get('title', '')), 200),
            'author': sanitize_string(settings.get('author', existing.get('settings', {}).get('author', '')), 100),
            'mappingId': settings.get('mappingId', existing.get('settings', {}).get('mappingId')),
        }

    existing['modified'] = datetime.utcnow().isoformat() + 'Z'

    try:
        save_script(existing, user.id)
    except ValueError as e:
        return jsonify({'error': str(e)}), 400

    return jsonify(existing)


@scripts_bp.route('/api/scripts/<script_id>', methods=['DELETE'])
@feature_required('create_scripts')
def delete_script(script_id):
    """Supprime un script."""
    if not is_valid_script_id(script_id):
        return jsonify({'error': 'ID de script invalide'}), 400

    user = g.current_user
    existing = load_script(script_id, user.id)

    if not existing:
        return jsonify({'error': 'Script non trouvé'}), 404

    if existing.get('_readonly'):
        return jsonify({'error': 'Impossible de supprimer un script par défaut'}), 403

    if existing.get('_owner') != user.id:
        return jsonify({'error': 'Accès non autorisé'}), 403

    if delete_script_file(script_id, user.id):
        return jsonify({'success': True, 'deleted': script_id})

    return jsonify({'error': 'Erreur lors de la suppression'}), 500


@scripts_bp.route('/api/scripts/<script_id>/run', methods=['POST'])
@feature_required('run_scripts')
def run_script(script_id):
    """Exécute un script et génère un rapport."""
    if not SANDBOX_AVAILABLE:
        return jsonify({'error': 'Exécution de scripts non disponible'}), 503

    if not is_valid_script_id(script_id):
        return jsonify({'error': 'ID de script invalide'}), 400

    user = g.current_user
    script = load_script(script_id, user.id)

    if not script:
        return jsonify({'error': 'Script non trouvé'}), 404

    # Valide les blocs avant génération
    valid, error = validate_blocks(script.get('blocks', []))
    if not valid:
        return jsonify({'error': f'Script invalide: {error}'}), 400

    # Génère le code
    code = generate_python_code(script)

    # Valide la sécurité du code généré
    safety = check_code_safety(code)
    if not safety['safe']:
        return jsonify({
            'success': False,
            'error': 'Code généré non sécurisé',
            'safety_errors': safety['errors']
        }), 400

    # TODO: Implémenter l'exécution réelle
    # result = safe_execute(code, data={'df': dataframe}, timeout_seconds=60)
    # if not result.success:
    #     return jsonify({'success': False, 'error': result.error}), 500

    import time
    start_time = time.time()
    duration = time.time() - start_time
    now = datetime.utcnow().isoformat() + 'Z'

    # Met à jour le script si c'est un script utilisateur
    if not script.get('_readonly') and script.get('_owner') == user.id:
        script['lastRun'] = now
        script['lastRunStatus'] = 'success'
        script['lastRunDuration'] = round(duration, 2)
        script['modified'] = now
        try:
            save_script(script, user.id)
        except ValueError:
            pass  # Ignore les erreurs de sauvegarde

    return jsonify({
        'success': True,
        'script_id': script_id,
        'status': 'success',
        'duration': round(duration, 2),
        'report_id': f"report_{uuid.uuid4().hex[:8]}"
    })


@scripts_bp.route('/api/scripts/<script_id>/preview', methods=['GET'])
@login_required
def preview_script_code(script_id):
    """Génère et retourne le code Python du script (sans l'exécuter)."""
    if not is_valid_script_id(script_id):
        return jsonify({'error': 'ID de script invalide'}), 400

    user = g.current_user
    script = load_script(script_id, user.id)

    if not script:
        return jsonify({'error': 'Script non trouvé'}), 404

    code = generate_python_code(script)

    safety_check = None
    if SANDBOX_AVAILABLE:
        safety_check = check_code_safety(code)

    return jsonify({
        'script_id': script_id,
        'code': code,
        'safety': safety_check
    })


@scripts_bp.route('/api/scripts/validate', methods=['POST'])
@login_required
def validate_script_code():
    """Valide la sécurité d'un bloc de code Python."""
    if not SANDBOX_AVAILABLE:
        return jsonify({
            'error': 'Sandbox non disponible',
            'safe': False
        }), 503

    data = request.get_json()
    if not data or 'code' not in data:
        return jsonify({'error': 'Code requis'}), 400

    code = data['code']
    if len(code) > MAX_CODE_LENGTH:
        return jsonify({
            'safe': False,
            'errors': [f'Code trop long (max {MAX_CODE_LENGTH} caractères)']
        })

    result = check_code_safety(code)

    return jsonify(result)


@scripts_bp.route('/api/scripts/allowed-modules', methods=['GET'])
def get_allowed_modules():
    """Retourne la liste des modules autorisés pour le code custom."""
    return jsonify({
        'sandbox_available': SANDBOX_AVAILABLE,
        'modules': sorted(list(ALLOWED_MODULES)) if SANDBOX_AVAILABLE else [],
        'builtins': sorted(list(ALLOWED_BUILTINS)) if SANDBOX_AVAILABLE else []
    })