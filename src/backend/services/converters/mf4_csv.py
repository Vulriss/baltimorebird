"""Baltimore Bird - MF4 to CSV converter.

Reading goes through `data_management.mf4_source`, so the Rust engine is used
whenever it is installed and the asammdf fallback, raw bus log decoding and
decoded-file caching all come for free.

Writing is single-sourced: both output modes feed the same writer, which is what
guarantees that a file converted on a machine with the Rust engine and the same
file converted without it produce byte-identical CSV.

Two output modes, per ASAM MDF semantics. A MF4 file holds several channel
groups, each with its own master, so there is no such thing as one natural CSV:
either every channel is projected onto a common time base and the result is one
file, or each group keeps its own master and the result is one file per group,
delivered as a ZIP archive.
"""

from __future__ import annotations

import csv
import logging
import zipfile
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
from numpy.typing import NDArray

from core.exceptions import ConversionError
from data_management.mf4_source import Mf4Index, build_index, get_column_raw

from .base import (
    BOOL_OPTION,
    ENUM_OPTION,
    FLOAT_OPTION,
    INT_OPTION,
    STR_LIST_OPTION,
    ConversionRequest,
    ConversionResult,
    Converter,
    OptionSpec,
)

logger = logging.getLogger(__name__)

TIME_BASE_SINGLE = "single"
TIME_BASE_PER_GROUP = "per_group"

HOLD_PREVIOUS = "previous"
HOLD_LINEAR = "linear"

TIMESTAMP_COLUMN = "timestamps"
TIMESTAMP_UNIT = "s"

# Bornes de progression réservées à la phase d'écriture.
READ_PROGRESS_START = 10.0
READ_PROGRESS_END = 55.0
WRITE_PROGRESS_START = 55.0
WRITE_PROGRESS_END = 95.0

# Budget de mémoire vive pour les colonnes sources d'une conversion. Le worker
# gunicorn est unique et porte les sessions EDA: une conversion qui déborde doit
# échouer avec un message, pas emporter le processus.
SOURCE_MEMORY_BUDGET_BYTES = 512 * 1024 * 1024

# Garde sur la taille de la table produite, exprimée en cellules. 50 millions de
# cellules représentent environ 600 Mo de CSV.
MAX_OUTPUT_CELLS = 50_000_000

CHUNK_ROWS = 20_000

_NUMERIC_KINDS = frozenset("fiub")


@dataclass(slots=True)
class _Series:
    """One channel read from the source file, with its own master."""

    name: str
    unit: str
    group: int
    timestamps: NDArray[np.float64]
    samples: NDArray[Any]

    @property
    def nbytes(self) -> int:
        """Memory held by this series."""
        return int(self.timestamps.nbytes + self.samples.nbytes)


@dataclass(slots=True, frozen=True)
class _ProgressSpan:
    """Slice of the global progress scale owned by one unit of work."""

    start: float
    end: float

    def at(self, ratio: float) -> float:
        """Map a local completion ratio onto the global scale."""
        return self.start + (self.end - self.start) * ratio


@dataclass(slots=True, frozen=True)
class _Layout:
    """Everything the writer needs that does not depend on the table."""

    options: dict[str, Any]
    origin: float
    format_cell: Callable[[Any], str]


@dataclass(slots=True)
class _Table:
    """A grid of timestamps and the series projected onto it."""

    grid: NDArray[np.float64]
    series: list[_Series]
    group: int | None = None


