"""
Baltimore Bird - API d'authentification et gestion des utilisateurs.

Fonctionnalités:
- Inscription / Connexion / Déconnexion
- Gestion des sessions (tokens)
- Rate limiting contre brute force
- Administration des utilisateurs
"""

import json
import secrets
import sqlite3
import threading
import time
import uuid
from collections import defaultdict
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from functools import wraps
from typing import Any, Callable, Dict, List, Optional, Set

import bcrypt
from flask import Blueprint, g, jsonify, request

from config import (
    AUTH_DATABASE_PATH,
    AUTH_SECRET_KEY,
    AUTH_TOKEN_EXPIRY_HOURS,
    RATE_LIMIT_LOCKOUT,
    RATE_LIMIT_MAX_ATTEMPTS,
    RATE_LIMIT_WINDOW,
)

auth_bp = Blueprint("auth", __name__)


class RateLimiter:
    """Protection contre le brute force avec sliding window."""

    def __init__(self):
        self._attempts: Dict[str, List[float]] = defaultdict(list)
        self._lockouts: Dict[str, float] = {}
        self._lock = threading.Lock()

    def _cleanup_old_attempts(self, key: str, now: float) -> None:
        cutoff = now - RATE_LIMIT_WINDOW
        self._attempts[key] = [t for t in self._attempts[key] if t > cutoff]

    def is_locked(self, key: str) -> tuple[bool, int]:
        with self._lock:
            now = time.time()
            if key in self._lockouts:
                remaining = self._lockouts[key] - now
                if remaining > 0:
                    return True, int(remaining)
                del self._lockouts[key]
            return False, 0

    def record_attempt(self, key: str) -> tuple[bool, int]:
        with self._lock:
            now = time.time()

            if key in self._lockouts and self._lockouts[key] > now:
                return False, 0

            self._cleanup_old_attempts(key, now)
            self._attempts[key].append(now)

            attempt_count = len(self._attempts[key])
            remaining = RATE_LIMIT_MAX_ATTEMPTS - attempt_count

            if attempt_count >= RATE_LIMIT_MAX_ATTEMPTS:
                self._lockouts[key] = now + RATE_LIMIT_LOCKOUT
                self._attempts[key] = []
                return False, 0

            return True, remaining

    def reset(self, key: str) -> None:
        with self._lock:
            self._attempts.pop(key, None)
            self._lockouts.pop(key, None)


rate_limiter = RateLimiter()


@dataclass
class User:
    """Modèle utilisateur."""
    id: str
    email: str
    password_hash: str
    name: str = ""
    role: str = "user"
    created_at: str = ""
    last_login: str = ""
    is_active: bool = True
    settings: Dict[str, Any] = field(default_factory=dict)

    def to_public_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "email": self.email,
            "name": self.name,
            "role": self.role,
            "created_at": self.created_at,
            "last_login": self.last_login,
            "is_active": self.is_active,
            "settings": self.settings
        }

    @classmethod
    def from_row(cls, row: sqlite3.Row) -> "User":
        settings = {}
        if row["settings"]:
            try:
                settings = json.loads(row["settings"])
            except (json.JSONDecodeError, TypeError):
                pass

        return cls(
            id=row["id"],
            email=row["email"],
            password_hash=row["password_hash"],
            name=row["name"] or "",
            role=row["role"] or "user",
            created_at=row["created_at"] or "",
            last_login=row["last_login"] or "",
            is_active=bool(row["is_active"]),
            settings=settings
        )


@dataclass
class Session:
    """Session utilisateur (token)."""
    token: str
    user_id: str
    created_at: str
    expires_at: str
    ip_address: str = ""
    user_agent: str = ""

    @classmethod
    def from_row(cls, row: sqlite3.Row) -> "Session":
        return cls(
            token=row["token"],
            user_id=row["user_id"],
            created_at=row["created_at"],
            expires_at=row["expires_at"],
            ip_address=row["ip_address"] or "",
            user_agent=row["user_agent"] or ""
        )


