"""Baltimore Bird - Collecte de retours utilisateur.

Les retours sont stockes en JSONL (une ligne JSON par retour). L'adresse IP n'est
conservee que sous forme hashee, coherente avec l'anonymat du module de metriques.
"""

import json
import threading
import time
from collections import defaultdict, deque
from datetime import datetime, timezone
from typing import Deque, Dict, Optional

from flask import Blueprint, jsonify, request

from config import (
    FEEDBACK_FILE,
    FEEDBACK_MAX_CONTEXT_LEN,
    FEEDBACK_MAX_EMAIL_LEN,
    FEEDBACK_MAX_MESSAGE_LEN,
    FEEDBACK_RATE_LIMIT_MAX,
    FEEDBACK_RATE_LIMIT_WINDOW,
)
from services.metrics import hash_ip

feedback_bp = Blueprint("feedback", __name__)


class SlidingWindowRateLimiter:
    """Limiteur de debit par cle sur une fenetre glissante, thread-safe."""

    def __init__(self, max_events: int, window_seconds: int) -> None:
        self._max = max_events
        self._window = window_seconds
        self._lock = threading.Lock()
        self._hits: Dict[str, Deque[float]] = defaultdict(deque)

    def allow(self, key: str) -> bool:
        now = time.time()
        with self._lock:
            hits = self._hits[key]
            while hits and now - hits[0] > self._window:
                hits.popleft()
            if len(hits) >= self._max:
                return False
            hits.append(now)
            return True


_rate_limiter = SlidingWindowRateLimiter(FEEDBACK_RATE_LIMIT_MAX, FEEDBACK_RATE_LIMIT_WINDOW)
_write_lock = threading.Lock()


def _client_ip() -> str:
    return request.headers.get("X-Real-IP") or request.remote_addr or "unknown"


def _clean(value: Optional[str], max_len: int) -> str:
    if not isinstance(value, str):
        return ""
    return value.strip()[:max_len]


def _append_feedback(entry: Dict[str, object]) -> None:
    FEEDBACK_FILE.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(entry, ensure_ascii=False)
    with _write_lock:
        with open(FEEDBACK_FILE, "a", encoding="utf-8") as handle:
            handle.write(line + "\n")


@feedback_bp.route("/api/feedback", methods=["POST"])
def submit_feedback():
    """Enregistre un retour utilisateur (message, contact optionnel, contexte)."""
    user_hash = hash_ip(_client_ip())
    if not _rate_limiter.allow(user_hash):
        return jsonify({"error": "Trop de retours envoyes, reessayez plus tard"}), 429

    payload = request.get_json(silent=True) or {}
    message = _clean(payload.get("message"), FEEDBACK_MAX_MESSAGE_LEN)
    if not message:
        return jsonify({"error": "Message vide"}), 400

    entry = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "message": message,
        "email": _clean(payload.get("email"), FEEDBACK_MAX_EMAIL_LEN),
        "context": _clean(payload.get("context"), FEEDBACK_MAX_CONTEXT_LEN),
        "user_hash": user_hash,
        "user_agent": _clean(request.headers.get("User-Agent"), 200),
    }
    _append_feedback(entry)
    return jsonify({"success": True}), 201
