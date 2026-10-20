"""Tests of the decimation of server views: the selection the client will reproduce.

Run with ``python -m pytest data_management/test_view_decimation.py`` from ``src/backend``.
A decimated view must carry exactly the screen-space selection the client computes later from
the full resolution data (``core.screen_decimation``), including the union over signals that
share a time base, so the plot does not change when the full data arrives.
"""

import shutil

import numpy as np

from config import BASE_DIR
from core.screen_decimation import screen_select
from data_management.datastore import MultiSourceDataStore
from data_management.sessions import LazyEDAManager, LazySignal, SignalMetadata, state_change_points

_USERS_ROOT = BASE_DIR / "data" / "users"
_USER_ID = "u-view-decimation"
_SESSION_ID = "sess-view-decimation"
_N = 50_000
_START, _END = 30.0, 420.0
_COLS, _HEIGHT = 400, 300


class _StubManager(LazyEDAManager):
    """Manager whose MF4 listing is neutralised (no real file to parse)."""

    def list_signals(self, session_id: str) -> dict | None:
        return {"signals": [], "n_signals": 0}


def _signals() -> tuple[np.ndarray, list[np.ndarray]]:
    rng = np.random.default_rng(42)
    timestamps = np.arange(_N, dtype=np.float64) * 0.01
    noisy = np.cumsum(rng.normal(size=_N))
    steps = np.floor(np.arange(_N) / 7_000.0) + 0.1 * rng.normal(size=_N)
    gate = (np.arange(_N) // 1_234 % 2).astype(np.float64)
    return timestamps, [noisy, steps, gate]


def _window(timestamps: np.ndarray) -> tuple[int, int]:
    i0 = int(np.searchsorted(timestamps, _START, side="left"))
    i1 = int(np.searchsorted(timestamps, _END, side="right"))
    return max(0, i0 - 1), min(len(timestamps) - 1, i1)


def _lazy_view(indices: list[int]) -> dict:
    mf4_dir = _USERS_ROOT / _USER_ID / "mf4"
    mf4_dir.mkdir(parents=True, exist_ok=True)
    mf4_path = mf4_dir / "run.mf4"
    mf4_path.write_bytes(b"placeholder")
    manager = _StubManager()
    try:
        session = manager.create_session(_SESSION_ID, _USER_ID, mf4_path)
        timestamps, signals = _signals()
        units = ["V", "V", "bool"]
        for idx, values in enumerate(signals):
            session.signals[idx] = LazySignal(
                metadata=SignalMetadata(index=idx, name=f"s{idx}", unit=units[idx], color="", loaded=True),
                timestamps=timestamps.copy(),
                values=values,
            )
        session.listed = True
        view = manager.get_view(_SESSION_ID, indices, _START, _END, _COLS, _HEIGHT)
    finally:
        manager.close_session(_SESSION_ID, forget=True)
        shutil.rmtree(_USERS_ROOT / _USER_ID, ignore_errors=True)
    assert view is not None
    return view


def _alone(values: np.ndarray) -> np.ndarray:
    timestamps, _ = _signals()
    s, e = _window(timestamps)
    return screen_select(timestamps, values, s, e, _START, _END, _COLS, _HEIGHT, _COLS)


def test_single_signal_carries_the_client_selection() -> None:
    timestamps, signals = _signals()
    view = _lazy_view([0])
    expected = _alone(signals[0])
    assert np.array_equal(view["signals"][0]["timestamps"], timestamps[expected])
    assert np.array_equal(view["signals"][0]["values"], signals[0][expected])


def test_signals_sharing_a_time_base_get_the_union_of_their_selections() -> None:
    timestamps, signals = _signals()
    view = _lazy_view([0, 1])
    union = np.union1d(_alone(signals[0]), _alone(signals[1]))
    for position, values in enumerate(signals[:2]):
        assert np.array_equal(view["signals"][position]["timestamps"], timestamps[union])
        assert np.array_equal(view["signals"][position]["values"], values[union])


def test_step_signal_keeps_its_fronts_and_stays_out_of_the_union() -> None:
    timestamps, signals = _signals()
    view = _lazy_view([0, 2])
    s, e = _window(timestamps)
    fronts_t, _ = state_change_points(timestamps[s:e + 1], signals[2][s:e + 1])
    assert np.array_equal(view["signals"][1]["timestamps"], fronts_t)
    assert np.array_equal(view["signals"][0]["timestamps"], timestamps[_alone(signals[0])])


def test_demo_datastore_uses_the_same_selection() -> None:
    timestamps, signals = _signals()
    store = MultiSourceDataStore()
    store.signals = [{"timestamps": timestamps, "values": values} for values in signals[:2]]
    store.metadata = [{"name": f"s{i}", "unit": "V", "color": ""} for i in range(2)]
    store.loaded = True
    view = store.get_view([0, 1], _START, _END, _COLS, _HEIGHT)
    union = np.union1d(_alone(signals[0]), _alone(signals[1]))
    assert view["signals"][0]["timestamps"] == timestamps[union].tolist()
    assert view["signals"][1]["values"] == signals[1][union].tolist()
