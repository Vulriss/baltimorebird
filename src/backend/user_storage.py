"""
User Storage Module - Multi-category file storage with default (DEMO) and private user zones.

Categories:
    - mf4: MF4/MDF data files (Interactive EDA)
    - dbc: CAN DBC definition files (Interactive EDA)
    - layouts: JSON view layouts (Interactive EDA)
    - mappings: JSON variable mappings (Dashboard)
    - analyses: JSON/Python analysis scripts (Dashboard)
"""

import os
import re
import json
import uuid
from pathlib import Path
from datetime import datetime
from dataclasses import dataclass, field
from typing import Any, Dict, List, Literal, Optional
import threading

from werkzeug.utils import secure_filename
from flask import Blueprint, g, jsonify, request, send_file

from auth import Database, admin_required, db, login_required

# INFO : Be careful with PEP 484 (Optional msut be used when the default value is None -> trigger warning on vscode)

# --- Configuration ---

DEFAULT_QUOTA_BYTES = 5 * 1024 * 1024 * 1024  # 5 GB
MAX_FILES_PER_USER = 1000  # Limite nombre de fichiers par utilisateur
MAX_FILES_PER_CATEGORY = 200  # Limite par catégorie
MAX_JSON_SIZE_BYTES = 5 * 1024 * 1024  # 5 MB pour les JSON
MAX_JSON_DEPTH = 10  # Profondeur max des JSON

FileCategory = Literal["mf4", "dbc", "layouts", "mappings", "analyses"]

CATEGORIES: Dict[str, Dict[str, Any]] = {
    "mf4": {
        "name": "Fichiers MF4",
        "extensions": {"mf4", "mdf", "dat"},
        "description": "Fichiers de données pour Interactive EDA",
        "max_size_mb": 2000,
    },
    "dbc": {
        "name": "Fichiers DBC",
        "extensions": {"dbc"},
        "description": "Fichiers de définition CAN",
        "max_size_mb": 50,
    },
    "layouts": {
        "name": "Layouts",
        "extensions": {"json"},
        "description": "Layouts des vues Interactive EDA",
        "max_size_mb": 5,
    },
    "mappings": {
        "name": "Mappings",
        "extensions": {"json"},
        "description": "Mappings de variables Dashboard",
        "max_size_mb": 5,
    },
    "analyses": {
        "name": "Analyses",
        "extensions": {"json", "py"},
        "description": "Scripts d'analyse Dashboard",
        "max_size_mb": 10,
    },
}

DATA_ROOT = Path(__file__).parent / "data"
DEFAULT_ROOT = DATA_ROOT / "default"
USERS_ROOT = DATA_ROOT / "users"

for category in CATEGORIES:
    (DEFAULT_ROOT / category).mkdir(parents=True, exist_ok=True)
USERS_ROOT.mkdir(parents=True, exist_ok=True)


# --- Validation Utilities ---

def is_valid_uuid(value: str) -> bool:
    """Vérifie si une chaîne est un UUID valide."""
    try:
        uuid.UUID(value)
        return True
    except (ValueError, TypeError, AttributeError):
        return False


def is_safe_path(base_dir: Path, requested_path: Path) -> bool:
    """Vérifie que le chemin est bien dans le répertoire autorisé."""
    try:
        base_resolved = base_dir.resolve()
        requested_resolved = requested_path.resolve()
        return str(requested_resolved).startswith(str(base_resolved))
    except (OSError, ValueError):
        return False


def validate_category(category: str) -> bool:
    """Vérifie que la catégorie est valide."""
    return category in CATEGORIES


def validate_json_depth(obj: Any, current_depth: int = 0) -> bool:
    """Vérifie que le JSON ne dépasse pas la profondeur maximale."""
    if current_depth > MAX_JSON_DEPTH:
        return False
    if isinstance(obj, dict):
        return all(validate_json_depth(v, current_depth + 1) for v in obj.values())
    if isinstance(obj, list):
        return all(validate_json_depth(item, current_depth + 1) for item in obj)
    return True


def sanitize_filename(filename: str) -> Optional[str]:
    """Nettoie et valide un nom de fichier. Retourne None si invalide."""
    if not filename:
        return None
    safe = secure_filename(filename)
    if not safe or safe == "":
        return None
    # Limite la longueur
    if len(safe) > 200:
        safe = safe[:200]
    return safe


# --- Models ---

def format_size(size_bytes: int) -> str:
    """Format bytes to human readable string."""
    size = float(size_bytes)
    for unit in ["B", "KB", "MB", "GB"]:
        if size < 1024:
            return f"{size:.1f} {unit}"
        size /= 1024
    return f"{size:.1f} TB"


