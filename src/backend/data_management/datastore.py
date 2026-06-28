"""
Baltimore Bird - DataStore multi-sources.

Gère le chargement et l'accès aux donnees:
- Fichiers MF4 de démo
- Données synthétiques
- Fichiers utilisateur
- Sessions EDA
"""

import time
import logging
from pathlib import Path
from typing import Any, Optional

import numpy as np

from config import BASE_DIR, DATA_SOURCES
from core.downsampling import lttb_downsample
from .loaders import load_mf4_with_dbc, load_synthetic_data

logger = logging.getLogger(__name__)


class MultiSourceDataStore:
    """Gestionnaire de sources de donnees."""

    def __init__(self):
        self.current_source: Optional[str] = None
        self.signals: list = []
        self.metadata: list = []
        self.t_min: float = 0
        self.t_max: float = 0
        self.loaded: bool = False
        self._eda_sessions: dict = {}

    def register_eda_session(self, session_id: str, session_data: dict) -> None:
        """Enregistre une session EDA pour accès via source."""
        self._eda_sessions[session_id] = session_data

    def unregister_eda_session(self, session_id: str) -> None:
        """Supprime une session EDA."""
        self._eda_sessions.pop(session_id, None)

    def get_available_sources(self) -> list[dict[str, Any]]:
        """Retourne toutes les sources disponibles (démo uniquement, users via endpoint)."""
        sources = []
        for key, config in DATA_SOURCES.items():
            available = True
            if key == "mf4":
                mf4_path = BASE_DIR / config.get("mf4_file", "")
                available = mf4_path.exists()
            elif key.startswith("session_"):
                session_id = config.get("session_id")
                available = session_id in self._eda_sessions

            sources.append({
                "id": key,
                "name": config["name"],
                "description": config["description"],
                "available": available,
                "category": "demo",
            })
        return sources

    def load(self, source_id: Optional[str] = None) -> None:
        """Charge une source de données."""
        if source_id is None:
            if self.current_source:
                source_id = self.current_source
            else:
                mf4_config = DATA_SOURCES.get("mf4", {})
                mf4_path = BASE_DIR / mf4_config.get("mf4_file", "")
                source_id = "mf4" if mf4_path.exists() else "synthetic"

        if self.loaded and self.current_source == source_id:
            return

        logger.info(f"Loading data source: {source_id}")

        if source_id == "synthetic":
            self.signals, self.metadata, self.t_min, self.t_max = load_synthetic_data()
        elif source_id == "mf4":
            config = DATA_SOURCES["mf4"]
            mf4_path = BASE_DIR / config["mf4_file"]
            dbc_path = BASE_DIR / config["dbc_file"] if config.get("dbc_file") else None
            if not mf4_path.exists():
                raise FileNotFoundError(f"MF4 file not found: {mf4_path}")
            self.signals, self.metadata, self.t_min, self.t_max = load_mf4_with_dbc(mf4_path, dbc_path)
        elif source_id.startswith("session_"):
            session_id = source_id.replace("session_", "")
            if session_id not in self._eda_sessions:
                raise ValueError(f"Session not found: {session_id}")
            session = self._eda_sessions[session_id]
            self.signals = session["signals"]
            self.metadata = session["metadata"]
            self.t_min = session["t_min"]
            self.t_max = session["t_max"]
            logger.info(f"Loaded session: {session['filename']}")
        else:
            raise ValueError(f"Unknown source: {source_id}")

        self.current_source = source_id
        self.loaded = True
        self._warmup_lttb()
        logger.info(f"Ready: {len(self.signals)} signals")

    def reload(self, source_id: str) -> None:
        """Force le rechargement d'une source."""
        self.loaded = False
        self.current_source = None
        self.load(source_id)

    def load_user_file(self, mf4_path: Path, dbc_path: Optional[Path] = None, source_id: Optional[str] = None) -> None:
        """Charge un fichier MF4 utilisateur."""
        logger.info(f"Loading user file: {mf4_path.name}")

        if dbc_path:
            logger.info(f"Using DBC: {dbc_path.name}")

        self.signals, self.metadata, self.t_min, self.t_max = load_mf4_with_dbc(mf4_path, dbc_path)
        self.current_source = source_id or f"user_{mf4_path.stem}"
        self.loaded = True
        self._warmup_lttb()
        logger.info(f"Ready: {len(self.signals)} signals")

    def get_view(
        self, signal_indices: list[int], start_time: float, end_time: float, max_points: int
    ) -> Optional[dict[str, Any]]:
        """Retourne une vue downsamplée des signaux demandés."""
        if not self.loaded:
            self.load()

        result = {
            "view": {
                "start": float(start_time),
                "end": float(end_time),
                "original_points": 0,
                "returned_points": 0
            },
            "signals": [],
        }

        for sig_idx in signal_indices:
            if sig_idx < 0 or sig_idx >= len(self.signals):
                continue

            sig = self.signals[sig_idx]
            meta = self.metadata[sig_idx]
            timestamps, values = sig["timestamps"], sig["values"]

            # Timestamps monotones: bornage O(log n) au lieu d'un masque O(n).
            i0 = int(np.searchsorted(timestamps, start_time, side="left"))
            i1 = int(np.searchsorted(timestamps, end_time, side="right"))
            view_ts, view_vals = timestamps[i0:i1], values[i0:i1]

            if len(view_ts) == 0:
                continue

            result["view"]["original_points"] += len(view_ts)

            t_start = time.time()
            if len(view_ts) > max_points:
                ds_ts, ds_vals = lttb_downsample(view_ts, view_vals, max_points)
            else:
                ds_ts, ds_vals = view_ts, view_vals
            lttb_time = (time.time() - t_start) * 1000

            result["view"]["returned_points"] += len(ds_ts)
            result["signals"].append({
                "index": sig_idx,
                "name": meta["name"],
                "unit": meta["unit"],
                "color": meta["color"],
                "timestamps": ds_ts.tolist(),
                "values": ds_vals.tolist(),
                "is_complete": len(view_ts) <= max_points,
                "stats": {
                    "min": float(np.min(view_vals)),
                    "max": float(np.max(view_vals)),
                    "lttb_ms": round(lttb_time, 2)
                },
            })

        return result if result["signals"] else None

    def _warmup_lttb(self) -> None:
        """JIT Numba warmup avec un petit échantillon."""
        try:
            if self.signals:
                sig = self.signals[0]
                n = min(1000, len(sig["timestamps"]))
                _ = lttb_downsample(sig["timestamps"][:n], sig["values"][:n], 100)
        except Exception:
            logger.warning("LTTB warmup failed", exc_info=True)


datastore = MultiSourceDataStore()
