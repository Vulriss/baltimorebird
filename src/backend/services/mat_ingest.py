"""Ingestion de fichiers MATLAB .mat (exports de simulation) vers MF4.

Les variables temporelles du .mat sont converties en signaux MF4, ce qui permet de réutiliser sans
modification toute la chaîne d'analyse lazy déjà bâtie autour d'asammdf (LOD, prefetch, voies
calculées, statistiques d'intervalle, export).

Structures réelles prises en charge (format Simulink, MAT v5/v7) :
    - Vecteur de temps global partagé (variable « Time ») et signaux de même longueur.
    - Scalaires (valeur unique), rendus en segment plat sur la plage temporelle.
    - Structures Simulink « Structure With Time » (.time / .signals.values), à temps propre.
    - Métadonnées de mise à l'échelle (ScalingInPorts/Intern/OutPorts/Calibs) fournissant l'unité,
      la description et le type (les signaux booléens sont marqués pour un rendu en escalier).
    - Bloc de calibrations (StructCalib) et entêtes texte, écartés car non temporels.

Les fichiers MAT v7.3 (conteneur HDF5) ne sont pas pris en charge par scipy et sont signalés
explicitement comme tels.
"""

from __future__ import annotations

import logging
import time as _time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
from asammdf import MDF, Signal

logger = logging.getLogger(__name__)

_FLOAT = np.float64

# Variables de premier niveau qui ne sont pas des signaux temporels.
_HEADER_NAMES = frozenset({
    "UserName", "ComputerName", "nProcessors", "Arch", "Version", "CurrentDate",
})
_SCALING_NAMES = frozenset({
    "ScalingInPorts", "ScalingIntern", "ScalingOutPorts", "ScalingCalibs",
})
_CALIBRATION_NAME = "StructCalib"
_TIME_CANDIDATES = ("Time", "time", "t", "tout")


@dataclass(slots=True)
class MatIngestionReport:
    """Synthèse quantitative d'une conversion .mat vers MF4."""

    total_variables: int = 0
    signal_count: int = 0
    group_count: int = 0
    time_series_signals: int = 0
    constant_signals: int = 0
    struct_signals: int = 0
    skipped_variables: list[str] = field(default_factory=list)
    time_variable: str = ""
    duration_s: float = 0.0
    output_path: str | None = None


@dataclass(slots=True)
class _ExtractedSignal:
    """Signal extrait du .mat, prêt à être groupé puis écrit en MF4."""

    name: str
    timestamps: np.ndarray
    values: np.ndarray
    unit: str
    is_boolean: bool


def _as_text(value: object) -> str:
    """Coerce un champ MATLAB (str ou tableau, éventuellement vide) en chaîne propre."""
    if isinstance(value, str):
        return value.strip()
    array = np.atleast_1d(np.asarray(value, dtype=object))
    if array.size == 0:
        return ""
    item = array.reshape(-1)[0]
    return str(item).strip() if not isinstance(item, np.ndarray) else ""


class MatScalingIndex:
    """Index des métadonnées de signaux (unité, type) issues des blocs Scaling* du .mat."""

    _BOOLEAN_TYPES = frozenset({"bool", "boolean"})

    def __init__(self, units: dict[str, str], booleans: set[str]) -> None:
        self._units = units
        self._booleans = booleans

    @classmethod
    def from_raw(cls, raw: dict[str, object]) -> MatScalingIndex:
        units: dict[str, str] = {}
        booleans: set[str] = set()
        for block_name in _SCALING_NAMES:
            block = raw.get(block_name)
            if block is None:
                continue
            for entry in np.atleast_1d(np.asarray(block)).reshape(-1):
                name = _as_text(getattr(entry, "Name", ""))
                if not name:
                    continue
                unit = _as_text(getattr(entry, "Unit", "")) or _as_text(getattr(entry, "DisplayUnit", ""))
                kind = _as_text(getattr(entry, "Type", "")).lower()
                if kind in cls._BOOLEAN_TYPES or unit.lower() == "bool":
                    booleans.add(name)
                    unit = "bool"
                if unit:
                    units[name] = unit
        return cls(units, booleans)

    def unit_of(self, name: str) -> str:
        if name in self._booleans:
            return "bool"
        return self._units.get(name, "")

    def is_boolean(self, name: str) -> bool:
        return name in self._booleans


