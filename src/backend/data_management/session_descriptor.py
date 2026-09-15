"""Baltimore Bird - Persistance du descripteur des sessions EDA.

Une session EDA porte deux natures d'état: l'état lourd (handles MF4, signaux décodés,
caches) qui n'a de sens qu'en mémoire, et l'état d'identité (quel fichier, quel propriétaire,
quelles variables calculées) qui suffit à la reconstruire. Seul le second est persisté ici:
il survit à l'éviction par expiration comme au redémarrage du service.

Invariant de sécurité: un descripteur ne décrit jamais qu'un fichier appartenant à son
propriétaire déclaré. Les chemins sont confinés à l'espace disque de cet utilisateur, à
l'écriture comme à la relecture. Un descripteur falsifié, ou dont l'identifiant de session
aurait fuité, ne peut donc pas désigner le fichier d'un tiers: la relecture le rejette avant
toute ouverture de fichier, et le contrôle d'accès de l'appelant s'applique par-dessus.
"""

import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from config import ANONYMOUS_USER_ID, BASE_DIR, SESSION_DESCRIPTOR_DIR
from core import is_safe_path, sanitize_session_id

logger = logging.getLogger(__name__)

SCHEMA_VERSION = 1


@dataclass(slots=True)
class ComputedSignalSpec:
    """Définition d'une variable calculée, suffisante pour la recalculer.

    Seule la définition est persistée, jamais les échantillons: ils se déduisent du fichier
    source et de la formule, et pèsent plusieurs ordres de grandeur de plus.
    """

    index: int
    name: str
    unit: str
    description: str
    formula: str
    mapping: Dict[str, str]

    def to_dict(self) -> Dict[str, Any]:
        return {
            "index": self.index,
            "name": self.name,
            "unit": self.unit,
            "description": self.description,
            "formula": self.formula,
            "mapping": dict(self.mapping),
        }

    @classmethod
    def from_dict(cls, payload: Dict[str, Any]) -> "ComputedSignalSpec":
        mapping = payload.get("mapping") or {}
        if not isinstance(mapping, dict):
            raise ValueError("mapping invalide")
        return cls(
            index=int(payload["index"]),
            name=str(payload["name"]),
            unit=str(payload.get("unit", "")),
            description=str(payload.get("description", "")),
            formula=str(payload["formula"]),
            mapping={str(k): str(v) for k, v in mapping.items()},
        )


@dataclass(slots=True)
class SessionDescriptor:
    """État minimal suffisant pour reconstruire une session EDA à l'identique."""

    session_id: str
    user_id: str
    mf4_path: Path
    dbc_path: Optional[Path]
    filename: str
    computed_signals: List[ComputedSignalSpec] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "schema": SCHEMA_VERSION,
            "session_id": self.session_id,
            "user_id": self.user_id,
            "mf4_path": str(self.mf4_path),
            "dbc_path": str(self.dbc_path) if self.dbc_path else None,
            "filename": self.filename,
            "computed_signals": [spec.to_dict() for spec in self.computed_signals],
        }

    @classmethod
    def from_dict(cls, payload: Dict[str, Any]) -> "SessionDescriptor":
        dbc_raw = payload.get("dbc_path")
        specs_raw = payload.get("computed_signals") or []
        if not isinstance(specs_raw, list):
            raise ValueError("computed_signals invalide")
        return cls(
            session_id=str(payload["session_id"]),
            user_id=str(payload["user_id"]),
            mf4_path=Path(payload["mf4_path"]),
            dbc_path=Path(dbc_raw) if dbc_raw else None,
            filename=str(payload.get("filename", "")),
            computed_signals=[ComputedSignalSpec.from_dict(spec) for spec in specs_raw],
        )


def user_data_root(user_id: str) -> Optional[Path]:
    """Racine disque d'un utilisateur, ou None si l'identifiant n'est pas un segment de chemin sûr.

    L'identifiant anonyme est refusé: les sessions anonymes sont éphémères par conception et
    n'ont pas de descripteur. En accepter un reviendrait à offrir, à quiconque connaît un
    identifiant de session, un propriétaire que le contrôle d'accès laisse passer sans token.
    """
    if not user_id or user_id == ANONYMOUS_USER_ID:
        return None
    if not all(c.isalnum() or c in "-_" for c in user_id):
        return None
    return BASE_DIR / "data" / "users" / user_id


