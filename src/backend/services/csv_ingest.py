"""Ingestion of CSV acquisition files into MF4.

A CSV is normalised into a physical MF4 file, exactly like the .mat and BLF importers, so the whole
lazy analysis chain (LOD pyramid, prefetch, computed channels, interval statistics, export) is
reused without a single change and a CSV reopened from the library behaves like any other
acquisition.

Supported structure, which is also what the user documentation promises:
    - Encoding: UTF-8 with or without BOM, then Windows-1252, then Latin-1 as a last resort.
    - Delimiter: comma, semicolon, tabulation or pipe, detected on the head of the file.
    - Header: first row carries the column names. A unit may be appended as ``Speed [km/h]`` or
      ``Speed (km/h)``.
    - Optional unit row: a second row holding no numeric value at all is read as units, which is
      what this application writes when exporting MF4 to CSV. The round trip is therefore lossless
      on names and units.
    - Time column: the first column, unless another one is named like a time axis. Numeric values
      are seconds unless the column name or the unit row says otherwise (ms, us, ns, min, h).
      ISO-8601 absolute timestamps are accepted and become seconds from the first sample, the
      absolute instant being kept in the MF4 header.
    - Numeric values: dot or comma decimal separator, detected on the head of the file, scientific
      notation accepted. Empty cells and the usual missing markers are holes, not zeros: the
      channel keeps its own master built from the samples it actually has.
    - Non numeric columns are skipped and reported rather than failing the file.

The content of the file is parsed as data and never evaluated. See
``.okf/policies/security-invariants.md``.
"""

from __future__ import annotations

import csv
import logging
import re
import time as _time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

import numpy as np
import polars as pl
from asammdf import MDF, Signal

logger = logging.getLogger(__name__)

_FLOAT = np.float64

# A single gunicorn worker carries every EDA session: an oversized import must fail with a message
# rather than take the process down.
# The source cap is aligned on MAX_CONTENT_LENGTH: a bigger file is already refused by Flask, so a
# lower value here would only move the refusal earlier without protecting anything.
MAX_SOURCE_BYTES = 5 * 1024 * 1024 * 1024
# The cell budget is the one that actually bounds memory, and it is not implied by the file size: a
# file of compact values holds several times more cells per byte than a file of formatted floats.
# 150 million cells represent 1.2 Go once in float64.
MAX_CELLS = 150_000_000

# MDF4 interleaves the records of a channel group, so reading one channel means striding through
# the whole block of its group. Measured on a 5465-channel acquisition: one group per master gives
# a 160 ms unit read, capping groups at 64 channels gives 3 ms for 1.5% more file size. The lazy
# session reads one channel at a time, so this cap is what keeps it responsive.
MAX_GROUP_CHANNELS = 64

_SNIFF_BYTES = 64 * 1024
_SNIFF_LINES = 20
_CANDIDATE_DELIMITERS = (",", ";", "\t", "|")
_ENCODINGS = ("utf-8-sig", "cp1252", "latin-1")

_TIME_NAMES = frozenset({
    "timestamps", "timestamp", "time", "times", "t", "temps", "zeit", "abstime", "datetime",
})
_TIME_UNIT_FACTORS = {
    "s": 1.0, "sec": 1.0, "secs": 1.0, "second": 1.0, "seconds": 1.0,
    "ms": 1e-3, "msec": 1e-3, "millisecond": 1e-3, "milliseconds": 1e-3,
    "us": 1e-6, "usec": 1e-6, "\u00b5s": 1e-6, "\u03bcs": 1e-6, "microsecond": 1e-6, "microseconds": 1e-6,
    "ns": 1e-9, "nsec": 1e-9, "nanosecond": 1e-9, "nanoseconds": 1e-9,
    "min": 60.0, "mins": 60.0, "minute": 60.0, "minutes": 60.0,
    "h": 3600.0, "hr": 3600.0, "hour": 3600.0, "hours": 3600.0,
}
_UNIT_IN_NAME = re.compile(r"^(?P<name>.+?)\s*[\[(](?P<unit>[^\])]*)[\])]\s*$")
_DECIMAL_COMMA = re.compile(r"\d,\d")
_EXTRA_MISSING = ("-", "--", "n/a", "N/A", "na", "NA", "nan", "NaN", "null", "NULL", "?")


