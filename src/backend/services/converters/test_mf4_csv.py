"""Tests for the MF4 to CSV converter.

The fixture file holds two channel groups with different rasters plus a text
channel, which is the shape that broke the previous asammdf-only export.

Run from ``src/backend`` (``python -m pytest services/converters/test_mf4_csv.py``).
"""

from __future__ import annotations

import csv
import zipfile
from pathlib import Path

import numpy as np
import pytest
from asammdf import MDF, Signal

from core.exceptions import ConversionError
from services.converters.base import ConversionCancelledError, ConversionRequest
from services.converters.mf4_csv import Mf4ToCsvConverter

_FAST_RASTER = 0.1
_SLOW_RASTER = 0.25
_DURATION = 1.0


@pytest.fixture(name="converter")
def converter_fixture() -> Mf4ToCsvConverter:
    return Mf4ToCsvConverter()


@pytest.fixture(name="source")
def source_fixture(tmp_path: Path) -> Path:
    fast_time = np.arange(0.0, _DURATION, _FAST_RASTER)
    slow_time = np.arange(0.0, _DURATION, _SLOW_RASTER)

    speed = Signal(samples=np.arange(fast_time.size, dtype=np.float64), timestamps=fast_time,
                   name="Speed", unit="km/h")
    torque = Signal(samples=np.arange(slow_time.size, dtype=np.float64) * 10.0, timestamps=slow_time,
                    name="Torque", unit="Nm")
    state = Signal(samples=np.array([b"IDLE", b"RUN", b"RUN", b"STOP"], dtype="S8"), timestamps=slow_time,
                   name="State", unit="", encoding="utf-8")

    path = tmp_path / "run.mf4"
    with MDF() as mdf:
        mdf.append([speed])
        mdf.append([torque, state])
        mdf.save(path, overwrite=True)
    return path


def _request(source: Path, converter: Mf4ToCsvConverter, tmp_path: Path, **options) -> ConversionRequest:
    work_dir = tmp_path / "work"
    work_dir.mkdir(exist_ok=True)
    return ConversionRequest(
        source=source,
        target_format="csv",
        work_dir=work_dir,
        options=converter.validate(options),
    )


def _read(path: Path, delimiter: str = ",") -> list[list[str]]:
    with path.open(newline="", encoding="utf-8") as handle:
        return list(csv.reader(handle, delimiter=delimiter))


def test_single_time_base_produces_one_existing_file(converter: Mf4ToCsvConverter, source: Path,
                                                     tmp_path: Path) -> None:
    result = converter.convert(_request(source, converter, tmp_path))

    assert result.primary.exists()
    assert result.primary.name == "run.csv"
    rows = _read(result.primary)
    assert rows[0] == ["timestamps", "Speed", "Torque", "State"]
    assert len(rows) - 1 == result.details["rows"]
    assert result.details["channels"] == 3


def test_single_time_base_unions_every_master(converter: Mf4ToCsvConverter, source: Path,
                                              tmp_path: Path) -> None:
    result = converter.convert(_request(source, converter, tmp_path))
    rows = _read(result.primary)[1:]

    fast = np.arange(0.0, _DURATION, _FAST_RASTER)
    slow = np.arange(0.0, _DURATION, _SLOW_RASTER)
    expected = np.unique(np.concatenate([fast, slow]))
    assert len(rows) == expected.size
    assert [float(row[0]) for row in rows] == pytest.approx(expected.tolist())


def test_text_channel_survives_the_export(converter: Mf4ToCsvConverter, source: Path, tmp_path: Path) -> None:
    result = converter.convert(_request(source, converter, tmp_path))
    rows = _read(result.primary)
    values = {row[3] for row in rows[1:]}

    assert values == {"IDLE", "RUN", "STOP"}


def test_previous_hold_does_not_invent_values_before_the_first_sample(
    converter: Mf4ToCsvConverter, source: Path, tmp_path: Path
) -> None:
    request = _request(source, converter, tmp_path, raster=0.05, time_from_zero=False)
    result = converter.convert(request)
    rows = _read(result.primary)[1:]

    assert rows[1][2] == rows[0][2]
    assert rows[5][2] == "10"


