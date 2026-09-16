"""Tests for the converter registry and the declarative option validation.

Run from ``src/backend`` (``python -m pytest services/converters/test_registry.py``).
"""

from __future__ import annotations

from pathlib import Path

import pytest

from core.exceptions import ValidationError
from services.converters.base import (
    BOOL_OPTION,
    ENUM_OPTION,
    FLOAT_OPTION,
    STR_LIST_OPTION,
    ConversionRequest,
    ConversionResult,
    Converter,
    OptionSpec,
    normalize_format,
    validate_options,
)
from services.converters.registry import ConverterRegistry

_SPECS = (
    OptionSpec(name="flag", kind=BOOL_OPTION, label="Drapeau", default=False),
    OptionSpec(name="raster", kind=FLOAT_OPTION, label="Pas", minimum=1e-9),
    OptionSpec(name="mode", kind=ENUM_OPTION, label="Mode", default="a", choices=("a", "b")),
    OptionSpec(name="channels", kind=STR_LIST_OPTION, label="Canaux", default=()),
)


class _FakeConverter(Converter):
    def __init__(self, identifier: str, sources: set[str], target: str) -> None:
        self._identifier = identifier
        self._sources = frozenset(sources)
        self._target = target

    @property
    def identifier(self) -> str:
        return self._identifier

    @property
    def source_formats(self) -> frozenset[str]:
        return self._sources

    @property
    def target_format(self) -> str:
        return self._target

    @property
    def options(self) -> tuple[OptionSpec, ...]:
        return _SPECS

    def convert(self, request: ConversionRequest) -> ConversionResult:
        return ConversionResult(primary=request.work_dir / "out")


def test_normalize_format_strips_dot_and_case() -> None:
    assert normalize_format(" .MF4 ") == "mf4"


def test_registry_resolves_every_declared_source() -> None:
    registry = ConverterRegistry()
    registry.register(_FakeConverter("mf4-csv", {"mf4", ".DAT"}, "csv"))

    assert registry.resolve("MF4", ".csv").identifier == "mf4-csv"
    assert registry.resolve("dat", "csv").identifier == "mf4-csv"
    assert registry.resolve("csv", "mf4") is None
    assert registry.supports("mf4", "csv")


def test_registry_rejects_a_duplicate_route() -> None:
    registry = ConverterRegistry()
    registry.register(_FakeConverter("first", {"mf4"}, "csv"))

    with pytest.raises(ValidationError):
        registry.register(_FakeConverter("second", {"mf4"}, "csv"))


def test_registry_accepts_a_second_target_for_the_same_source() -> None:
    registry = ConverterRegistry()
    registry.register(_FakeConverter("csv", {"mf4"}, "csv"))
    registry.register(_FakeConverter("parquet", {"mf4"}, "parquet"))

    assert registry.matrix() == {"mf4": ["csv", "parquet"]}
    assert [entry["identifier"] for entry in registry.describe()] == ["csv", "parquet"]


def test_registry_rejects_an_incomplete_route() -> None:
    registry = ConverterRegistry()

    with pytest.raises(ValidationError):
        registry.register(_FakeConverter("empty", set(), "csv"))


def test_validate_options_fills_defaults() -> None:
    validated = validate_options(_SPECS, {})

    assert validated == {"flag": False, "raster": None, "mode": "a", "channels": ()}


def test_validate_options_rejects_unknown_keys() -> None:
    with pytest.raises(ValidationError):
        validate_options(_SPECS, {"unknown": 1})


def test_validate_options_rejects_a_bool_passed_as_number() -> None:
    with pytest.raises(ValidationError):
        validate_options(_SPECS, {"raster": True})


def test_validate_options_enforces_bounds_and_choices() -> None:
    with pytest.raises(ValidationError):
        validate_options(_SPECS, {"raster": 0.0})
    with pytest.raises(ValidationError):
        validate_options(_SPECS, {"mode": "c"})
    with pytest.raises(ValidationError):
        validate_options(_SPECS, {"channels": ["ok", ""]})


def test_request_cancellation_hook_defaults_to_never() -> None:
    request = ConversionRequest(source=Path("a.mf4"), target_format="csv", work_dir=Path("."))

    request.raise_if_cancelled()