class Database:
    """Gestionnaire de base de données SQLite thread-safe."""

    def __init__(self, db_path):
        self.db_path = db_path
        self._local = threading.local()
        self._init_db()

    def _get_connection(self) -> sqlite3.Connection:
        if not hasattr(self._local, "connection") or self._local.connection is None:
            self._local.connection = sqlite3.connect(str(self.db_path), check_same_thread=False)
            self._local.connection.row_factory = sqlite3.Row
            self._local.connection.execute("PRAGMA foreign_keys = ON")
        return self._local.connection

    @contextmanager
    def get_cursor(self):
        conn = self._get_connection()
        cursor = conn.cursor()
        try:
            yield cursor
            conn.commit()
        except Exception as e:
            conn.rollback()
            raise e

    def _init_db(self) -> None:
        with self.get_cursor() as cursor:
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS users (
                    id TEXT PRIMARY KEY,
                    email TEXT UNIQUE NOT NULL COLLATE NOCASE,
                    password_hash TEXT NOT NULL,
                    name TEXT DEFAULT '',
                    role TEXT DEFAULT 'user' CHECK(role IN ('user', 'admin')),
                    created_at TEXT NOT NULL,
                    last_login TEXT,
                    is_active INTEGER DEFAULT 1,
                    settings TEXT DEFAULT '{}'
                )
            """)
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)")

            cursor.execute("""
                CREATE TABLE IF NOT EXISTS sessions (
                    token TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    expires_at TEXT NOT NULL,
                    ip_address TEXT DEFAULT '',
                    user_agent TEXT DEFAULT '',
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                )
            """)
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)")
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)")


db = Database(AUTH_DATABASE_PATH)


class UserStore:
    """Gestionnaire de persistance des utilisateurs."""

    def __init__(self, database: Database):
        self.db = database

    def get_by_email(self, email: str) -> Optional[User]:
        with self.db.get_cursor() as cursor:
            cursor.execute("SELECT * FROM users WHERE email = ? COLLATE NOCASE", (email,))
            row = cursor.fetchone()
            return User.from_row(row) if row else None

    def get_by_id(self, user_id: str) -> Optional[User]:
        with self.db.get_cursor() as cursor:
            cursor.execute("SELECT * FROM users WHERE id = ?", (user_id,))
            row = cursor.fetchone()
            return User.from_row(row) if row else None

    def create(self, email: str, password_hash: str, name: str = "", role: str = "user") -> User:
        user_id = str(uuid.uuid4())
        now = datetime.utcnow().isoformat() + "Z"

        with self.db.get_cursor() as cursor:
            cursor.execute(
                """INSERT INTO users (id, email, password_hash, name, role, created_at, is_active, settings)
                   VALUES (?, ?, ?, ?, ?, ?, 1, '{}')""",
                (user_id, email, password_hash, name, role, now)
            )

        return User(
            id=user_id,
            email=email,
            password_hash=password_hash,
            name=name,
            role=role,
            created_at=now,
            is_active=True
        )

    def update(self, user: User) -> None:
        with self.db.get_cursor() as cursor:
            cursor.execute(
                """UPDATE users SET name = ?, role = ?, is_active = ?, settings = ?, last_login = ?, password_hash = ?
                   WHERE id = ?""",
                (user.name, user.role, int(user.is_active), json.dumps(user.settings),
                 user.last_login, user.password_hash, user.id)
            )

    def delete(self, user_id: str) -> bool:
        with self.db.get_cursor() as cursor:
            cursor.execute("DELETE FROM users WHERE id = ?", (user_id,))
            return cursor.rowcount > 0

    def list_all(self) -> List[User]:
        with self.db.get_cursor() as cursor:
            cursor.execute("SELECT * FROM users ORDER BY created_at DESC")
            return [User.from_row(row) for row in cursor.fetchall()]

    def count_by_role(self) -> Dict[str, int]:
        with self.db.get_cursor() as cursor:
            cursor.execute("SELECT role, COUNT(*) as count FROM users GROUP BY role")
            return {row["role"]: row["count"] for row in cursor.fetchall()}

    def count_active(self) -> int:
        with self.db.get_cursor() as cursor:
            cursor.execute("SELECT COUNT(*) as count FROM users WHERE is_active = 1")
            return cursor.fetchone()["count"]

    def create_session(self, user: User, ip_address: str, user_agent: str) -> Session:
        token = secrets.token_urlsafe(32)
        now = datetime.utcnow()
        expires = now + timedelta(hours=AUTH_TOKEN_EXPIRY_HOURS)

        with self.db.get_cursor() as cursor:
            cursor.execute(
                """INSERT INTO sessions (token, user_id, created_at, expires_at, ip_address, user_agent)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (token, user.id, now.isoformat() + "Z", expires.isoformat() + "Z",
                 ip_address[:50], user_agent[:200])
            )

        return Session(
            token=token,
            user_id=user.id,
            created_at=now.isoformat() + "Z",
            expires_at=expires.isoformat() + "Z",
            ip_address=ip_address,
            user_agent=user_agent
        )

    def get_session(self, token: str) -> Optional[Session]:
        with self.db.get_cursor() as cursor:
            cursor.execute("SELECT * FROM sessions WHERE token = ?", (token,))
            row = cursor.fetchone()
            if not row:
                return None

            session = Session.from_row(row)
            expires = datetime.fromisoformat(session.expires_at.replace("Z", "+00:00"))
            if expires < datetime.now(expires.tzinfo):
                cursor.execute("DELETE FROM sessions WHERE token = ?", (token,))
                return None

            return session

    def delete_session(self, token: str) -> None:
        with self.db.get_cursor() as cursor:
            cursor.execute("DELETE FROM sessions WHERE token = ?", (token,))

    def delete_user_sessions(self, user_id: str) -> None:
        with self.db.get_cursor() as cursor:
            cursor.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))

    def get_user_sessions_count(self, user_id: str) -> int:
        with self.db.get_cursor() as cursor:
            cursor.execute("SELECT COUNT(*) as count FROM sessions WHERE user_id = ?", (user_id,))
            return cursor.fetchone()["count"]

    def cleanup_expired_sessions(self) -> int:
        now = datetime.utcnow().isoformat() + "Z"
        with self.db.get_cursor() as cursor:
            cursor.execute("DELETE FROM sessions WHERE expires_at < ?", (now,))
            return cursor.rowcount