class MatSignalExtractor:
    """Transforme le dictionnaire brut scipy en une liste de signaux exploitables.

    Sépare les trois familles temporelles (séries sur le temps global, scalaires, structures
    Simulink à temps propre) et leur associe l'unité issue de l'index de mise à l'échelle.
    """

    def __init__(self, raw: dict[str, object], scaling: MatScalingIndex) -> None:
        self._raw = raw
        self._scaling = scaling
        self._time, self.time_variable = self._resolve_time_vector(raw)
        # Master partagé à deux points pour les valeurs constantes (segment plat sur la plage).
        start, end = (float(self._time[0]), float(self._time[-1])) if self._time.size else (0.0, 1.0)
        if end <= start:
            end = start + 1.0
        self._constant_master = np.array([start, end], dtype=_FLOAT)

    def extract(self, report: MatIngestionReport) -> list[_ExtractedSignal]:
        signals: list[_ExtractedSignal] = []
        for name, value in self._raw.items():
            if name.startswith("__"):
                continue
            if name in _HEADER_NAMES or name in _SCALING_NAMES or name == _CALIBRATION_NAME:
                continue
            if name == self.time_variable:
                continue
            report.total_variables += 1
            produced = self._extract_variable(name, value)
            if not produced:
                report.skipped_variables.append(name)
                continue
            signals.extend(produced)
        return signals

    def _extract_variable(self, name: str, value: object) -> list[_ExtractedSignal]:
        if self._is_struct_with_time(value):
            return self._extract_struct_with_time(name, value)
        array = np.asarray(value)
        if not np.issubdtype(array.dtype, np.number):
            return []
        flat = np.atleast_1d(array).astype(_FLOAT).reshape(-1)
        if flat.size == 0 or not np.isfinite(flat).any():
            return []
        if flat.size == self._time.size:
            return [self._make(name, self._time, flat)]
        if flat.size == 1:
            return [self._make(name, self._constant_master, np.repeat(flat, 2))]
        # Vecteur de longueur inattendue : axe d'échantillons par défaut.
        index_axis = np.arange(flat.size, dtype=_FLOAT)
        return [self._make(name, index_axis, flat)]

    def _extract_struct_with_time(self, name: str, value: Any) -> list[_ExtractedSignal]:
        own_time = np.atleast_1d(np.asarray(value.time, dtype=_FLOAT)).reshape(-1)
        produced: list[_ExtractedSignal] = []
        members = np.atleast_1d(np.asarray(value.signals, dtype=object)).reshape(-1)
        for offset, member in enumerate(members):
            channel = self._deref(member)
            raw_values = getattr(channel, "values", None)
            if raw_values is None:
                continue
            samples = np.atleast_1d(np.asarray(self._deref(raw_values), dtype=_FLOAT))
            label = self._channel_label(name, channel, offset, len(members))
            for column in self._split_columns(samples, own_time.size):
                timestamps, values = self._align(own_time, column)
                if values.size:
                    produced.append(self._make(label, timestamps, values))
        return produced

    def _make(self, name: str, timestamps: np.ndarray, values: np.ndarray) -> _ExtractedSignal:
        return _ExtractedSignal(
            name=name,
            timestamps=timestamps,
            values=np.ascontiguousarray(values, dtype=_FLOAT),
            unit=self._scaling.unit_of(name),
            is_boolean=self._scaling.is_boolean(name),
        )

    def _align(self, own_time: np.ndarray, values: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Aligne une série de structure sur son temps propre, ou la traite en constante."""
        if values.size == own_time.size and own_time.size > 1:
            return own_time, values
        if values.size == 1:
            return self._constant_master, np.repeat(values, 2)
        return np.arange(values.size, dtype=_FLOAT), values

    @staticmethod
    def _split_columns(samples: np.ndarray, time_size: int):
        """Sépare un tableau de signaux multi-voies en colonnes individuelles."""
        if samples.ndim <= 1:
            yield samples
            return
        # Oriente le tableau pour que l'axe temps soit le premier.
        matrix = samples if samples.shape[0] == time_size else samples.T
        for col in range(matrix.shape[1]):
            yield matrix[:, col]

    def _channel_label(self, var_name: str, channel: Any, offset: int, count: int) -> str:
        label = _as_text(getattr(channel, "name", "")) or var_name
        return label if count == 1 else f"{label}_{offset}"

    @classmethod
    def _is_struct_with_time(cls, value: Any) -> bool:
        node = cls._deref(value)
        fields = getattr(node, "_fieldnames", None) or ()
        return "time" in fields and "signals" in fields

    @staticmethod
    def _deref(value: Any) -> Any:
        """Déréférence les tableaux d'objets MATLAB de taille 1 jusqu'à l'élément contenu."""
        while isinstance(value, np.ndarray) and value.dtype == object and value.size >= 1:
            value = value.reshape(-1)[0]
        return value

    @classmethod
    def _resolve_time_vector(cls, raw: dict[str, object]) -> tuple[np.ndarray, str]:
        for candidate in _TIME_CANDIDATES:
            value = raw.get(candidate)
            if isinstance(value, np.ndarray) and np.issubdtype(value.dtype, np.number):
                vector = np.atleast_1d(value.astype(_FLOAT)).reshape(-1)
                if vector.size > 1:
                    return vector, candidate
        # À défaut d'un nom connu, on retient le plus long vecteur numérique.
        best_name, best_vector = "", np.empty(0, dtype=_FLOAT)
        for name, value in raw.items():
            if name.startswith("__") or not isinstance(value, np.ndarray):
                continue
            if np.issubdtype(value.dtype, np.number):
                vector = np.atleast_1d(value.astype(_FLOAT)).reshape(-1)
                if vector.size > best_vector.size:
                    best_name, best_vector = name, vector
        return best_vector, best_name


class MatToMf4Converter:
    """Orchestre la conversion d'un fichier .mat de simulation en MF4."""

    def convert(self, mat_path: Path, output_path: Path) -> MatIngestionReport:
        raw = self._load(mat_path)
        scaling = MatScalingIndex.from_raw(raw)
        extractor = MatSignalExtractor(raw, scaling)

        report = MatIngestionReport(time_variable=extractor.time_variable)
        signals = extractor.extract(report)
        if not signals:
            raise ValueError("Aucun signal temporel exploitable dans le fichier .mat")

        self._write_mf4(signals, output_path, report)
        report.output_path = str(output_path)
        return report

    @staticmethod
    def _load(mat_path: Path) -> dict[str, object]:
        import scipy.io as sio

        try:
            return sio.loadmat(str(mat_path), squeeze_me=True, struct_as_record=False)
        except NotImplementedError as exc:  # conteneur HDF5 (MAT v7.3)
            raise ValueError("Les fichiers MAT v7.3 (HDF5) ne sont pas pris en charge") from exc

    def _write_mf4(self, signals: list[_ExtractedSignal], output_path: Path,
                   report: MatIngestionReport) -> None:
        groups: dict[int, list[_ExtractedSignal]] = {}
        for signal in signals:
            groups.setdefault(id(signal.timestamps), []).append(signal)

        allocated: set[str] = set()
        mdf = MDF()
        for members in groups.values():
            master = members[0].timestamps
            mdf_signals = []
            for extracted in members:
                self._tally(extracted, master, report)
                mdf_signals.append(Signal(
                    samples=extracted.values, timestamps=master,
                    name=self._allocate_name(extracted.name, allocated),
                    unit=extracted.unit,
                ))
            mdf.append(mdf_signals, comment="mat")
            report.group_count += 1
            report.signal_count += len(mdf_signals)

        output_path.parent.mkdir(parents=True, exist_ok=True)
        mdf.save(str(output_path), overwrite=True)
        mdf.close()

    @staticmethod
    def _tally(extracted: _ExtractedSignal, master: np.ndarray, report: MatIngestionReport) -> None:
        if master.size == 2 and extracted.values.size == 2:
            report.constant_signals += 1
        else:
            report.time_series_signals += 1

    @staticmethod
    def _allocate_name(name: str, allocated: set[str]) -> str:
        candidate = name
        index = 2
        while candidate in allocated:
            candidate = f"{name}_{index}"
            index += 1
        allocated.add(candidate)
        return candidate


def convert_mat_to_mf4(mat_path: str | Path, output_path: str | Path) -> MatIngestionReport:
    """Convertit un fichier MATLAB .mat de simulation en MF4 décodé.

    Point d'entrée destiné à la couche Flask. Le MF4 produit est consommable tel quel par la
    session d'analyse lazy existante.
    """
    started = _time.perf_counter()
    report = MatToMf4Converter().convert(Path(mat_path), Path(output_path))
    report.duration_s = _time.perf_counter() - started
    logger.info("MAT converti: %d signaux (%d séries, %d constantes), %d groupes en %.1fs",
                report.signal_count, report.time_series_signals, report.constant_signals,
                report.group_count, report.duration_s)
    return report