class Mf4ToCsvConverter(Converter):
    """Export MDF4 measurements to CSV."""

    @property
    def identifier(self) -> str:
        return "mf4-csv"

    @property
    def source_formats(self) -> frozenset[str]:
        return frozenset({"mf4", "mdf", "dat"})

    @property
    def target_format(self) -> str:
        return "csv"

    @property
    def label(self) -> str:
        return "MF4 vers CSV"

    @property
    def options(self) -> tuple[OptionSpec, ...]:
        return (
            OptionSpec(
                name="time_base",
                kind=ENUM_OPTION,
                label="Base de temps",
                default=TIME_BASE_SINGLE,
                choices=(TIME_BASE_SINGLE, TIME_BASE_PER_GROUP),
            ),
            OptionSpec(name="raster", kind=FLOAT_OPTION, label="Pas de rééchantillonnage (s)", minimum=1e-9),
            OptionSpec(
                name="hold",
                kind=ENUM_OPTION,
                label="Rééchantillonnage",
                default=HOLD_PREVIOUS,
                choices=(HOLD_PREVIOUS, HOLD_LINEAR),
            ),
            OptionSpec(name="channels", kind=STR_LIST_OPTION, label="Canaux à exporter", default=()),
            OptionSpec(name="time_from_zero", kind=BOOL_OPTION, label="Temps à partir de zéro", default=True),
            OptionSpec(name="add_units", kind=BOOL_OPTION, label="Ligne d'unités", default=False),
            OptionSpec(
                name="delimiter",
                kind=ENUM_OPTION,
                label="Séparateur de colonnes",
                default=",",
                choices=(",", ";", "\t"),
            ),
            OptionSpec(
                name="decimal",
                kind=ENUM_OPTION,
                label="Séparateur décimal",
                default=".",
                choices=(".", ","),
            ),
            OptionSpec(name="precision", kind=INT_OPTION, label="Chiffres significatifs", default=10,
                       minimum=1, maximum=17),
            OptionSpec(name="compress", kind=BOOL_OPTION, label="Archive ZIP", default=False),
        )

    def convert(self, request: ConversionRequest) -> ConversionResult:
        options = dict(request.options)
        _reject_ambiguous_separators(options)

        request.report(2.0, "Indexation du fichier source")
        index = _open_index(request)
        request.raise_if_cancelled()

        positions = _select_positions(index, options["channels"])
        request.report(READ_PROGRESS_START, f"{len(positions)} canaux retenus")

        series = _read_series(index, positions, request)
        request.raise_if_cancelled()

        origin = min(float(item.timestamps[0]) for item in series)
        tables = _build_tables(series, options, origin)
        _guard_output_size(tables)

        request.report(WRITE_PROGRESS_START, "Écriture du CSV")
        written = _write_tables(tables, request, options, origin)

        primary = _finalize(written, request, options)
        rows = sum(int(table.grid.size) for table in tables)
        request.report(100.0, "Conversion terminée")
        logger.info(
            "Converted %s to CSV via %s backend: %d channels, %d rows, %d file(s)",
            request.source.name, index.backend, len(series), rows, len(written),
        )
        return ConversionResult(
            primary=primary,
            artifacts=tuple(dict.fromkeys([*written, primary])),
            details={
                "backend": index.backend,
                "channels": len(series),
                "rows": rows,
                "files": [path.name for path in written],
                "time_base": options["time_base"],
            },
        )


def _reject_ambiguous_separators(options: dict[str, Any]) -> None:
    """Refuse a delimiter that collides with the decimal separator.

    Raises:
        ConversionError: When both separators are a comma.
    """
    if options["delimiter"] == options["decimal"]:
        raise ConversionError("Le séparateur de colonnes et le séparateur décimal ne peuvent pas être identiques")


def _open_index(request: ConversionRequest) -> Mf4Index:
    """Index the source file, Rust first, asammdf as fallback.

    Raises:
        ConversionError: When the file cannot be indexed or holds no channel.
    """
    try:
        index = build_index(
            request.source,
            dbc_path=request.dbc,
            keep_handle=True,
            decoded_cache_dir=request.work_dir / "decoded",
        )
    except Exception as exc:
        raise ConversionError(f"Lecture impossible du fichier source: {exc}") from exc
    if not index.columns:
        raise ConversionError("Le fichier ne contient aucun canal exploitable")
    return index


def _select_positions(index: Mf4Index, requested: Sequence[str]) -> list[int]:
    """Resolve the requested channel names to column positions.

    Matching accepts the display name and the raw channel name, so a selection
    captured in the EDA view can be replayed here unchanged.

    Raises:
        ConversionError: When a requested channel is absent from the file.
    """
    if not requested:
        return list(range(len(index.columns)))

    positions: list[int] = []
    seen: set[int] = set()
    for name in requested:
        matches = [
            i for i, column in enumerate(index.columns)
            if name in (column.name, column.raw_name)
        ]
        if not matches:
            raise ConversionError(f"Canal introuvable dans le fichier: {name}")
        for position in matches:
            if position not in seen:
                seen.add(position)
                positions.append(position)
    return positions