@dataclass(slots=True, frozen=True)
class CsvDialect:
    """How the file is laid out, as detected on its head."""

    delimiter: str
    decimal: str
    encoding: str
    has_unit_row: bool


@dataclass(slots=True)
class CsvIngestionReport:
    """Quantitative summary of a CSV to MF4 conversion."""

    total_columns: int = 0
    signal_count: int = 0
    group_count: int = 0
    row_count: int = 0
    skipped_columns: list[str] = field(default_factory=list)
    time_column: str = ""
    time_unit: str = "s"
    delimiter: str = ","
    decimal: str = "."
    encoding: str = "utf-8"
    absolute_time: bool = False
    reordered: bool = False
    duration_s: float = 0.0
    output_path: str | None = None


@dataclass(slots=True)
class _ExtractedSignal:
    """One column turned into a signal, with the master it actually covers."""

    name: str
    timestamps: np.ndarray
    values: np.ndarray
    unit: str


def _split_unit(column: str) -> tuple[str, str]:
    """Split a column header into its name and the unit it may carry in brackets."""
    match = _UNIT_IN_NAME.match(column.strip())
    if not match:
        return column.strip(), ""
    return match.group("name").strip(), match.group("unit").strip()


def _read_head(csv_path: Path) -> tuple[list[str], str]:
    """Decode the head of the file and return its first lines and the encoding that worked."""
    with csv_path.open("rb") as handle:
        raw = handle.read(_SNIFF_BYTES)
    if not raw.strip():
        raise ValueError("Fichier CSV vide")
    # Truncating on a byte boundary can cut a multi-byte character in half; drop the partial line.
    head = raw.rsplit(b"\n", 1)[0] if b"\n" in raw else raw

    for encoding in _ENCODINGS:
        try:
            text = head.decode(encoding)
        except UnicodeDecodeError:
            continue
        lines = [line for line in text.splitlines() if line.strip()][:_SNIFF_LINES]
        if lines:
            return lines, encoding
        raise ValueError("Fichier CSV vide")
    raise ValueError("Encodage du fichier CSV non reconnu : UTF-8, Windows-1252 ou Latin-1 attendus")


def _detect_delimiter(lines: list[str]) -> str:
    """Pick the delimiter that splits the head into a constant number of columns."""
    consistent, consistent_count = "", 0
    fallback, fallback_count = "", 0
    for candidate in _CANDIDATE_DELIMITERS:
        counts = [line.count(candidate) for line in lines]
        if counts[0] == 0:
            continue
        if counts[0] > fallback_count:
            fallback, fallback_count = candidate, counts[0]
        if all(count == counts[0] for count in counts) and counts[0] > consistent_count:
            consistent, consistent_count = candidate, counts[0]
    delimiter = consistent or fallback
    if not delimiter:
        raise ValueError(
            "Structure CSV non reconnue : aucun séparateur de colonnes parmi « , » « ; » « tabulation » « | »"
        )
    return delimiter


def _is_number(cell: str) -> bool:
    """Tell whether a raw cell reads as a number under either decimal convention."""
    text = cell.strip().strip('"')
    if not text:
        return False
    try:
        float(text.replace(",", "."))
    except ValueError:
        return False
    return True


def sniff_dialect(csv_path: Path) -> CsvDialect:
    """Detect delimiter, decimal separator, encoding and unit row on the head of a CSV."""
    lines, encoding = _read_head(csv_path)
    delimiter = _detect_delimiter(lines)

    rows = list(csv.reader(lines, delimiter=delimiter))
    data_rows = [row for row in rows[1:] if any(cell.strip() for cell in row)]
    has_unit_row = bool(data_rows) and not any(_is_number(cell) for cell in data_rows[0])
    numeric_rows = data_rows[1:] if has_unit_row else data_rows

    decimal = "."
    if delimiter != ",":
        sample = "\n".join(delimiter.join(row) for row in numeric_rows[:_SNIFF_LINES])
        if _DECIMAL_COMMA.search(sample):
            decimal = ","
    return CsvDialect(delimiter=delimiter, decimal=decimal, encoding=encoding, has_unit_row=has_unit_row)