user_store = UserStore(db)


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))
    except Exception:
        return False


def validate_email(email: str) -> tuple[bool, str]:
    import re
    if not email or len(email) > 254:
        return False, "Email invalide"
    pattern = r"^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$"
    if not re.match(pattern, email):
        return False, "Format d'email invalide"
    return True, ""


def validate_password(password: str) -> tuple[bool, str]:
    if not password or len(password) < 8:
        return False, "Le mot de passe doit contenir au moins 8 caractères"
    if len(password) > 128:
        return False, "Le mot de passe est trop long"
    return True, ""


def get_client_ip() -> str:
    return request.headers.get("X-Real-IP") or request.remote_addr or "unknown"


def get_current_user() -> Optional[User]:
    auth_header = request.headers.get("Authorization")
    if not auth_header or not auth_header.startswith("Bearer "):
        return None

    token = auth_header[7:]
    session = user_store.get_session(token)
    if not session:
        return None

    user = user_store.get_by_id(session.user_id)
    if not user or not user.is_active:
        return None

    return user


def login_required(f: Callable) -> Callable:
    """Décorateur: authentification requise."""
    @wraps(f)
    def decorated(*args, **kwargs):
        user = get_current_user()
        if not user:
            return jsonify({"error": "Authentification requise"}), 401
        g.current_user = user
        return f(*args, **kwargs)
    return decorated


def admin_required(f: Callable) -> Callable:
    """Décorateur: rôle admin requis."""
    @wraps(f)
    def decorated(*args, **kwargs):
        user = get_current_user()
        if not user:
            return jsonify({"error": "Authentification requise"}), 401
        if user.role != "admin":
            return jsonify({"error": "Accès administrateur requis"}), 403
        g.current_user = user
        return f(*args, **kwargs)
    return decorated


def optional_auth(f: Callable) -> Callable:
    """Décorateur: authentification optionnelle."""
    @wraps(f)
    def decorated(*args, **kwargs):
        g.current_user = get_current_user()
        return f(*args, **kwargs)
    return decorated


FEATURE_ACCESS: Dict[str, Set[str]] = {
    "public": {"view_eda", "view_reports", "convert_files"},
    "user": {
        "view_eda", "view_reports", "convert_files", "create_scripts",
        "run_scripts", "save_layouts", "create_mappings", "upload_files"
    },
    "admin": {
        "view_eda", "view_reports", "convert_files", "create_scripts",
        "run_scripts", "save_layouts", "create_mappings", "upload_files",
        "manage_users", "view_metrics", "delete_reports"
    }
}


def has_feature_access(feature: str, user: Optional[User] = None) -> bool:
    if user is None:
        return feature in FEATURE_ACCESS["public"]
    role = user.role if user.role in FEATURE_ACCESS else "user"
    return feature in FEATURE_ACCESS[role]