def test_raster_drives_the_row_count(converter: Mf4ToCsvConverter, source: Path, tmp_path: Path) -> None:
    result = converter.convert(_request(source, converter, tmp_path, raster=0.5))
    rows = _read(result.primary)[1:]

    assert [row[0] for row in rows] == ["0", "0.5"]


def test_per_group_mode_yields_one_csv_per_group_in_an_archive(
    converter: Mf4ToCsvConverter, source: Path, tmp_path: Path
) -> None:
    result = converter.convert(_request(source, converter, tmp_path, time_base="per_group"))

    assert result.primary.suffix == ".zip"
    with zipfile.ZipFile(result.primary) as bundle:
        names = sorted(bundle.namelist())
    assert len(names) == 2
    assert all(name.startswith("run.ChannelGroup_") for name in names)


def test_channel_selection_restricts_the_columns(converter: Mf4ToCsvConverter, source: Path,
                                                 tmp_path: Path) -> None:
    result = converter.convert(_request(source, converter, tmp_path, channels=["Speed"]))
    rows = _read(result.primary)

    assert rows[0] == ["timestamps", "Speed"]


def test_unknown_channel_is_reported(converter: Mf4ToCsvConverter, source: Path, tmp_path: Path) -> None:
    with pytest.raises(ConversionError):
        converter.convert(_request(source, converter, tmp_path, channels=["Absent"]))


def test_french_locale_output_uses_semicolon_and_comma(converter: Mf4ToCsvConverter, source: Path,
                                                       tmp_path: Path) -> None:
    request = _request(source, converter, tmp_path, delimiter=";", decimal=",", raster=0.15, add_units=True)
    result = converter.convert(request)
    rows = _read(result.primary, delimiter=";")

    assert rows[1][0] == "s"
    assert rows[2][0] == "0"
    assert rows[3][0] == "0,15"


def test_identical_separators_are_refused(converter: Mf4ToCsvConverter, source: Path, tmp_path: Path) -> None:
    with pytest.raises(ConversionError):
        converter.convert(_request(source, converter, tmp_path, decimal=","))


def test_units_row_is_optional(converter: Mf4ToCsvConverter, source: Path, tmp_path: Path) -> None:
    result = converter.convert(_request(source, converter, tmp_path))
    rows = _read(result.primary)

    assert rows[1][0] == "0"


def test_cancellation_is_honoured(converter: Mf4ToCsvConverter, source: Path, tmp_path: Path) -> None:
    work_dir = tmp_path / "work"
    work_dir.mkdir()
    request = ConversionRequest(
        source=source,
        target_format="csv",
        work_dir=work_dir,
        options=converter.validate({}),
        is_cancelled=lambda: True,
    )

    with pytest.raises(ConversionCancelledError):
        converter.convert(request)


def test_output_guard_refuses_an_oversized_table(converter: Mf4ToCsvConverter, source: Path,
                                                 tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("services.converters.mf4_csv.MAX_OUTPUT_CELLS", 4)

    with pytest.raises(ConversionError):
        converter.convert(_request(source, converter, tmp_path))


def test_linear_mode_matches_the_native_asammdf_export(converter: Mf4ToCsvConverter, source: Path,
                                                       tmp_path: Path) -> None:
    request = _request(source, converter, tmp_path, raster=0.05, hold="linear", precision=12)
    result = converter.convert(request)
    ours = _read(result.primary)

    reference_dir = tmp_path / "reference"
    reference_dir.mkdir()
    with MDF(source) as mdf:
        mdf.export("csv", filename=reference_dir / source.stem, single_time_base=True,
                   raster=0.05, time_from_zero=True)
    reference = _read(next(reference_dir.glob("*.csv")))

    assert ours[0][:3] == reference[0][:3]
    for row, expected in zip(ours[1:], reference[1:], strict=True):
        assert float(row[1]) == pytest.approx(float(expected[1]), abs=1e-9)


def test_progress_reaches_completion(converter: Mf4ToCsvConverter, source: Path, tmp_path: Path) -> None:
    seen: list[float] = []
    work_dir = tmp_path / "work"
    work_dir.mkdir()
    request = ConversionRequest(
        source=source,
        target_format="csv",
        work_dir=work_dir,
        options=converter.validate({}),
        report=lambda percent, message: seen.append(percent),
    )

    converter.convert(request)

    assert seen[-1] == 100.0
    assert seen == sorted(seen)
