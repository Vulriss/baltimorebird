"""
Auth Module - Gestion des utilisateurs et authentification avec SQLite
Utilise des requêtes paramétrées pour la protection contre les injections SQL
"""

import os
import sqlite3
import uuid
import hashlib
import secrets
import threading
from datetime import datetime, timedelta
from pathlib import Path
from functools import wraps
from typing import Optional, Dict, Any, List
from dataclasses import dataclass, field
from contextlib import contextmanager
import json

from flask import Blueprint, request, jsonify, g

# =============================================================================
# Configuration
# =============================================================================

# Clé secrète pour les tokens de session
# EN PRODUCTION: définir AUTH_SECRET_KEY dans les variables d'environnement
# Exemple: export AUTH_SECRET_KEY="votre-clé-secrète-de-64-caractères-minimum"
SECRET_KEY = os.environ.get('AUTH_SECRET_KEY')

if not SECRET_KEY:
    # Génère une clé aléatoire si non définie (dev uniquement)
    SECRET_KEY = secrets.token_hex(32)
    print("  ⚠ AUTH_SECRET_KEY non définie - clé temporaire générée (dev mode)")

# Durée de validité des tokens (configurable via env)
TOKEN_EXPIRY_HOURS = int(os.environ.get('AUTH_TOKEN_EXPIRY_HOURS', 24 * 7))  # 7 jours par défaut

# Chemin vers la base de données
AUTH_DATA_DIR = Path(__file__).parent / "data" / "auth"
AUTH_DATA_DIR.mkdir(parents=True, exist_ok=True)
DATABASE_PATH = AUTH_DATA_DIR / "users.db"

# =============================================================================
# Modèles
# =============================================================================

@dataclass
class User:
    """Modèle utilisateur"""
    id: str
    email: str
    password_hash: str
    name: str = ""
    role: str = "user"  # 'user', 'admin'
    created_at: str = ""
    last_login: str = ""
    is_active: bool = True
    settings: Dict[str, Any] = field(default_factory=dict)
    
    def to_public_dict(self) -> Dict[str, Any]:
        """Retourne les infos publiques (sans le mot de passe)"""
        return {
            'id': self.id,
            'email': self.email,
            'name': self.name,
            'role': self.role,
            'created_at': self.created_at,
            'last_login': self.last_login,
            'is_active': self.is_active,
            'settings': self.settings
        }
    
    @classmethod
    def from_row(cls, row: sqlite3.Row) -> 'User':
        """Crée un User depuis une row SQLite"""
        settings = {}
        if row['settings']:
            try:
                settings = json.loads(row['settings'])
            except:
                pass
        
        return cls(
            id=row['id'],
            email=row['email'],
            password_hash=row['password_hash'],
            name=row['name'] or "",
            role=row['role'] or "user",
            created_at=row['created_at'] or "",
            last_login=row['last_login'] or "",
            is_active=bool(row['is_active']),
            settings=settings
        )


@dataclass
class Session:
    """Session utilisateur (token)"""
    token: str
    user_id: str
    created_at: str
    expires_at: str
    ip_address: str = ""
    user_agent: str = ""
    
    @classmethod
    def from_row(cls, row: sqlite3.Row) -> 'Session':
        """Crée une Session depuis une row SQLite"""
        return cls(
            token=row['token'],
            user_id=row['user_id'],
            created_at=row['created_at'],
            expires_at=row['expires_at'],
            ip_address=row['ip_address'] or "",
            user_agent=row['user_agent'] or ""
        )


# =============================================================================
# Base de données SQLite avec protection contre les injections SQL
# =============================================================================

