"""Tests of the server-side screen-space selection (``core.screen_decimation``).

The parity cases are shared with ``src/frontend/test/screen-decimation-parity.test.js``: both
rebuild the same signals from a generator restricted to exact IEEE operations and must select
the indices stored in ``tests/fixtures/screen_decimation_parity.json``.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any, Callable, Dict, Tuple

import numpy as np
import pytest

from core.screen_decimation import (
    NUMBA_AVAILABLE,
    _select,
    group_by_raster,
    same_raster,
    screen_select,
)

FIXTURE = Path(__file__).resolve().parents[3] / "tests" / "fixtures" / "screen_decimation_parity.json"
MASK = 0xFFFFFFFF


def _imul(a: int, b: int) -> int:
    return (a * b) & MASK


def _mulberry32(seed: int) -> Callable[[], float]:
    state = [seed & MASK]

    def rng() -> float:
        state[0] = (state[0] + 0x6D2B79F5) & MASK
        a = state[0]
        t = _imul(a ^ (a >> 15), a | 1)
        t ^= (t + _imul(t ^ (t >> 7), t | 61)) & MASK
        return ((t ^ (t >> 14)) & MASK) / 4294967296

    return rng


def _make_signal(spec: Dict[str, Any]) -> Tuple[np.ndarray, np.ndarray]:
    rng = _mulberry32(spec["seed"])
    n = spec["n"]
    t = np.empty(n, dtype=np.float64)
    y = np.empty(n, dtype=np.float32)
    clock = 0.0
    for i in range(n):
        clock += 0.01 * (1 + spec["jitter"] * (rng() - 0.5))
        t[i] = clock
        phase = i / n
        v = spec["steps"] * (math.floor(phase * 8) % 3) + spec["ramp"] * phase * 5 + spec["noise"] * (rng() - 0.5)
        if spec["spikeEvery"] > 0 and i % spec["spikeEvery"] == 0:
            v += 4
        if spec["quant"] > 0:
            v = math.floor(v * spec["quant"] + 0.5) / spec["quant"]
        y[i] = v
    return t, y


def _window(t: np.ndarray, view_min: float, view_max: float) -> Tuple[int, int]:
    first = int(np.searchsorted(t, view_min, side="left"))
    last = int(np.searchsorted(t, view_max, side="right")) - 1
    return (first - 1 if first > 0 else 0), (last + 1 if last < len(t) - 1 else len(t) - 1)


def _run_case(spec: Dict[str, Any], select: Callable = screen_select):
    t, y = _make_signal(spec)
    span = t[-1] - t[0]
    view_min = t[0] + spec["a"] * span
    view_max = t[0] + spec["b"] * span
    s, e = _window(t, view_min, view_max)
    # The server holds float64 values; the selection must rank them as the float32 the client gets.
    picked = select(t, y.astype(np.float64), s, e, view_min, view_max, spec["cols"], spec["height"], spec["budget"])
    return None if picked is None else picked.tolist()


def _cases():
    return json.loads(FIXTURE.read_text(encoding="utf-8"))["cases"]


@pytest.mark.parametrize("case", _cases(), ids=lambda case: case["name"])
def test_selects_the_same_indices_as_the_client(case: Dict[str, Any]) -> None:
    assert _run_case(case) == case["expected"]


def _plain_python_select(t, values, s, e, t_min, t_max, cols, height, budget):
    window = np.ascontiguousarray(values[s:e + 1], dtype=np.float32)
    if e - s + 1 <= budget:
        return None
    kernel = _select.py_func if NUMBA_AVAILABLE else _select
    return kernel(np.ascontiguousarray(t[s:e + 1]), window, 0, e - s, float(t_min), float(t_max),
                  int(cols), int(height), int(budget)) + s


@pytest.mark.parametrize("case", [c for c in _cases() if c["n"] <= 20000], ids=lambda case: case["name"])
def test_plain_python_fallback_matches_the_compiled_kernel(case: Dict[str, Any]) -> None:
    assert _run_case(case, _plain_python_select) == case["expected"]


def test_returns_none_when_the_window_fits_the_budget() -> None:
    t = np.arange(500, dtype=np.float64)
    assert screen_select(t, np.sin(t), 10, 409, 10.0, 409.0, 400, 200, 400) is None


def test_keeps_first_last_and_envelope_within_budget() -> None:
    rng = np.random.default_rng(0)
    t = np.cumsum(rng.uniform(0.5, 1.5, 200_000))
    y = np.cumsum(rng.normal(size=200_000)).astype(np.float32)
    y[123_456] += 500
    s, e = 1000, 190_000
    picked = screen_select(t, y, s, e, t[s], t[e], 1600, 400, 1600)
    assert picked[0] == s and picked[-1] == e
    assert len(picked) <= 1600
    assert np.all(np.diff(picked) > 0)
    assert y[picked].min() == y[s:e + 1].min() and y[picked].max() == y[s:e + 1].max()


def test_flat_window_is_two_points() -> None:
    t = np.arange(100_000, dtype=np.float64)
    picked = screen_select(t, np.full(100_000, 2.5), 0, 99_999, 0.0, 99_999.0, 1600, 400, 1600)
    assert picked.tolist() == [0, 99_999]


def test_group_by_raster_follows_the_client_heuristic() -> None:
    a = np.linspace(0, 10, 1001)
    b = a.copy()
    c = np.linspace(0, 10, 1002)
    assert same_raster(a, b) and not same_raster(a, c)
    assert group_by_raster([a, c, b]) == [[0, 2], [1]]