@dataclass
class StoredFile:
    """Represents a stored file."""

    id: str
    user_id: Optional[str]
    category: str
    filename: str
    original_name: str
    size_bytes: int
    uploaded_at: str
    description: str = ""
    metadata: Dict[str, Any] = field(default_factory=dict)

    @property
    def is_default(self) -> bool:
        return self.user_id is None

    @property
    def source(self) -> str:
        return "default" if self.is_default else "user"

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "category": self.category,
            "filename": self.original_name,
            "size_bytes": self.size_bytes,
            "size_human": format_size(self.size_bytes),
            "uploaded_at": self.uploaded_at,
            "description": self.description,
            "source": self.source,
            "is_default": self.is_default,
            "is_readonly": self.is_default,
            "metadata": self.metadata,
        }

    @classmethod
    def from_row(cls, row) -> "StoredFile":
        metadata = {}
        if row["metadata"]:
            try:
                metadata = json.loads(row["metadata"])
            except (json.JSONDecodeError, TypeError):
                pass

        return cls(
            id=row["id"],
            user_id=row["user_id"],
            category=row["category"],
            filename=row["filename"],
            original_name=row["original_name"],
            size_bytes=row["size_bytes"],
            uploaded_at=row["uploaded_at"],
            description=row["description"] or "",
            metadata=metadata,
        )


# --- File Utilities ---

def allowed_file(filename: str, category: str) -> bool:
    """Check if file extension is allowed for the category."""
    if category not in CATEGORIES:
        return False
    allowed_ext = CATEGORIES[category]["extensions"]
    return "." in filename and filename.rsplit(".", 1)[1].lower() in allowed_ext


def get_file_extension(filename: str) -> str:
    """Return file extension."""
    return filename.rsplit(".", 1)[1].lower() if "." in filename else ""


def get_storage_path(user_id: Optional[str], category: str) -> Path:
    """Return storage path for user/category."""
    if not validate_category(category):
        raise ValueError(f"Catégorie invalide: {category}")

    if user_id is None:
        path = DEFAULT_ROOT / category
    else:
        if not is_valid_uuid(user_id):
            raise ValueError("User ID invalide")
        # Utilise seulement les premiers caractères pour éviter les paths trop longs
        path = USERS_ROOT / user_id / category

    path.mkdir(parents=True, exist_ok=True)
    return path


# --- Database Schema ---

def init_storage_tables():
    """Initialize storage tables."""
    with db.get_cursor() as cursor:
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS stored_files (
                id TEXT PRIMARY KEY,
                user_id TEXT,
                category TEXT NOT NULL,
                filename TEXT NOT NULL,
                original_name TEXT NOT NULL,
                size_bytes INTEGER NOT NULL,
                uploaded_at TEXT NOT NULL,
                description TEXT DEFAULT '',
                metadata TEXT DEFAULT '{}',
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        """)

        cursor.execute("CREATE INDEX IF NOT EXISTS idx_stored_files_user ON stored_files(user_id)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_stored_files_category ON stored_files(category)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_stored_files_user_category ON stored_files(user_id, category)")

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS user_quotas (
                user_id TEXT PRIMARY KEY,
                quota_bytes INTEGER NOT NULL DEFAULT 5368709120,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        """)

    print(f"  ✓ Storage paths:")
    print(f"      Default: {DEFAULT_ROOT}")
    print(f"      Users:   {USERS_ROOT}")


# --- Storage Manager ---

