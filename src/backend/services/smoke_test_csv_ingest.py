"""Standalone smoke test of the CSV ingestion.

Depends on no external file: synthetic CSV files are written on the fly, converted, then checked.
Covers the comma/dot form, the semicolon/comma-decimal form with a unit row, millisecond and
ISO-8601 time axes, holes, non-numeric columns and malformed input.
Run: python smoke_test_csv_ingest.py
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

import numpy as np
from asammdf import MDF

sys.path.insert(0, str(Path(__file__).resolve().parent))
import csv_ingest  # noqa: E402
from csv_ingest import convert_csv_to_mf4  # noqa: E402


def _write(path: Path, text: str, encoding: str = "utf-8") -> Path:
    path.write_text(text, encoding=encoding)
    return path


def test_comma_dot(workdir: Path) -> None:
    source = _write(workdir / "plain.csv", "\n".join([
        "timestamps,Speed [km/h],Rpm,Label",
        "0.0,0.0,800,idle",
        "0.5,50.0,1600,drive",
        "1.0,100.0,3200,drive",
    ]))
    report = convert_csv_to_mf4(source, workdir / "plain.mf4")
    assert report.delimiter == ",", report.delimiter
    assert report.decimal == ".", report.decimal
    assert report.time_column == "timestamps", report.time_column
    assert report.row_count == 3, report.row_count
    assert report.signal_count == 2, report.signal_count
    assert report.skipped_columns == ["Label"], report.skipped_columns

    mdf = MDF(str(workdir / "plain.mf4"))
    try:
        speed = mdf.get("Speed")
        assert speed.unit == "km/h", speed.unit
        assert np.allclose(speed.samples, [0.0, 50.0, 100.0]), speed.samples
        assert np.allclose(speed.timestamps, [0.0, 0.5, 1.0]), speed.timestamps
    finally:
        mdf.close()
    print("test_comma_dot OK")


def test_semicolon_unit_row(workdir: Path) -> None:
    """Semicolon, comma decimal, unit row, millisecond axis and an accented Windows-1252 name."""
    source = _write(workdir / "euro.csv", "\n".join([
        "Time;P\u00e9dale;Couple",
        "ms;%;Nm",
        "0;0,0;1,5",
        "100;12,5;2,5",
        "200;25,0;3,5",
    ]), encoding="cp1252")
    report = convert_csv_to_mf4(source, workdir / "euro.mf4")
    assert report.delimiter == ";", report.delimiter
    assert report.decimal == ",", report.decimal
    assert report.encoding == "cp1252", report.encoding
    assert report.time_unit == "ms", report.time_unit
    assert report.signal_count == 2, report.signal_count

    mdf = MDF(str(workdir / "euro.mf4"))
    try:
        # The name is read with the detected encoding, not by the parser, which only decodes UTF-8.
        pedale = mdf.get("P\u00e9dale")
        assert pedale.unit == "%", pedale.unit
        assert np.allclose(pedale.samples, [0.0, 12.5, 25.0]), pedale.samples
        # Milliseconds are normalised to seconds: the whole chain assumes a master in seconds.
        assert np.allclose(pedale.timestamps, [0.0, 0.1, 0.2]), pedale.timestamps
    finally:
        mdf.close()
    print("test_semicolon_unit_row OK")


def test_group_cap(workdir: Path) -> None:
    """Channels sharing a master are split: MDF4 interleaves a group, so a wide one reads slowly."""
    count = csv_ingest.MAX_GROUP_CHANNELS * 2 + 3
    header = ["t"] + [f"S{i}" for i in range(count)]
    rows = [",".join(str(float(i)) for i in range(count + 1)) for _ in range(3)]
    source = _write(workdir / "wide.csv", "\n".join([",".join(header), *rows]))

    report = convert_csv_to_mf4(source, workdir / "wide.mf4")
    assert report.signal_count == count, report.signal_count
    expected = -(-count // csv_ingest.MAX_GROUP_CHANNELS)
    assert report.group_count == expected, f"{report.group_count} groupes au lieu de {expected}"

    mdf = MDF(str(workdir / "wide.mf4"))
    try:
        names = [c.name for g in mdf.groups for c in g.channels if c.name not in ("time", "t")]
        assert len(names) == len(set(names)), "noms dupliqués entre groupes"
        assert np.allclose(mdf.get(f"S{count - 1}").samples, float(count)), "dernier canal perdu"
    finally:
        mdf.close()
    print("test_group_cap OK")


def test_absolute_time_and_holes(workdir: Path) -> None:
    source = _write(workdir / "abs.csv", "\n".join([
        "datetime,Voltage,Current",
        "2026-01-02T10:00:00,12.0,1.0",
        "2026-01-02T10:00:01,12.5,",
        "2026-01-02T10:00:02,13.0,3.0",
    ]))
    report = convert_csv_to_mf4(source, workdir / "abs.mf4")
    assert report.absolute_time, "l'axe ISO-8601 aurait dû être reconnu comme absolu"
    assert report.signal_count == 2, report.signal_count
    assert report.group_count == 2, report.group_count  # Current garde son propre master

    mdf = MDF(str(workdir / "abs.mf4"))
    try:
        assert mdf.header.start_time.year == 2026, mdf.header.start_time
        voltage = mdf.get("Voltage")
        assert np.allclose(voltage.timestamps, [0.0, 1.0, 2.0]), voltage.timestamps
        current = mdf.get("Current")
        assert np.allclose(current.samples, [1.0, 3.0]), current.samples
        assert np.allclose(current.timestamps, [0.0, 2.0]), current.timestamps
    finally:
        mdf.close()
    print("test_absolute_time_and_holes OK")


def test_unsorted_is_reordered(workdir: Path) -> None:
    source = _write(workdir / "unsorted.csv", "\n".join([
        "t,Speed",
        "2.0,20.0",
        "0.0,0.0",
        "1.0,10.0",
    ]))
    report = convert_csv_to_mf4(source, workdir / "unsorted.mf4")
    assert report.reordered, "un axe désordonné aurait dû être réordonné"

    mdf = MDF(str(workdir / "unsorted.mf4"))
    try:
        speed = mdf.get("Speed")
        assert np.allclose(speed.timestamps, [0.0, 1.0, 2.0]), speed.timestamps
        assert np.allclose(speed.samples, [0.0, 10.0, 20.0]), speed.samples
    finally:
        mdf.close()
    print("test_unsorted_is_reordered OK")


def _rejects(path: Path, output: Path) -> str:
    try:
        convert_csv_to_mf4(path, output)
    except ValueError as exc:
        return str(exc)
    raise AssertionError(f"{path.name} aurait dû être refusé")


def test_rejects_malformed(workdir: Path) -> None:
    empty = _write(workdir / "empty.csv", "")
    assert "vide" in _rejects(empty, workdir / "empty.mf4").lower()

    no_signal = _write(workdir / "text.csv", "time,Mode,Comment\n0.0,idle,start\n1.0,drive,stop\n")
    assert "num\u00e9rique" in _rejects(no_signal, workdir / "text.mf4")

    no_time = _write(workdir / "notime.csv", "label,Mode\nalpha,beta\ngamma,delta\n")
    assert "temps" in _rejects(no_time, workdir / "notime.mf4")

    single_column = _write(workdir / "single.csv", "une seule colonne sans separateur\nvaleur\n")
    assert "s\u00e9parateur" in _rejects(single_column, workdir / "single.mf4")
    print("test_rejects_malformed OK")


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        workdir = Path(tmp)
        test_comma_dot(workdir)
        test_semicolon_unit_row(workdir)
        test_group_cap(workdir)
        test_absolute_time_and_holes(workdir)
        test_unsorted_is_reordered(workdir)
        test_rejects_malformed(workdir)
    print("Tous les tests passent.")


if __name__ == "__main__":
    main()