class Database:
    """Gestionnaire de base de données SQLite thread-safe"""
    
    def __init__(self, db_path: Path):
        self.db_path = db_path
        self._local = threading.local()
        self._init_db()
    
    def _get_connection(self) -> sqlite3.Connection:
        """Récupère une connexion thread-local"""
        if not hasattr(self._local, 'connection') or self._local.connection is None:
            self._local.connection = sqlite3.connect(
                str(self.db_path),
                check_same_thread=False
            )
            self._local.connection.row_factory = sqlite3.Row
            # Active les clés étrangères
            self._local.connection.execute("PRAGMA foreign_keys = ON")
        return self._local.connection
    
    @contextmanager
    def get_cursor(self):
        """Context manager pour obtenir un curseur avec commit/rollback automatique"""
        conn = self._get_connection()
        cursor = conn.cursor()
        try:
            yield cursor
            conn.commit()
        except Exception as e:
            conn.rollback()
            raise e
    
    def _init_db(self):
        """Initialise le schéma de la base de données"""
        with self.get_cursor() as cursor:
            # Table des utilisateurs
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
            
            # Index sur l'email pour les recherches rapides
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)
            """)
            
            # Table des sessions
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
            
            # Index sur user_id et expires_at
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)
            """)
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)
            """)
        
        print(f"  ✓ SQLite database: {self.db_path}")


class UserStore:
    """Gestion du stockage des utilisateurs avec SQLite"""
    
    def __init__(self, db: Database):
        self.db = db
        self._count_users()
    
    def _count_users(self):
        """Compte et affiche le nombre d'utilisateurs"""
        with self.db.get_cursor() as cursor:
            cursor.execute("SELECT COUNT(*) FROM users")
            count = cursor.fetchone()[0]
            print(f"  ✓ Auth: {count} utilisateur(s) en base")
    
    # =========================================================================
    # CRUD Utilisateurs - Toutes les requêtes utilisent des paramètres
    # =========================================================================
    
    def get_by_id(self, user_id: str) -> Optional[User]:
        """Récupère un utilisateur par ID (paramétré contre injection SQL)"""
        with self.db.get_cursor() as cursor:
            cursor.execute(
                "SELECT * FROM users WHERE id = ?",
                (user_id,)
            )
            row = cursor.fetchone()
            return User.from_row(row) if row else None
    
    def get_by_email(self, email: str) -> Optional[User]:
        """Récupère un utilisateur par email (paramétré contre injection SQL)"""
        with self.db.get_cursor() as cursor:
            cursor.execute(
                "SELECT * FROM users WHERE email = ? COLLATE NOCASE",
                (email.lower(),)
            )
            row = cursor.fetchone()
            return User.from_row(row) if row else None
    
    def create(self, email: str, password: str, name: str = "", role: str = "user") -> User:
        """Crée un nouvel utilisateur (paramétré contre injection SQL)"""
        if self.get_by_email(email):
            raise ValueError("Un utilisateur avec cet email existe déjà")
        
        if role not in ('user', 'admin'):
            role = 'user'
        
        user_id = str(uuid.uuid4())
        now = datetime.utcnow().isoformat() + 'Z'
        password_hash = hash_password(password)
        settings_json = '{}'
        
        with self.db.get_cursor() as cursor:
            cursor.execute("""
                INSERT INTO users (id, email, password_hash, name, role, created_at, is_active, settings)
                VALUES (?, ?, ?, ?, ?, ?, 1, ?)
            """, (
                user_id,
                email.lower(),
                password_hash,
                name,
                role,
                now,
                settings_json
            ))
        
        return User(
            id=user_id,
            email=email.lower(),
            password_hash=password_hash,
            name=name,
            role=role,
            created_at=now,
            is_active=True,
            settings={}
        )
    
    def update(self, user: User):
        """Met à jour un utilisateur (paramétré contre injection SQL)"""
        settings_json = json.dumps(user.settings)
        
        with self.db.get_cursor() as cursor:
            cursor.execute("""
                UPDATE users SET
                    email = ?,
                    password_hash = ?,
                    name = ?,
                    role = ?,
                    last_login = ?,
                    is_active = ?,
                    settings = ?
                WHERE id = ?
            """, (
                user.email,
                user.password_hash,
                user.name,
                user.role,
                user.last_login,
                1 if user.is_active else 0,
                settings_json,
                user.id
            ))
    
    def delete(self, user_id: str) -> bool:
        """Supprime un utilisateur (paramétré contre injection SQL)"""
        with self.db.get_cursor() as cursor:
            cursor.execute("DELETE FROM users WHERE id = ?", (user_id,))
            return cursor.rowcount > 0
    
    def list_all(self) -> List[User]:
        """Liste tous les utilisateurs"""
        with self.db.get_cursor() as cursor:
            cursor.execute("SELECT * FROM users ORDER BY created_at DESC")
            return [User.from_row(row) for row in cursor.fetchall()]
    
    def count_by_role(self) -> Dict[str, int]:
        """Compte les utilisateurs par rôle"""
        with self.db.get_cursor() as cursor:
            cursor.execute("SELECT role, COUNT(*) as count FROM users GROUP BY role")
            return {row['role']: row['count'] for row in cursor.fetchall()}
    
    def count_active(self) -> int:
        """Compte les utilisateurs actifs"""
        with self.db.get_cursor() as cursor:
            cursor.execute("SELECT COUNT(*) FROM users WHERE is_active = 1")
            return cursor.fetchone()[0]
    
    # =========================================================================
    # Sessions
    # =========================================================================
    
    def create_session(self, user: User, ip: str = "", user_agent: str = "") -> Session:
        """Crée une nouvelle session"""
        now = datetime.utcnow()
        expires = now + timedelta(hours=TOKEN_EXPIRY_HOURS)
        token = generate_token()
        
        with self.db.get_cursor() as cursor:
            cursor.execute("""
                INSERT INTO sessions (token, user_id, created_at, expires_at, ip_address, user_agent)
                VALUES (?, ?, ?, ?, ?, ?)
            """, (
                token,
                user.id,
                now.isoformat() + 'Z',
                expires.isoformat() + 'Z',
                ip,
                user_agent[:200] if user_agent else ""
            ))
        
        user.last_login = now.isoformat() + 'Z'
        self.update(user)
        
        return Session(
            token=token,
            user_id=user.id,
            created_at=now.isoformat() + 'Z',
            expires_at=expires.isoformat() + 'Z',
            ip_address=ip,
            user_agent=user_agent[:200] if user_agent else ""
        )
    
    def get_session(self, token: str) -> Optional[Session]:
        """Récupère une session par token"""
        with self.db.get_cursor() as cursor:
            cursor.execute("SELECT * FROM sessions WHERE token = ?", (token,))
            row = cursor.fetchone()
            
            if not row:
                return None
            
            session = Session.from_row(row)
            
            # Vérifie l'expiration
            expires = datetime.fromisoformat(session.expires_at.replace('Z', '+00:00'))
            if datetime.now(expires.tzinfo) > expires:
                self.delete_session(token)
                return None
            
            return session
    
    def delete_session(self, token: str) -> bool:
        """Supprime une session"""
        with self.db.get_cursor() as cursor:
            cursor.execute("DELETE FROM sessions WHERE token = ?", (token,))
            return cursor.rowcount > 0
    
    def delete_user_sessions(self, user_id: str):
        """Supprime toutes les sessions d'un utilisateur"""
        with self.db.get_cursor() as cursor:
            cursor.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
    
    def cleanup_expired_sessions(self) -> int:
        """Nettoie les sessions expirées"""
        now = datetime.utcnow().isoformat() + 'Z'
        with self.db.get_cursor() as cursor:
            cursor.execute("DELETE FROM sessions WHERE expires_at < ?", (now,))
            return cursor.rowcount
    
    def get_user_sessions_count(self, user_id: str) -> int:
        """Compte les sessions actives d'un utilisateur"""
        with self.db.get_cursor() as cursor:
            cursor.execute("SELECT COUNT(*) FROM sessions WHERE user_id = ?", (user_id,))
            return cursor.fetchone()[0]