class StorageManager:
    """Multi-category storage manager."""

    def __init__(self, database: Database):
        self.db = database
        self._upload_locks: Dict[str, threading.Lock] = {}
        self._locks_lock = threading.Lock()
        init_storage_tables()
        self._scan_default_files()

    def _get_user_lock(self, user_id: str) -> threading.Lock:
        """Obtient un lock par utilisateur pour éviter les race conditions."""
        with self._locks_lock:
            if user_id not in self._upload_locks:
                self._upload_locks[user_id] = threading.Lock()
            return self._upload_locks[user_id]

    def _scan_default_files(self):
        """Scan and register default (DEMO) files."""
        with self.db.get_cursor() as cursor:
            for category in CATEGORIES:
                category_path = DEFAULT_ROOT / category
                if not category_path.exists():
                    continue

                for file_path in category_path.iterdir():
                    if not file_path.is_file() or not allowed_file(file_path.name, category):
                        continue

                    cursor.execute(
                        "SELECT id FROM stored_files WHERE user_id IS NULL AND filename = ? AND category = ?",
                        (file_path.name, category),
                    )
                    if cursor.fetchone():
                        continue

                    file_id = str(uuid.uuid4())
                    now = datetime.utcnow().isoformat() + "Z"

                    cursor.execute(
                        """
                        INSERT INTO stored_files (id, user_id, category, filename, original_name, size_bytes, uploaded_at, description)
                        VALUES (?, NULL, ?, ?, ?, ?, ?, ?)
                        """,
                        (file_id, category, file_path.name, file_path.name, file_path.stat().st_size, now, "Fichier de démonstration"),
                    )
                    print(f"      Registered default file: {category}/{file_path.name}")

    # --- Orphan Cleanup ---

    def cleanup_orphans(self, user_id: Optional[str] = None) -> int:
        """
        Supprime les entrées orphelines (fichiers en DB mais pas sur disque).
        
        Args:
            user_id: Si fourni, nettoie uniquement pour cet utilisateur.
                     Si None, nettoie les fichiers de démo (user_id IS NULL).
        
        Returns:
            Nombre d'entrées supprimées.
        """
        deleted_count = 0
        
        with self.db.get_cursor() as cursor:
            # Récupère les fichiers à vérifier
            if user_id:
                if not is_valid_uuid(user_id):
                    return 0
                cursor.execute(
                    "SELECT id, category, filename FROM stored_files WHERE user_id = ?",
                    (user_id,)
                )
            else:
                cursor.execute(
                    "SELECT id, category, filename FROM stored_files WHERE user_id IS NULL"
                )
            
            files = cursor.fetchall()
            orphan_ids = []
            
            for f in files:
                # Détermine le chemin du fichier
                if user_id:
                    file_path = USERS_ROOT / user_id / f["category"] / f["filename"]
                else:
                    file_path = DEFAULT_ROOT / f["category"] / f["filename"]
                
                # Vérifie si le fichier existe sur le disque
                if not file_path.exists():
                    orphan_ids.append(f["id"])
            
            # Supprime les entrées orphelines
            for orphan_id in orphan_ids:
                cursor.execute("DELETE FROM stored_files WHERE id = ?", (orphan_id,))
                deleted_count += 1
        
        if deleted_count > 0:
            print(f"  🧹 Cleaned up {deleted_count} orphan file(s) for user {user_id or 'DEMO'}")
        
        return deleted_count

    def cleanup_all_orphans(self) -> int:
        """
        Nettoie toutes les entrées orphelines (démo + tous les utilisateurs).
        À appeler au démarrage du serveur.
        
        Returns:
            Nombre total d'entrées supprimées.
        """
        total_deleted = 0
        
        # Nettoie les fichiers de démo
        total_deleted += self.cleanup_orphans(user_id=None)
        
        # Récupère la liste des user_ids uniques
        with self.db.get_cursor() as cursor:
            cursor.execute("SELECT DISTINCT user_id FROM stored_files WHERE user_id IS NOT NULL")
            user_ids = [row["user_id"] for row in cursor.fetchall()]
        
        # Nettoie pour chaque utilisateur
        for uid in user_ids:
            total_deleted += self.cleanup_orphans(user_id=uid)
        
        return total_deleted

    # --- Quota Management ---

    def get_quota(self, user_id: str) -> int:
        """Get user quota in bytes."""
        if not is_valid_uuid(user_id):
            return DEFAULT_QUOTA_BYTES

        with self.db.get_cursor() as cursor:
            cursor.execute("SELECT quota_bytes FROM user_quotas WHERE user_id = ?", (user_id,))
            row = cursor.fetchone()
            return row["quota_bytes"] if row else DEFAULT_QUOTA_BYTES

    def set_quota(self, user_id: str, quota_bytes: int):
        """Set user quota."""
        if not is_valid_uuid(user_id):
            raise ValueError("User ID invalide")
        if quota_bytes < 0:
            raise ValueError("Quota invalide")

        with self.db.get_cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO user_quotas (user_id, quota_bytes) VALUES (?, ?)
                ON CONFLICT(user_id) DO UPDATE SET quota_bytes = ?
                """,
                (user_id, quota_bytes, quota_bytes),
            )

    def get_used_space(self, user_id: str, category: Optional[str] = None) -> int:
        """Calculate used space for a user."""
        if not is_valid_uuid(user_id):
            return 0

        with self.db.get_cursor() as cursor:
            if category:
                if not validate_category(category):
                    return 0
                cursor.execute(
                    "SELECT COALESCE(SUM(size_bytes), 0) as total FROM stored_files WHERE user_id = ? AND category = ?",
                    (user_id, category),
                )
            else:
                cursor.execute(
                    "SELECT COALESCE(SUM(size_bytes), 0) as total FROM stored_files WHERE user_id = ?",
                    (user_id,),
                )
            return cursor.fetchone()["total"]

    def get_storage_info(self, user_id: str) -> Dict[str, Any]:
        """Return storage info for a user."""
        if not is_valid_uuid(user_id):
            raise ValueError("User ID invalide")

        quota = self.get_quota(user_id)
        used = self.get_used_space(user_id)

        by_category = {}
        for category in CATEGORIES:
            cat_used = self.get_used_space(user_id, category)
            cat_count = self.count_files(user_id, category)
            by_category[category] = {
                "used_bytes": cat_used,
                "used_human": format_size(cat_used),
                "count": cat_count,
            }

        return {
            "quota_bytes": quota,
            "quota_human": format_size(quota),
            "used_bytes": used,
            "used_human": format_size(used),
            "available_bytes": max(0, quota - used),
            "available_human": format_size(max(0, quota - used)),
            "usage_percent": round((used / quota) * 100, 1) if quota > 0 else 0,
            "by_category": by_category,
            "limits": {
                "max_files_total": MAX_FILES_PER_USER,
                "max_files_per_category": MAX_FILES_PER_CATEGORY,
            },
        }

    def can_upload(self, user_id: str, file_size: int, category: str) -> tuple[bool, str]:
        """Check if user can upload a file."""
        if not validate_category(category):
            return False, "Catégorie invalide"

        if not is_valid_uuid(user_id):
            return False, "User ID invalide"

        # Vérifie la taille max par catégorie
        max_size = CATEGORIES[category]["max_size_mb"] * 1024 * 1024
        if file_size > max_size:
            return False, f"Fichier trop volumineux. Max: {CATEGORIES[category]['max_size_mb']} MB"

        # Vérifie le quota global
        quota = self.get_quota(user_id)
        used = self.get_used_space(user_id)
        if used + file_size > quota:
            available = quota - used
            return False, f"Quota dépassé. Disponible: {format_size(available)}"

        # Vérifie le nombre de fichiers total
        total_files = self.count_files(user_id)
        if total_files >= MAX_FILES_PER_USER:
            return False, f"Limite de fichiers atteinte ({MAX_FILES_PER_USER} max)"

        # Vérifie le nombre de fichiers par catégorie
        category_files = self.count_files(user_id, category)
        if category_files >= MAX_FILES_PER_CATEGORY:
            return False, f"Limite de fichiers pour cette catégorie atteinte ({MAX_FILES_PER_CATEGORY} max)"

        return True, ""

    # --- File Operations ---

    def save_file(self, user_id: str, category: str, file, description: str = "", metadata: Optional[Dict] = None) -> StoredFile:
        """Save a user file."""
        if not validate_category(category):
            raise ValueError(f"Catégorie invalide: {category}")

        if not is_valid_uuid(user_id):
            raise ValueError("User ID invalide")

        original_name = sanitize_filename(file.filename)
        if not original_name:
            raise ValueError("Nom de fichier invalide")

        if not allowed_file(original_name, category):
            allowed = ", ".join(CATEGORIES[category]["extensions"])
            raise ValueError(f"Extension non autorisée. Extensions valides: {allowed}")

        # Calcule la taille
        file.seek(0, os.SEEK_END)
        file_size = file.tell()
        file.seek(0)

        # Lock par utilisateur pour éviter race condition sur quota
        with self._get_user_lock(user_id):
            can_upload, error_msg = self.can_upload(user_id, file_size, category)
            if not can_upload:
                raise ValueError(error_msg)

            file_id = str(uuid.uuid4())
            extension = get_file_extension(original_name)
            stored_filename = f"{file_id}.{extension}"

            storage_path = get_storage_path(user_id, category)
            file_path = storage_path / stored_filename

            # Vérifie que le path est sûr
            if not is_safe_path(storage_path, file_path):
                raise ValueError("Chemin de fichier invalide")

            file.save(file_path)

            now = datetime.utcnow().isoformat() + "Z"

            # Valide et limite les metadata
            safe_metadata = {}
            if metadata:
                try:
                    meta_str = json.dumps(metadata)
                    if len(meta_str) <= 10000 and validate_json_depth(metadata):
                        safe_metadata = metadata
                except (TypeError, ValueError):
                    pass

            metadata_json = json.dumps(safe_metadata)

            # Sanitize description
            safe_description = str(description)[:500] if description else ""

            with self.db.get_cursor() as cursor:
                cursor.execute(
                    """
                    INSERT INTO stored_files (id, user_id, category, filename, original_name, size_bytes, uploaded_at, description, metadata)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (file_id, user_id, category, stored_filename, original_name, file_size, now, safe_description, metadata_json),
                )

        return StoredFile(
            id=file_id,
            user_id=user_id,
            category=category,
            filename=stored_filename,
            original_name=original_name,
            size_bytes=file_size,
            uploaded_at=now,
            description=safe_description,
            metadata=safe_metadata,
        )

    def save_json(self, user_id: str, category: str, name: str, data: Dict, description: str = "") -> StoredFile:
        """Save a JSON file directly (for layouts, mappings, analyses)."""
        if category not in ["layouts", "mappings", "analyses"]:
            raise ValueError(f"Catégorie {category} non supportée pour JSON direct")

        if not is_valid_uuid(user_id):
            raise ValueError("User ID invalide")

        # Valide le JSON
        if not isinstance(data, dict):
            raise ValueError("Les données doivent être un objet JSON")

        if not validate_json_depth(data):
            raise ValueError(f"JSON trop profond (max {MAX_JSON_DEPTH} niveaux)")

        file_id = str(uuid.uuid4())

        # Sanitize le nom
        safe_name = sanitize_filename(name)
        if not safe_name:
            safe_name = "untitled"
        original_name = safe_name if safe_name.endswith(".json") else f"{safe_name}.json"
        stored_filename = f"{file_id}.json"

        try:
            json_str = json.dumps(data, indent=2)
        except (TypeError, ValueError) as e:
            raise ValueError(f"Données JSON invalides: {e}")

        file_size = len(json_str.encode("utf-8"))

        if file_size > MAX_JSON_SIZE_BYTES:
            raise ValueError(f"JSON trop volumineux (max {MAX_JSON_SIZE_BYTES // 1024 // 1024} MB)")

        with self._get_user_lock(user_id):
            can_upload, error_msg = self.can_upload(user_id, file_size, category)
            if not can_upload:
                raise ValueError(error_msg)

            storage_path = get_storage_path(user_id, category)
            file_path = storage_path / stored_filename

            if not is_safe_path(storage_path, file_path):
                raise ValueError("Chemin de fichier invalide")

            file_path.write_text(json_str, encoding="utf-8")

            now = datetime.utcnow().isoformat() + "Z"
            safe_description = str(description)[:500] if description else ""

            with self.db.get_cursor() as cursor:
                cursor.execute(
                    """
                    INSERT INTO stored_files (id, user_id, category, filename, original_name, size_bytes, uploaded_at, description, metadata)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}')
                    """,
                    (file_id, user_id, category, stored_filename, original_name, file_size, now, safe_description),
                )

        return StoredFile(
            id=file_id,
            user_id=user_id,
            category=category,
            filename=stored_filename,
            original_name=original_name,
            size_bytes=file_size,
            uploaded_at=now,
            description=safe_description,
        )

    def get_file(self, file_id: str, user_id: Optional[str] = None) -> Optional[StoredFile]:
        """Get a file by ID. If user_id provided, checks access (user file OR default)."""
        if not is_valid_uuid(file_id):
            return None

        with self.db.get_cursor() as cursor:
            if user_id:
                if not is_valid_uuid(user_id):
                    return None
                cursor.execute(
                    "SELECT * FROM stored_files WHERE id = ? AND (user_id = ? OR user_id IS NULL)",
                    (file_id, user_id),
                )
            else:
                cursor.execute("SELECT * FROM stored_files WHERE id = ?", (file_id,))

            row = cursor.fetchone()
            return StoredFile.from_row(row) if row else None

    def get_default_file(self, file_id: str) -> Optional[StoredFile]:
        """Get a default file by ID (strictly default files only)."""
        if not is_valid_uuid(file_id):
            return None

        with self.db.get_cursor() as cursor:
            cursor.execute(
                "SELECT * FROM stored_files WHERE id = ? AND user_id IS NULL",
                (file_id,),
            )
            row = cursor.fetchone()
            return StoredFile.from_row(row) if row else None

    def get_file_path(self, file_id: str, user_id: Optional[str] = None) -> Optional[Path]:
        """Return physical path of a file with security validation."""
        stored_file = self.get_file(file_id, user_id)
        if not stored_file:
            return None

        storage_path = get_storage_path(stored_file.user_id, stored_file.category)
        file_path = storage_path / stored_file.filename

        # Validation de sécurité du chemin
        if not is_safe_path(storage_path, file_path):
            return None

        return file_path if file_path.exists() else None

    def read_json(self, file_id: str, user_id: Optional[str] = None) -> Optional[Dict]:
        """Read and return JSON file content."""
        file_path = self.get_file_path(file_id, user_id)
        if not file_path:
            return None

        try:
            content = file_path.read_text(encoding="utf-8")
            if len(content) > MAX_JSON_SIZE_BYTES:
                return None
            return json.loads(content)
        except (json.JSONDecodeError, OSError):
            return None

    def list_files(self, user_id: str, category: Optional[str] = None, include_default: bool = True) -> List[StoredFile]:
        """List files accessible by a user."""
        if not is_valid_uuid(user_id):
            return []

        with self.db.get_cursor() as cursor:
            if category:
                if not validate_category(category):
                    return []
                if include_default:
                    cursor.execute(
                        """
                        SELECT * FROM stored_files
                        WHERE category = ? AND (user_id = ? OR user_id IS NULL)
                        ORDER BY user_id IS NULL, uploaded_at DESC
                        """,
                        (category, user_id),
                    )
                else:
                    cursor.execute(
                        "SELECT * FROM stored_files WHERE category = ? AND user_id = ? ORDER BY uploaded_at DESC",
                        (category, user_id),
                    )
            else:
                if include_default:
                    cursor.execute(
                        """
                        SELECT * FROM stored_files
                        WHERE user_id = ? OR user_id IS NULL
                        ORDER BY category, user_id IS NULL, uploaded_at DESC
                        """,
                        (user_id,),
                    )
                else:
                    cursor.execute(
                        "SELECT * FROM stored_files WHERE user_id = ? ORDER BY category, uploaded_at DESC",
                        (user_id,),
                    )

            return [StoredFile.from_row(row) for row in cursor.fetchall()]

    def list_default_files(self, category: Optional[str] = None) -> List[StoredFile]:
        """List default (DEMO) files."""
        with self.db.get_cursor() as cursor:
            if category:
                if not validate_category(category):
                    return []
                cursor.execute(
                    "SELECT * FROM stored_files WHERE user_id IS NULL AND category = ? ORDER BY original_name",
                    (category,),
                )
            else:
                cursor.execute("SELECT * FROM stored_files WHERE user_id IS NULL ORDER BY category, original_name")
            return [StoredFile.from_row(row) for row in cursor.fetchall()]

    def count_files(self, user_id: str, category: Optional[str] = None) -> int:
        """Count user files."""
        if not is_valid_uuid(user_id):
            return 0

        with self.db.get_cursor() as cursor:
            if category:
                if not validate_category(category):
                    return 0
                cursor.execute(
                    "SELECT COUNT(*) as cnt FROM stored_files WHERE user_id = ? AND category = ?",
                    (user_id, category),
                )
            else:
                cursor.execute("SELECT COUNT(*) as cnt FROM stored_files WHERE user_id = ?", (user_id,))
            return cursor.fetchone()["cnt"]

    def delete_file(self, file_id: str, user_id: str) -> bool:
        """Delete a user file (not default files)."""
        if not is_valid_uuid(file_id) or not is_valid_uuid(user_id):
            return False

        stored_file = self.get_file(file_id, user_id)

        if not stored_file:
            return False

        if stored_file.is_default:
            raise ValueError("Impossible de supprimer un fichier de démonstration")

        if stored_file.user_id != user_id:
            raise ValueError("Accès non autorisé")

        storage_path = get_storage_path(user_id, stored_file.category)
        file_path = storage_path / stored_file.filename

        # Validation de sécurité
        if is_safe_path(storage_path, file_path) and file_path.exists():
            file_path.unlink()

        with self.db.get_cursor() as cursor:
            cursor.execute("DELETE FROM stored_files WHERE id = ? AND user_id = ?", (file_id, user_id))
            return cursor.rowcount > 0

    def update_file(self, file_id: str, user_id: str, description: Optional[str] = None, metadata: Optional[Dict] = None) -> bool:
        """Update file metadata."""
        if not is_valid_uuid(file_id) or not is_valid_uuid(user_id):
            return False

        stored_file = self.get_file(file_id, user_id)

        if not stored_file or stored_file.is_default or stored_file.user_id != user_id:
            return False

        updates = []
        params = []

        if description is not None:
            safe_description = str(description)[:500]
            updates.append("description = ?")
            params.append(safe_description)

        if metadata is not None:
            if isinstance(metadata, dict) and validate_json_depth(metadata):
                try:
                    meta_str = json.dumps(metadata)
                    if len(meta_str) <= 10000:
                        updates.append("metadata = ?")
                        params.append(meta_str)
                except (TypeError, ValueError):
                    pass

        if not updates:
            return True

        params.append(file_id)

        with self.db.get_cursor() as cursor:
            cursor.execute(f"UPDATE stored_files SET {', '.join(updates)} WHERE id = ?", params)
            return cursor.rowcount > 0


