"""Test de fumée autonome de l'ingestion .mat.

Ne dépend d'aucun fichier externe : un .mat de simulation synthétique est fabriqué à la volée
(série sur temps global, scalaire, signal booléen avec métadonnée de mise à l'échelle, structure
Simulink time/signals), converti puis vérifié.
Exécution : python smoke_test_mat_ingest.py
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

import numpy as np
from asammdf import MDF
from scipy.io import savemat

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mat_ingest import convert_mat_to_mf4  # noqa: E402


def _scaling(name: str, unit: str, kind: str) -> dict:
    return {"Name": name, "Unit": unit, "Type": kind}


def _write_mat(path: Path) -> None:
    time = np.linspace(0.0, 1.0, 11, dtype=np.float32)
    scaling = np.empty((3,), dtype=object)
    scaling[0] = _scaling("Speed", "km/h", "Float")
    scaling[1] = _scaling("Flag", "", "Bool")
    scaling[2] = _scaling("Const", "V", "Float")
    payload = {
        "Time": time,
        "Speed": (time * 100.0).astype(np.float32),
        "Flag": (np.arange(11) % 2).astype(np.float32),
        "Const": np.float32(42.0),
        "StructSig": {"time": np.array([0.0, 0.5, 1.0]),
                      "signals": {"name": "inside", "values": np.array([1.0, 2.0, 3.0])}},
        "ScalingOutPorts": scaling,
        "UserName": "tester",
    }
    savemat(str(path), payload)


def test_conversion(workdir: Path) -> None:
    mat = workdir / "sim.mat"
    _write_mat(mat)
    output = workdir / "decoded.mf4"

    report = convert_mat_to_mf4(mat, output)
    assert report.time_variable == "Time", report.time_variable
    assert report.signal_count == 4, report.signal_count  # Speed, Flag, Const, StructSig
    assert report.time_series_signals == 3, report.time_series_signals  # Speed, Flag, StructSig
    assert report.constant_signals == 1, report.constant_signals  # Const

    mdf = MDF(str(output))
    try:
        names = [c.name for g in mdf.groups for c in g.channels if c.name not in ("time", "t")]
        assert len(names) == len(set(names)), f"noms dupliqués: {names}"

        speed = mdf.get("Speed")
        assert speed.unit == "km/h", speed.unit
        assert speed.timestamps.size == 11, speed.timestamps.size
        assert np.isclose(speed.samples[-1], 100.0), speed.samples[-1]

        flag = mdf.get("Flag")
        assert flag.unit == "bool", flag.unit  # type Bool -> rendu en escalier

        const = mdf.get("Const")
        assert const.timestamps.size == 2, const.timestamps.size
        assert np.allclose(const.samples, 42.0), const.samples
        assert const.timestamps[0] == 0.0 and const.timestamps[-1] == 1.0
    finally:
        mdf.close()
    print("test_conversion OK")


def test_requires_time_series(workdir: Path) -> None:
    mat = workdir / "empty.mat"
    savemat(str(mat), {"UserName": "tester", "CurrentDate": "2026-06-24"})
    raised = False
    try:
        convert_mat_to_mf4(mat, workdir / "empty.mf4")
    except ValueError:
        raised = True
    assert raised, "un .mat sans signal temporel aurait dû lever ValueError"
    print("test_requires_time_series OK")


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        workdir = Path(tmp)
        test_conversion(workdir)
        test_requires_time_series(workdir)
    print("Tous les tests passent.")


if __name__ == "__main__":
    main()
