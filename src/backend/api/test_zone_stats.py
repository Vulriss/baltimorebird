"""zone-stats endpoint smoke test.

La logique d'extraction des zones HIGH et d'agrégation vit dans le handler
eda_zone_stats. On l'exerce via un contexte de requête Flask avec un lazy_eda
stubé (aucune session réelle, aucun fichier). Vérifie aussi que l'extraction
numpy des zones reste identique au portage JS extractBoolHighRanges.

Exécution : python test_zone_stats.py
"""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


# ---------------------------------------------------------------------------
# Chargement du handler avec dépendances stubées
# ---------------------------------------------------------------------------
def _load_handler(signals):
    """Recompile eda_zone_stats avec des stubs légers.

    Le handler référence lazy_eda / _resolve_session / jsonify / request /
    logger dans son module ; on exécute sa source dans un namespace où ces
    noms sont des stubs. Évite d'importer tout eda.py (et ses deps lourdes).
    """
    from flask import jsonify, request

    src = (Path(__file__).resolve().parents[1] / "api" / "eda.py").read_text(encoding="utf-8")
    fn_src = src[src.index("def eda_zone_stats"):]
    # Coupe à la prochaine définition top-level éventuelle
    nl = fn_src.find("\n@")
    if nl != -1:
        fn_src = fn_src[:nl]

    ns = {
        "request": request,
        "jsonify": jsonify,
        "lazy_eda": SimpleNamespace(
            preload_signals=lambda s, idxs: {},
            get_signal_data=lambda s, i: signals.get(i),
        ),
        "_resolve_session": lambda sid: (SimpleNamespace(session_id="sess"), None),
        "logger": SimpleNamespace(info=lambda *a, **k: None,
                                  warning=lambda *a, **k: None),
    }
    exec(fn_src, ns)
    return ns["eda_zone_stats"]


class _Sig:
    def __init__(self, ts, vs):
        self.timestamps = np.asarray(ts, float)
        self.values = np.asarray(vs, float)
        self.is_loaded = True


def _json(resp):
    return resp.get_json() if hasattr(resp, "get_json") else resp[0].get_json()


def _status(resp):
    return resp[1] if isinstance(resp, tuple) else 200


# Bool 10 Hz (2 zones : [0.2,0.4] et [0.6,0.9]), cible 100 Hz rampe valeur=t*100
BOOL = _Sig(np.arange(10) / 10.0, [0, 0, 1, 1, 0, 0, 1, 1, 1, 0])
TARGET = _Sig(np.arange(100) / 100.0, (np.arange(100) / 100.0) * 100)
SIGNALS = {5: BOOL, 7: TARGET}


# ---------------------------------------------------------------------------
# Extraction de zones : identité avec le portage JS
# ---------------------------------------------------------------------------
def _extract_js(bts, bvs, threshold=0.5):
    """Portage littéral de extractBoolHighRanges (référence front)."""
    ranges, in_high, rs = [], False, None
    for i in range(len(bts)):
        is_high = bvs[i] > threshold
        if is_high and not in_high:
            rs, in_high = bts[i], True
        elif (not is_high) and in_high:
            ranges.append((rs, bts[i]))
            in_high = False
    if in_high and rs is not None:
        ranges.append((rs, bts[-1]))
    return ranges


def _extract_np(bts, bvs):
    """Réplique de la vectorisation numpy du handler."""
    high = bvs > 0.5
    starts = np.flatnonzero(high & ~np.roll(high, 1))
    ends = np.flatnonzero(~high & np.roll(high, 1))
    if high.size and high[0]:
        starts = np.concatenate(([0], starts[starts != 0]))
    ranges, ei = [], 0
    for s in starts:
        while ei < len(ends) and ends[ei] <= s:
            ei += 1
        e = ends[ei] if ei < len(ends) else None
        ranges.append((float(bts[s]), float(bts[e]) if e is not None else float(bts[-1])))
    return ranges