# --- Initialization ---

storage = StorageManager(db)


# --- Flask Blueprint ---

storage_bp = Blueprint("storage", __name__)


@storage_bp.route("/api/storage/info", methods=["GET"])
@login_required
def get_storage_info():
    """Return storage info for current user."""
    user = g.current_user
    try:
        info = storage.get_storage_info(user.id)
        info["categories"] = {k: v["name"] for k, v in CATEGORIES.items()}
        return jsonify(info)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400


@storage_bp.route("/api/storage/files", methods=["GET"])
@login_required
def list_files():
    """List user files."""
    user = g.current_user
    category = request.args.get("category")
    include_default = request.args.get("include_default", "true").lower() == "true"

    if category and not validate_category(category):
        return jsonify({"error": "Catégorie invalide"}), 400

    files = storage.list_files(user.id, category, include_default)

    return jsonify({"files": [f.to_dict() for f in files], "count": len(files)})


@storage_bp.route("/api/storage/files/<category>", methods=["POST"])
@login_required
def upload_file(category):
    """Upload a file to a category."""
    user = g.current_user

    if not validate_category(category):
        return jsonify({"error": "Catégorie invalide"}), 400

    if "file" not in request.files:
        return jsonify({"error": "Aucun fichier fourni"}), 400

    file = request.files["file"]
    if not file.filename:
        return jsonify({"error": "Nom de fichier vide"}), 400

    description = request.form.get("description", "")[:500]

    try:
        stored_file = storage.save_file(user.id, category, file, description)
        return jsonify({
            "success": True,
            "file": stored_file.to_dict(),
            "storage": storage.get_storage_info(user.id)
        }), 201
    except ValueError as e:
        return jsonify({"error": str(e)}), 400


