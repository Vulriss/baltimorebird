"""Baltimore Bird - Maintenance des fichiers temporaires des sessions EDA éphémères."""

import logging
import shutil
import time
from pathlib import Path
from typing import Set

logger = logging.getLogger(__name__)


def purge_orphan_files(directory: Path, max_age_seconds: float, protected: Set[Path]) -> int:
    """Supprime les fichiers orphelins d'un répertoire de sessions éphémères.

    Un fichier est supprimé lorsque les deux conditions suivantes sont réunies :
    il n'est référencé par aucune session vivante (absent de ``protected``) et son dernier accès
    disque dépasse ``max_age_seconds``. Les fichiers d'une session active sont donc toujours
    préservés, indépendamment de leur âge. Les sous-répertoires sont ignorés.

    Ce balayage est le filet de sécurité des fichiers laissés sur disque par un processus arrêté
    ou redémarré, dont la session en mémoire a disparu. Retourne le nombre de fichiers supprimés.
    """
    if not directory.exists():
        return 0

    protected_resolved = {path.resolve() for path in protected}
    cutoff = time.time() - max_age_seconds
    deleted = 0

    for entry in directory.iterdir():
        if not entry.is_file():
            continue
        if entry.resolve() in protected_resolved:
            continue
        try:
            if entry.stat().st_mtime >= cutoff:
                continue
            entry.unlink()
            deleted += 1
        except OSError:
            logger.warning(f"[Maintenance] Échec de suppression de l'orphelin {entry.name}", exc_info=True)

    if deleted:
        logger.info(f"[Maintenance] {deleted} fichier(s) éphémère(s) orphelin(s) supprimé(s) dans {directory.name}")
    return deleted


def purge_ingest_scratch(directory: Path, max_age_seconds: float) -> int:
    """Supprime les scratchs d'ingestion laissés par un upload interrompu.

    Chaque upload authentifié travaille dans son propre sous-répertoire, effacé dès la remise au
    stockage. Seul un arrêt brutal ou un décodage en échec en laisse un derrière lui: passé
    ``max_age_seconds``, il n'a plus aucune chance d'être repris. Retourne le nombre de scratchs
    supprimés.
    """
    if not directory.exists():
        return 0

    cutoff = time.time() - max_age_seconds
    deleted = 0

    for entry in directory.iterdir():
        if not entry.is_dir():
            continue
        try:
            if entry.stat().st_mtime >= cutoff:
                continue
            shutil.rmtree(entry, ignore_errors=True)
            deleted += 1
        except OSError:
            logger.warning(f"[Maintenance] Échec de suppression du scratch {entry.name}", exc_info=True)

    if deleted:
        logger.info(f"[Maintenance] {deleted} scratch(s) d'ingestion supprimé(s) dans {directory.name}")
    return deleted