def feature_required(feature: str) -> Callable:
    """Décorateur: vérifie l'accès à une feature."""
    def decorator(f: Callable) -> Callable:
        @wraps(f)
        def decorated(*args, **kwargs):
            user = get_current_user()
            if not has_feature_access(feature, user):
                if user is None:
                    return jsonify({"error": "Authentification requise pour cette fonctionnalité"}), 401
                return jsonify({"error": "Accès non autorisé à cette fonctionnalité"}), 403
            g.current_user = user
            return f(*args, **kwargs)
        return decorated
    return decorator


@auth_bp.route("/api/auth/register", methods=["POST"])
def register():
    """Inscription d'un nouvel utilisateur."""
    data = request.get_json()
    if not data:
        return jsonify({"error": "Données requises"}), 400

    email = (data.get("email") or "").strip().lower()
    password = data.get("password", "")
    name = (data.get("name") or "").strip()[:100]

    valid, msg = validate_email(email)
    if not valid:
        return jsonify({"error": msg}), 400

    valid, msg = validate_password(password)
    if not valid:
        return jsonify({"error": msg}), 400

    if user_store.get_by_email(email):
        return jsonify({"error": "Cet email est déjà utilisé"}), 409

    password_hash = hash_password(password)
    role = "admin" if user_store.count_active() == 0 else "user"
    user = user_store.create(email, password_hash, name, role)

    client_ip = get_client_ip()
    user_agent = request.headers.get("User-Agent", "")[:200]
    session = user_store.create_session(user, client_ip, user_agent)

    return jsonify({
        "success": True,
        "user": user.to_public_dict(),
        "token": session.token,
        "expires_at": session.expires_at
    }), 201


@auth_bp.route("/api/auth/login", methods=["POST"])
def login():
    """Connexion utilisateur."""
    client_ip = get_client_ip()

    locked, remaining = rate_limiter.is_locked(client_ip)
    if locked:
        return jsonify({"error": f"Trop de tentatives. Réessayez dans {remaining // 60} minutes."}), 429

    data = request.get_json()
    if not data:
        return jsonify({"error": "Données requises"}), 400

    email = (data.get("email") or "").strip().lower()
    password = data.get("password", "")

    if not email or not password:
        return jsonify({"error": "Email et mot de passe requis"}), 400

    allowed, attempts_left = rate_limiter.record_attempt(client_ip)
    if not allowed:
        return jsonify({"error": "Trop de tentatives. Compte temporairement verrouillé."}), 429

    user = user_store.get_by_email(email)
    if not user or not verify_password(password, user.password_hash):
        return jsonify({"error": f"Identifiants incorrects. {attempts_left} tentative(s) restante(s)."}), 401

    if not user.is_active:
        return jsonify({"error": "Ce compte a été désactivé"}), 403

    rate_limiter.reset(client_ip)

    user.last_login = datetime.utcnow().isoformat() + "Z"
    user_store.update(user)

    user_agent = request.headers.get("User-Agent", "")[:200]
    session = user_store.create_session(user, client_ip, user_agent)

    return jsonify({
        "success": True,
        "user": user.to_public_dict(),
        "token": session.token,
        "expires_at": session.expires_at
    })


@auth_bp.route("/api/auth/logout", methods=["POST"])
def logout():
    """Déconnexion."""
    auth_header = request.headers.get("Authorization")
    if auth_header and auth_header.startswith("Bearer "):
        token = auth_header[7:]
        user_store.delete_session(token)
    return jsonify({"success": True})


@auth_bp.route("/api/auth/me", methods=["GET"])
@login_required
def get_current_user_info():
    """Récupère les infos de l'utilisateur connecté."""
    return jsonify({"user": g.current_user.to_public_dict()})


@auth_bp.route("/api/auth/me", methods=["PUT"])
@login_required
def update_current_user():
    """Met à jour le profil de l'utilisateur connecté."""
    data = request.get_json()
    if not data:
        return jsonify({"error": "Données requises"}), 400

    user = g.current_user

    if "name" in data:
        user.name = str(data["name"]).strip()[:100]

    if "settings" in data and isinstance(data["settings"], dict):
        settings_str = json.dumps(data["settings"])
        if len(settings_str) <= 10000:
            user.settings.update(data["settings"])

    user_store.update(user)
    return jsonify({"success": True, "user": user.to_public_dict()})