@storage_bp.route("/api/storage/json/<category>", methods=["POST"])
@login_required
def save_json_route(category):
    """Save a JSON file directly."""
    user = g.current_user

    if category not in ["layouts", "mappings", "analyses"]:
        return jsonify({"error": "Catégorie non supportée pour JSON"}), 400

    data = request.get_json()
    if not data:
        return jsonify({"error": "Données JSON requises"}), 400

    name = data.get("name", "untitled")
    content = data.get("content")
    description = data.get("description", "")

    if not isinstance(content, dict):
        return jsonify({"error": "Le contenu doit être un objet JSON"}), 400

    try:
        stored_file = storage.save_json(user.id, category, name, content, description)
        return jsonify({"success": True, "file": stored_file.to_dict()}), 201
    except ValueError as e:
        return jsonify({"error": str(e)}), 400


@storage_bp.route("/api/storage/files/<file_id>", methods=["GET"])
@login_required
def get_file_info(file_id):
    """Get file info."""
    if not is_valid_uuid(file_id):
        return jsonify({"error": "ID de fichier invalide"}), 400

    user = g.current_user
    stored_file = storage.get_file(file_id, user.id)

    if not stored_file:
        return jsonify({"error": "Fichier non trouvé"}), 404

    return jsonify({"file": stored_file.to_dict()})