# =============================================================================
# Initialisation
# =============================================================================

db = Database(DATABASE_PATH)
user_store = UserStore(db)


# =============================================================================
# Utilitaires de sécurité
# =============================================================================

def hash_password(password: str) -> str:
    """Hash un mot de passe avec SHA-256 + salt"""
    salt = secrets.token_hex(16)
    hash_obj = hashlib.sha256((salt + password).encode())
    return f"{salt}${hash_obj.hexdigest()}"


def verify_password(password: str, password_hash: str) -> bool:
    """Vérifie un mot de passe"""
    try:
        salt, hash_value = password_hash.split('$')
        hash_obj = hashlib.sha256((salt + password).encode())
        return hash_obj.hexdigest() == hash_value
    except:
        return False


def generate_token() -> str:
    """Génère un token de session sécurisé"""
    return secrets.token_urlsafe(32)


def validate_email(email: str) -> bool:
    """Validation basique d'email"""
    import re
    pattern = r'^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$'
    return bool(re.match(pattern, email))


def validate_password(password: str) -> tuple[bool, str]:
    """Valide la force du mot de passe"""
    if len(password) < 8:
        return False, "Le mot de passe doit contenir au moins 8 caractères"
    if not any(c.isupper() for c in password):
        return False, "Le mot de passe doit contenir au moins une majuscule"
    if not any(c.islower() for c in password):
        return False, "Le mot de passe doit contenir au moins une minuscule"
    if not any(c.isdigit() for c in password):
        return False, "Le mot de passe doit contenir au moins un chiffre"
    return True, ""