def confinement_violations(descriptor: SessionDescriptor) -> Tuple[str, ...]:
    """Chemins du descripteur sortant de l'espace disque de son propriétaire.

    Retourne un tuple vide quand le descripteur est conforme. Le contrôle porte sur les
    chemins résolus: un lien symbolique ou un `..` échappant à la racine utilisateur est
    donc détecté, pas seulement une différence textuelle.
    """
    root = user_data_root(descriptor.user_id)
    if root is None:
        return ("user_id",)

    violations: List[str] = []
    if not is_safe_path(root, descriptor.mf4_path):
        violations.append("mf4_path")
    if descriptor.dbc_path is not None and not is_safe_path(root, descriptor.dbc_path):
        violations.append("dbc_path")
    return tuple(violations)


def descriptor_path(session_id: str) -> Optional[Path]:
    """Chemin du descripteur d'une session, ou None si l'identifiant est invalide.

    L'identifiant est revalidé ici et pas seulement chez l'appelant: ce chemin est construit
    par concaténation, la validation est donc une contrainte de ce module.
    """
    safe_id = sanitize_session_id(session_id)
    if not safe_id:
        return None
    return SESSION_DESCRIPTOR_DIR / f"{safe_id}.json"


def save_descriptor(descriptor: SessionDescriptor) -> bool:
    """Écrit le descripteur de manière atomique. Retourne False si l'écriture est refusée.

    Un descripteur non conforme n'est pas persisté: la session reste pleinement utilisable,
    elle n'est simplement pas reconstructible après éviction.
    """
    path = descriptor_path(descriptor.session_id)
    if path is None:
        return False

    violations = confinement_violations(descriptor)
    if violations:
        logger.error(
            "[SessionDescriptor] Descripteur refusé pour %s: %s hors de l'espace du propriétaire",
            descriptor.session_id[:8], ", ".join(violations),
        )
        return False

    tmp_path = path.with_suffix(".json.tmp")
    try:
        SESSION_DESCRIPTOR_DIR.mkdir(parents=True, exist_ok=True)
        tmp_path.write_text(json.dumps(descriptor.to_dict(), ensure_ascii=False), encoding="utf-8")
        tmp_path.replace(path)
        return True
    except OSError:
        logger.warning("[SessionDescriptor] Écriture impossible pour %s", descriptor.session_id[:8], exc_info=True)
        tmp_path.unlink(missing_ok=True)
        return False


def load_descriptor(session_id: str) -> Optional[SessionDescriptor]:
    """Relit le descripteur d'une session.

    Retourne None si le descripteur est absent, illisible, de schéma inconnu, incohérent avec
    l'identifiant demandé, ou s'il désigne un fichier hors de l'espace de son propriétaire.
    Toutes ces situations sont traitées comme une session disparue: l'appelant n'a aucune
    raison de distinguer un descripteur corrompu d'un descripteur falsifié.
    """
    path = descriptor_path(session_id)
    if path is None or not path.exists():
        return None

    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        logger.warning("[SessionDescriptor] Descripteur illisible pour %s", session_id[:8], exc_info=True)
        return None

    if not isinstance(payload, dict) or payload.get("schema") != SCHEMA_VERSION:
        return None

    try:
        descriptor = SessionDescriptor.from_dict(payload)
    except (KeyError, TypeError, ValueError):
        logger.warning("[SessionDescriptor] Descripteur incomplet pour %s", session_id[:8], exc_info=True)
        return None

    if descriptor.session_id != session_id:
        logger.error("[SessionDescriptor] Identifiant incohérent dans le descripteur %s", session_id[:8])
        return None

    violations = confinement_violations(descriptor)
    if violations:
        logger.error(
            "[SessionDescriptor] Descripteur rejeté pour %s: %s hors de l'espace du propriétaire",
            session_id[:8], ", ".join(violations),
        )
        return None

    return descriptor


def delete_descriptor(session_id: str) -> None:
    """Supprime le descripteur: la session devient définitivement irrécupérable."""
    path = descriptor_path(session_id)
    if path is None:
        return
    try:
        path.unlink(missing_ok=True)
    except OSError:
        logger.warning("[SessionDescriptor] Suppression impossible pour %s", session_id[:8], exc_info=True)
