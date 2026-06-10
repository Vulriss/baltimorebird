"""Baltimore Bird - Utilitaires temporels."""

from datetime import datetime, timezone


def utc_now() -> datetime:
    """Retourne l'instant courant en UTC (timezone-aware)."""
    return datetime.now(timezone.utc)


def utc_now_iso() -> str:
    """Retourne l'instant courant UTC au format ISO 8601 suffixe 'Z'."""
    return utc_now().isoformat().replace("+00:00", "Z")
