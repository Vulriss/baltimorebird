"""
Baltimore Bird - On-demand MF4 source.

Remplace le chemin asammdf de `loaders.load_mf4_with_dbc` par un accès
colonne-par-colonne à la demande, relu depuis le disque à chaque requête
(empreinte RAM ~nulle entre les requêtes, adapté à la concurrence).

Deux cas de fichiers :
- MF4 physique (canaux déjà décodés)  -> parser Rust `rust_mdf_parser`,
  ~12 ms/colonne à froid (réouverture par requête).
- Log CAN/LIN brut nécessitant un DBC  -> décodage asammdf `extract_bus_logging`,
  puis mise en cache du .mf4 décodé sur disque pour repasser en chemin Rust.

L'API publique reproduit le contrat consommé par `datastore.py` :
  - `build_index(...)`  -> (metadata: list[dict], t_min, t_max)  (une fois, léger)
  - `get_column(index, i)` -> {"timestamps": np.ndarray, "values": np.ndarray}
    (à la demande, relu du disque)

`metadata[i]` porte le nom d'affichage, l'unité, la couleur, et les
coordonnées internes (dg/cn) nécessaires pour relire la bonne colonne.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import numpy as np
from numpy.typing import NDArray

logger = logging.getLogger(__name__)

RAW_FRAME_PREFIXES = ("CAN_DataFrame", "CAN_ErrorFrame", "CAN_RemoteFrame")

# En-tête MDF4 : les logs bruts non finalisés commencent par "UnFinMF".
# On route uniquement sur la présence de canaux physiques (voir _looks_decoded).


@dataclass
class ColumnRef:
    """Métadonnées + coordonnées internes d'un signal traçable."""
    name: str            # nom d'affichage (désambiguïsé si homonyme)
    raw_name: str        # nom réel du canal dans le fichier
    unit: str
    color: str
    dg: int              # data group (pour désambiguïsation / relecture ciblée)


@dataclass
class Mf4Index:
    """Index léger d'un fichier, chargé une fois. Ne contient AUCUNE donnée décodée."""
    path: Path
    backend: str                      # "rust" | "asammdf"
    columns: list[ColumnRef]
    t_min: float
    t_max: float
    # Handle Rust optionnel gardé chaud (mmap paginé + index ~16 Mo/fichier).
    # None => relecture à froid par requête (empreinte quasi nulle).
    _handle: object = field(default=None, repr=False)


# ---------------------------------------------------------------------------
# Détection / routage
# ---------------------------------------------------------------------------

def _rust_available() -> bool:
    try:
        import rust_mdf_parser  # noqa: F401
        return True
    except ImportError:
        return False


def _looks_decoded_rust(path: Path) -> Optional[list[str]]:
    """Ouvre avec Rust; renvoie la liste des noms physiques traçables, ou None
    si le fichier n'a pas de canaux exploitables (probable log bus brut)."""
    import rust_mdf_parser
    m = rust_mdf_parser.MdfFile(str(path))
    names = [
        n for n in m.channel_names()
        if not n.startswith(RAW_FRAME_PREFIXES)
    ]
    # Un log CAN brut n'expose que des trames CAN_* et un Timestamp : après
    # filtrage il ne reste (quasi) rien de numérique décodable.
    return names or None


# ---------------------------------------------------------------------------
# Construction de l'index (une fois par source)
# ---------------------------------------------------------------------------

def build_index(
    mf4_path: Path,
    dbc_path: Optional[Path] = None,
    keep_handle: bool = False,
    decoded_cache_dir: Optional[Path] = None,
) -> Mf4Index:
    """Construit l'index léger d'un fichier MF4.

    - Fichier physique  -> index Rust direct.
    - Log bus brut + DBC -> décodage asammdf une fois, écriture d'un .mf4
      décodé en cache, puis index Rust sur le fichier décodé.
    - Sans Rust disponible -> index asammdf (compat).
    """
    mf4_path = Path(mf4_path)

    if _rust_available():
        physical = None
        try:
            physical = _looks_decoded_rust(mf4_path)
        except Exception:
            logger.debug("Rust open failed, will try DBC/asammdf path", exc_info=True)

        if physical is not None:
            return _build_rust_index(mf4_path, keep_handle=keep_handle)

        # Log bus brut : décoder puis repasser en Rust sur le fichier décodé.
        if dbc_path and Path(dbc_path).exists():
            decoded = _decode_bus_to_mf4(mf4_path, Path(dbc_path), decoded_cache_dir)
            if decoded is not None:
                return _build_rust_index(decoded, keep_handle=keep_handle)

    # Repli complet asammdf (pas de Rust, ou décodage indisponible).
    return _build_asammdf_index(mf4_path, dbc_path)


def _build_rust_index(path: Path, keep_handle: bool) -> Mf4Index:
    import rust_mdf_parser

    m = rust_mdf_parser.MdfFile(str(path))
    names = [n for n in m.channel_names() if not n.startswith(RAW_FRAME_PREFIXES)]

    # Désambiguïsation des homonymes (même sémantique que loaders.py).
    counts: dict[str, int] = {}
    for n in names:
        counts[n] = counts.get(n, 0) + 1

    columns: list[ColumnRef] = []
    # Un représentant par data group (les canaux d'un même groupe partagent
    # le même maître/axe temps) -> bornes exactes sans tout lire.
    dg_repr: dict[int, str] = {}

    for n in names:
        info = m.channel_info(n)
        dg = int(info["data_group"])
        display = f"{n} ({dg})" if counts[n] > 1 else n
        hue = (len(columns) * 37) % 360
        columns.append(ColumnRef(
            name=display, raw_name=n, unit=info.get("unit") or "",
            color=f"hsl({hue}, 70%, 55%)", dg=dg,
        ))
        dg_repr.setdefault(dg, n)

    # Bornes temporelles exactes : un maître par data group (handle chaud ici,
    # ~0.08 ms/lecture -> négligeable même avec des centaines de groupes).
    t_min, t_max = float("inf"), float("-inf")
    for raw_name in dg_repr.values():
        try:
            tt, _ = m.get_with_master(raw_name)
            if tt is not None and tt.size:
                t_min = min(t_min, float(tt[0]))
                t_max = max(t_max, float(tt[-1]))
        except Exception:
            continue
    if not np.isfinite(t_min):
        t_min, t_max = 0.0, 0.0

    handle = m if keep_handle else None
    logger.info(f"[rust] indexed {len(columns)} channels from {path.name}")
    return Mf4Index(path=path, backend="rust", columns=columns,
                    t_min=t_min, t_max=t_max, _handle=handle)