class CsvToMf4Converter:
    """Turn a CSV acquisition into an MF4 file consumable by the lazy analysis chain."""

    def convert(self, csv_path: Path, output_path: Path) -> CsvIngestionReport:
        """Convert one CSV file and return what the conversion produced.

        Args:
            csv_path: Source CSV file.
            output_path: MF4 file to write.

        Returns:
            The ingestion report.

        Raises:
            ValueError: The file is empty, oversized, malformed, or holds no usable signal. The
                message is user facing and in French.
        """
        size = csv_path.stat().st_size
        if size > MAX_SOURCE_BYTES:
            raise ValueError(
                f"Fichier CSV trop volumineux : {size // (1024 * 1024)} Mo pour un maximum de "
                f"{MAX_SOURCE_BYTES // (1024 * 1024)} Mo"
            )

        dialect = sniff_dialect(csv_path)
        report = CsvIngestionReport(
            delimiter=dialect.delimiter, decimal=dialect.decimal, encoding=dialect.encoding,
        )
        frame, units = self._load(csv_path, dialect)
        report.total_columns = frame.width

        frame, timestamps, start_time = self._resolve_time(csv_path, dialect, frame, units, report)
        report.row_count = int(timestamps.size)
        signals = self._extract(frame, units, timestamps, report)
        if not signals:
            raise ValueError("Aucune colonne numérique exploitable dans le fichier CSV")

        # The signals own their samples, so the parsed table is dead weight from here on: on a file
        # of this size, holding both at once is what would make the import run out of memory.
        del frame
        self._write_mf4(signals, output_path, start_time, report)
        report.output_path = str(output_path)
        return report

    @staticmethod
    def _unit_row(csv_path: Path, dialect: CsvDialect, columns: list[str]) -> dict[str, str]:
        """Read the optional unit row and map it onto the column names."""
        with csv_path.open("r", encoding=dialect.encoding, newline="") as handle:
            reader = csv.reader(handle, delimiter=dialect.delimiter)
            rows = [row for _, row in zip(range(2), reader)]
        if len(rows) < 2:
            return {}
        return {name: cell.strip() for name, cell in zip(columns, rows[1]) if cell.strip()}

    def _load(self, csv_path: Path, dialect: CsvDialect):
        """Parse the file into a table, bounding the number of cells actually read."""
        header = self._header(csv_path, dialect)
        if not header:
            raise ValueError("Fichier CSV sans en-tête de colonnes exploitable")
        names = self._unique_names(header)
        max_rows = max(MAX_CELLS // len(names), 1)

        try:
            frame = pl.read_csv(
                csv_path,
                separator=dialect.delimiter,
                decimal_comma=(dialect.decimal == ","),
                # The header is skipped and replaced by the names we decoded ourselves: polars only
                # decodes UTF-8 and would silently mangle an accented name in a Windows-1252 file.
                # The body is left to it, where a numeric value is ASCII by construction.
                has_header=False,
                skip_rows=self._body_offset(dialect),
                new_columns=names,
                # Everything asked as Float64: a text column comes back all null and is skipped
                # downstream, without a single string ever being materialised.
                schema_overrides=[pl.Float64] * len(names),
                ignore_errors=True,
                null_values=list(_EXTRA_MISSING),
                n_rows=max_rows + 1,
                encoding="utf8-lossy",
                low_memory=True,
            )
        except pl.exceptions.NoDataError as exc:
            raise ValueError("Fichier CSV vide") from exc
        except pl.exceptions.PolarsError as exc:
            raise ValueError(f"Structure CSV invalide : {exc}") from exc

        if frame.height > max_rows:
            raise ValueError(
                f"Fichier CSV trop volumineux : plus de {MAX_CELLS // 1_000_000} millions de valeurs"
            )
        if frame.is_empty():
            raise ValueError("Fichier CSV sans ligne de données")

        units = self._unit_row(csv_path, dialect, names) if dialect.has_unit_row else {}
        return frame, units

    @staticmethod
    def _body_offset(dialect: CsvDialect) -> int:
        """Number of leading rows that carry no data."""
        return 2 if dialect.has_unit_row else 1

    @staticmethod
    def _unique_names(header: list[str]) -> list[str]:
        """Make the column names unique, a duplicate being fatal to the parser rather than to us."""
        seen: dict[str, int] = {}
        names = []
        for position, name in enumerate(header):
            candidate = name or f"Column_{position}"
            if candidate in seen:
                seen[candidate] += 1
                candidate = f"{candidate}_{seen[candidate]}"
            seen.setdefault(candidate, 1)
            names.append(candidate)
        return names

    @staticmethod
    def _header(csv_path: Path, dialect: CsvDialect) -> list[str]:
        """Read the header row alone, to size the parse before allocating anything."""
        with csv_path.open("r", encoding=dialect.encoding, newline="") as handle:
            reader = csv.reader(handle, delimiter=dialect.delimiter)
            for row in reader:
                if any(cell.strip() for cell in row):
                    return [cell.strip() for cell in row]
        return []

    def _resolve_time(self, csv_path: Path, dialect: CsvDialect, frame, units: dict[str, str],
                      report: CsvIngestionReport):
        """Build the time axis in seconds and return the table aligned on it."""
        column = self._time_column(frame)
        report.time_column = column

        timestamps, start_time, unit = self._parse_time_values(csv_path, dialect, frame, column, units)
        report.time_unit = unit
        report.absolute_time = start_time is not None

        finite = np.isfinite(timestamps)
        if int(finite.sum()) < 2:
            raise ValueError(
                f"La colonne de temps « {column} » ne contient pas assez de valeurs exploitables"
            )
        if not finite.all():
            frame, timestamps = frame.filter(pl.Series(finite)), timestamps[finite]
        if np.any(np.diff(timestamps) < 0):
            # The rendering pyramid assumes a sorted master; an unsorted export is reordered here
            # rather than refused, the reordering being reported to the user.
            order = np.argsort(timestamps, kind="stable")
            frame, timestamps = frame[order], timestamps[order]
            report.reordered = True
        return frame, np.ascontiguousarray(timestamps, dtype=_FLOAT), start_time

    @staticmethod
    def _time_column(frame) -> str:
        """Pick the time column: a column named like a time axis, else the first one."""
        for column in frame.columns:
            name, _ = _split_unit(column)
            if name.lower() in _TIME_NAMES:
                return column
        return frame.columns[0]

    def _parse_time_values(self, csv_path: Path, dialect: CsvDialect, frame, column: str,
                           units: dict[str, str]):
        """Convert the time column to seconds, accepting numeric axes and ISO-8601 instants."""
        name, inline_unit = _split_unit(column)
        unit_text = (inline_unit or units.get(column, "") or "s").strip().strip("[]()")
        factor = _TIME_UNIT_FACTORS.get(unit_text.lower())

        values = frame[column].to_numpy().astype(_FLOAT)
        if int(np.isfinite(values).sum()) >= 2:
            if factor is None:
                logger.warning("Unité de temps inconnue sur « %s » : %s, secondes supposées", name, unit_text)
                factor, unit_text = 1.0, "s"
            return values * factor, None, unit_text

        return self._parse_absolute_time(csv_path, dialect, frame, column)

    def _parse_absolute_time(self, csv_path: Path, dialect: CsvDialect, frame, column: str):
        """Re-read the time column as text and read it as instants, the axis being non-numeric."""
        position = frame.columns.index(column)
        texts = pl.read_csv(
            csv_path,
            separator=dialect.delimiter,
            has_header=False,
            skip_rows=self._body_offset(dialect),
            columns=[position],
            infer_schema=False,
            n_rows=frame.height,
            encoding="utf8-lossy",
        ).to_series()
        unusable = ValueError(
            f"La colonne de temps « {column} » n'est ni numérique ni une date reconnue (ISO-8601 attendu)"
        )
        try:
            instants = texts.str.to_datetime(strict=False).to_numpy()
        except pl.exceptions.PolarsError as exc:
            # No format could even be guessed: the column holds plain text, not dates.
            raise unusable from exc

        known = ~np.isnat(instants)
        if int(known.sum()) < 2:
            raise unusable
        origin = instants[known][0]
        seconds = (instants - origin) / np.timedelta64(1, "s")
        start = origin.astype("datetime64[us]").astype(datetime)
        return seconds.astype(_FLOAT), start if isinstance(start, datetime) else None, "s"

    def _extract(self, frame, units: dict[str, str], timestamps: np.ndarray,
                 report: CsvIngestionReport) -> list[_ExtractedSignal]:
        """Turn every non-time column into a signal, skipping what is not numeric."""
        signals: list[_ExtractedSignal] = []
        for position, column in enumerate(list(frame.columns)):
            if column == report.time_column:
                continue
            name, inline_unit = _split_unit(column)
            if not name:
                name = f"Column_{position}"
            unit = inline_unit or units.get(column, "")

            # drop_in_place releases the column from the table as it is consumed, so the peak stays
            # at the table plus one column instead of the table plus every extracted array.
            values = frame.drop_in_place(column).to_numpy().astype(_FLOAT, copy=False)
            covered = np.isfinite(values)
            if not covered.any():
                report.skipped_columns.append(column)
                continue
            if covered.all():
                signals.append(_ExtractedSignal(name, timestamps, values, unit))
            else:
                # A column with holes keeps its own master: holes are missing samples, not zeros.
                signals.append(_ExtractedSignal(
                    name, np.ascontiguousarray(timestamps[covered]), values[covered], unit,
                ))
        return signals

    def _write_mf4(self, signals: list[_ExtractedSignal], output_path: Path,
                   start_time: datetime | None, report: CsvIngestionReport) -> None:
        """Group the signals by master and write them as MF4 channel groups."""
        groups: dict[int, list[_ExtractedSignal]] = {}
        for signal in signals:
            groups.setdefault(id(signal.timestamps), []).append(signal)

        allocated: set[str] = set()
        mdf = MDF()
        if start_time is not None:
            mdf.header.start_time = start_time
        for members in groups.values():
            master = members[0].timestamps
            for offset in range(0, len(members), MAX_GROUP_CHANNELS):
                mdf.append([
                    Signal(
                        samples=np.ascontiguousarray(extracted.values, dtype=_FLOAT),
                        timestamps=master,
                        name=self._allocate_name(extracted.name, allocated),
                        unit=extracted.unit,
                    )
                    for extracted in members[offset:offset + MAX_GROUP_CHANNELS]
                ], comment="csv")
                report.group_count += 1
            report.signal_count += len(members)

        output_path.parent.mkdir(parents=True, exist_ok=True)
        mdf.save(str(output_path), overwrite=True)
        mdf.close()

    @staticmethod
    def _allocate_name(name: str, allocated: set[str]) -> str:
        """Give the channel a name no other channel of the file already holds."""
        candidate = name
        index = 2
        while candidate in allocated:
            candidate = f"{name}_{index}"
            index += 1
        allocated.add(candidate)
        return candidate


def convert_csv_to_mf4(csv_path: str | Path, output_path: str | Path) -> CsvIngestionReport:
    """Convert a CSV acquisition into a decoded MF4 file.

    Entry point for the Flask layer. The MF4 produced is consumable as is by the existing lazy
    analysis session.

    Args:
        csv_path: Source CSV file.
        output_path: MF4 file to write.

    Returns:
        The ingestion report.

    Raises:
        ValueError: The file is empty, oversized, malformed, or holds no usable signal.
    """
    started = _time.perf_counter()
    report = CsvToMf4Converter().convert(Path(csv_path), Path(output_path))
    report.duration_s = _time.perf_counter() - started
    logger.info("CSV converti: %d signaux, %d groupes, %d lignes (sép. %r, décimale %r, %s) en %.1fs",
                report.signal_count, report.group_count, report.row_count, report.delimiter,
                report.decimal, report.encoding, report.duration_s)
    return report
