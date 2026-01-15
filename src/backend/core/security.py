"""
Baltimore Bird - Utilitaires de sécurité et validation.
Ce module centralise toutes les fonctions de validation et de sécurité utilisées dans l'app.
"""

import re
import uuid
from pathlib import Path
from typing import Any, Optional

from werkzeug.utils import secure_filename as werkzeug_secure_filename


def is_safe_path(base_dir: Path, requested_path: Path) -> bool:
    """Check if path exist in a given directory."""
    try:
        base_resolved = base_dir.resolve()
        requested_resolved = requested_path.resolve()
        return base_resolved in requested_resolved.parents or requested_resolved == base_resolved
    except (OSError, ValueError):
        return False


def is_valid_uuid(value: str) -> bool:
    """Vérifie si une chaîne est un UUID valide."""
    if not value:
        return False
    try:
        uuid.UUID(value)
        return True
    except (ValueError, TypeError, AttributeError):
        return False


def sanitize_filename(filename: str, max_length: int = 200) -> Optional[str]:
    """Nettoie et valide un nom de fichier."""
    if not filename:
        return None
    safe = werkzeug_secure_filename(filename)
    if not safe:
        return None
    if len(safe) > max_length:
        safe = safe[:max_length]
    return safe


def sanitize_string(value: Any, max_length: int = 500) -> str:
    """Nettoie et limite une chaîne de caracteres."""
    if not isinstance(value, str):
        value = str(value) if value is not None else ""
    return value[:max_length]


def sanitize_task_id(task_id: str) -> Optional[str]:
    """Valide et nettoie un ID de tâche (UUID ou UUID court)."""
    if not task_id or len(task_id) > 36:
        return None
    if not all(c.isalnum() or c == "-" for c in task_id):
        return None
    return task_id


def validate_script_id(script_id: str) -> bool:
    """Valide le format d'un ID de script (script_XXX ou UUID)."""
    if not script_id or len(script_id) > 50:
        return False
    if re.match(r"^script_[a-zA-Z0-9_]+$", script_id):
        return True
    return is_valid_uuid(script_id)


def validate_layout_id(layout_id: str) -> bool:
    """Valide le format d'un ID de layout (alphanum, underscore, tiret)."""
    if not layout_id or len(layout_id) > 100:
        return False
    safe_id = re.sub(r"[^a-zA-Z0-9_-]", "", layout_id)
    return safe_id == layout_id


def validate_json_depth(obj: Any, current_depth: int = 0, max_depth: int = 10) -> bool:
    """Vérifie que la profondeur d'un objet JSON ne dépasse pas la limite de conf."""
    if current_depth > max_depth:
        return False
    if isinstance(obj, dict):
        return all(validate_json_depth(v, current_depth + 1, max_depth) for v in obj.values())
    if isinstance(obj, list):
        return all(validate_json_depth(item, current_depth + 1, max_depth) for item in obj)
    return True


def escape_python_string(value: str) -> str:
    """Escape std python sting"""
    return (
        value
        .replace("\\", "\\\\")
        .replace('"', '\\"')
        .replace("\n", "\\n")
        .replace("\r", "\\r")
        .replace("\t", "\\t")
    )


def allowed_file(filename: str, allowed_extensions: set[str]) -> bool:
    """Vérifie si l'extension d'un fichier est dans le set autorisé."""
    return Path(filename).suffix.lower() in allowed_extensions


def get_file_extension(filename: str) -> str:
    """Retourne l'extension d'un fichier en minuscules, sans le point."""
    if "." not in filename:
        return ""
    return filename.rsplit(".", 1)[1].lower()