@storage_bp.route("/api/storage/files/<file_id>/download", methods=["GET"])
@login_required
def download_file(file_id):
    """Download a file."""
    if not is_valid_uuid(file_id):
        return jsonify({"error": "ID de fichier invalide"}), 400

    user = g.current_user
    stored_file = storage.get_file(file_id, user.id)

    if not stored_file:
        return jsonify({"error": "Fichier non trouvé"}), 404

    file_path = storage.get_file_path(file_id, user.id)

    if not file_path:
        return jsonify({"error": "Fichier introuvable sur le disque"}), 404

    return send_file(file_path, as_attachment=True, download_name=stored_file.original_name)


@storage_bp.route("/api/storage/files/<file_id>/content", methods=["GET"])
@login_required
def get_file_content(file_id):
    """Get JSON file content."""
    if not is_valid_uuid(file_id):
        return jsonify({"error": "ID de fichier invalide"}), 400

    user = g.current_user
    stored_file = storage.get_file(file_id, user.id)

    if not stored_file:
        return jsonify({"error": "Fichier non trouvé"}), 404

    if stored_file.category not in ["layouts", "mappings", "analyses"]:
        return jsonify({"error": "Lecture de contenu non supportée pour cette catégorie"}), 400

    content = storage.read_json(file_id, user.id)

    if content is None:
        return jsonify({"error": "Impossible de lire le fichier"}), 500

    return jsonify({"file": stored_file.to_dict(), "content": content})


