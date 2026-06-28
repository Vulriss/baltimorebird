"""Baltimore Bird - Service de conversion et concaténation de fichiers."""

import threading
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Dict, List, Optional

from config import TEMP_DIR

try:
    from asammdf import MDF
    ASAMMDF_AVAILABLE = True
except ImportError:
    ASAMMDF_AVAILABLE = False


class ConversionStatus(Enum):
    """Statuts possibles d'une tâche de conversion."""
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


@dataclass
class ConversionTask:
    """Représente une tâche de conversion de fichier."""
    id: str
    input_file: Path
    output_format: str
    status: ConversionStatus = ConversionStatus.PENDING
    progress: float = 0.0
    message: str = ""
    output_file: Optional[Path] = None
    dbc_file: Optional[Path] = None
    resample_raster: Optional[float] = None
    created_at: float = field(default_factory=time.time)
    completed_at: Optional[float] = None


@dataclass
class ConcatenationTask:
    """Représente une tâche de concaténation de fichiers MF4."""
    id: str
    input_files: List[Path]
    status: ConversionStatus = ConversionStatus.PENDING
    progress: float = 0.0
    message: str = ""
    output_file: Optional[Path] = None
    created_at: float = field(default_factory=time.time)
    completed_at: Optional[float] = None
    stats: Dict[str, Any] = field(default_factory=dict)


SUPPORTED_CONVERSIONS: Dict[str, List[str]] = {
    "mf4": ["csv"],
    "mdf": ["csv"],
    "dat": ["csv"],
}


def get_supported_conversions() -> Dict[str, List[str]]:
    """Retourne le dictionnaire des conversions supportées."""
    return SUPPORTED_CONVERSIONS.copy()


def is_conversion_supported(input_format: str, output_format: str) -> bool:
    """Vérifie si une conversion est supportée."""
    input_fmt = input_format.lower().lstrip(".")
    output_fmt = output_format.lower().lstrip(".")
    return output_fmt in SUPPORTED_CONVERSIONS.get(input_fmt, [])


class ConversionManager:
    """Gestionnaire des tâches de conversion de fichiers."""

    def __init__(self):
        self._tasks: Dict[str, ConversionTask] = {}
        self._lock = threading.Lock()

    def create_task(
        self,
        input_file: Path,
        output_format: str,
        dbc_file: Optional[Path] = None,
        resample_raster: Optional[float] = None
    ) -> ConversionTask:
        """Crée une nouvelle tâche de conversion."""
        task_id = str(uuid.uuid4())[:8]
        task = ConversionTask(
            id=task_id,
            input_file=input_file,
            output_format=output_format,
            dbc_file=dbc_file,
            resample_raster=resample_raster,
        )
        with self._lock:
            self._tasks[task_id] = task
        return task

    def get_task(self, task_id: str) -> Optional[ConversionTask]:
        """Récupère une tâche par son ID."""
        with self._lock:
            return self._tasks.get(task_id)

    def run_conversion(self, task_id: str) -> None:
        """Lance la conversion en arrière-plan."""
        task = self.get_task(task_id)
        if not task:
            return
        thread = threading.Thread(target=self._do_conversion, args=(task,), daemon=True)
        thread.start()

    def _do_conversion(self, task: ConversionTask) -> None:
        """Exécute la conversion (appelé dans un thread)."""
        try:
            task.status = ConversionStatus.RUNNING
            task.message = "Conversion en cours..."
            task.progress = 10.0

            if not ASAMMDF_AVAILABLE:
                task.status = ConversionStatus.FAILED
                task.message = "asammdf non disponible"
                return

            mdf = MDF(str(task.input_file))
            task.progress = 30.0

            if task.dbc_file and task.dbc_file.exists():
                try:
                    mdf = mdf.extract_bus_logging({"CAN": [(task.dbc_file, 0)]})
                    task.progress = 50.0
                except Exception as e:
                    task.message = f"Warning: DBC extraction failed: {e}"

            if task.resample_raster:
                mdf = mdf.resample(task.resample_raster)
                task.progress = 70.0

            output_name = task.input_file.stem + f".{task.output_format}"
            output_path = TEMP_DIR / output_name
            task.progress = 80.0

            if task.output_format == "csv":
                mdf.export("csv", filename=str(output_path))
            else:
                task.status = ConversionStatus.FAILED
                task.message = f"Format de sortie non supporté: {task.output_format}"
                return

            mdf.close()
            task.output_file = output_path
            task.status = ConversionStatus.COMPLETED
            task.progress = 100.0
            task.message = "Conversion terminée"
            task.completed_at = time.time()

        except Exception as e:
            task.status = ConversionStatus.FAILED
            task.message = f"Erreur: {str(e)}"
            task.completed_at = time.time()

    def cleanup_old_tasks(self, max_age_hours: int = 24) -> int:
        """Nettoie les tâches anciennes."""
        cutoff = time.time() - (max_age_hours * 3600)
        deleted = 0
        with self._lock:
            to_delete = [tid for tid, task in self._tasks.items() if task.created_at < cutoff]
            for tid in to_delete:
                task = self._tasks.pop(tid)
                for artifact in (task.output_file, task.input_file, task.dbc_file):
                    if artifact and artifact.exists():
                        try:
                            artifact.unlink()
                        except OSError:
                            pass
                deleted += 1
        return deleted