def _read_series(index: Mf4Index, positions: Sequence[int], request: ConversionRequest) -> list[_Series]:
    """Read every selected column, holding the memory budget.

    Raises:
        ConversionError: When the budget is exceeded or nothing could be read.
    """
    series: list[_Series] = []
    held = 0
    total = len(positions)
    for step, position in enumerate(positions):
        if step % 32 == 0:
            request.raise_if_cancelled()
            ratio = step / max(total, 1)
        request.report(READ_PROGRESS_START + (READ_PROGRESS_END - READ_PROGRESS_START) * ratio,
                       f"Lecture des canaux ({step}/{total})")

        raw = get_column_raw(index, position)
        if raw is None:
            continue
        timestamps, samples = raw
        if timestamps.size == 0 or samples.size == 0:
            continue

        column = index.columns[position]
        item = _Series(
            name=column.name,
            unit=column.unit,
            group=column.dg,
            timestamps=np.asarray(timestamps, dtype=np.float64),
            samples=samples,
        )
        held += item.nbytes
        if held > SOURCE_MEMORY_BUDGET_BYTES:
            raise ConversionError(
                "Volume de données trop important pour une conversion en une passe. "
                "Sélectionner un sous-ensemble de canaux ou fournir un pas de rééchantillonnage."
            )
        series.append(item)

    if not series:
        raise ConversionError("Aucun canal exploitable après lecture du fichier")
    return series


def _build_tables(series: Sequence[_Series], options: dict[str, Any], origin: float) -> list[_Table]:
    """Lay the series out on one or several time grids."""
    if options["time_base"] == TIME_BASE_PER_GROUP:
        groups: dict[int, list[_Series]] = {}
        for item in series:
            groups.setdefault(item.group, []).append(item)
        return [
            _Table(grid=_group_master(members), series=members, group=group)
            for group, members in sorted(groups.items())
        ]

    return [_Table(grid=_common_grid(series, options["raster"], origin), series=list(series))]


def _group_master(members: Sequence[_Series]) -> NDArray[np.float64]:
    """Return the master of a channel group.

    Channels of one group share a master by construction, but a DBC-decoded file
    can hold groups whose channels were written with differing lengths, so the
    longest master wins and the others are held onto it.
    """
    return max((item.timestamps for item in members), key=lambda stamps: stamps.size)


def _common_grid(series: Sequence[_Series], raster: float | None, origin: float) -> NDArray[np.float64]:
    """Build the common time base of a single-file export.

    Without a raster the grid is the union of every master, which is lossless
    but as long as the file is dense. With a raster it is a regular axis.

    Raises:
        ConversionError: When the union would exceed the output guard on its own.
    """
    end = max(float(item.timestamps[-1]) for item in series)
    if raster:
        count = int(np.floor((end - origin) / raster)) + 1
        if count > MAX_OUTPUT_CELLS:
            raise ConversionError("Le pas de rééchantillonnage produit trop de lignes")
        return origin + np.arange(count, dtype=np.float64) * raster

    total = sum(int(item.timestamps.size) for item in series)
    if total > MAX_OUTPUT_CELLS:
        raise ConversionError(
            "Base de temps commune trop dense pour ce fichier. "
            "Fournir un pas de rééchantillonnage ou exporter par groupe de canaux."
        )
    return np.unique(np.concatenate([item.timestamps for item in series]))


def _guard_output_size(tables: Sequence[_Table]) -> None:
    """Refuse a table that would not fit the output guard.

    Raises:
        ConversionError: When the projected cell count is too large.
    """
    cells = sum(int(table.grid.size) * (len(table.series) + 1) for table in tables)
    if cells > MAX_OUTPUT_CELLS:
        raise ConversionError(
            f"Table de sortie trop volumineuse ({cells} cellules). "
            "Réduire le nombre de canaux ou augmenter le pas de rééchantillonnage."
        )