# =============================================================================
# Middleware & Décorateurs
# =============================================================================

def get_current_user() -> Optional[User]:
    """Récupère l'utilisateur courant depuis le token"""
    auth_header = request.headers.get('Authorization', '')
    
    if not auth_header.startswith('Bearer '):
        return None
    
    token = auth_header[7:]
    session = user_store.get_session(token)
    
    if not session:
        return None
    
    user = user_store.get_by_id(session.user_id)
    
    if not user or not user.is_active:
        return None
    
    return user


def login_required(f):
    """Décorateur: authentification requise"""
    @wraps(f)
    def decorated(*args, **kwargs):
        user = get_current_user()
        if not user:
            return jsonify({'error': 'Authentification requise'}), 401
        g.current_user = user
        return f(*args, **kwargs)
    return decorated


def admin_required(f):
    """Décorateur: droits admin requis"""
    @wraps(f)
    def decorated(*args, **kwargs):
        user = get_current_user()
        if not user:
            return jsonify({'error': 'Authentification requise'}), 401
        if user.role != 'admin':
            return jsonify({'error': 'Droits administrateur requis'}), 403
        g.current_user = user
        return f(*args, **kwargs)
    return decorated


def optional_auth(f):
    """Décorateur: authentification optionnelle"""
    @wraps(f)
    def decorated(*args, **kwargs):
        g.current_user = get_current_user()
        return f(*args, **kwargs)
    return decorated


# =============================================================================
# Blueprint Flask
# =============================================================================

auth_bp = Blueprint('auth', __name__)


@auth_bp.route('/api/auth/register', methods=['POST'])
def register():
    """Inscription d'un nouvel utilisateur"""
    data = request.get_json()
    
    if not data:
        return jsonify({'error': 'Données requises'}), 400
    
    email = data.get('email', '').strip()
    password = data.get('password', '')
    name = data.get('name', '').strip()
    
    if not email or not password:
        return jsonify({'error': 'Email et mot de passe requis'}), 400
    
    if not validate_email(email):
        return jsonify({'error': 'Format d\'email invalide'}), 400
    
    valid, msg = validate_password(password)
    if not valid:
        return jsonify({'error': msg}), 400
    
    try:
        # Premier utilisateur = admin
        with db.get_cursor() as cursor:
            cursor.execute("SELECT COUNT(*) FROM users")
            is_first = cursor.fetchone()[0] == 0
        
        role = 'admin' if is_first else 'user'
        user = user_store.create(email, password, name, role)
        
        ip = request.headers.get('X-Real-IP', request.remote_addr)
        user_agent = request.headers.get('User-Agent', '')
        session = user_store.create_session(user, ip, user_agent)
        
        return jsonify({
            'success': True,
            'user': user.to_public_dict(),
            'token': session.token,
            'expires_at': session.expires_at,
            'message': 'Compte créé avec succès' + (' (admin)' if is_first else '')
        }), 201
        
    except ValueError as e:
        return jsonify({'error': str(e)}), 409


