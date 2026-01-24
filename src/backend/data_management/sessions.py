"""
Baltimore Bird - Gestionnaire de sessions EDA.
Permet de charger les signaux des MF4 à la demande, limit memory footprint.
"""

import time
import logging
from pathlib import Path
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import numpy as np
from numpy.typing import NDArray

from config import LAZY_EDA_MAX_SESSIONS, LAZY_EDA_SESSION_TIMEOUT

logger = logging.getLogger(__name__)


@dataclass
class SignalMetadata:
    """Métadonnées d'un signal (sans les données)."""
    index: int
    name: str
    unit: str
    color: str
    group_index: int = 0
    channel_index: int = 0
    loaded: bool = False


@dataclass
class LazySignal:
    """Signal avec données chargées à la demande."""
    metadata: SignalMetadata
    timestamps: Optional[NDArray[np.float64]] = None
    values: Optional[NDArray[np.float64]] = None
    string_map: Optional[Dict[int, str]] = None  # Mapping int->string pour signaux catégoriels

    @property
    def is_loaded(self) -> bool:
        return self.timestamps is not None and self.values is not None


@dataclass
class LazySession:
    """Session EDA avec chargement lazy."""
    session_id: str
    user_id: str
    mf4_path: Path
    dbc_path: Optional[Path] = None
    filename: str = ""
    signals: Dict[int, LazySignal] = field(default_factory=dict)
    signal_names: List[str] = field(default_factory=list)
    t_min: float = 0.0
    t_max: float = 0.0
    n_signals: int = 0
    mdf_handle: Any = None
    listed: bool = False
    created_at: float = field(default_factory=time.time)
    last_access: float = field(default_factory=time.time)

    def touch(self) -> None:
        """Met à jour le timestamp de dernier accès."""
        self.last_access = time.time()


