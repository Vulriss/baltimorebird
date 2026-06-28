"""
Baltimore Bird - Gestionnaire de sessions EDA.
Permet de charger les signaux des MF4 à la demande, limit memory footprint.
"""

import os
import time
import logging
import threading
from pathlib import Path
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Set

import numpy as np
from numpy.typing import NDArray

from config import LAZY_EDA_MAX_SESSIONS, LAZY_EDA_SESSION_TIMEOUT
from .loaders import iter_channel_occurrences, disambiguate_name

logger = logging.getLogger(__name__)


def state_change_points(
    timestamps: NDArray[np.float64], values: NDArray[np.float64]
) -> tuple[NDArray[np.float64], NDArray[np.float64]]:
    """Réduit un signal en escalier à ses seuls fronts.

    Pour chaque changement d'état (values[i] != values[i-1]) on conserve l'échantillon
    du front (i) ET celui juste avant (i-1): l'instant exact du basculement est incertain
    à l'échelle de la période d'échantillonnage, et garder les deux bornes encadre cette
    incertitude. Les deux extrémités sont toujours conservées. Représentation exacte en
    rendu escalier, et très compacte pour un signal qui change peu.
    """
    n = len(values)
    if n <= 2:
        return timestamps, values
    # Masque des fronts par comparaison decalee, puis report sur le point du front ET
    # sur l'echantillon juste avant via deux masques decales (OU en place). flatnonzero
    # donne des indices deja tries et uniques: strictement O(n), sans concatenate ni tri.
    diff = values[1:] != values[:-1]
    keep = np.zeros(n, dtype=bool)
    keep[1:] |= diff   # point du front (i)
    keep[:-1] |= diff  # echantillon juste avant (i-1)
    keep[0] = True
    keep[-1] = True
    idx = np.flatnonzero(keep)
    return timestamps[idx], values[idx]


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
    computed: bool = False
    formula: str = ""
    description: str = ""
    source_signals: List[str] = field(default_factory=list)


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
    ephemeral: bool = False
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
        self._lock = threading.RLock()

    def create_session(
        self, session_id: str, user_id: str, mf4_path: Path,
        dbc_path: Optional[Path] = None, ephemeral: bool = False
    ) -> LazySession:
        """Crée une nouvelle session lazy. Les sessions éphémères suppriment leurs fichiers à la fermeture."""
        with self._lock:
            self._cleanup_old_sessions()

            session = LazySession(
                session_id=session_id,
                user_id=user_id,
                mf4_path=mf4_path,
                dbc_path=dbc_path,
                filename=mf4_path.name,
                ephemeral=ephemeral
            )
            self.sessions[session_id] = session
            return session

    def get_session(self, session_id: str) -> Optional[LazySession]:
        """Récupère une session par ID."""
        with self._lock:
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

            occurrences = list(iter_channel_occurrences(mdf))
            name_counts = {}
            for name, _, _ in occurrences:
                name_counts[name] = name_counts.get(name, 0) + 1

            logger.info(f"[LazyEDA] Found {len(occurrences)} channels, collecting metadata...")

            t_min_global = float("inf")
            t_max_global = float("-inf")
            sampled_one = False
            valid_signals = []

            for name, group_idx, channel_idx in occurrences:
                try:
                    channel = mdf.groups[group_idx].channels[channel_idx]
                    unit = str(channel.unit) if getattr(channel, "unit", "") else ""

                    if not sampled_one:
                        try:
                            sig = mdf.get(group=group_idx, index=channel_idx, raw=True)
                            if sig is not None and sig.timestamps is not None and len(sig.timestamps) > 0:
                                t_min_global = float(sig.timestamps[0])
                                t_max_global = float(sig.timestamps[-1])
                                sampled_one = True
                        except Exception:
                            pass

                    display = disambiguate_name(name, group_idx, name_counts[name] > 1)
                    hue = (len(valid_signals) * 37) % 360
                    metadata = SignalMetadata(
                        index=len(valid_signals),
                        name=display,
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

            sig = mdf.get(group=meta.group_index, index=meta.channel_index)

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

    def get_signal_index_by_name(self, session_id: str, name: str) -> Optional[int]:
        """Retrouve l'index d'un signal de session par son nom d'affichage."""
        session = self.get_session(session_id)
        if not session:
            return None
        for idx, sig in session.signals.items():
            if sig.metadata.name == name:
                return idx
        return None

    def add_computed_signal(
        self, session_id: str, name: str, unit: str, description: str,
        formula: str, source_signals: List[str],
        timestamps: NDArray[np.float64], values: NDArray[np.float64]
    ) -> Optional[Dict]:
        """Ajoute une variable calculée (données déjà calculées) à la session."""
        session = self.get_session(session_id)
        if not session:
            return None
        with self._lock:
            index = max(session.signals.keys(), default=-1) + 1
            hue = (index * 37) % 360
            meta = SignalMetadata(
                index=index, name=name, unit=unit, color=f"hsl({hue}, 70%, 55%)",
                loaded=True, computed=True, formula=formula,
                description=description, source_signals=list(source_signals)
            )
            session.signals[index] = LazySignal(
                metadata=meta,
                timestamps=np.asarray(timestamps, dtype=np.float64),
                values=np.asarray(values, dtype=np.float64)
            )
            session.signal_names.append(name)
            session.n_signals = len(session.signals)
        return {"name": name, "unit": unit, "index": index, "color": meta.color}

    def update_computed_signal(
        self, session_id: str, index: int, unit: str, description: str,
        formula: str, source_signals: List[str],
        timestamps: NDArray[np.float64], values: NDArray[np.float64]
    ) -> Optional[Dict]:
        """Met à jour une variable calculée existante. Retourne None si absente,
        False si le signal visé n'est pas une variable calculée."""
        session = self.get_session(session_id)
        if not session or index not in session.signals:
            return None
        sig = session.signals[index]
        if not sig.metadata.computed:
            return False
        with self._lock:
            sig.timestamps = np.asarray(timestamps, dtype=np.float64)
            sig.values = np.asarray(values, dtype=np.float64)
            sig.metadata.unit = unit
            sig.metadata.description = description
            sig.metadata.formula = formula
            sig.metadata.source_signals = list(source_signals)
        return {"name": sig.metadata.name, "unit": unit, "index": index, "color": sig.metadata.color}

    def remove_computed_signal(self, session_id: str, index: int) -> Optional[bool]:
        """Supprime une variable calculée. None si absente, False si non calculée."""
        session = self.get_session(session_id)
        if not session or index not in session.signals:
            return None
        if not session.signals[index].metadata.computed:
            return False
        with self._lock:
            del session.signals[index]
            session.n_signals = len(session.signals)
        return True

    def close_session(self, session_id: str) -> None:
        """Ferme une session et libère les ressources."""
        with self._lock:
            session = self.sessions.pop(session_id, None)
        if session and session.mdf_handle:
            try:
                session.mdf_handle.close()
                logger.info(f"[LazyEDA] Closed MDF handle for session {session_id[:8]}")
            except Exception:
                logger.warning("[LazyEDA] couldnt close current session", exc_info=True)

        if session and session.ephemeral:
            for path in (session.mf4_path, session.dbc_path):
                if path is None:
                    continue
                try:
                    path.unlink(missing_ok=True)
                except OSError:
                    logger.warning(f"[LazyEDA] Could not delete temp file {path.name}", exc_info=True)
            logger.info(f"[LazyEDA] Ephemeral session {session_id[:8]} files removed")

    def close_user_sessions(self, user_id: str) -> int:
        """Ferme toutes les sessions d'un utilisateur. Retourne le nombre de sessions fermées."""
        with self._lock:
            to_close = [sid for sid, session in self.sessions.items() if session.user_id == user_id]
        for sid in to_close:
            self.close_session(sid)
            logger.info(f"[LazyEDA] Closed session {sid[:8]} for user {user_id}")
        return len(to_close)

    def _expired_session_ids(self, now: float) -> List[str]:
        """Identifiants des sessions expirées. Suppose le verrou détenu par l'appelant."""
        return [
            sid for sid, session in self.sessions.items()
            if now - session.last_access > self.session_timeout
        ]

    def _cleanup_old_sessions(self) -> None:
        """Supprime les sessions expirées et applique le plafond de sessions pour libérer la mémoire."""
        with self._lock:
            for sid in self._expired_session_ids(time.time()):
                self.close_session(sid)
                logger.info(f"[LazyEDA] Cleaned up expired session {sid[:8]}")

            if len(self.sessions) > self.max_sessions:
                sorted_sessions = sorted(self.sessions.items(), key=lambda x: x[1].last_access)
                for sid, _ in sorted_sessions[:len(self.sessions) - self.max_sessions]:
                    self.close_session(sid)

    def cleanup_expired(self) -> int:
        """Évince les sessions expirées et libère leurs ressources (fichiers éphémères inclus).

        Pensé pour un appel périodique en tâche de fond. La liste des sessions à fermer est calculée
        sous verrou, mais la fermeture (entrées/sorties disque) a lieu hors verrou pour ne pas bloquer
        les requêtes concurrentes. Retourne le nombre de sessions évincées.
        """
        with self._lock:
            expired = self._expired_session_ids(time.time())
        for session_id in expired:
            self.close_session(session_id)
            logger.info(f"[LazyEDA] Session expirée évincée: {session_id[:8]}")
        return len(expired)

    def active_file_paths(self) -> Set[Path]:
        """Chemins disque référencés par les sessions vivantes, pour les protéger du balayage des orphelins."""
        with self._lock:
            paths: Set[Path] = set()
            for session in self.sessions.values():
                paths.add(session.mf4_path)
                if session.dbc_path is not None:
                    paths.add(session.dbc_path)
            return paths

    def refresh_ephemeral_file_mtimes(self) -> None:
        """Aligne le mtime des fichiers éphémères vivants sur l'heure courante.

        Le balayage des orphelins se fonde sur l'âge du fichier sur disque. Dans un déploiement
        multi-worker, un worker ne connaît pas les sessions des autres : sans ce rafraîchissement,
        le fichier d'une session active de longue durée (dont le mtime reste figé à l'upload) pourrait
        être considéré à tort comme orphelin par un autre worker et supprimé. On maintient donc les
        fichiers des sessions vivantes « récents » tant qu'elles ne sont pas expirées.
        """
        with self._lock:
            live_paths = [
                (session.mf4_path, session.dbc_path)
                for session in self.sessions.values()
                if session.ephemeral
            ]
        now = time.time()
        for mf4_path, dbc_path in live_paths:
            for path in (mf4_path, dbc_path):
                if path is None:
                    continue
                try:
                    os.utime(path, (now, now))
                except OSError:
                    logger.debug(f"[LazyEDA] mtime non rafraîchi pour {path.name}", exc_info=True)

    def _format_signal_list(self, session: LazySession) -> Dict:
        """Formate la liste des signaux pour la réponse API."""
        signals = []
        for idx, lazy_sig in sorted(session.signals.items()):
            meta = lazy_sig.metadata
            entry = {
                "index": meta.index,
                "name": meta.name,
                "unit": meta.unit,
                "color": meta.color,
                "loaded": lazy_sig.is_loaded
            }
            if meta.computed:
                entry.update({
                    "computed": True,
                    "formula": meta.formula,
                    "description": meta.description,
                    "source_signals": meta.source_signals,
                })
            signals.append(entry)

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

            # Timestamps monotones (serie temporelle MDF): on borne la fenetre en
            # O(log n) via searchsorted plutot que par un masque booleen O(n)
            # recalcule sur tout le signal a chaque zoom/pan.
            i0 = int(np.searchsorted(timestamps, start, side="left"))
            i1 = int(np.searchsorted(timestamps, end, side="right"))

            is_step = lazy_signal.string_map is not None or meta.unit == "bool"

            if is_step:
                # Signal escalier (booleen/etat): on ne renvoie que les fronts. On etend
                # d'un echantillon de chaque cote pour porter l'etat aux bords de la vue.
                a0 = max(0, i0 - 1)
                a1 = min(len(values), i1 + 1)
                t_seg = timestamps[a0:a1]
                v_seg = values[a0:a1]
                if len(t_seg) == 0:
                    continue
                t_red, v_red = state_change_points(t_seg, v_seg)
                if len(t_red) > max(2 * max_points, 4000):
                    # Cas pathologique (transitions quasi a chaque echantillon): repli.
                    t_slice = timestamps[i0:i1]
                    v_slice = values[i0:i1]
                    if len(t_slice) > max_points:
                        t_down, v_down = lttb_downsample(t_slice, v_slice, max_points)
                    else:
                        t_down, v_down = t_slice, v_slice
                else:
                    t_down, v_down = t_red, v_red
                stat_values = values[i0:i1]
                n_original = i1 - i0
                is_complete = i0 == 0 and i1 == len(values)
            else:
                t_slice = timestamps[i0:i1]
                v_slice = values[i0:i1]
                if len(t_slice) == 0:
                    continue
                n_original = i1 - i0
                if len(t_slice) > max_points:
                    t_down, v_down = lttb_downsample(t_slice, v_slice, max_points)
                else:
                    t_down, v_down = t_slice, v_slice
                stat_values = v_slice
                is_complete = n_original <= max_points

            signal_data = {
                "index": idx,
                "name": meta.name,
                "unit": meta.unit,
                "color": meta.color,
                "timestamps": t_down.tolist(),
                "values": v_down.tolist(),
                "n_original": n_original,
                "n_returned": len(t_down),
                "is_complete": is_complete,
                "stats": {
                    "min": float(np.min(stat_values)) if len(stat_values) > 0 else 0,
                    "max": float(np.max(stat_values)) if len(stat_values) > 0 else 0,
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
