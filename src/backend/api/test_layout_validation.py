"""Validation des variables calculées portées par un layout.

Exécution : python -m pytest api/test_layout_validation.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from api.layouts import _validate_computed_variables  # noqa: E402


def _cv(**overrides: object) -> dict[str, object]:
    base: dict[str, object] = {
        "name": "Puissance",
        "formula": "A * B",
        "mapping": {"A": "EngineTorque", "B": "EngineRPM"},
        "source_signals": ["EngineTorque", "EngineRPM"],
    }
    base.update(overrides)
    return base


def test_accepts_layout_with_mapping() -> None:
    assert _validate_computed_variables([_cv()]) == (True, None)


def test_accepts_legacy_layout_without_mapping() -> None:
    legacy = _cv()
    del legacy["mapping"]
    assert _validate_computed_variables([legacy]) == (True, None)


def test_rejects_non_list() -> None:
    ok, _ = _validate_computed_variables({"name": "x"})
    assert not ok


def test_rejects_non_dict_entry() -> None:
    ok, _ = _validate_computed_variables(["Puissance"])
    assert not ok


def test_rejects_missing_formula() -> None:
    ok, _ = _validate_computed_variables([_cv(formula="")])
    assert not ok


def test_rejects_malformed_mapping() -> None:
    for mapping in (["A", "B"], {"A": 3}, "A=x"):
        ok, error = _validate_computed_variables([_cv(mapping=mapping)])
        assert not ok and error and "Puissance" in error


def test_rejects_malformed_source_signals() -> None:
    ok, _ = _validate_computed_variables([_cv(source_signals="EngineRPM")])
    assert not ok


if __name__ == "__main__":
    for name, func in list(globals().items()):
        if name.startswith("test_") and callable(func):
            func()
    print("OK")
