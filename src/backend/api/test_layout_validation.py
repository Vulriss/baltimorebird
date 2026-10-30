"""Validation des variables calculées portées par un layout.

Exécution : python -m pytest api/test_layout_validation.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from api.layouts import _validate_computed_variables, _validate_layout, validate_layout_content  # noqa: E402
from config import LAYOUT_MAX_COMPUTED_VARIABLES  # noqa: E402


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


def test_rejects_oversized_entries() -> None:
    assert not _validate_computed_variables([_cv(name="x" * 101)])[0]
    assert not _validate_computed_variables([_cv(formula="A + " * 200)])[0]
    assert not _validate_computed_variables([_cv(description="d" * 5000)])[0]
    assert not _validate_computed_variables([_cv(source_signals=["s"] * 27)])[0]
    assert not _validate_computed_variables([_cv(name=f"v{i}") for i in range(LAYOUT_MAX_COMPUTED_VARIABLES + 1)])[0]


def test_rejects_non_string_fields() -> None:
    for overrides in ({"name": 3}, {"formula": ["A"]}, {"unit": 1}, {"mapping": {"AB": "x"}}):
        ok, _ = _validate_computed_variables([_cv(**overrides)])
        assert not ok, overrides


def _layout(signal: dict[str, object], computed: object = None) -> dict[str, object]:
    return {
        "name": "Essai",
        "tabs": [{"name": "Moteur", "plots": [{"flex": 1, "signals": [signal]}]}],
        "computed_variables": [_cv()] if computed is None else computed,
    }


def test_accepts_signal_transforms() -> None:
    for transform in (None, {"mode": "savgol", "window": 151}, {"mode": "ddt", "window": 75}, {"mode": "integral"}):
        assert _validate_layout(_layout({"name": "EngineRPM", "transform": transform})) == (True, None)


def test_rejects_malformed_transforms() -> None:
    for transform in ("savgol", {"mode": "eval"}, {"mode": "savgol", "window": "75"},
                      {"mode": "savgol", "window": 0}, {"mode": "savgol", "window": True}):
        ok, error = _validate_layout(_layout({"name": "EngineRPM", "transform": transform}))
        assert not ok and error and "EngineRPM" in error, transform


def test_layout_rejects_malformed_signal_and_computed() -> None:
    assert not _validate_layout(_layout("EngineRPM"))[0]  # type: ignore[arg-type]
    assert not _validate_layout(_layout({"name": "EngineRPM"}, computed=[None]))[0]
    assert not _validate_layout({**_layout({"name": "EngineRPM"}), "name": 42})[0]


def test_storage_content_validation() -> None:
    content = _layout({"name": "EngineRPM", "transform": {"mode": "ddt"}})
    del content["name"]
    assert validate_layout_content(content) == (True, None)
    assert not validate_layout_content({**content, "computed_variables": [{"name": "x"}]})[0]
    assert not validate_layout_content(["tabs"])[0]


def test_legacy_layout_still_valid() -> None:
    legacy = _cv()
    del legacy["mapping"]
    assert _validate_layout(_layout({"name": "EngineRPM", "style": {"color": "#fff"}}, [legacy])) == (True, None)


if __name__ == "__main__":
    for name, func in list(globals().items()):
        if name.startswith("test_") and callable(func):
            func()
    print("OK")