@storage_bp.route("/api/storage/files/<file_id>", methods=["PUT"])
@login_required
def update_file_route(file_id):
    """Update file metadata."""
    if not is_valid_uuid(file_id):
        return jsonify({"error": "ID de fichier invalide"}), 400

    user = g.current_user
    data = request.get_json()

    if not data:
        return jsonify({"error": "Données requises"}), 400

    try:
        success = storage.update_file(
            file_id, user.id,
            description=data.get("description"),
            metadata=data.get("metadata")
        )

        if success:
            stored_file = storage.get_file(file_id, user.id)
            if stored_file:
                return jsonify({"success": True, "file": stored_file.to_dict()})

        return jsonify({"error": "Fichier non trouvé ou accès refusé"}), 404
    except ValueError as e:
        return jsonify({"error": str(e)}), 403


@storage_bp.route("/api/storage/files/<file_id>", methods=["DELETE"])
@login_required
def delete_file_route(file_id):
    """Delete a file."""
    if not is_valid_uuid(file_id):
        return jsonify({"error": "ID de fichier invalide"}), 400

    user = g.current_user

    try:
        if storage.delete_file(file_id, user.id):
            return jsonify({"success": True, "storage": storage.get_storage_info(user.id)})
        return jsonify({"error": "Fichier non trouvé"}), 404
    except ValueError as e:
        return jsonify({"error": str(e)}), 403


