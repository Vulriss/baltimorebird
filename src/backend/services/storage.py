"""Baltimore Bird - Service de stockage utilisateur avec SQLite."""

import json
import sqlite3
import threading
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from config import (
    BASE_DIR,
    DEFAULT_QUOTA_BYTES,
    MAX_FILES_PER_CATEGORY,
    MAX_FILES_PER_USER,
    MAX_JSON_DEPTH,
    MAX_JSON_SIZE_BYTES,
)
from core import is_safe_path, is_valid_uuid, sanitize_filename, validate_json_depth


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

DEFAULT_ROOT = BASE_DIR / "data" / "default"
USERS_ROOT = BASE_DIR / "data" / "users"
DB_PATH = BASE_DIR / "data" / "auth" / "users.db"


def format_size(size_bytes: int) -> str:
    size = float(size_bytes)
    for unit in ["B", "KB", "MB", "GB"]:
        if size < 1024:
            return f"{size:.1f} {unit}"
        size /= 1024
    return f"{size:.1f} TB"


def validate_category(category: str) -> bool:
    return category in CATEGORIES


def allowed_file(filename: str, category: str) -> bool:
    if category not in CATEGORIES:
        return False
    ext = filename.rsplit(".", 1)[1].lower() if "." in filename else ""
    return ext in CATEGORIES[category]["extensions"]


@dataclass
class StoredFile:
    """Représente un fichier stocké."""
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
    def from_row(cls, row: sqlite3.Row) -> "StoredFile":
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


