"""Extraction des evenements de commentaire INCA (Ctrl+K) d'un fichier MF4.

Les captures INCA inscrivent chaque Ctrl+K comme un evenement MF4 dont le commentaire
porte, en tete, la date et l'heure de la capture suivies d'un texte libre. Ce module
transforme ces evenements en points horodates exploitables par le strip commentaires de
l'EDA. Il n'ouvre ni ne ferme aucun fichier: l'appelant fournit les evenements d'un MDF
deja ouvert (asammdf), ce qui isole la transformation et la rend testable.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Iterable, List, Optional, Tuple

# En-tete INCA: "Date: JJ.MM.AAAA Temps: HH:MM:SS <texte>". Le libelle varie selon la
# langue (Temps / Time) et le separateur de date peut etre un point ou un slash; on ne
# capture donc que la date, l'heure et le reste.
_HEADER_PATTERN = re.compile(
    r"(?P<date>\d{2}[./]\d{2}[./]\d{4})\D+(?P<time>\d{2}:\d{2}:\d{2})\s*(?P<text>.*)",
    re.DOTALL,
)
_XML_TAG_PATTERN = re.compile(r"<[^>]+>")


@dataclass(frozen=True)
class EventComment:
    """Point de commentaire horodate issu d'un evenement MF4."""

    time: float
    text: str
    date: Optional[str] = None
    clock: Optional[str] = None


def _plain_comment(raw: Optional[str]) -> str:
    """Reduit un commentaire d'evenement, parfois enrobe de balises XML, a du texte brut."""
    if not raw:
        return ""
    return _XML_TAG_PATTERN.sub(" ", raw).strip()


def _parse_comment(raw: Optional[str]) -> Tuple[Optional[str], Optional[str], str]:
    """Isole l'en-tete date/heure INCA du texte libre.

    Retourne (date, heure, texte). Sans en-tete reconnaissable, date et heure valent None
    et le commentaire entier tient lieu de texte.
    """
    plain = _plain_comment(raw)
    match = _HEADER_PATTERN.search(plain)
    if match is None:
        return None, None, plain
    return match.group("date"), match.group("time"), match.group("text").strip()


def _event_time(event: object) -> Optional[float]:
    """Instant de l'evenement en secondes, tolerant aux variantes d'API asammdf."""
    value = getattr(event, "value", None)
    if value is None:
        return None
    try:
        seconds = float(value)
    except (TypeError, ValueError):
        return None
    return seconds if math.isfinite(seconds) else None


def extract_event_comments(
    events: Iterable[object],
    require_header: bool = True,
) -> List[EventComment]:
    """Convertit les evenements d'un MDF en points de commentaire tries par instant.

    Un evenement est retenu s'il porte un instant exploitable et un texte non vide. Avec
    require_header (defaut), seuls les evenements a en-tete date/heure INCA sont conserves,
    ce qui cible les Ctrl+K et ecarte les marqueurs d'acquisition. A False, tout evenement
    commente est conserve, son commentaire entier servant de texte.

    Les instants sont ceux du MDF (event.value): l'appelant les aligne sur son referentiel
    temporel comme pour les autres signaux.
    """
    comments: List[EventComment] = []
    for event in events:
        time = _event_time(event)
        if time is None:
            continue
        date, clock, text = _parse_comment(getattr(event, "comment", None))
        if require_header and (date is None or clock is None):
            continue
        if not text:
            continue
        comments.append(EventComment(time=time, text=text, date=date, clock=clock))
    comments.sort(key=lambda comment: comment.time)
    return comments


# Signal special expose au frontend: unite vide (un event n'a pas de grandeur physique),
# reconnu par le frontend au champ kind == EVENT_SIGNAL_KIND. La couleur d'accent teal
# aligne le strip sur le theme (le frontend la reapplique cote rendu).
EVENT_SIGNAL_NAME = "EventComment"
EVENT_SIGNAL_KIND = "event"
EVENT_SIGNAL_COLOR = "#94e2d5"


def build_event_signal_descriptor(index: int) -> dict:
    """Entree de liste des signaux pour le signal commentaires (meme forme que les reels)."""
    return {
        "index": index,
        "name": EVENT_SIGNAL_NAME,
        "unit": "",
        "color": EVENT_SIGNAL_COLOR,
        "loaded": True,
        "kind": EVENT_SIGNAL_KIND,
    }


def serialize_event_comments(comments: "Iterable[EventComment]") -> List[dict]:
    """Serialise les points pour le frontend: t = instant (s), time = heure murale INCA."""
    return [
        {"t": comment.time, "text": comment.text, "date": comment.date, "time": comment.clock}
        for comment in comments
    ]