class LazyEDAManager:
    """Gestionnaire de sessions EDA lazy-loading."""

    def __init__(self, max_sessions: int = LAZY_EDA_MAX_SESSIONS, session_timeout: int = LAZY_EDA_SESSION_TIMEOUT):
        self.sessions: Dict[str, LazySession] = {}
        self.max_sessions = max_sessions
        self.session_timeout = session_timeout

    def create_session(self, session_id: str, user_id: str, mf4_path: Path, dbc_path: Optional[Path] = None) -> LazySession:
        """Crée une nouvelle session lazy."""
        self._cleanup_old_sessions()

        session = LazySession(
            session_id=session_id,
            user_id=user_id,
            mf4_path=mf4_path,
            dbc_path=dbc_path,
            filename=mf4_path.name
        )
        self.sessions[session_id] = session
        return session

    def get_session(self, session_id: str) -> Optional[LazySession]:
        """Récupère une session par ID."""
        session = self.sessions.get(session_id)
        if session:
            session.touch()
        return session

    def list_signals(self, session_id: str) -> Optional[Dict]:
        """Liste les signaux d'un fichier MF4 sans charger les données."""
        session = self.get_session(session_id)
        if not session:
            return None

        if session.listed:
            return self._format_signal_list(session)

        from asammdf import MDF

        start_time = time.time()
        logger.info(f"[LazyEDA] Listing signals for session {session_id[:8]}")

        try:
            mdf = MDF(session.mf4_path)

            if session.dbc_path and session.dbc_path.exists():
                logger.info("[LazyEDA] Applying DBC decoding...")
                decode_start = time.time()
                extracted = mdf.extract_bus_logging(database_files={"CAN": [(str(session.dbc_path), 0)]})
                mdf.close()
                mdf = extracted
                logger.info(f"[LazyEDA] DBC decoding done in {time.time() - decode_start:.2f}s")

            session.mdf_handle = mdf

            signal_names = list(mdf.channels_db.keys())
            exclude_patterns = ["time", "t_", "timestamp", "CAN_DataFrame"]
            filtered_names = [n for n in signal_names if not any(p.lower() in n.lower() for p in exclude_patterns)]

            logger.info(f"[LazyEDA] Found {len(filtered_names)} channels, collecting metadata...")

            channel_info = {}
            for name in filtered_names:
                groups = mdf.channels_db.get(name, [])
                if groups:
                    group_idx, channel_idx = groups[0]
                    channel_info[name] = (group_idx, channel_idx)

            t_min_global = float("inf")
            t_max_global = float("-inf")
            sampled_one = False
            valid_signals = []

            for name, (group_idx, channel_idx) in channel_info.items():
                try:
                    group = mdf.groups[group_idx]
                    channel = group.channels[channel_idx]

                    unit = ""
                    if hasattr(channel, "unit"):
                        unit = str(channel.unit) if channel.unit else ""

                    if not sampled_one:
                        try:
                            sig = mdf.get(name, group=group_idx, index=channel_idx, raw=True)
                            if sig is not None and sig.timestamps is not None and len(sig.timestamps) > 0:
                                t_min_global = float(sig.timestamps[0])
                                t_max_global = float(sig.timestamps[-1])
                                sampled_one = True
                                if not np.issubdtype(sig.samples.dtype, np.number):
                                    continue
                        except Exception:
                            pass

                    hue = (len(valid_signals) * 37) % 360
                    metadata = SignalMetadata(
                        index=len(valid_signals),
                        name=name,
                        unit=unit,
                        color=f"hsl({hue}, 70%, 55%)",
                        group_index=group_idx,
                        channel_index=channel_idx,
                        loaded=False
                    )

                    lazy_signal = LazySignal(metadata=metadata)
                    session.signals[len(valid_signals)] = lazy_signal
                    session.signal_names.append(name)
                    valid_signals.append(metadata)

                except Exception:
                    continue

            session.n_signals = len(valid_signals)
            session.t_min = t_min_global if t_min_global != float("inf") else 0
            session.t_max = t_max_global if t_max_global != float("-inf") else 0
            session.listed = True

            elapsed = time.time() - start_time
            logger.info(f"[LazyEDA] Listed {session.n_signals} signals in {elapsed:.2f}s")

            return self._format_signal_list(session)

        except Exception:
            logger.error("[LazyEDA] faced an error listing signals", exc_info=True)

            if session.mdf_handle:
                try:
                    session.mdf_handle.close()
                except Exception:
                    logger.warning("[LazyEDA] couldnt close current session", exc_info=True)
                session.mdf_handle = None
            raise

    def preload_signal(self, session_id: str, signal_index: int) -> Optional[Dict]:
        """Précharge les données d'un signal spécifique."""
        session = self.get_session(session_id)
        if not session or not session.listed:
            return None

        if signal_index not in session.signals:
            return None

        lazy_signal = session.signals[signal_index]

        if lazy_signal.is_loaded:
            return {
                "index": signal_index,
                "name": lazy_signal.metadata.name,
                "status": "ready",
                "n_samples": len(lazy_signal.timestamps) if lazy_signal.timestamps is not None else 0
            }

        start_time = time.time()
        meta = lazy_signal.metadata
        signal_name = meta.name

        try:
            mdf = session.mdf_handle
            if mdf is None:
                from asammdf import MDF
                mdf = MDF(session.mf4_path)
                if session.dbc_path and session.dbc_path.exists():
                    extracted = mdf.extract_bus_logging(database_files={"CAN": [(str(session.dbc_path), 0)]})
                    mdf.close()
                    mdf = extracted
                session.mdf_handle = mdf

            sig = mdf.get(signal_name, group=meta.group_index, index=meta.channel_index)

            if sig is None or sig.samples is None or len(sig.samples) == 0:
                return {"index": signal_index, "status": "error", "error": "Signal empty"}

            timestamps = np.asarray(sig.timestamps, dtype=np.float64)
            samples = sig.samples
            string_map = None

            # Handle non-numeric signals (string/bytes/object)
            if samples.dtype.kind in ('S', 'U', 'O'):  # String, Unicode, or Object
                unique_vals = np.unique(samples)
                string_map = {}
                val_to_num = {}

                for i, val in enumerate(unique_vals):
                    if isinstance(val, bytes):
                        decoded = val.decode('utf-8', errors='replace')
                    else:
                        decoded = str(val)
                    string_map[i] = decoded
                    val_to_num[val] = i

                values = np.array([val_to_num[v] for v in samples], dtype=np.float64)
                lazy_signal.metadata.unit = "state"
                lazy_signal.string_map = string_map
            else:
                values = np.asarray(samples, dtype=np.float64)
                lazy_signal.string_map = None

                mask = ~np.isfinite(values)
                if mask.all():
                    return {"index": signal_index, "status": "error", "error": "All NaN values"}

                if mask.any():
                    valid_mask = ~mask
                    values[mask] = np.interp(
                        timestamps[mask],
                        timestamps[valid_mask],
                        values[valid_mask],
                        left=values[valid_mask][0],
                        right=values[valid_mask][-1]
                    )

            lazy_signal.timestamps = timestamps
            lazy_signal.values = values
            lazy_signal.metadata.loaded = True

            elapsed = (time.time() - start_time) * 1000
            is_categorical = string_map is not None
            print(f"[LazyEDA] Preloaded '{signal_name}' ({len(timestamps):,} pts) in {elapsed:.1f}ms"
                  f"{' [categorical]' if is_categorical else ''}")

            response = {
                "index": signal_index,
                "name": signal_name,
                "status": "ready",
                "n_samples": len(timestamps),
                "load_time_ms": round(elapsed, 1),
                "unit": lazy_signal.metadata.unit,
            }

            if string_map:
                response["string_map"] = string_map
                response["is_categorical"] = True

            return response

        except Exception as e:
            logger.error(f"[LazyEDA] Error preloading signal {signal_index}", exc_info=True)
            return {"index": signal_index, "status": "error", "error": str(e)}

    def get_signal_data(self, session_id: str, signal_index: int) -> Optional[LazySignal]:
        """Récupère les données d'un signal, en le chargeant si nécessaire."""
        session = self.get_session(session_id)
        if not session:
            return None

        lazy_signal = session.signals.get(signal_index)
        if not lazy_signal:
            return None

        if not lazy_signal.is_loaded:
            self.preload_signal(session_id, signal_index)

        return lazy_signal

    def close_session(self, session_id: str) -> None:
        """Ferme une session et libère les ressources."""
        session = self.sessions.pop(session_id, None)
        if session and session.mdf_handle:
            try:
                session.mdf_handle.close()
                logger.info(f"[LazyEDA] Closed MDF handle for session {session_id[:8]}")
            except Exception:
                logger.warning("[LazyEDA] couldnt close current session", exc_info=True)

    def _cleanup_old_sessions(self) -> None:
        """Supprime les sessions expirées pour libérer la mémoire."""
        now = time.time()
        to_remove = []

        for sid, session in self.sessions.items():
            if now - session.last_access > self.session_timeout:
                to_remove.append(sid)

        for sid in to_remove:
            self.close_session(sid)
            logger.info(f"[LazyEDA] Cleaned up expired session {sid[:8]}")

        if len(self.sessions) > self.max_sessions:
            sorted_sessions = sorted(self.sessions.items(), key=lambda x: x[1].last_access)
            for sid, _ in sorted_sessions[:len(self.sessions) - self.max_sessions]:
                self.close_session(sid)

    def _format_signal_list(self, session: LazySession) -> Dict:
        """Formate la liste des signaux pour la réponse API."""
        signals = []
        for idx, lazy_sig in sorted(session.signals.items()):
            meta = lazy_sig.metadata
            signals.append({
                "index": meta.index,
                "name": meta.name,
                "unit": meta.unit,
                "color": meta.color,
                "loaded": lazy_sig.is_loaded
            })

        return {
            "session_id": session.session_id,
            "filename": session.filename,
            "n_signals": session.n_signals,
            "time_range": {
                "min": session.t_min,
                "max": session.t_max
            },
            "duration": session.t_max - session.t_min,
            "signals": signals
        }

    def get_view(
        self,
        session_id: str,
        signal_indices: List[int],
        start: float,
        end: float,
        max_points: int = 2000
    ) -> Optional[Dict]:
        """Récupère une vue downsamplée des signaux demandés."""
        from core.downsampling import lttb_downsample

        session = self.get_session(session_id)
        if not session or not session.listed:
            return None

        if start == 0 and end == 0:
            start = session.t_min
            end = session.t_max

        result_signals = []

        for idx in signal_indices:
            lazy_signal = self.get_signal_data(session_id, idx)
            if not lazy_signal or not lazy_signal.is_loaded:
                continue

            timestamps = lazy_signal.timestamps
            values = lazy_signal.values
            meta = lazy_signal.metadata

            mask = (timestamps >= start) & (timestamps <= end)
            t_slice = timestamps[mask]
            v_slice = values[mask]

            if len(t_slice) == 0:
                continue

            if len(t_slice) > max_points:
                t_down, v_down = lttb_downsample(t_slice, v_slice, max_points)
            else:
                t_down, v_down = t_slice, v_slice

            signal_data = {
                "index": idx,
                "name": meta.name,
                "unit": meta.unit,
                "color": meta.color,
                "timestamps": t_down.tolist(),
                "values": v_down.tolist(),
                "n_original": int(mask.sum()),
                "n_returned": len(t_down),
                "is_complete": len(t_slice) <= max_points,
                "stats": {
                    "min": float(np.min(v_slice)) if len(v_slice) > 0 else 0,
                    "max": float(np.max(v_slice)) if len(v_slice) > 0 else 0,
                    "lttb_ms": 0,
                },
            }

            # Ajouter string_map pour les signaux catégoriels
            if lazy_signal.string_map:
                signal_data["string_map"] = lazy_signal.string_map
                signal_data["is_categorical"] = True

            result_signals.append(signal_data)

        if not result_signals:
            return None

        signals_status = []
        for idx, sig in sorted(session.signals.items()):
            signals_status.append({
                "index": idx,
                "name": sig.metadata.name,
                "loaded": sig.is_loaded
            })

        total_original = sum(s["n_original"] for s in result_signals)
        total_returned = sum(s["n_returned"] for s in result_signals)

        return {
            "session_id": session_id,
            "time_range": {"start": start, "end": end},
            "requested_signals": len(signal_indices),
            "returned_signals": len(result_signals),
            "max_points": max_points,
            "signals": result_signals,
            "signals_status": signals_status,
            "view": {
                "start": start,
                "end": end,
                "original_points": total_original,
                "returned_points": total_returned,
            },
        }


lazy_eda = LazyEDAManager()