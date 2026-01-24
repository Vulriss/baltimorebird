"""
Baltimore Bird - Configuration centralisée.

Toutes les constantes et paramètres de configuration sont définis ici.
"""

import os
import secrets
from typing import Set
from pathlib import Path


def _parse_cors_origins() -> list[str]:
    origins = os.environ.get("CORS_ORIGINS", "").split(",")
    if not origins or origins == [""]:
        return [
            "http://localhost:5000",
            "http://127.0.0.1:5000",
        ]
    
    for origin in origins:
        assert origin.startswith("https://"), (
            f"CORS origin invalide (https requis) : {origin}"
        )
    
    return origins


def _get_auth_secret_key() -> str:
    key = os.environ.get("AUTH_SECRET_KEY")
    if not key:
        key = secrets.token_hex(32)
        print("AUTH_SECRET_KEY non définie fallbakc to using temp key (dev mode)")
    return key


BASE_DIR = Path(__file__).parent
DATA_DIR = BASE_DIR / "data"
TEMP_DIR = BASE_DIR / "TEMP"
REPORTS_DIR = BASE_DIR / "reports"
METRICS_DATA_DIR = BASE_DIR / "metrics_data"
AUTH_DATA_DIR = DATA_DIR / "auth"

TEMP_DIR.mkdir(exist_ok=True)
REPORTS_DIR.mkdir(exist_ok=True)
METRICS_DATA_DIR.mkdir(parents=True, exist_ok=True)
AUTH_DATA_DIR.mkdir(parents=True, exist_ok=True)

MAX_CONTENT_LENGTH = 1500 * 1024 * 1024  # 1.5GB
ALLOWED_ORIGINS = _parse_cors_origins()

AUTH_SECRET_KEY = _get_auth_secret_key()
AUTH_TOKEN_EXPIRY_HOURS = int(os.environ.get("AUTH_TOKEN_EXPIRY_HOURS", 24 * 7))  # 7days rn
AUTH_DATABASE_PATH = AUTH_DATA_DIR / "users.db"

# Brute force limitation
RATE_LIMIT_WINDOW = 900  # 15min
RATE_LIMIT_MAX_ATTEMPTS = 5  # 5 attempts
RATE_LIMIT_LOCKOUT = 1800  # 30min

ALLOWED_EXTENSIONS: Set[str] = {".mf4", ".csv", ".mat", ".dat", ".blf", ".dbc"}

DATA_SOURCES = {
    "mf4": {
        "name": "OBD2 Data (MF4)",
        "description": "Real automotive data from MF4 file",
        "mf4_file": "data/default/mf4/00000002.mf4",
        "dbc_file": "data/default/dbc/11-bit-OBD2-v4.0.dbc",
    },
    "synthetic": {
        "name": "Synthetic Data",
        "description": "Generated test signals (20 signals, 3000s)",
    },
}

DEFAULT_QUOTA_BYTES = 5 * 1024 * 1024 * 1024  # 5Go by user -> limited only for the current prod serv baltimorebird.cloud
MAX_FILES_PER_USER = 1000
MAX_FILES_PER_CATEGORY = 200
MAX_JSON_SIZE_BYTES = 5 * 1024 * 1024
MAX_JSON_DEPTH = 10  # JSON bomb protection

MAX_SCRIPT_SIZE = 1024 * 1024
MAX_BLOCKS = 100
MAX_CODE_LENGTH = 50000
MAX_STRING_LENGTH = 10000

SANDBOX_MAX_AST_NODES = 10000
SANDBOX_MAX_STRING_LENGTH = 100000
SANDBOX_MAX_CODE_LENGTH = 500000

LAZY_EDA_MAX_SESSIONS = 50
LAZY_EDA_SESSION_TIMEOUT = 3600  # Expirqtion apres 1h

METRICS_IP_SALT = os.environ.get("METRICS_IP_SALT", "baltimore_bird_2025")  # Different en prod

LAYOUT_VERSION = 1