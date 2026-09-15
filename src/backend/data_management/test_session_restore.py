"""Tests du cycle de vie des sessions EDA persistantes.

Exécution: ``python -m data_management.test_session_restore`` depuis ``src/backend``.
Couvre la reconstruction après éviction, la persistance des variables calculées, le
confinement des descripteurs à l'espace de leur propriétaire, et le délestage mémoire.
Le listing MF4 est neutralisé: aucun fichier réel n'est parsé.
"""

import json
import shutil
from pathlib import Path
from typing import Dict, Optional

import numpy as np

from config import BASE_DIR
from data_management.session_descriptor import (
    ComputedSignalSpec,
    SessionDescriptor,
    descriptor_path,
    load_descriptor,
    save_descriptor,
)
from data_management.sessions import LazyEDAManager, LazySession, LazySignal, SignalMetadata

_USERS_ROOT = BASE_DIR / "data" / "users"


class _StubManager(LazyEDAManager):
    """Gestionnaire dont le listing MF4 est neutralisé (aucun fichier réel à parser)."""

    def list_signals(self, session_id: str) -> Optional[Dict]:
        return {"signals": [], "n_signals": 0}


def _user_file(user_id: str, name: str = "run.mf4") -> Path:
    """Crée un fichier factice dans l'espace disque d'un utilisateur."""
    mf4_dir = _USERS_ROOT / user_id / "mf4"
    mf4_dir.mkdir(parents=True, exist_ok=True)
    path = mf4_dir / name
    path.write_bytes(b"placeholder")
    return path


def _cleanup(user_id: str, *session_ids: str) -> None:
    shutil.rmtree(_USERS_ROOT / user_id, ignore_errors=True)
    for session_id in session_ids:
        path = descriptor_path(session_id)
        if path is not None:
            path.unlink(missing_ok=True)


def _fake_recomputer(_session_id: str, spec: ComputedSignalSpec):
    """Moteur de recalcul déterministe: une rampe, et un échec si la source est absente."""
    if "absent" in spec.mapping.values():
        return None
    timestamps = np.arange(4, dtype=np.float64)
    return timestamps, timestamps * 2.0


def test_persistent_session_is_restored_after_eviction() -> None:
    mf4_path = _user_file("u-restore")
    manager = _StubManager()
    manager.create_session("sess-restore", "u-restore", mf4_path, filename="acquisition.mf4")

    manager.close_session("sess-restore")
    assert manager.get_session("sess-restore") is None

    restored = manager.restore_session("sess-restore", owner_id="u-restore")
    assert isinstance(restored, LazySession)
    assert restored.mf4_path == mf4_path
    assert restored.filename == "acquisition.mf4"

    _cleanup("u-restore", "sess-restore")


def test_computed_signals_survive_eviction() -> None:
    mf4_path = _user_file("u-computed")
    manager = _StubManager()
    manager.set_computed_recomputer(_fake_recomputer)
    session = manager.create_session("sess-computed", "u-computed", mf4_path)
    session.signals[0] = LazySignal(metadata=SignalMetadata(index=0, name="RPM", unit="rpm", color=""))

    ramp = np.arange(4, dtype=np.float64)
    manager.add_computed_signal(
        "sess-computed", "RPM_x2", "rpm", "double du régime", "A * 2", {"A": "RPM"}, ramp, ramp * 2.0,
    )

    descriptor = load_descriptor("sess-computed")
    assert descriptor is not None
    assert [spec.name for spec in descriptor.computed_signals] == ["RPM_x2"]
    assert descriptor.computed_signals[0].mapping == {"A": "RPM"}

    manager.close_session("sess-computed")
    restored = manager.restore_session("sess-computed", owner_id="u-computed")
    assert restored is not None

    computed = [sig for sig in restored.signals.values() if sig.metadata.computed]
    assert len(computed) == 1
    assert computed[0].metadata.name == "RPM_x2"
    assert computed[0].metadata.formula == "A * 2"
    assert computed[0].metadata.index == 1

    _cleanup("u-computed", "sess-computed")


def test_unrecomputable_variable_does_not_shift_the_others() -> None:
    mf4_path = _user_file("u-partial")
    manager = _StubManager()
    manager.set_computed_recomputer(_fake_recomputer)
    session = manager.create_session("sess-partial", "u-partial", mf4_path)
    ramp = np.arange(4, dtype=np.float64)

    manager._insert_computed_signal(session, 5, "perdue", "", "", "A", {"A": "absent"}, ramp, ramp)
    manager._insert_computed_signal(session, 6, "gardee", "", "", "A * 2", {"A": "RPM"}, ramp, ramp)
    manager._persist(session)

    manager.close_session("sess-partial")
    restored = manager.restore_session("sess-partial", owner_id="u-partial")
    assert restored is not None
    assert 5 not in restored.signals
    assert restored.signals[6].metadata.name == "gardee"

    _cleanup("u-partial", "sess-partial")