@auth_bp.route("/api/auth/change-password", methods=["POST"])
@login_required
def change_password():
    """Change le mot de passe."""
    data = request.get_json()
    if not data:
        return jsonify({"error": "Données requises"}), 400

    current_password = data.get("current_password", "")
    new_password = data.get("new_password", "")

    if not current_password or not new_password:
        return jsonify({"error": "Mot de passe actuel et nouveau requis"}), 400

    user = g.current_user

    if not verify_password(current_password, user.password_hash):
        return jsonify({"error": "Mot de passe actuel incorrect"}), 401

    valid, msg = validate_password(new_password)
    if not valid:
        return jsonify({"error": msg}), 400

    user.password_hash = hash_password(new_password)
    user_store.update(user)
    user_store.delete_user_sessions(user.id)

    client_ip = get_client_ip()
    user_agent = request.headers.get("User-Agent", "")[:200]
    new_session = user_store.create_session(user, client_ip, user_agent)

    return jsonify({
        "success": True,
        "message": "Mot de passe modifié. Toutes les autres sessions ont été déconnectées.",
        "token": new_session.token,
        "expires_at": new_session.expires_at
    })


@auth_bp.route("/api/auth/features", methods=["GET"])
@optional_auth
def get_user_features():
    """Retourne les features accessibles à l'utilisateur."""
    user = g.current_user

    if user is None:
        features = list(FEATURE_ACCESS["public"])
        role = "anonymous"
    else:
        role = user.role if user.role in FEATURE_ACCESS else "user"
        features = list(FEATURE_ACCESS[role])

    return jsonify({
        "role": role,
        "features": sorted(features),
        "authenticated": user is not None
    })


@auth_bp.route("/api/admin/users", methods=["GET"])
@admin_required
def list_users():
    """Liste tous les utilisateurs (admin)."""
    users = user_store.list_all()
    return jsonify({
        "users": [u.to_public_dict() for u in users],
        "count": len(users),
        "stats": {
            "by_role": user_store.count_by_role(),
            "active": user_store.count_active()
        }
    })


@auth_bp.route("/api/admin/users/<user_id>", methods=["GET"])
@admin_required
def get_user(user_id: str):
    """Récupère un utilisateur (admin)."""
    try:
        uuid.UUID(user_id)
    except ValueError:
        return jsonify({"error": "ID utilisateur invalide"}), 400

    user = user_store.get_by_id(user_id)
    if not user:
        return jsonify({"error": "Utilisateur non trouvé"}), 404

    return jsonify({
        "user": user.to_public_dict(),
        "sessions": user_store.get_user_sessions_count(user_id)
    })


@auth_bp.route("/api/admin/users/<user_id>", methods=["PUT"])
@admin_required
def update_user(user_id: str):
    """Met à jour un utilisateur (admin)."""
    try:
        uuid.UUID(user_id)
    except ValueError:
        return jsonify({"error": "ID utilisateur invalide"}), 400

    user = user_store.get_by_id(user_id)
    if not user:
        return jsonify({"error": "Utilisateur non trouvé"}), 404

    data = request.get_json()
    if not data:
        return jsonify({"error": "Données requises"}), 400

    if "name" in data:
        user.name = str(data["name"])[:100]

    if "role" in data and data["role"] in ["user", "admin"]:
        if user_id == g.current_user.id and data["role"] != "admin":
            admin_count = user_store.count_by_role().get("admin", 0)
            if admin_count <= 1:
                return jsonify({"error": "Impossible: vous êtes le seul administrateur"}), 400
        user.role = data["role"]

    if "is_active" in data:
        user.is_active = bool(data["is_active"])
        if not user.is_active:
            user_store.delete_user_sessions(user_id)

    user_store.update(user)
    return jsonify({"success": True, "user": user.to_public_dict()})


@auth_bp.route("/api/admin/users/<user_id>", methods=["DELETE"])
@admin_required
def delete_user(user_id: str):
    """Supprime un utilisateur (admin)."""
    try:
        uuid.UUID(user_id)
    except ValueError:
        return jsonify({"error": "ID utilisateur invalide"}), 400

    if user_id == g.current_user.id:
        return jsonify({"error": "Impossible de supprimer votre propre compte"}), 400

    if user_store.delete(user_id):
        return jsonify({"success": True})
    return jsonify({"error": "Utilisateur non trouvé"}), 404


@auth_bp.route("/api/admin/sessions/cleanup", methods=["POST"])
@admin_required
def cleanup_sessions():
    """Nettoie les sessions expirées (admin)."""
    count = user_store.cleanup_expired_sessions()
    return jsonify({
        "success": True,
        "cleaned": count,
        "message": f"{count} session(s) expirée(s) supprimée(s)"
    })
