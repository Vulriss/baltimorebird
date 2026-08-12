"""Autonomous smoke test for var creation engine.

Couvre la logique pure de computed.py sans Flask ni session : moteur de formules
(comparaisons, logique, réécriture AST, sécurité) et alignement multi-raster.
Ces fonctions sont le cœur métier des variables calculées ; elles n'ont besoin
que de numpy.

Exécution : python test_computed_formula.py
(ou, si pytest est présent : pytest test_computed_formula.py)
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

# computed.py utilise des imports absolus (api.*, config, ...) : la racine backend
# doit être sur le path, pas seulement le dossier api/.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from api.computed import (  # noqa: E402
    _align_on_common_raster,
    _is_step_signal,
    coerce_boolean_result,
    compute_formula,
    get_formula_variables,
    normalize_formula,
    validate_formula,
)


# ---------------------------------------------------------------------------
# Jeux de données partagés
# ---------------------------------------------------------------------------
def _base_signals():
    t = np.array([0.0, 1.0, 2.0, 3.0])
    return t, {
        "A": np.array([1.0, 5.0, 0.0, 10.0]),
        "B": np.array([0.0, 1.0, 1.0, 1.0]),   # booléen 0/1
        "C": np.array([1.0, 1.0, 0.0, 1.0]),   # booléen 0/1
    }


def _run(formula, data=None, t=None):
    if data is None:
        t, data = _base_signals()
    _, vals = compute_formula(formula, {k: v.copy() for k, v in data.items()}, t)
    return vals


# ---------------------------------------------------------------------------
# Normalisation & extraction de variables
# ---------------------------------------------------------------------------
def test_normalize_operators():
    assert normalize_formula("A && B") == "A  and  B"
    assert normalize_formula("A || B") == "A  or  B"
    assert normalize_formula("A = 3").strip() == "A == 3"
    assert normalize_formula("A != 3") == "A != 3"          # != préservé
    assert normalize_formula("A >= 3") == "A >= 3"          # >= préservé
    assert normalize_formula("!A") == " not A"
    assert normalize_formula("A AND B").strip() == "A and B"
    print("test_normalize_operators OK")


def test_get_variables_ignores_operator_words():
    # AND/OR/NOT ne doivent pas être lus comme des variables A, N, D, O, R, T
    assert get_formula_variables("A AND B") == ["A", "B"]
    assert get_formula_variables("A + B * C") == ["A", "B", "C"]
    assert get_formula_variables("not A or B") == ["A", "B"]
    print("test_get_variables_ignores_operator_words OK")


# ---------------------------------------------------------------------------
# Comparaisons & logique (résultats booléens 0/1)
# ---------------------------------------------------------------------------
def test_comparisons():
    assert np.array_equal(_run("A > 3"), [0, 1, 0, 1])
    assert np.array_equal(_run("A >= 5"), [0, 1, 0, 1])
    assert np.array_equal(_run("A == 0"), [0, 0, 1, 0])
    assert np.array_equal(_run("A = 0"), [0, 0, 1, 0])       # '=' seul = égalité
    assert np.array_equal(_run("A != 0"), [1, 1, 0, 1])
    print("test_comparisons OK")


def test_logical_operators():
    assert np.array_equal(_run("A > 3 and B == 1"), [0, 1, 0, 1])
    assert np.array_equal(_run("A > 3 && B == 1"), [0, 1, 0, 1])
    # A>3=[0,1,0,1] ; B==0=[1,0,0,0] ; OR=[1,1,0,1]
    assert np.array_equal(_run("A > 3 or B == 0"), [1, 1, 0, 1])
    assert np.array_equal(_run("not (A > 3)"), [1, 0, 1, 0])
    assert np.array_equal(_run("!(A > 3)"), [1, 0, 1, 0])
    assert np.array_equal(_run("~(A > 3)"), [1, 0, 1, 0])
    print("test_logical_operators OK")


def test_bitwise_on_floats():
    # &/|/^ échoueraient sur du float64 en numpy brut : la réécriture AST les
    # transforme en logical_* element-wise.
    assert np.array_equal(_run("B & C"), [0, 1, 0, 1])
    assert np.array_equal(_run("B | C"), [1, 1, 1, 1])
    assert np.array_equal(_run("B ^ C"), [1, 0, 1, 0])
    print("test_bitwise_on_floats OK")


def test_chained_comparison():
    # 0 < A < 6 est invalide sur tableaux en numpy brut ; réécrit en logical_and.
    assert np.array_equal(_run("0 < A < 6"), [1, 1, 0, 0])
    print("test_chained_comparison OK")


def test_boolean_set_algebra():
    # Entre ensembles booléens : * = ET, + = OU (peut donner 2)
    assert np.array_equal(_run("B * C"), [0, 1, 0, 1])
    assert np.array_equal(_run("B + C"), [1, 2, 1, 2])
    print("test_boolean_set_algebra OK")


def test_arithmetic_intact():
    assert np.allclose(_run("A + B * 2.5"), [1, 7.5, 2.5, 12.5])
    assert np.allclose(_run("sqrt(A) * (A > 0)"), [1.0, np.sqrt(5), 0.0, np.sqrt(10)])
    print("test_arithmetic_intact OK")


def test_scalar_broadcast():
    # Une constante doit être diffusée sur toute la base de temps.
    assert np.array_equal(_run("2"), [2, 2, 2, 2])
    print("test_scalar_broadcast OK")


# ---------------------------------------------------------------------------
# Sécurité & erreurs
# ---------------------------------------------------------------------------
def test_rejects_unsafe():
    for bad in ["import os", "__class__", "open('x')", "A.__dict__"]:
        ok, _ = validate_formula(bad)
        assert not ok, f"{bad!r} aurait dû être rejeté"
    print("test_rejects_unsafe OK")


def test_runtime_errors():
    t, data = _base_signals()
    for bad, needle in [("A +* B", "invalide"), ("D > 2", "non définies")]:
        raised = ""
        try:
            compute_formula(bad, {k: v.copy() for k, v in data.items()}, t)
        except ValueError as e:
            raised = str(e)
        assert needle in raised, f"{bad!r} -> {raised!r}"
    print("test_runtime_errors OK")


def test_length_mismatch_is_aligned_not_rejected():
    # Les longueurs différentes ne lèvent plus d'erreur : compute_formula reçoit
    # des données déjà alignées en amont (voir _align_on_common_raster).
    t = np.arange(4, dtype=float)
    data = {"A": np.ones(4), "B": np.zeros(4)}
    _, vals = compute_formula("A + B", data, t)
    assert vals.shape == (4,)
    print("test_length_mismatch_is_aligned_not_rejected OK")


# ---------------------------------------------------------------------------
# Coercition booléenne
# ---------------------------------------------------------------------------
def test_coerce_boolean():
    vals = np.array([0.0, 2.0, 1.0, 0.0])
    assert np.array_equal(coerce_boolean_result(vals, "bool"), [0, 1, 1, 0])
    # Unité non-bool : inchangé
    assert np.array_equal(coerce_boolean_result(vals, "kW"), vals)
    print("test_coerce_boolean OK")


# ---------------------------------------------------------------------------
# Détection de signaux en escalier
# ---------------------------------------------------------------------------
def test_is_step_signal():
    assert _is_step_signal("bool", False)
    assert _is_step_signal("BOOL ", False)       # casse + espaces
    assert _is_step_signal("", True)             # string_map
    assert _is_step_signal(None, False, True)    # état
    assert not _is_step_signal("km/h", False)
    assert not _is_step_signal(None, False)
    print("test_is_step_signal OK")


# ---------------------------------------------------------------------------
# Alignement multi-raster
# ---------------------------------------------------------------------------
def _entry(letter, name, ts, vals, step):
    return {"letter": letter, "name": name, "ts": ts, "vals": vals, "step": step}


def test_align_reference_is_densest():
    t_fast = np.arange(100) / 100.0
    v_fast = np.arange(100, dtype=float)
    t_slow = np.arange(10) / 10.0
    v_slow = t_slow * 10.0
    data, ref, info = _align_on_common_raster([
        _entry("A", "fast", t_fast, v_fast, False),
        _entry("B", "slow", t_slow, v_slow, False),
    ])
    assert len(ref) == 100 and info["raster_of"] == "fast"
    assert np.array_equal(data["A"], v_fast)          # référence intacte
    assert info["resampled"] == ["slow"]
    print("test_align_reference_is_densest OK")


def test_align_linear_interp_and_clamp():
    t_fast = np.arange(100) / 100.0
    t_slow = np.arange(10) / 10.0
    data, ref, _ = _align_on_common_raster([
        _entry("A", "fast", t_fast, np.arange(100, dtype=float), False),
        _entry("B", "slow", t_slow, t_slow * 10.0, False),
    ])
    covered = t_fast <= 0.9
    assert np.allclose(data["B"][covered], t_fast[covered] * 10.0)   # linéaire exact
    assert np.all(data["B"][~covered] == 9.0)                        # clamp, pas d'extrapolation
    print("test_align_linear_interp_and_clamp OK")


def test_align_step_zoh():
    t_fast = np.arange(100) / 100.0
    t_bool = np.arange(10) / 10.0
    v_bool = np.array([0, 0, 1, 1, 0, 0, 1, 1, 1, 0], dtype=float)
    data, _, _ = _align_on_common_raster([
        _entry("A", "fast", t_fast, np.arange(100, dtype=float), False),
        _entry("F", "flag", t_bool, v_bool, True),
    ])
    # Maintien de valeur : uniquement des 0/1, jamais d'interpolation fractionnaire
    assert set(np.unique(data["F"])) <= {0.0, 1.0}
    i15 = int(np.argmin(np.abs(t_fast - 0.15)))
    i25 = int(np.argmin(np.abs(t_fast - 0.25)))
    assert data["F"][i15] == 0.0 and data["F"][i25] == 1.0
    print("test_align_step_zoh OK")


def test_align_same_length_shifted_raster():
    # Même longueur mais rasters décalés : doit rééchantillonner, pas combiner en silence.
    t = np.arange(100) / 100.0
    data, _, info = _align_on_common_raster([
        _entry("A", "a", t, np.arange(100, dtype=float), False),
        _entry("B", "b", t + 0.005, np.arange(100, dtype=float), False),
    ])
    assert info is not None and info["resampled"] == ["b"]
    print("test_align_same_length_shifted_raster OK")


def test_align_identical_rasters_no_resample():
    t = np.arange(50) / 50.0
    data, _, info = _align_on_common_raster([
        _entry("A", "a", t, np.arange(50, dtype=float), False),
        _entry("B", "b", t.copy(), np.arange(50, dtype=float) * 2, False),
    ])
    assert info is None                     # rien de rééchantillonné
    print("test_align_identical_rasters_no_resample OK")


# ---------------------------------------------------------------------------
# Runner (style smoke_test_*)
# ---------------------------------------------------------------------------
def main() -> None:
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
    print(f"Tous les tests passent ({len(tests)}).")


if __name__ == "__main__":
    main()