def test_explicit_close_forgets_the_session() -> None:
    mf4_path = _user_file("u-forget")
    manager = _StubManager()
    manager.create_session("sess-forget", "u-forget", mf4_path)

    manager.close_session("sess-forget", forget=True)
    assert load_descriptor("sess-forget") is None
    assert manager.restore_session("sess-forget", owner_id="u-forget") is None

    _cleanup("u-forget", "sess-forget")


def test_ephemeral_session_leaves_no_descriptor() -> None:
    mf4_path = _user_file("u-anon")
    manager = _StubManager()
    manager.create_session("sess-anon", "anonymous", mf4_path, ephemeral=True)

    assert load_descriptor("sess-anon") is None
    manager.close_session("sess-anon")
    _cleanup("u-anon", "sess-anon")


def test_missing_file_invalidates_the_descriptor() -> None:
    mf4_path = _user_file("u-gone")
    manager = _StubManager()
    manager.create_session("sess-gone", "u-gone", mf4_path)
    manager.close_session("sess-gone")
    mf4_path.unlink()

    assert manager.restore_session("sess-gone", owner_id="u-gone") is None
    assert load_descriptor("sess-gone") is None

    _cleanup("u-gone", "sess-gone")


def test_foreign_owner_cannot_restore_a_session() -> None:
    mf4_path = _user_file("u-victime")
    manager = _StubManager()
    manager.create_session("sess-victime", "u-victime", mf4_path)
    manager.close_session("sess-victime")

    assert manager.restore_session("sess-victime", owner_id="u-attaquant") is None
    assert manager.get_session("sess-victime") is None

    _cleanup("u-victime", "sess-victime")


def test_descriptor_pointing_outside_the_owner_space_is_rejected() -> None:
    victim_file = _user_file("u-cible", "secret.mf4")
    _user_file("u-pirate")
    path = descriptor_path("sess-forge")
    assert path is not None
    path.write_text(json.dumps({
        "schema": 1,
        "session_id": "sess-forge",
        "user_id": "u-pirate",
        "mf4_path": str(victim_file),
        "dbc_path": None,
        "filename": "secret.mf4",
        "computed_signals": [],
    }), encoding="utf-8")

    assert load_descriptor("sess-forge") is None
    manager = _StubManager()
    assert manager.restore_session("sess-forge", owner_id="u-pirate") is None

    _cleanup("u-cible")
    _cleanup("u-pirate", "sess-forge")


def test_anonymous_owner_is_never_persisted() -> None:
    mf4_path = _user_file("u-anon-desc")
    refused = SessionDescriptor(
        session_id="sess-anon-desc", user_id="anonymous", mf4_path=mf4_path,
        dbc_path=None, filename="run.mf4",
    )
    assert save_descriptor(refused) is False
    assert load_descriptor("sess-anon-desc") is None

    _cleanup("u-anon-desc", "sess-anon-desc")


def test_traversal_attempt_yields_no_descriptor_path() -> None:
    assert descriptor_path("../../etc/passwd") is None
    assert descriptor_path("") is None


def _loaded_session(manager: LazyEDAManager, session_id: str, user_id: str, n_samples: int) -> LazySession:
    mf4_path = _user_file(user_id)
    session = manager.create_session(session_id, user_id, mf4_path)
    samples = np.zeros(n_samples, dtype=np.float64)
    signal = LazySignal(
        metadata=SignalMetadata(index=0, name="sig", unit="", color="", loaded=True),
        timestamps=samples.copy(), values=samples.copy(),
    )
    session.signals[0] = signal
    session.loaded_bytes = signal.nbytes
    return session


def test_memory_pressure_unloads_idle_sessions_only() -> None:
    # Budget large pendant la mise en place: le contrôle déclenché par chaque création ne doit
    # pas délester avant que les deux sessions soient en place.
    manager = _StubManager(memory_budget_bytes=1024 ** 3, eviction_grace=0)
    idle = _loaded_session(manager, "sess-idle", "u-idle", 4096)
    active = _loaded_session(manager, "sess-active", "u-active", 4096)

    manager.memory_budget_bytes = 1024
    freed = manager.relieve_memory_pressure(protected_id="sess-active")

    assert freed > 0
    assert idle.loaded_bytes == 0
    assert not idle.signals[0].is_loaded
    assert active.signals[0].is_loaded
    assert manager.get_session("sess-idle") is not None

    _cleanup("u-idle", "sess-idle")
    _cleanup("u-active", "sess-active")


def test_computed_signals_are_never_unloaded() -> None:
    manager = _StubManager(memory_budget_bytes=1024 ** 3, eviction_grace=0)
    session = _loaded_session(manager, "sess-keep", "u-keep", 4096)
    ramp = np.arange(4096, dtype=np.float64)
    manager._insert_computed_signal(session, 1, "calc", "", "", "A", {"A": "sig"}, ramp, ramp)

    manager.memory_budget_bytes = 0
    manager.relieve_memory_pressure()

    assert not session.signals[0].is_loaded
    assert session.signals[1].is_loaded
    assert session.loaded_bytes == session.signals[1].nbytes

    _cleanup("u-keep", "sess-keep")


if __name__ == "__main__":
    for name, case in sorted(globals().items()):
        if name.startswith("test_") and callable(case):
            case()
            print(f"OK {name}")