@auth_bp.route('/api/auth/login', methods=['POST'])
def login():
    """Connexion utilisateur"""
    data = request.get_json()
    
    if not data:
        return jsonify({'error': 'Données requises'}), 400
    
    email = data.get('email', '').strip()
    password = data.get('password', '')
    
    if not email or not password:
        return jsonify({'error': 'Email et mot de passe requis'}), 400
    
    user = user_store.get_by_email(email)
    
    if not user or not verify_password(password, user.password_hash):
        return jsonify({'error': 'Email ou mot de passe incorrect'}), 401
    
    if not user.is_active:
        return jsonify({'error': 'Compte désactivé'}), 403
    
    ip = request.headers.get('X-Real-IP', request.remote_addr)
    user_agent = request.headers.get('User-Agent', '')
    session = user_store.create_session(user, ip, user_agent)
    
    return jsonify({
        'success': True,
        'user': user.to_public_dict(),
        'token': session.token,
        'expires_at': session.expires_at
    })


@auth_bp.route('/api/auth/logout', methods=['POST'])
@login_required
def logout():
    """Déconnexion"""
    auth_header = request.headers.get('Authorization', '')
    if auth_header.startswith('Bearer '):
        token = auth_header[7:]
        user_store.delete_session(token)
    
    return jsonify({'success': True})


@auth_bp.route('/api/auth/me', methods=['GET'])
@login_required
def get_current_user_info():
    """Récupère les infos de l'utilisateur connecté"""
    return jsonify({'user': g.current_user.to_public_dict()})


@auth_bp.route('/api/auth/me', methods=['PUT'])
@login_required
def update_current_user():
    """Met à jour le profil de l'utilisateur connecté"""
    data = request.get_json()
    user = g.current_user
    
    if 'name' in data:
        user.name = data['name'].strip()
    
    if 'settings' in data:
        user.settings.update(data['settings'])
    
    user_store.update(user)
    
    return jsonify({'success': True, 'user': user.to_public_dict()})


@auth_bp.route('/api/auth/change-password', methods=['POST'])
@login_required
def change_password():
    """Change le mot de passe"""
    data = request.get_json()
    
    current_password = data.get('current_password', '')
    new_password = data.get('new_password', '')
    
    if not current_password or not new_password:
        return jsonify({'error': 'Mot de passe actuel et nouveau requis'}), 400
    
    user = g.current_user
    
    if not verify_password(current_password, user.password_hash):
        return jsonify({'error': 'Mot de passe actuel incorrect'}), 401
    
    valid, msg = validate_password(new_password)
    if not valid:
        return jsonify({'error': msg}), 400
    
    user.password_hash = hash_password(new_password)
    user_store.update(user)
    
    return jsonify({'success': True, 'message': 'Mot de passe modifié'})


# =============================================================================
# Routes Admin
# =============================================================================

@auth_bp.route('/api/admin/users', methods=['GET'])
@admin_required
def list_users():
    """Liste tous les utilisateurs (admin)"""
    users = user_store.list_all()
    return jsonify({
        'users': [u.to_public_dict() for u in users],
        'count': len(users),
        'stats': {
            'by_role': user_store.count_by_role(),
            'active': user_store.count_active()
        }
    })