# --- Public routes (DEMO files) ---

@storage_bp.route("/api/storage/default", methods=["GET"])
def list_default_files_route():
    """List default (DEMO) files - accessible to all."""
    category = request.args.get("category")

    if category and not validate_category(category):
        return jsonify({"error": "Catégorie invalide"}), 400

    files = storage.list_default_files(category)

    return jsonify({
        "files": [f.to_dict() for f in files],
        "count": len(files),
        "categories": {k: v["name"] for k, v in CATEGORIES.items()},
    })


@storage_bp.route("/api/storage/default/<file_id>/download", methods=["GET"])
def download_default_file(file_id):
    """Download a default file - accessible to all."""
    if not is_valid_uuid(file_id):
        return jsonify({"error": "ID de fichier invalide"}), 400

    # Utilise get_default_file pour s'assurer que c'est bien un fichier default
    stored_file = storage.get_default_file(file_id)

    if not stored_file:
        return jsonify({"error": "Fichier non trouvé"}), 404

    file_path = storage.get_file_path(file_id)

    if not file_path:
        return jsonify({"error": "Fichier introuvable"}), 404

    return send_file(file_path, as_attachment=True, download_name=stored_file.original_name)


# --- Admin routes ---

@storage_bp.route("/api/admin/storage/stats", methods=["GET"])
@admin_required
def admin_storage_stats():
    """Global storage statistics."""
    with db.get_cursor() as cursor:
        cursor.execute("""
            SELECT
                COUNT(DISTINCT user_id) as users_with_files,
                COUNT(*) as total_files,
                COALESCE(SUM(size_bytes), 0) as total_size
            FROM stored_files
            WHERE user_id IS NOT NULL
        """)
        row = cursor.fetchone()

        cursor.execute("""
            SELECT category, COUNT(*) as count, COALESCE(SUM(size_bytes), 0) as size
            FROM stored_files
            WHERE user_id IS NOT NULL
            GROUP BY category
        """)
        by_category = {r["category"]: {"count": r["count"], "size": r["size"]} for r in cursor.fetchall()}

    return jsonify({
        "users_with_files": row["users_with_files"],
        "total_files": row["total_files"],
        "total_size_bytes": row["total_size"],
        "total_size_human": format_size(row["total_size"]),
        "by_category": by_category,
    })


@storage_bp.route("/api/admin/storage/users/<user_id>/quota", methods=["PUT"])
@admin_required
def admin_set_quota(user_id):
    """Set user quota."""
    if not is_valid_uuid(user_id):
        return jsonify({"error": "User ID invalide"}), 400

    data = request.get_json()
    if not data:
        return jsonify({"error": "Données requises"}), 400

    quota_gb = data.get("quota_gb")

    if quota_gb is None or not isinstance(quota_gb, (int, float)) or quota_gb < 0 or quota_gb > 1000:
        return jsonify({"error": "Quota invalide (0-1000 GB)"}), 400

    quota_bytes = int(quota_gb * 1024 * 1024 * 1024)

    try:
        storage.set_quota(user_id, quota_bytes)
        return jsonify({
            "success": True,
            "quota_bytes": quota_bytes,
            "quota_human": format_size(quota_bytes)
        })
    except ValueError as e:
        return jsonify({"error": str(e)}), 400