"""
Baltimore Bird - Gestionnaire de sessions EDA.
Permet de charger les signaux des MF4 à la demande, limit memory footprint.
"""

import os
import time
import logging
import zlib
import threading
from pathlib import Path
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Set

import numpy as np
from numpy.typing import NDArray

from config import LAZY_EDA_MAX_SESSIONS, LAZY_EDA_SESSION_TIMEOUT
from .loaders import iter_channel_occurrences, disambiguate_name
from .event_comments import (
    EventComment,
    build_event_signal_descriptor,
    extract_event_comments,
)

logger = logging.getLogger(__name__)

# Parser Rust optionnel (rust_mdf_parser). Si absent -> chemin 100% asammdf.
try:
    import rust_mdf_parser as _rust
    _RUST_OK = True
except ImportError:
    _rust = None
    _RUST_OK = False

# Types de conversion CCBLOCK textuels : ces canaux sont catégoriels (asammdf
# renvoie des chaînes -> string_map). Rust rend du float64 (NaN pour le texte),
# donc on les laisse à asammdf pour préserver le mapping d'états.
_RUST_TEXT_CONV = {"value_to_text", "range_to_text"}
_RUST_NUM_DTYPE = {0, 1, 2, 3, 4, 5}


def signal_hue(display_name: str) -> int:
    """Teinte stable derivee du NOM du signal (et non de sa position).

    Le meme signal garde ainsi sa couleur d'un fichier a l'autre : au changement
    de fichier, le layout est re-lie par nom et les couleurs suivent, meme quand
    l'index du signal change. crc32 (et non hash()) car hash() est randomise a
    chaque process Python : les couleurs changeraient a chaque redemarrage.

    Le multiplicateur 47 (premier avec 360) etale les teintes de noms proches.
    """
    return (zlib.crc32(display_name.encode("utf-8")) * 47) % 360