def _decode_bus_to_mf4(
    mf4_path: Path, dbc_path: Path, cache_dir: Optional[Path]
) -> Optional[Path]:
    """Décode un log CAN brut via asammdf et écrit un .mf4 décodé en cache."""
    try:
        from asammdf import MDF
    except ImportError:
        logger.error("asammdf required for DBC decode but not installed")
        return None

    cache_dir = Path(cache_dir) if cache_dir else mf4_path.parent / ".decoded"
    cache_dir.mkdir(parents=True, exist_ok=True)
    out = cache_dir / f"{mf4_path.stem}.decoded.mf4"
    if out.exists() and out.stat().st_mtime >= mf4_path.stat().st_mtime:
        return out

    logger.info(f"[asammdf] DBC-decoding {mf4_path.name} -> {out.name}")
    try:
        mdf = MDF(mf4_path)
        extracted = mdf.extract_bus_logging(
            database_files={"CAN": [(str(dbc_path), 0)]}
        )
        mdf.close()
        extracted.save(out, overwrite=True)
        extracted.close()
        return out
    except Exception:
        logger.error("DBC decode failed", exc_info=True)
        return None


def _build_asammdf_index(path: Path, dbc_path: Optional[Path]) -> Mf4Index:
    """Repli : index via asammdf (utilisé si Rust indisponible)."""
    from asammdf import MDF

    mdf = MDF(path)
    if dbc_path and Path(dbc_path).exists():
        try:
            ext = mdf.extract_bus_logging(
                database_files={"CAN": [(str(dbc_path), 0)]}
            )
            mdf.close()
            mdf = ext
        except Exception:
            logger.error("DBC decode failed", exc_info=True)

    masters = set()
    for gi, ci in getattr(mdf, "masters_db", {}).items():
        try:
            masters.add(mdf.groups[gi].channels[ci].name)
        except Exception:
            continue

    columns: list[ColumnRef] = []
    counts: dict[str, int] = {}
    occ: list[tuple[str, int, int]] = []
    for name, entries in mdf.channels_db.items():
        if name in masters or name.startswith(RAW_FRAME_PREFIXES):
            continue
        for gi, ci in entries:
            counts[name] = counts.get(name, 0) + 1
            occ.append((name, gi, ci))

    for name, gi, _ci in occ:
        display = f"{name} ({gi})" if counts[name] > 1 else name
        hue = (len(columns) * 37) % 360
        columns.append(ColumnRef(name=display, raw_name=name, unit="",
                                 color=f"hsl({hue}, 70%, 55%)", dg=gi))
    mdf.close()
    logger.info(f"[asammdf] indexed {len(columns)} channels from {path.name}")
    return Mf4Index(path=path, backend="asammdf", columns=columns,
                    t_min=0.0, t_max=0.0)


# ---------------------------------------------------------------------------
# Récupération à la demande d'une colonne
# ---------------------------------------------------------------------------

def _clean(values: NDArray, timestamps: NDArray) -> Optional[tuple[NDArray, NDArray]]:
    """Filtrage numérique + interpolation des NaN (même logique que loaders.py)."""
    values = np.asarray(values, dtype=np.float64)
    timestamps = np.asarray(timestamps, dtype=np.float64)
    if values.size == 0:
        return None
    mask = ~np.isfinite(values)
    if mask.all():
        return None
    if mask.any():
        valid = ~mask
        values[mask] = np.interp(
            timestamps[mask], timestamps[valid], values[valid],
            left=values[valid][0], right=values[valid][-1],
        )
    return timestamps, values


def get_column(index: Mf4Index, i: int) -> Optional[dict[str, NDArray]]:
    """Relit une colonne à la demande. Retourne {"timestamps","values"} ou None."""
    if i < 0 or i >= len(index.columns):
        return None
    col = index.columns[i]

    if index.backend == "rust":
        import rust_mdf_parser
        # Handle chaud si disponible, sinon réouverture à froid (~12 ms).
        m = index._handle or rust_mdf_parser.MdfFile(str(index.path))
        try:
            tt, vv = m.get_with_master(col.raw_name)
        except Exception:
            logger.debug(f"rust get failed for {col.raw_name}", exc_info=True)
            return None
        if tt is None:
            return None
        cleaned = _clean(vv, tt)
        if cleaned is None:
            return None
        ts, vals = cleaned
        return {"timestamps": ts, "values": vals}

    # asammdf
    from asammdf import MDF
    m = MDF(index.path)
    try:
        sig = m.get(col.raw_name, group=col.dg)
        cleaned = _clean(sig.samples, sig.timestamps)
    except Exception:
        logger.debug(f"asammdf get failed for {col.raw_name}", exc_info=True)
        cleaned = None
    finally:
        m.close()
    if cleaned is None:
        return None
    ts, vals = cleaned
    return {"timestamps": ts, "values": vals}
