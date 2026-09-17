"""Tests du fenêtrage des vues serveur: un échantillon de part et d'autre de la fenêtre.

Exécution: ``python -m data_management.test_view_window`` depuis ``src/backend``.
Couvre le datastore de démonstration et les sessions lazy (branche analogique): bords
de la vue, fenêtre tombant entre deux échantillons, bords du fichier, statistiques.
"""

import shutil

import numpy as np

from config import BASE_DIR
from data_management.datastore import MultiSourceDataStore
from data_management.sessions import LazyEDAManager, LazySignal, SignalMetadata

_USERS_ROOT = BASE_DIR / "data" / "users"
_USER_ID = "u-view-window"
_SESSION_ID = "sess-view-window"
_N_SAMPLES = 100
_DT = 0.01


class _StubManager(LazyEDAManager):
    """Gestionnaire dont le listing MF4 est neutralisé (aucun fichier réel à parser)."""

    def list_signals(self, session_id: str) -> dict | None:
        return {"signals": [], "n_signals": 0}


def _ramp() -> tuple[np.ndarray, np.ndarray]:
    """Rampe à 100 Hz: la valeur vaut l'indice de l'échantillon."""
    timestamps = np.arange(_N_SAMPLES, dtype=np.float64) * _DT
    return timestamps, np.arange(_N_SAMPLES, dtype=np.float64)


def _datastore() -> MultiSourceDataStore:
    timestamps, values = _ramp()
    store = MultiSourceDataStore()
    store.signals = [{"timestamps": timestamps, "values": values}]
    store.metadata = [{"name": "ramp", "unit": "", "color": ""}]
    store.loaded = True
    return store


def _lazy_manager() -> LazyEDAManager:
    mf4_dir = _USERS_ROOT / _USER_ID / "mf4"
    mf4_dir.mkdir(parents=True, exist_ok=True)
    mf4_path = mf4_dir / "run.mf4"
    mf4_path.write_bytes(b"placeholder")
    manager = _StubManager()
    session = manager.create_session(_SESSION_ID, _USER_ID, mf4_path)
    timestamps, values = _ramp()
    session.signals[0] = LazySignal(
        metadata=SignalMetadata(index=0, name="ramp", unit="", color="", loaded=True),
        timestamps=timestamps,
        values=values,
    )
    session.listed = True
    return manager


def _cleanup() -> None:
    shutil.rmtree(_USERS_ROOT / _USER_ID, ignore_errors=True)


def _view_values(start: float, end: float, max_points: int = 2000) -> list[tuple[list[float], dict]]:
    """Valeurs renvoyées et statistiques par les deux implémentations, pour la même fenêtre."""
    store_view = _datastore().get_view([0], start, end, max_points)
    manager = _lazy_manager()
    try:
        lazy_view = manager.get_view(_SESSION_ID, [0], start, end, max_points)
    finally:
        _cleanup()
    assert store_view is not None and lazy_view is not None
    return [
        (list(np.asarray(view["signals"][0]["values"], dtype=np.float64)), view["signals"][0])
        for view in (store_view, lazy_view)
    ]


def test_inner_window_includes_one_sample_on_each_side() -> None:
    for values, signal in _view_values(0.105, 0.145):
        assert values == [10.0, 11.0, 12.0, 13.0, 14.0, 15.0]
        assert signal["stats"]["min"] == 11.0
        assert signal["stats"]["max"] == 14.0


def test_window_between_two_samples_returns_both_neighbours() -> None:
    for values, _signal in _view_values(0.1012, 0.1017):
        assert values == [10.0, 11.0]


def test_window_at_file_edges_stays_in_bounds() -> None:
    for values, _signal in _view_values(-1.0, 0.025):
        assert values == [0.0, 1.0, 2.0, 3.0]
    for values, _signal in _view_values(0.975, 5.0):
        assert values == [97.0, 98.0, 99.0]


def test_decimated_window_keeps_outer_samples() -> None:
    for values, signal in _view_values(0.105, 0.905, max_points=20):
        assert values[0] == 10.0
        assert values[-1] == 91.0
        assert signal["is_complete"] is False


if __name__ == "__main__":
    for name, case in sorted(globals().items()):
        if name.startswith("test_") and callable(case):
            case()
            print(f"OK {name}")
