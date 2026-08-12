"""Import de layouts ETAS MDA (.xdx) vers le modele de layout Baltimore Bird.

Un fichier .xdx est une base SQLite (modele objet ETAS EEE). La structure utile pour
reconstruire une disposition d'oscilloscopes YT est:

    Layer (onglet) -> InstrumentGroup -> Instrument (oscilloscope)
        -> Strips (panneaux, ordonnes par Position)
            -> Axes -> SignalReferences (couleur, epaisseur, ordre d'affichage)

Les references de signaux portent un style mais pas de nom; le nom (Label, qui est le
nom du canal MF4) est resolu via SignalToInstrumentSignalReference (Signal -> reference).

Le layout produit respecte exactement le schema consomme par applyLayout cote frontend:
    {tabs: [{name, plots: [{flex, signals: [{name, style: {color, width, dash, path, fill}}]}]}]}
"""

import sqlite3
from typing import Any, Dict, List, Optional

# Prefixes des tables typees du modele EEE.
_IG = "Etas.Eee.McdClient.Instrumentation.BL.Model.InstrumentationSetup."
_YT = "Etas.Eee.McdClient.Instruments.YtOscilloscope.BL.Model.OscilloscopeModelPart."
_IM = "Etas.Eee.McdClient.Instruments.BL.Model.InstrumentsModel."
_S = "Etas.Eee.McdClient.Signals.BL.Model.SignalSetup."


def _color_to_hex(value: Optional[int]) -> str:
    """Convertit une couleur .NET (entier signe 0xAARRGGBB) en '#rrggbb'."""
    if value is None:
        return "#cdd6f4"
    c = int(value) & 0xFFFFFFFF
    r = (c >> 16) & 0xFF
    g = (c >> 8) & 0xFF
    b = c & 0xFF
    return f"#{r:02x}{g:02x}{b:02x}"


def _table_exists(cur: sqlite3.Cursor, name: str) -> bool:
    row = cur.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1", (name,)
    ).fetchone()
    return row is not None


def _index_by_handle(cur: sqlite3.Cursor, table: str) -> Dict[bytes, sqlite3.Row]:
    """Indexe une table typee par sa cle ModelObjectHandle (BLOB de 16 octets)."""
    out: Dict[bytes, sqlite3.Row] = {}
    if not _table_exists(cur, table):
        return out
    for row in cur.execute(f'SELECT * FROM "{table}"'):
        out[row["ModelObjectHandle"]] = row
    return out


def _relation(cur: sqlite3.Cursor, table: str) -> List[tuple]:
    """Retourne les paires (Source, Target) d'une table de relation."""
    if not _table_exists(cur, table):
        return []
    return [(r["Source"], r["Target"]) for r in cur.execute(f'SELECT * FROM "{table}"')]


def _relation_map(cur: sqlite3.Cursor, table: str) -> Dict[bytes, List[bytes]]:
    """Relation Source -> [Target...] en conservant l'ordre d'insertion."""
    out: Dict[bytes, List[bytes]] = {}
    for src, tgt in _relation(cur, table):
        out.setdefault(src, []).append(tgt)
    return out


def parse_mda_layout(sqlite_path: str) -> Dict[str, Any]:
    """Parse un .xdx et produit un layout Baltimore Bird.

    Leve une exception si le fichier n'est pas une base SQLite exploitable ou ne
    contient aucun oscilloscope YT.
    """
    con = sqlite3.connect(sqlite_path)
    con.row_factory = sqlite3.Row
    try:
        cur = con.cursor()

        layers = _index_by_handle(cur, _IG + "Layers")
        strips = _index_by_handle(cur, _YT + "Strips")
        sigrefs = _index_by_handle(cur, _YT + "SignalReferences")
        signals = _index_by_handle(cur, _S + "Signals")

        layer_to_group = _relation_map(cur, _IG + "LayerToInstrumentGroup")
        group_to_inst = _relation_map(cur, _IG + "InstrumentGroupToInstruments")
        osc_to_strip = _relation_map(cur, _YT + "OscilloscopeToStrips")
        strip_to_axes = _relation_map(cur, _YT + "StripToAxes")
        axis_to_sig = _relation_map(cur, _YT + "AxisToSignals")

        # Resolution reference de signal -> nom de canal (Label).
        ref_to_label: Dict[bytes, str] = {}
        for sig_h, ref_h in _relation(cur, _IM + "SignalToInstrumentSignalReference"):
            sig_row = signals.get(sig_h)
            if sig_row is not None:
                ref_to_label[ref_h] = sig_row["Label"]

        # Ordre des couches: relation LayerGroupToLayers, repli sur l'ordre de table.
        layer_order = [t for _, t in _relation(cur, _IG + "LayerGroupToLayers")]
        if not layer_order:
            layer_order = list(layers.keys())

        tabs: List[Dict[str, Any]] = []
        for layer_h in layer_order:
            layer = layers.get(layer_h)
            if layer is None:
                continue
            tab_name = (layer["Name"] or "Layer").strip() or "Layer"

            plots: List[Dict[str, Any]] = []
            for group_h in layer_to_group.get(layer_h, []):
                for inst_h in group_to_inst.get(group_h, []):
                    strip_handles = osc_to_strip.get(inst_h, [])
                    strip_handles = sorted(
                        strip_handles,
                        key=lambda h: strips[h]["Position"] if h in strips else 0,
                    )
                    for strip_h in strip_handles:
                        strip = strips.get(strip_h)
                        sigs: List[Dict[str, Any]] = []
                        for axis_h in strip_to_axes.get(strip_h, []):
                            for ref_h in axis_to_sig.get(axis_h, []):
                                name = ref_to_label.get(ref_h)
                                if not name:
                                    continue
                                ref = sigrefs.get(ref_h)
                                color = _color_to_hex(ref["Color"]) if ref else "#cdd6f4"
                                width = float(ref["LineWidth"]) if ref and ref["LineWidth"] else 1.5
                                disp = ref["DisplayIndex"] if ref and ref["DisplayIndex"] is not None else 0
                                sigs.append({
                                    "name": name,
                                    "_display_index": disp,
                                    "style": {
                                        "color": color,
                                        "width": width if width > 0 else 1.5,
                                        "dash": "",
                                        "path": "",
                                        "fill": "",
                                    },
                                })
                        sigs.sort(key=lambda s: s["_display_index"])
                        for s in sigs:
                            s.pop("_display_index", None)
                        if not sigs:
                            continue
                        flex = 1.0
                        if strip is not None and strip["HeightWeight"]:
                            try:
                                flex = round(float(strip["HeightWeight"]), 4)
                            except (TypeError, ValueError):
                                flex = 1.0
                        plots.append({"flex": flex if flex > 0 else 1.0, "signals": sigs})

            if plots:
                tabs.append({"name": tab_name, "plots": plots})

        if not tabs:
            raise ValueError("Aucun oscilloscope YT exploitable dans le fichier MDA")

        return {"tabs": tabs}
    finally:
        con.close()