def _project(item: _Series, grid: NDArray[np.float64], hold: str) -> tuple[NDArray[Any], NDArray[np.bool_]]:
    """Project one series onto a grid.

    Returns:
        The projected samples and the mask of grid positions actually covered by
        the series. Positions before the first sample are never invented.
    """
    covered = grid >= item.timestamps[0]
    if hold == HOLD_LINEAR and item.samples.dtype.kind in _NUMERIC_KINDS:
        values = np.interp(
            grid,
            item.timestamps,
            item.samples.astype(np.float64),
            left=np.nan,
            right=item.samples[-1],
        )
        return values, covered

    positions = np.searchsorted(item.timestamps, grid, side="right") - 1
    np.clip(positions, 0, item.timestamps.size - 1, out=positions)
    return item.samples[positions], covered


def _cell_formatter(precision: int, decimal: str) -> Callable[[Any], str]:
    """Build the value formatter for a CSV cell."""
    numeric_format = f"{{:.{precision}g}}"

    def format_cell(value: Any) -> str:
        if isinstance(value, (bytes, np.bytes_)):
            return value.decode("utf-8", errors="replace")
        if isinstance(value, (float, np.floating)):
            if not np.isfinite(value):
                return ""
            text = numeric_format.format(float(value))
            return text.replace(".", decimal) if decimal != "." else text
        if isinstance(value, (int, np.integer, np.bool_, bool)):
            return str(value)
        return str(value)

    return format_cell


def _write_tables(
    tables: Sequence[_Table],
    request: ConversionRequest,
    options: dict[str, Any],
    origin: float,
) -> list[Path]:
    """Write every table to disk and return the files produced."""
    layout = _Layout(
        options=options,
        origin=origin,
        format_cell=_cell_formatter(options["precision"], options["decimal"]),
    )
    stem = request.source.stem
    width = (WRITE_PROGRESS_END - WRITE_PROGRESS_START) / max(len(tables), 1)

    written: list[Path] = []
    for position, table in enumerate(tables):
        name = f"{stem}.csv" if table.group is None else f"{stem}.ChannelGroup_{table.group}.csv"
        path = request.work_dir / name
        start = WRITE_PROGRESS_START + width * position
        _write_table(path, table, request, layout, _ProgressSpan(start=start, end=start + width))
        written.append(path)
    return written


def _write_table(
    path: Path,
    table: _Table,
    request: ConversionRequest,
    layout: _Layout,
    span: _ProgressSpan,
) -> None:
    """Write one table, chunk by chunk, never materializing the full matrix."""
    options = layout.options
    format_cell = layout.format_cell
    grid = table.grid - layout.origin if options["time_from_zero"] else table.grid
    projected = [_project(item, table.grid, options["hold"]) for item in table.series]

    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle, delimiter=options["delimiter"], lineterminator="\n")
        writer.writerow([TIMESTAMP_COLUMN, *(item.name for item in table.series)])
        if options["add_units"]:
            writer.writerow([TIMESTAMP_UNIT, *(item.unit for item in table.series)])

        for offset in range(0, grid.size, CHUNK_ROWS):
            request.raise_if_cancelled()
            stop = min(offset + CHUNK_ROWS, grid.size)
            columns: list[Sequence[str]] = [[format_cell(value) for value in grid[offset:stop]]]
            for values, covered in projected:
                columns.append([
                    format_cell(value) if is_covered else ""
                    for value, is_covered in zip(values[offset:stop], covered[offset:stop], strict=True)
                ])
            writer.writerows(zip(*columns, strict=True))
            request.report(span.at(stop / max(grid.size, 1)), f"Écriture de {path.name}")


def _finalize(written: Sequence[Path], request: ConversionRequest, options: dict[str, Any]) -> Path:
    """Pick the file offered for download, archiving when needed.

    A per-group export always yields an archive: several files cannot be served
    through one download endpoint.
    """
    if len(written) == 1 and not options["compress"]:
        return written[0]

    archive = request.work_dir / f"{request.source.stem}.csv.zip"
    request.report(96.0, "Compression de l'archive")
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
        for path in written:
            request.raise_if_cancelled()
            bundle.write(path, arcname=path.name)
    return archive