@auth_bp.route('/api/admin/users/<user_id>', methods=['GET'])
@admin_required
def get_user(user_id):
    """Récupère un utilisateur (admin)"""
    user = user_store.get_by_id(user_id)
    if not user:
        return jsonify({'error': 'Utilisateur non trouvé'}), 404
    return jsonify({
        'user': user.to_public_dict(),
        'sessions': user_store.get_user_sessions_count(user_id)
    })


@auth_bp.route('/api/admin/users/<user_id>', methods=['PUT'])
@admin_required
def update_user(user_id):
    """Met à jour un utilisateur (admin)"""
    user = user_store.get_by_id(user_id)
    if not user:
        return jsonify({'error': 'Utilisateur non trouvé'}), 404
    
    data = request.get_json()
    
    if 'name' in data:
        user.name = data['name']
    if 'role' in data and data['role'] in ['user', 'admin']:
        user.role = data['role']
    if 'is_active' in data:
        user.is_active = bool(data['is_active'])
        if not user.is_active:
            user_store.delete_user_sessions(user_id)
    
    user_store.update(user)
    
    return jsonify({'success': True, 'user': user.to_public_dict()})


@auth_bp.route('/api/admin/users/<user_id>', methods=['DELETE'])
@admin_required
def delete_user(user_id):
    """Supprime un utilisateur (admin)"""
    if user_id == g.current_user.id:
        return jsonify({'error': 'Impossible de supprimer votre propre compte'}), 400
    
    if user_store.delete(user_id):
        return jsonify({'success': True})
    return jsonify({'error': 'Utilisateur non trouvé'}), 404


@auth_bp.route('/api/admin/sessions/cleanup', methods=['POST'])
@admin_required
def cleanup_sessions():
    """Nettoie les sessions expirées (admin)"""
    count = user_store.cleanup_expired_sessions()
    return jsonify({
        'success': True,
        'cleaned': count,
        'message': f'{count} session(s) expirée(s) supprimée(s)'
    })


# =============================================================================
# Feature Access Control
# =============================================================================

FEATURE_ACCESS = {
    'public': {
        'view_eda',
        'view_reports',
        'convert_files',
    },
    'user': {
        'view_eda',
        'view_reports', 
        'convert_files',
        'create_scripts',
        'run_scripts',
        'save_layouts',
        'create_mappings',
        'upload_files',
    },
    'admin': {
        'view_eda',
        'view_reports',
        'convert_files',
        'create_scripts',
        'run_scripts',
        'save_layouts',
        'create_mappings',
        'upload_files',
        'manage_users',
        'view_metrics',
        'delete_reports',
    }
}


def has_feature_access(feature: str, user: Optional[User] = None) -> bool:
    """Vérifie si l'utilisateur a accès à une feature"""
    if user is None:
        return feature in FEATURE_ACCESS['public']
    role = user.role if user.role in FEATURE_ACCESS else 'user'
    return feature in FEATURE_ACCESS[role]


def feature_required(feature: str):
    """Décorateur: vérifie l'accès à une feature"""
    def decorator(f):
        @wraps(f)
        def decorated(*args, **kwargs):
            user = get_current_user()
            if not has_feature_access(feature, user):
                if user is None:
                    return jsonify({
                        'error': 'Authentification requise pour cette fonctionnalité',
                        'feature': feature
                    }), 401
                else:
                    return jsonify({
                        'error': 'Accès non autorisé à cette fonctionnalité',
                        'feature': feature
                    }), 403
            g.current_user = user
            return f(*args, **kwargs)
        return decorated
    return decorator


@auth_bp.route('/api/auth/features', methods=['GET'])
@optional_auth
def get_user_features():
    """Retourne les features accessibles à l'utilisateur"""
    user = g.current_user
    
    if user is None:
        features = list(FEATURE_ACCESS['public'])
        role = 'anonymous'
    else:
        role = user.role if user.role in FEATURE_ACCESS else 'user'
        features = list(FEATURE_ACCESS[role])
    
    return jsonify({
        'role': role,
        'features': sorted(features),
        'authenticated': user is not None
    })