def signal_color(display_name: str) -> str:
    return f"hsl({signal_hue(display_name)}, 70%, 55%)"  # uint/int/float LE+BE


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
    # Nom littéral du canal dans le fichier (pour la relecture Rust par nom).
    raw_name: str = ""
    # True => éligible au chemin rapide Rust (nom unique + numérique).
    rust_ok: bool = False
    # True => voie en état (conversion value_to_text/range_to_text) : nécessite
    # la reconstruction des labels, traitée hors du batch numérique.
    rust_is_state: bool = False
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
    # Points de commentaire INCA (Ctrl+K) extraits des events du MF4. Non vide => un signal
    # special "EventComment" est expose dans la liste et sert via /api/eda/events.
    event_comments: List[EventComment] = field(default_factory=list)
    t_min: float = 0.0
    t_max: float = 0.0
    n_signals: int = 0
    mdf_handle: Any = None
    # Handle Rust (rust_mdf_parser.MdfFile) pour la relecture rapide des canaux
    # numériques des fichiers physiques (sans DBC). None si indisponible/non
    # applicable. Immuable après ouverture (Sync) : lecture concurrente sûre.
    rust_handle: Any = None
    # Verrou par session autour de tout acces au handle asammdf (get/select/listing):
    # asammdf n'est pas thread-safe (seeks concurrents sur le meme descripteur) et le
    # serveur tourne en multi-thread. Un verrou par session plutot que global: les
    # sessions restent independantes et un listing long ne bloque pas les autres.
    mdf_lock: Any = field(default_factory=threading.RLock)
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
        """Liste les signaux d'un fichier MF4 sans charger les données.

        Idempotent et sur en concurrence: le corps est protege par le verrou de session,
        avec re-verification de `listed` apres acquisition. Le listing peut ainsi etre
        lance en tache de fond des l'upload, l'appel client concurrent attendant
        simplement la fin du meme travail au lieu de le refaire.
        """
        session = self.get_session(session_id)
        if not session:
            return None

        if session.listed:
            return self._format_signal_list(session)

        with session.mdf_lock:
            if session.listed:
                return self._format_signal_list(session)
            return self._list_signals_locked(session)

    def _list_signals_locked(self, session: LazySession) -> Dict:
        """Corps du listing. Suppose le verrou de session détenu par l'appelant."""
        from asammdf import MDF

        session_id = session.session_id
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

            # Handle Rust pour la relecture rapide : uniquement sur fichier physique
            # (sans DBC). Les noms littéraux du fichier correspondent alors à ceux
            # d'asammdf. Sur un fichier décodé-DBC, asammdf invente des alias
            # hiérarchiques absents du fichier -> on reste 100% asammdf.
            rust = self._ensure_rust_handle(session)
            rust_names = set(rust.channel_names()) if rust is not None else set()

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

                    # Éligibilité Rust : nom unique + connu de Rust + data_type
                    # numérique. Couvre les voies numériques pures ET les voies
                    # en état (dont le raw est numérique + table valeur→texte).
                    # Le chemin de fetch décide numérique vs état à la lecture.
                    # Les homonymes et les vraies voies string (data_type 6-9,
                    # VLSD) restent sur asammdf.
                    rust_ok = False
                    rust_is_state = False
                    if rust is not None and name_counts[name] == 1 and name in rust_names:
                        try:
                            info = rust.channel_info(name)
                            rust_ok = int(info["data_type"]) in _RUST_NUM_DTYPE
                            rust_is_state = info["conversion"] in _RUST_TEXT_CONV
                        except Exception:
                            rust_ok = False

                    metadata = SignalMetadata(
                        index=len(valid_signals),
                        name=display,
                        unit=unit,
                        color=signal_color(display),
                        group_index=group_idx,
                        channel_index=channel_idx,
                        raw_name=name,
                        rust_ok=rust_ok,
                        rust_is_state=rust_is_state,
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

            # Events de commentaire INCA (Ctrl+K): extraits une fois au listing, servis via
            # /api/eda/events. Un echec d'extraction ne doit pas faire echouer le listing.
            try:
                session.event_comments = extract_event_comments(mdf.events)
            except Exception:
                logger.warning("[LazyEDA] extraction des events de commentaire echouee", exc_info=True)
                session.event_comments = []

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
            session.rust_handle = None
            raise

    def _ensure_mdf_handle(self, session: LazySession) -> Any:
        """Ouvre le handle asammdf (avec décodage DBC éventuel) s'il ne l'est pas déjà.

        Suppose le verrou de session détenu par l'appelant.
        """
        if session.mdf_handle is not None:
            return session.mdf_handle

        from asammdf import MDF

        mdf = MDF(session.mf4_path)
        if session.dbc_path and session.dbc_path.exists():
            extracted = mdf.extract_bus_logging(database_files={"CAN": [(str(session.dbc_path), 0)]})
            mdf.close()
            mdf = extracted
        session.mdf_handle = mdf
        return mdf

    def _ensure_rust_handle(self, session: LazySession) -> Any:
        """Ouvre (paresseusement) le handle Rust pour un fichier physique.

        Renvoie None si Rust est indisponible, si le fichier nécessite un
        décodage DBC (les alias asammdf ne correspondent alors pas aux noms
        littéraux du fichier), ou en cas d'échec d'ouverture. Le handle est
        immuable après ouverture (Sync) : partageable sans verrou.
        Suppose le verrou de session détenu par l'appelant lors du listing.
        """
        if session.rust_handle is not None:
            return session.rust_handle
        if not _RUST_OK or (session.dbc_path and session.dbc_path.exists()):
            return None
        try:
            session.rust_handle = _rust.MdfFile(str(session.mf4_path))
        except Exception:
            logger.warning("[LazyEDA] ouverture Rust échouée, repli asammdf", exc_info=True)
            session.rust_handle = None
        return session.rust_handle

    class _RustSignal:
        """Adaptateur minimal exposant l'interface attendue par _ingest_signal."""
        __slots__ = ("samples", "timestamps", "unit")

        def __init__(self, samples, timestamps, unit):
            self.samples = samples
            self.timestamps = timestamps
            self.unit = unit

    def _rust_fetch(self, session: LazySession, meta: "SignalMetadata") -> Any:
        """Lit un canal via Rust et renvoie un adaptateur de type Signal, ou None.

        - Voie en état (conversion value_to_text / range_to_text) : reconstruit
          les labels par échantillon depuis la table valeur→texte exposée par
          Rust. Si au moins un échantillon tombe sur un label texte -> renvoie un
          tableau de chaînes (`_ingest_signal` bâtira le string_map, comme pour
          asammdf). Sinon (aucun texte) -> valeurs numériques converties.
        - Voie numérique -> valeurs physiques (conversion appliquée).
        """
        rust = session.rust_handle
        if rust is None:
            return None
        name = meta.raw_name
        try:
            master, phys = rust.get_with_master(name)
        except Exception:
            return None
        if master is None:
            return None

        info_conv = None
        try:
            info_conv = rust.channel_info(name)["conversion"]
        except Exception:
            info_conv = None

        if info_conv in _RUST_TEXT_CONV:
            try:
                st = rust.channel_states(name)
            except Exception:
                st = None
            if st is not None:
                raw = np.asarray(rust.get(name, raw=True), dtype=np.float64)
                labels = np.empty(raw.shape, dtype=object)
                labels[:] = ""
                hit = np.zeros(raw.shape, dtype=bool)
                if st["kind"] == "value":
                    for k, txt in zip(st["keys"], st["texts"]):
                        if txt is None:
                            continue
                        m = raw == k
                        labels[m] = txt.strip()
                        hit |= m
                else:  # range
                    for lo, hi, txt in zip(st["lows"], st["highs"], st["texts"]):
                        if txt is None:
                            continue
                        m = (raw >= lo) & (raw <= hi)
                        labels[m] = txt.strip()
                        hit |= m
                # asammdf ne renvoie des chaînes que si TOUS les échantillons
                # tombent sur un label texte ; sinon la voie est numérique
                # (la branche par défaut/numérique s'applique).
                if raw.size and hit.all():
                    return self._RustSignal(labels.astype(str), master, "state")

        # Voie numérique pure (ou état sans aucun texte) -> valeurs physiques.
        return self._RustSignal(phys, master, meta.unit)

    def _ingest_signal(self, lazy_signal: LazySignal, sig: Any) -> Optional[str]:
        """Normalise un signal asammdf et le range dans la session.

        Mapping catégoriel vectorisé (np.unique avec return_inverse, pas de boucle Python
        sur les échantillons) et interpolation des NaN. Retourne un message d'erreur ou
        None en cas de succès.
        """
        if sig is None or sig.samples is None or len(sig.samples) == 0:
            return "Signal empty"

        timestamps = np.asarray(sig.timestamps, dtype=np.float64)
        samples = sig.samples

        if samples.dtype.kind in ("S", "U", "O"):
            # np.unique simple puis searchsorted: mesure ~2x plus rapide que la boucle
            # Python historique, et ~5x plus rapide que return_inverse (qui paie un
            # second argsort sur les chaines).
            unique_vals = np.unique(samples)
            string_map: Dict[int, str] = {}
            for i, val in enumerate(unique_vals):
                decoded = val.decode("utf-8", errors="replace") if isinstance(val, bytes) else str(val)
                string_map[i] = decoded
            values = np.searchsorted(unique_vals, samples).astype(np.float64)
            lazy_signal.metadata.unit = "state"
            lazy_signal.string_map = string_map
        else:
            values = np.asarray(samples, dtype=np.float64)
            lazy_signal.string_map = None

            mask = ~np.isfinite(values)
            if mask.all():
                return "All NaN values"
            if mask.any():
                valid_mask = ~mask
                values = values.copy()
                values[mask] = np.interp(
                    timestamps[mask],
                    timestamps[valid_mask],
                    values[valid_mask],
                    left=values[valid_mask][0],
                    right=values[valid_mask][-1],
                )

        lazy_signal.timestamps = timestamps
        lazy_signal.values = values
        lazy_signal.metadata.loaded = True
        return None

    def _signal_ready_response(self, index: int, lazy_signal: LazySignal, load_time_ms: Optional[float]) -> Dict:
        """Réponse API d'un signal chargé, avec string_map pour les catégoriels."""
        response: Dict[str, Any] = {
            "index": index,
            "name": lazy_signal.metadata.name,
            "status": "ready",
            "n_samples": len(lazy_signal.timestamps) if lazy_signal.timestamps is not None else 0,
            "unit": lazy_signal.metadata.unit,
        }
        if load_time_ms is not None:
            response["load_time_ms"] = round(load_time_ms, 1)
        if lazy_signal.string_map:
            response["string_map"] = lazy_signal.string_map
            response["is_categorical"] = True
        return response

    def preload_signals(self, session_id: str, signal_indices: List[int]) -> Dict[int, Dict]:
        """Précharge un lot de signaux en une seule passe fichier (mdf.select).

        Charger N canaux via select coûte une passe sur le fichier, contre une passe par
        canal avec get: c'est le chemin critique du dépôt d'un groupe de signaux entier.
        En cas d'échec du select (canal défectueux), repli signal par signal pour isoler
        l'erreur. Tout accès au handle est sérialisé par le verrou de session.
        Retourne un dict index -> réponse de statut par signal demandé.
        """
        session = self.get_session(session_id)
        if not session or not session.listed:
            return {}

        responses: Dict[int, Dict] = {}
        to_load: List[int] = []
        for idx in signal_indices:
            lazy_signal = session.signals.get(idx)
            if lazy_signal is None:
                responses[idx] = {"index": idx, "status": "error", "error": "Unknown signal"}
            elif lazy_signal.is_loaded:
                responses[idx] = self._signal_ready_response(idx, lazy_signal, load_time_ms=None)
            else:
                to_load.append(idx)

        if not to_load:
            return responses

        start_time = time.time()
        with session.mdf_lock:
            # Un thread concurrent a pu charger une partie du lot entre le pre-filtrage
            # et l'acquisition du verrou: on ne recharge que le restant, les reponses
            # des signaux devenus prets sont completees apres la section verrouillee.
            to_load = [idx for idx in to_load if not session.signals[idx].is_loaded]

            if to_load:
                try:
                    mdf = self._ensure_mdf_handle(session)
                except Exception as exc:
                    logger.error("[LazyEDA] Cannot open MDF handle", exc_info=True)
                    for idx in to_load:
                        responses[idx] = {"index": idx, "status": "error", "error": str(exc)}
                    return responses

                raw_signals = self._select_signals(mdf, session, to_load)

                for idx, sig in zip(to_load, raw_signals):
                    lazy_signal = session.signals[idx]
                    if isinstance(sig, Exception):
                        responses[idx] = {"index": idx, "status": "error", "error": str(sig)}
                        continue
                    error = self._ingest_signal(lazy_signal, sig)
                    if error:
                        responses[idx] = {"index": idx, "status": "error", "error": error}
                    else:
                        elapsed_ms = (time.time() - start_time) * 1000
                        responses[idx] = self._signal_ready_response(idx, lazy_signal, elapsed_ms)

        for idx in signal_indices:
            if idx in responses:
                continue
            lazy_signal = session.signals[idx]
            if lazy_signal.is_loaded:
                responses[idx] = self._signal_ready_response(idx, lazy_signal, load_time_ms=None)
            else:
                responses[idx] = {"index": idx, "status": "error", "error": "Load skipped"}

        loaded = [i for i in to_load if responses[i].get("status") == "ready"]
        if loaded:
            total = sum(len(session.signals[i].timestamps) for i in loaded)
            logger.info(
                "[LazyEDA] Preloaded %d signal(s) (%s pts) in %.1fms",
                len(loaded), f"{total:,}", (time.time() - start_time) * 1000,
            )
        return responses

    def _select_signals(self, mdf: Any, session: LazySession, indices: List[int]) -> List[Any]:
        """Charge les canaux demandés, alignés sur `indices`.

        Chemin rapide Rust pour les signaux éligibles (numériques purs à nom
        unique) : relecture par nom avec axe temps, ~3x plus rapide qu'asammdf
        à chaud et sans matérialisation lourde. Le reste (homonymes, catégoriels)
        passe par asammdf, en lot (`select`) si possible. Suppose le verrou de
        session détenu. Chaque élément est un Signal (asammdf ou adaptateur Rust)
        ou l'exception rencontrée pour ce canal.
        """
        rust = session.rust_handle
        results: List[Any] = [None] * len(indices)
        asam_todo: List[tuple] = []  # (pos, group_index, channel_index)

        # 1) Voies numériques éligibles -> UN SEUL get_signals (chaque data group
        #    décompressé une seule fois pour tout le lot). C'est le gain clé quand
        #    un graphe charge plusieurs signaux du même raster.
        batch_pos: dict = {}  # raw_name -> pos
        for pos, idx in enumerate(indices):
            meta = session.signals[idx].metadata
            if rust is not None and meta.rust_ok and not meta.rust_is_state and meta.raw_name:
                batch_pos[meta.raw_name] = pos
            elif rust is not None and meta.rust_ok and meta.rust_is_state and meta.raw_name:
                # voie en état : reconstruction des labels, hors batch numérique
                sig = self._rust_fetch(session, meta)
                if sig is not None:
                    results[pos] = sig
                else:
                    asam_todo.append((pos, meta.group_index, meta.channel_index))
            else:
                asam_todo.append((pos, meta.group_index, meta.channel_index))

        if batch_pos:
            try:
                got = rust.get_signals(list(batch_pos.keys()))  # {name: (master, values)}
            except Exception:
                logger.debug("[LazyEDA] get_signals batch a échoué, repli asammdf", exc_info=True)
                got = {}
            for raw_name, pos in batch_pos.items():
                pair = got.get(raw_name)
                meta = session.signals[indices[pos]].metadata
                if pair is not None and pair[0] is not None:
                    master, values = pair
                    results[pos] = self._RustSignal(values, master, meta.unit)
                else:
                    # pas de maître ou absent -> asammdf
                    asam_todo.append((pos, meta.group_index, meta.channel_index))

        if not asam_todo:
            return results

        # 2) Repli asammdf pour le reste (homonymes, vraies voies string, échecs).
        channels = [(None, g, c) for _, g, c in asam_todo]
        got_a: Optional[List[Any]] = None
        if len(channels) > 1:
            try:
                got_a = list(mdf.select(channels, copy_master=False))
            except Exception:
                logger.warning("[LazyEDA] Batch select failed, per-signal get", exc_info=True)
                got_a = None
        if got_a is None:
            got_a = []
            for _, g, c in channels:
                try:
                    got_a.append(mdf.get(group=g, index=c))
                except Exception as exc:
                    got_a.append(exc)

        for (pos, _, _), sig in zip(asam_todo, got_a):
            results[pos] = sig
        return results

    def preload_signal(self, session_id: str, signal_index: int) -> Optional[Dict]:
        """Précharge les données d'un signal spécifique."""
        session = self.get_session(session_id)
        if not session or not session.listed:
            return None
        if signal_index not in session.signals:
            return None
        return self.preload_signals(session_id, [signal_index]).get(signal_index)

    def get_signal_data(self, session_id: str, signal_index: int) -> Optional[LazySignal]:
        """Récupère les données d'un signal, en le chargeant si nécessaire."""
        session = self.get_session(session_id)
        if not session:
            return None

        lazy_signal = session.signals.get(signal_index)
        if not lazy_signal:
            return None

        if not lazy_signal.is_loaded:
            self.preload_signals(session_id, [signal_index])

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
            meta = SignalMetadata(
                index=index, name=name, unit=unit, color=signal_color(name),
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
        if session:
            # Le handle Rust n'a pas de close() explicite : le mmap est libéré au GC.
            session.rust_handle = None

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

        # Signal special commentaires en fin de liste (index juste apres les reels), seulement
        # si le fichier porte des events Ctrl+K. Son index sert cote frontend a l'identifier;
        # ses points transitent par /api/eda/events, pas par /view.
        if session.event_comments:
            signals.append(build_event_signal_descriptor(session.n_signals))

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

        # Chargement batch prealable: une seule passe fichier (mdf.select) pour tous les
        # signaux demandes non charges, au lieu d'une passe par signal dans la boucle.
        unloaded = [
            idx for idx in signal_indices
            if idx in session.signals and not session.signals[idx].is_loaded
        ]
        if unloaded:
            self.preload_signals(session_id, unloaded)

        result_signals = []

        for idx in signal_indices:
            lazy_signal = session.signals.get(idx)
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
                # Tableaux numpy: la serialisation (binaire ou JSON) est le role de la
                # couche API, pas du gestionnaire de sessions.
                "timestamps": t_down,
                "values": v_down,
                "n_original": n_original,
                "n_returned": int(len(t_down)),
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

        total_original = sum(s["n_original"] for s in result_signals)
        total_returned = sum(s["n_returned"] for s in result_signals)

        return {
            "session_id": session_id,
            "time_range": {"start": start, "end": end},
            "requested_signals": len(signal_indices),
            "returned_signals": len(result_signals),
            "max_points": max_points,
            "signals": result_signals,
            "view": {
                "start": start,
                "end": end,
                "original_points": total_original,
                "returned_points": total_returned,
            },
        }


lazy_eda = LazyEDAManager()