class StorageManager:
    """Gestionnaire de stockage multi-catégorie avec SQLite."""

    def __init__(self, db_path: Path = DB_PATH):
        self.db_path = db_path
        self._local = threading.local()
        self._init_tables()
        self._scan_default_files()

    def _get_conn(self) -> sqlite3.Connection:
        if not hasattr(self._local, "conn") or self._local.conn is None:
            self._local.conn = sqlite3.connect(str(self.db_path), check_same_thread=False)
            self._local.conn.row_factory = sqlite3.Row
        return self._local.conn

    def _init_tables(self) -> None:
        conn = self._get_conn()
        cursor = conn.cursor()

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
                metadata TEXT DEFAULT '{}'
            )
        """)

        cursor.execute("CREATE INDEX IF NOT EXISTS idx_stored_files_user ON stored_files(user_id)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_stored_files_category ON stored_files(category)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_stored_files_user_category ON stored_files(user_id, category)")

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS user_quotas (
                user_id TEXT PRIMARY KEY,
                quota_bytes INTEGER NOT NULL DEFAULT 5368709120
            )
        """)

        conn.commit()

    def _scan_default_files(self) -> None:
        conn = self._get_conn()
        cursor = conn.cursor()

        for category in CATEGORIES:
            category_path = DEFAULT_ROOT / category
            if not category_path.exists():
                continue

            for file_path in category_path.iterdir():
                if not file_path.is_file() or not allowed_file(file_path.name, category):
                    continue
                if file_path.name.startswith(".") or file_path.name == "README.md":
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

        conn.commit()

    def get_quota(self, user_id: str) -> int:
        if not is_valid_uuid(user_id):
            return DEFAULT_QUOTA_BYTES

        conn = self._get_conn()
        cursor = conn.cursor()
        cursor.execute("SELECT quota_bytes FROM user_quotas WHERE user_id = ?", (user_id,))
        row = cursor.fetchone()
        return row["quota_bytes"] if row else DEFAULT_QUOTA_BYTES

    def get_used_space(self, user_id: str, category: Optional[str] = None) -> int:
        if not is_valid_uuid(user_id):
            return 0

        conn = self._get_conn()
        cursor = conn.cursor()

        if category:
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

    def count_files(self, user_id: str, category: Optional[str] = None) -> int:
        if not is_valid_uuid(user_id):
            return 0

        conn = self._get_conn()
        cursor = conn.cursor()

        if category:
            cursor.execute(
                "SELECT COUNT(*) as cnt FROM stored_files WHERE user_id = ? AND category = ?",
                (user_id, category),
            )
        else:
            cursor.execute("SELECT COUNT(*) as cnt FROM stored_files WHERE user_id = ?", (user_id,))

        return cursor.fetchone()["cnt"]

    def get_storage_info(self, user_id: str) -> Dict[str, Any]:
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

    def list_files(self, user_id: str, category: Optional[str] = None, include_default: bool = True) -> List[StoredFile]:
        if not is_valid_uuid(user_id):
            return []

        conn = self._get_conn()
        cursor = conn.cursor()

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

    def get_file(self, file_id: str, user_id: str) -> Optional[StoredFile]:
        if not is_valid_uuid(file_id):
            return None

        conn = self._get_conn()
        cursor = conn.cursor()

        cursor.execute(
            "SELECT * FROM stored_files WHERE id = ? AND (user_id = ? OR user_id IS NULL)",
            (file_id, user_id),
        )
        row = cursor.fetchone()
        return StoredFile.from_row(row) if row else None

    def get_file_path(self, file_id: str, user_id: str) -> Optional[Path]:
        stored_file = self.get_file(file_id, user_id)
        if not stored_file:
            return None

        if stored_file.is_default:
            file_path = DEFAULT_ROOT / stored_file.category / stored_file.filename
        else:
            file_path = USERS_ROOT / stored_file.user_id / stored_file.category / stored_file.filename

        if not file_path.exists():
            return None

        return file_path

    def store_file(
        self,
        user_id: str,
        file_data: bytes,
        original_name: str,
        category: str,
        description: str = "",
        metadata: Optional[Dict[str, Any]] = None
    ) -> StoredFile:
        if not is_valid_uuid(user_id):
            raise ValueError("User ID invalide")

        if not validate_category(category):
            raise ValueError(f"Catégorie invalide: {category}")

        safe_name = sanitize_filename(original_name)
        if not safe_name or not allowed_file(safe_name, category):
            raise ValueError("Nom ou extension de fichier invalide")

        file_size = len(file_data)
        max_size = CATEGORIES[category]["max_size_mb"] * 1024 * 1024
        if file_size > max_size:
            raise ValueError(f"Fichier trop volumineux. Max: {CATEGORIES[category]['max_size_mb']} MB")

        quota = self.get_quota(user_id)
        used = self.get_used_space(user_id)
        if used + file_size > quota:
            raise ValueError("Quota de stockage dépassé")

        if self.count_files(user_id, category) >= MAX_FILES_PER_CATEGORY:
            raise ValueError(f"Limite de fichiers atteinte pour la catégorie {category}")

        if self.count_files(user_id) >= MAX_FILES_PER_USER:
            raise ValueError("Limite totale de fichiers atteinte")

        file_id = str(uuid.uuid4())
        stored_name = f"{file_id[:8]}_{safe_name}"
        now = datetime.utcnow().isoformat() + "Z"

        user_cat_dir = USERS_ROOT / user_id / category
        user_cat_dir.mkdir(parents=True, exist_ok=True)

        file_path = user_cat_dir / stored_name
        with open(file_path, "wb") as f:
            f.write(file_data)

        conn = self._get_conn()
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO stored_files (id, user_id, category, filename, original_name, size_bytes, uploaded_at, description, metadata)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (file_id, user_id, category, stored_name, safe_name, file_size, now, description, json.dumps(metadata or {})),
        )
        conn.commit()

        return StoredFile(
            id=file_id,
            user_id=user_id,
            category=category,
            filename=stored_name,
            original_name=safe_name,
            size_bytes=file_size,
            uploaded_at=now,
            description=description,
            metadata=metadata or {},
        )

    def delete_file(self, file_id: str, user_id: str) -> bool:
        if not is_valid_uuid(file_id) or not is_valid_uuid(user_id):
            return False

        stored_file = self.get_file(file_id, user_id)
        if not stored_file or stored_file.is_default:
            return False

        file_path = USERS_ROOT / user_id / stored_file.category / stored_file.filename
        if file_path.exists():
            file_path.unlink()

        conn = self._get_conn()
        cursor = conn.cursor()
        cursor.execute("DELETE FROM stored_files WHERE id = ? AND user_id = ?", (file_id, user_id))
        conn.commit()

        return cursor.rowcount > 0

    def store_json(
        self,
        user_id: str,
        data: Any,
        name: str,
        category: str,
        description: str = ""
    ) -> StoredFile:
        if not validate_json_depth(data, max_depth=MAX_JSON_DEPTH):
            raise ValueError("Structure JSON trop profonde")

        json_bytes = json.dumps(data, indent=2).encode("utf-8")

        if len(json_bytes) > MAX_JSON_SIZE_BYTES:
            raise ValueError(f"Données JSON trop volumineuses (max {MAX_JSON_SIZE_BYTES // 1024 // 1024} MB)")

        if not name.endswith(".json"):
            name = f"{name}.json"

        return self.store_file(user_id, json_bytes, name, category, description, {"type": "json"})

    def load_json(self, file_id: str, user_id: str) -> Optional[Any]:
        file_path = self.get_file_path(file_id, user_id)
        if not file_path:
            return None

        try:
            with open(file_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError):
            return None


storage = StorageManager()
