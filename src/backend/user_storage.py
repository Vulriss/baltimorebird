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
import json
import uuid
from pathlib import Path
from datetime import datetime
from dataclasses import dataclass, field
from typing import Any, Dict, List, Literal, Optional

from werkzeug.utils import secure_filename
from flask import Blueprint, g, jsonify, request, send_file

from auth import Database, admin_required, db, login_required

# INFO : Be careful with PEP 484 (Optional msut be used when the default value is None -> trigger warning on vscode)

# Configuration

DEFAULT_QUOTA_BYTES = 5 * 1024 * 1024 * 1024  # 5 GB

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


# Models

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
    user_id: Optional[str]  # None = default/DEMO file
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


# Utilities

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
    if user_id is None:
        path = DEFAULT_ROOT / category
    else:
        path = USERS_ROOT / user_id / category
    path.mkdir(parents=True, exist_ok=True)
    return path


# Database Schema

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


# Storage Manager

class StorageManager:
    """Multi-category storage manager."""

    def __init__(self, database: Database):
        self.db = database
        init_storage_tables()
        self._scan_default_files()

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

    # Quota Management

    def get_quota(self, user_id: str) -> int:
        """Get user quota in bytes."""
        with self.db.get_cursor() as cursor:
            cursor.execute("SELECT quota_bytes FROM user_quotas WHERE user_id = ?", (user_id,))
            row = cursor.fetchone()
            return row["quota_bytes"] if row else DEFAULT_QUOTA_BYTES

    def set_quota(self, user_id: str, quota_bytes: int):
        """Set user quota."""
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
        with self.db.get_cursor() as cursor:
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

    def get_storage_info(self, user_id: str) -> Dict[str, Any]:
        """Return storage info for a user."""
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
        }

    def can_upload(self, user_id: str, file_size: int, category: str) -> tuple[bool, str]:
        """Check if user can upload a file."""
        max_size = CATEGORIES[category]["max_size_mb"] * 1024 * 1024
        if file_size > max_size:
            return False, f"Fichier trop volumineux. Max: {CATEGORIES[category]['max_size_mb']} MB"

        quota = self.get_quota(user_id)
        used = self.get_used_space(user_id)

        if used + file_size > quota:
            available = quota - used
            return False, f"Quota dépassé. Disponible: {format_size(available)}"

        return True, ""

    # File Operations

    def save_file(self, user_id: str, category: str, file, description: str = "", metadata: Optional[Dict] = None) -> StoredFile:
        """Save a user file."""
        if category not in CATEGORIES:
            raise ValueError(f"Catégorie invalide: {category}")

        original_name = secure_filename(file.filename)

        if not allowed_file(original_name, category):
            allowed = ", ".join(CATEGORIES[category]["extensions"])
            raise ValueError(f"Extension non autorisée. Extensions valides: {allowed}")

        file.seek(0, os.SEEK_END)
        file_size = file.tell()
        file.seek(0)

        can_upload, error_msg = self.can_upload(user_id, file_size, category)
        if not can_upload:
            raise ValueError(error_msg)

        file_id = str(uuid.uuid4())
        extension = get_file_extension(original_name)
        stored_filename = f"{file_id}.{extension}"

        storage_path = get_storage_path(user_id, category)
        file_path = storage_path / stored_filename
        file.save(file_path)

        now = datetime.utcnow().isoformat() + "Z"
        metadata_json = json.dumps(metadata or {})

        with self.db.get_cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO stored_files (id, user_id, category, filename, original_name, size_bytes, uploaded_at, description, metadata)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (file_id, user_id, category, stored_filename, original_name, file_size, now, description, metadata_json),
            )

        return StoredFile(
            id=file_id,
            user_id=user_id,
            category=category,
            filename=stored_filename,
            original_name=original_name,
            size_bytes=file_size,
            uploaded_at=now,
            description=description,
            metadata=metadata or {},
        )

    def save_json(self, user_id: str, category: str, name: str, data: Dict, description: str = "") -> StoredFile:
        """Save a JSON file directly (for layouts, mappings, analyses)."""
        if category not in ["layouts", "mappings", "analyses"]:
            raise ValueError(f"Catégorie {category} non supportée pour JSON direct")

        file_id = str(uuid.uuid4())
        original_name = secure_filename(name) if name.endswith(".json") else secure_filename(name) + ".json"
        stored_filename = f"{file_id}.json"

        json_str = json.dumps(data, indent=2)
        file_size = len(json_str.encode("utf-8"))

        can_upload, error_msg = self.can_upload(user_id, file_size, category)
        if not can_upload:
            raise ValueError(error_msg)

        storage_path = get_storage_path(user_id, category)
        file_path = storage_path / stored_filename
        file_path.write_text(json_str, encoding="utf-8")

        now = datetime.utcnow().isoformat() + "Z"

        with self.db.get_cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO stored_files (id, user_id, category, filename, original_name, size_bytes, uploaded_at, description, metadata)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}')
                """,
                (file_id, user_id, category, stored_filename, original_name, file_size, now, description),
            )

        return StoredFile(
            id=file_id,
            user_id=user_id,
            category=category,
            filename=stored_filename,
            original_name=original_name,
            size_bytes=file_size,
            uploaded_at=now,
            description=description,
        )

    def get_file(self, file_id: str, user_id: Optional[str] = None) -> Optional[StoredFile]:
        """Get a file by ID. If user_id provided, checks access (user file OR default)."""
        with self.db.get_cursor() as cursor:
            if user_id:
                cursor.execute(
                    "SELECT * FROM stored_files WHERE id = ? AND (user_id = ? OR user_id IS NULL)",
                    (file_id, user_id),
                )
            else:
                cursor.execute("SELECT * FROM stored_files WHERE id = ?", (file_id,))

            row = cursor.fetchone()
            return StoredFile.from_row(row) if row else None

    def get_file_path(self, file_id: str, user_id: Optional[str] = None) -> Optional[Path]:
        """Return physical path of a file."""
        stored_file = self.get_file(file_id, user_id)
        if not stored_file:
            return None

        storage_path = get_storage_path(stored_file.user_id, stored_file.category)
        file_path = storage_path / stored_file.filename

        return file_path if file_path.exists() else None

    def read_json(self, file_id: str, user_id: Optional[str] = None) -> Optional[Dict]:
        """Read and return JSON file content."""
        file_path = self.get_file_path(file_id, user_id)
        if not file_path:
            return None

        try:
            return json.loads(file_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return None

    def list_files(self, user_id: str, category: Optional[str] = None, include_default: bool = True) -> List[StoredFile]:
        """List files accessible by a user. Includes default (DEMO) files if include_default=True."""
        with self.db.get_cursor() as cursor:
            if category:
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
                cursor.execute(
                    "SELECT * FROM stored_files WHERE user_id IS NULL AND category = ? ORDER BY original_name",
                    (category,),
                )
            else:
                cursor.execute("SELECT * FROM stored_files WHERE user_id IS NULL ORDER BY category, original_name")
            return [StoredFile.from_row(row) for row in cursor.fetchall()]

    def count_files(self, user_id: str, category: Optional[str] = None) -> int:
        """Count user files."""
        with self.db.get_cursor() as cursor:
            if category:
                cursor.execute(
                    "SELECT COUNT(*) as cnt FROM stored_files WHERE user_id = ? AND category = ?",
                    (user_id, category),
                )
            else:
                cursor.execute("SELECT COUNT(*) as cnt FROM stored_files WHERE user_id = ?", (user_id,))
            return cursor.fetchone()["cnt"]

    def delete_file(self, file_id: str, user_id: str) -> bool:
        """Delete a user file (not default files)."""
        stored_file = self.get_file(file_id, user_id)

        if not stored_file:
            return False

        if stored_file.is_default:
            raise ValueError("Impossible de supprimer un fichier de démonstration")

        if stored_file.user_id != user_id:
            raise ValueError("Accès non autorisé")

        storage_path = get_storage_path(user_id, stored_file.category)
        file_path = storage_path / stored_file.filename

        if file_path.exists():
            file_path.unlink()

        with self.db.get_cursor() as cursor:
            cursor.execute("DELETE FROM stored_files WHERE id = ? AND user_id = ?", (file_id, user_id))
            return cursor.rowcount > 0

    def update_file(self, file_id: str, user_id: str, description: Optional[str] = None, metadata: Optional[Dict] = None) -> bool:
        """Update file metadata."""
        stored_file = self.get_file(file_id, user_id)

        if not stored_file or stored_file.is_default or stored_file.user_id != user_id:
            return False

        updates = []
        params = []

        if description is not None:
            updates.append("description = ?")
            params.append(description)

        if metadata is not None:
            updates.append("metadata = ?")
            params.append(json.dumps(metadata))

        if not updates:
            return True

        params.append(file_id)

        with self.db.get_cursor() as cursor:
            cursor.execute(f"UPDATE stored_files SET {', '.join(updates)} WHERE id = ?", params)
            return cursor.rowcount > 0


# Initialization

storage = StorageManager(db)

# Flask Blueprint

storage_bp = Blueprint("storage", __name__)


@storage_bp.route("/api/storage/info", methods=["GET"])
@login_required
def get_storage_info():
    """Return storage info for current user."""
    user = g.current_user
    info = storage.get_storage_info(user.id)
    info["categories"] = {k: v["name"] for k, v in CATEGORIES.items()}
    return jsonify(info)


@storage_bp.route("/api/storage/files", methods=["GET"])
@login_required
def list_files():
    """List user files."""
    user = g.current_user
    category = request.args.get("category")
    include_default = request.args.get("include_default", "true").lower() == "true"

    if category and category not in CATEGORIES:
        return jsonify({"error": "Catégorie invalide"}), 400

    files = storage.list_files(user.id, category, include_default)

    return jsonify({"files": [f.to_dict() for f in files], "count": len(files)})


@storage_bp.route("/api/storage/files/<category>", methods=["POST"])
@login_required
def upload_file(category):
    """Upload a file to a category."""
    user = g.current_user

    if category not in CATEGORIES:
        return jsonify({"error": "Catégorie invalide"}), 400

    if "file" not in request.files:
        return jsonify({"error": "Aucun fichier fourni"}), 400

    file = request.files["file"]
    if file.filename == "":
        return jsonify({"error": "Nom de fichier vide"}), 400

    description = request.form.get("description", "")

    try:
        stored_file = storage.save_file(user.id, category, file, description)
        return jsonify({"success": True, "file": stored_file.to_dict(), "storage": storage.get_storage_info(user.id)}), 201
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
    content = data.get("content", {})
    description = data.get("description", "")

    try:
        stored_file = storage.save_json(user.id, category, name, content, description)
        return jsonify({"success": True, "file": stored_file.to_dict()}), 201
    except ValueError as e:
        return jsonify({"error": str(e)}), 400


@storage_bp.route("/api/storage/files/<file_id>", methods=["GET"])
@login_required
def get_file_info(file_id):
    """Get file info."""
    user = g.current_user
    stored_file = storage.get_file(file_id, user.id)

    if not stored_file:
        return jsonify({"error": "Fichier non trouvé"}), 404

    return jsonify({"file": stored_file.to_dict()})


@storage_bp.route("/api/storage/files/<file_id>/download", methods=["GET"])
@login_required
def download_file(file_id):
    """Download a file."""
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
    user = g.current_user
    data = request.get_json()

    try:
        success = storage.update_file(file_id, user.id, description=data.get("description"), metadata=data.get("metadata"))

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
    user = g.current_user

    try:
        if storage.delete_file(file_id, user.id):
            return jsonify({"success": True, "storage": storage.get_storage_info(user.id)})
        return jsonify({"error": "Fichier non trouvé"}), 404
    except ValueError as e:
        return jsonify({"error": str(e)}), 403


# Public routes (DEMO files)

@storage_bp.route("/api/storage/default", methods=["GET"])
def list_default_files_route():
    """List default (DEMO) files - accessible to all."""
    category = request.args.get("category")

    if category and category not in CATEGORIES:
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
    stored_file = storage.get_file(file_id)

    if not stored_file or not stored_file.is_default:
        return jsonify({"error": "Fichier non trouvé"}), 404

    file_path = storage.get_file_path(file_id)

    if not file_path:
        return jsonify({"error": "Fichier introuvable"}), 404

    return send_file(file_path, as_attachment=True, download_name=stored_file.original_name)


# Admin routes

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
    data = request.get_json()
    quota_gb = data.get("quota_gb")

    if quota_gb is None or quota_gb < 0:
        return jsonify({"error": "Quota invalide"}), 400

    quota_bytes = int(quota_gb * 1024 * 1024 * 1024)
    storage.set_quota(user_id, quota_bytes)

    return jsonify({"success": True, "quota_bytes": quota_bytes, "quota_human": format_size(quota_bytes)})