class ConcatenationManager:
    """Gestionnaire des tâches de concaténation de fichiers MF4."""

    def __init__(self):
        self._tasks: Dict[str, ConcatenationTask] = {}
        self._lock = threading.Lock()

    def create_task(self, input_files: List[Path]) -> ConcatenationTask:
        """Crée une nouvelle tâche de concaténation."""
        task_id = str(uuid.uuid4())[:8]
        task = ConcatenationTask(id=task_id, input_files=input_files)
        with self._lock:
            self._tasks[task_id] = task
        return task

    def get_task(self, task_id: str) -> Optional[ConcatenationTask]:
        """Récupère une tâche par son ID."""
        with self._lock:
            return self._tasks.get(task_id)

    def run_concatenation(self, task_id: str) -> None:
        """Lance la concaténation en arrière-plan."""
        task = self.get_task(task_id)
        if not task:
            return
        thread = threading.Thread(target=self._do_concatenation, args=(task,), daemon=True)
        thread.start()

    def _do_concatenation(self, task: ConcatenationTask) -> None:
        """Exécute la concaténation (appelé dans un thread)."""
        try:
            task.status = ConversionStatus.RUNNING
            task.message = "Concaténation en cours..."
            task.progress = 10.0

            if not ASAMMDF_AVAILABLE:
                task.status = ConversionStatus.FAILED
                task.message = "asammdf non disponible"
                return

            if len(task.input_files) < 2:
                task.status = ConversionStatus.FAILED
                task.message = "Au moins 2 fichiers requis"
                return

            mdf_files = []
            for i, f in enumerate(task.input_files):
                mdf_files.append(MDF(str(f)))
                task.progress = 10 + (i / len(task.input_files)) * 40

            task.progress = 50.0
            task.message = "Fusion des fichiers..."

            merged = MDF.concatenate(mdf_files)
            task.progress = 80.0

            output_name = f"concatenated_{task.id}.mf4"
            output_path = TEMP_DIR / output_name
            merged.save(str(output_path), overwrite=True)

            for mdf in mdf_files:
                mdf.close()
            merged.close()

            task.output_file = output_path
            task.status = ConversionStatus.COMPLETED
            task.progress = 100.0
            task.message = "Concaténation terminée"
            task.completed_at = time.time()
            task.stats = {
                "input_count": len(task.input_files),
                "output_size_mb": round(output_path.stat().st_size / 1024 / 1024, 2),
            }

        except Exception as e:
            task.status = ConversionStatus.FAILED
            task.message = f"Erreur: {str(e)}"
            task.completed_at = time.time()

    def cleanup_old_tasks(self, max_age_hours: int = 24) -> int:
        """Nettoie les tâches anciennes."""
        cutoff = time.time() - (max_age_hours * 3600)
        deleted = 0
        with self._lock:
            to_delete = [tid for tid, task in self._tasks.items() if task.created_at < cutoff]
            for tid in to_delete:
                task = self._tasks.pop(tid)
                artifacts = list(task.input_files)
                if task.output_file:
                    artifacts.append(task.output_file)
                for artifact in artifacts:
                    if artifact and artifact.exists():
                        try:
                            artifact.unlink()
                        except OSError:
                            pass
                deleted += 1
        return deleted


conversion_manager = ConversionManager()
concatenation_manager = ConcatenationManager()