def test_extraction_matches_js_reference():
    cases = [
        [0, 0, 1, 1, 0, 0, 1, 1, 1, 0],
        [1, 1, 0, 0, 1],       # commence ET finit high
        [1, 1, 1], [0, 0, 0], [0, 1], [1],
        [0, 1, 0, 1, 0, 1, 0, 1],   # bavard
    ]
    for bvs in cases:
        bvs = np.array(bvs, float)
        bts = np.arange(len(bvs), dtype=float) / 10
        assert _extract_np(bts, bvs) == _extract_js(bts, bvs), bvs
    # fuzz
    rng = np.random.default_rng(42)
    for _ in range(200):
        n = int(rng.integers(1, 60))
        bvs = (rng.random(n) > 0.5).astype(float)
        bts = np.sort(rng.random(n)) * 100
        assert _extract_np(bts, bvs) == _extract_js(bts, bvs)
    print("test_extraction_matches_js_reference OK")


# ---------------------------------------------------------------------------
# Mode "at" (tooltip)
# ---------------------------------------------------------------------------
def test_mode_at_inside_zone(app):
    handler = _load_handler(SIGNALS)
    with app.test_request_context(json={"bool_index": 5, "target_indices": [7], "at": 0.3}):
        z = _json(handler("sess"))["zone"]
    assert (z["start"], z["end"]) == (0.2, 0.4)
    assert z["index"] == 0 and z["total_zones"] == 2
    s = z["stats"]["7"]
    assert s["min"] == 20 and s["max"] == 40 and s["count"] == 21
    assert abs(s["mean"] - 30) < 1e-9
    print("test_mode_at_inside_zone OK")


def test_mode_at_outside_zone(app):
    handler = _load_handler(SIGNALS)
    with app.test_request_context(json={"bool_index": 5, "target_indices": [7], "at": 0.45}):
        data = _json(handler("sess"))
    assert data["zone"] is None and data["total_zones"] == 2
    print("test_mode_at_outside_zone OK")


# ---------------------------------------------------------------------------
# Mode fenêtre (popover récapitulatif)
# ---------------------------------------------------------------------------
def test_window_full(app):
    handler = _load_handler(SIGNALS)
    with app.test_request_context(json={"bool_index": 5, "target_indices": [7]}):
        data = _json(handler("sess"))
    agg = data["aggregate"]
    assert agg["count"] == 2 and len(data["zones"]) == 2
    assert abs(agg["total_duration"] - 0.5) < 1e-9
    assert abs(agg["coverage"] - 0.5 / 0.9) < 1e-9
    assert all(not z["partial"] for z in data["zones"])
    # Moyenne agrégée pondérée par échantillons : zone1 (n=21,μ=30), zone2 (n=31,μ=75)
    expected = (21 * 30 + 31 * 75) / 52
    assert abs(agg["stats"]["7"]["mean"] - expected) < 1e-9
    assert agg["stats"]["7"]["min"] == 20 and agg["stats"]["7"]["max"] == 90
    print("test_window_full OK")


def test_window_restricted_truncates_zones(app):
    handler = _load_handler(SIGNALS)
    with app.test_request_context(json={"bool_index": 5, "target_indices": [7], "t0": 0.3, "t1": 0.7}):
        zs = _json(handler("sess"))["zones"]
    assert len(zs) == 2 and all(z["partial"] for z in zs)
    assert (zs[0]["start"], zs[0]["end"]) == (0.3, 0.4)
    assert (zs[1]["start"], zs[1]["end"]) == (0.6, 0.7)
    print("test_window_restricted_truncates_zones OK")


# ---------------------------------------------------------------------------
# Validation des entrées
# ---------------------------------------------------------------------------
def test_input_validation(app):
    handler = _load_handler(SIGNALS)
    with app.test_request_context(json={"bool_index": -1, "target_indices": []}):
        assert _status(handler("sess")) == 400
    with app.test_request_context(json={"bool_index": 5, "target_indices": list(range(20))}):
        assert _status(handler("sess")) == 400
    with app.test_request_context(json={"bool_index": 99, "target_indices": []}):
        assert _status(handler("sess")) == 404      # voie non chargeable
    print("test_input_validation OK")


def test_empty_bool(app):
    handler = _load_handler({5: _Sig([], []), 7: TARGET})
    with app.test_request_context(json={"bool_index": 5, "target_indices": [7]}):
        data = _json(handler("sess"))
    assert data["zones"] == [] and data["aggregate"] is None
    print("test_empty_bool OK")


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------
def main() -> None:
    from flask import Flask
    app = Flask(__name__)

    import inspect
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        if "app" in inspect.signature(fn).parameters:
            fn(app)
        else:
            fn()
    print(f"Tous les tests passent ({len(tests)}).")


if __name__ == "__main__":
    main()
