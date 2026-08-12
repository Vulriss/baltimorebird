"""Baltimore Bird - Collecteur de métriques anonymes.

Suivi d'utilisation pour le monitoring de l'infrastructure. Aucune donnée personnelle
stockée : les adresses IP sont hachées avec sel. L'état journalier est persisté dans
daily_stats.json et rechargé au démarrage ; toutes les structures rechargées sont
normalisées (defaultdict, ensembles, clés obligatoires) afin que l'agrégation reste
uniforme quel que soit le cycle de redémarrage du service.
"""

import hashlib
import json
import logging
import random
import threading
import time
import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, List, Optional

from config import METRICS_DATA_DIR, METRICS_IP_SALT

logger = logging.getLogger(__name__)

SESSION_TIMEOUT_S = 1800
CLEANUP_INTERVAL_S = 300
LATENCY_MAX_SAMPLES = 500


def hash_ip(ip: str) -> str:
    """Hash une adresse IP pour l'anonymat."""
    salted = f"{METRICS_IP_SALT}:{ip}"
    return hashlib.sha256(salted.encode()).hexdigest()[:16]


@dataclass
class SessionInfo:
    """Représente une session utilisateur anonyme."""
    session_id: str
    user_hash: str
    started_at: float
    last_activity: float
    page_views: int = 0
    actions: Dict[str, int] = field(default_factory=dict)


@dataclass
class RequestMetrics:
    """Métriques d'une requête."""
    timestamp: float
    endpoint: str
    method: str
    latency_ms: float
    status_code: int
    user_hash: str


@dataclass
class LatencyStats:
    """Statistiques de latence agrégées, avec réservoir d'échantillons pour les percentiles."""
    count: int = 0
    total: float = 0.0
    min: float = float("inf")
    max: float = 0.0
    samples: List[float] = field(default_factory=list)
    max_samples: int = LATENCY_MAX_SAMPLES

    def add(self, latency: float) -> None:
        self.count += 1
        self.total += latency
        self.min = min(self.min, latency)
        self.max = max(self.max, latency)

        if len(self.samples) < self.max_samples:
            self.samples.append(latency)
        else:
            idx = random.randint(0, self.count - 1)
            if idx < self.max_samples:
                self.samples[idx] = latency

    def merged_with(self, other: "LatencyStats") -> "LatencyStats":
        """Combinaison sans effet de bord, pour enrichir une lecture des requêtes en buffer."""
        return LatencyStats(
            count=self.count + other.count,
            total=self.total + other.total,
            min=min(self.min, other.min),
            max=max(self.max, other.max),
            samples=(self.samples + other.samples)[-self.max_samples:],
        )

    def _percentile(self, ordered: List[float], quantile: float) -> float:
        idx = min(len(ordered) - 1, int(len(ordered) * quantile))
        return round(ordered[idx], 2)

    def to_dict(self) -> dict:
        """Forme publique (API), sans les échantillons bruts."""
        if self.count == 0:
            return {"count": 0}

        ordered = sorted(self.samples)
        has_samples = bool(ordered)
        return {
            "count": self.count,
            "min": round(self.min, 2),
            "max": round(self.max, 2),
            "avg": round(self.total / self.count, 2),
            "p50": self._percentile(ordered, 0.50) if has_samples else 0,
            "p95": self._percentile(ordered, 0.95) if has_samples else 0,
            "p99": self._percentile(ordered, 0.99) if has_samples else 0,
        }

    def to_persistable(self) -> dict:
        """Forme de persistance : la forme publique plus le réservoir d'échantillons.

        Sans lui, les percentiles retomberaient à zéro à chaque redémarrage du service.
        """
        payload = self.to_dict()
        if self.count > 0:
            payload["samples"] = [round(sample, 2) for sample in self.samples]
        return payload

    @classmethod
    def from_dict(cls, data: dict) -> "LatencyStats":
        stats = cls()
        stats.count = int(data.get("count", 0))
        if stats.count > 0:
            stats.total = float(data.get("avg", 0)) * stats.count
            stats.min = float(data.get("min", float("inf")))
            stats.max = float(data.get("max", 0))
            stats.samples = [float(sample) for sample in data.get("samples", [])][:stats.max_samples]
        return stats


class MetricsCollector:
    """Collecteur et stockage de métriques anonymes.

    Discipline de verrouillage : les méthodes publiques prennent le verrou, les méthodes
    suffixées `_locked` supposent le verrou détenu par l'appelant et ne le prennent jamais.
    """

    def __init__(self, storage_path: Optional[Path] = None):
        self.storage_path = storage_path or METRICS_DATA_DIR
        self.storage_path.mkdir(parents=True, exist_ok=True)

        self._lock = threading.Lock()
        self.sessions: Dict[str, SessionInfo] = {}
        self.request_buffer: List[RequestMetrics] = []
        self.buffer_max_size = 1000
        self.daily_stats: Dict[str, dict] = {}
        self.latency_stats: Dict[str, LatencyStats] = {}

        self._load_stats()
        self._start_cleanup_thread()

    @staticmethod
    def _normalized_day(raw: dict) -> dict:
        """Structure journalière canonique à partir de données brutes (fichier ou vide).

        Les compteurs sont des defaultdict et les utilisateurs un ensemble : l'agrégation
        peut alors incrémenter n'importe quelle clé sans distinguer un jour rechargé du
        fichier d'un jour créé en mémoire.
        """
        sessions = raw.get("sessions", {})
        return {
            "unique_users": set(raw.get("unique_users", [])),
            "total_requests": int(raw.get("total_requests", 0)),
            "endpoints": defaultdict(int, raw.get("endpoints", {})),
            "status_codes": defaultdict(int, raw.get("status_codes", {})),
            "sessions": {
                "count": int(sessions.get("count", 0)),
                "total_duration": float(sessions.get("total_duration", 0)),
                "max_duration": float(sessions.get("max_duration", 0)),
            },
            "events": defaultdict(int, raw.get("events", {})),
        }

    def _load_stats(self) -> None:
        stats_file = self.storage_path / "daily_stats.json"
        if not stats_file.exists():
            return

        try:
            with open(stats_file, "r") as f:
                raw_stats = json.load(f)
        except Exception:
            logger.exception("Chargement des métriques impossible, repartir d'un état vide")
            self.daily_stats = {}
            return

        for date_str, raw in raw_stats.items():
            self.daily_stats[date_str] = self._normalized_day(raw)
            if "latency" in raw:
                self.latency_stats[date_str] = LatencyStats.from_dict(raw["latency"])

        logger.info("Métriques chargées : %d jours", len(self.daily_stats))

    def _serializable_day_locked(self, date_str: str) -> dict:
        stats = self.daily_stats[date_str]
        result = {
            "unique_users": sorted(stats["unique_users"]),
            "total_requests": stats["total_requests"],
            "endpoints": dict(stats["endpoints"]),
            "status_codes": dict(stats["status_codes"]),
            "sessions": dict(stats["sessions"]),
            "events": dict(stats["events"]),
        }
        if date_str in self.latency_stats:
            result["latency"] = self.latency_stats[date_str].to_persistable()
        return result

    def _save_stats(self) -> None:
        with self._lock:
            snapshot = {date_str: self._serializable_day_locked(date_str) for date_str in self.daily_stats}

        stats_file = self.storage_path / "daily_stats.json"
        try:
            with open(stats_file, "w") as f:
                json.dump(snapshot, f, indent=2)
        except Exception:
            logger.exception("Sauvegarde des métriques en échec")

    def _start_cleanup_thread(self) -> None:
        def cleanup_loop() -> None:
            while True:
                time.sleep(CLEANUP_INTERVAL_S)
                try:
                    self._cleanup_sessions()
                    self.flush()
                    self._save_stats()
                except Exception:
                    logger.exception("Cycle de maintenance des métriques en échec")

        threading.Thread(target=cleanup_loop, daemon=True, name="metrics-maintenance").start()

    def _cleanup_sessions(self) -> None:
        now = time.time()
        with self._lock:
            expired = [
                sid for sid, session in self.sessions.items()
                if now - session.last_activity > SESSION_TIMEOUT_S
            ]
            for sid in expired:
                session = self.sessions.pop(sid)
                self._record_session_end_locked(session, session.last_activity - session.started_at)

    def flush(self) -> None:
        """Vide le buffer de requêtes vers les agrégats journaliers."""
        with self._lock:
            self._flush_buffer_locked()

    def _flush_buffer_locked(self) -> None:
        if not self.request_buffer:
            return

        by_date: Dict[str, List[RequestMetrics]] = defaultdict(list)
        for req in self.request_buffer:
            date_str = datetime.fromtimestamp(req.timestamp).strftime("%Y-%m-%d")
            by_date[date_str].append(req)

        for date_str, requests in by_date.items():
            self._aggregate_requests_locked(date_str, requests)

        self.request_buffer = []

    def _ensure_stats_structure_locked(self, date_str: str) -> None:
        if date_str not in self.daily_stats:
            self.daily_stats[date_str] = self._normalized_day({})
        if date_str not in self.latency_stats:
            self.latency_stats[date_str] = LatencyStats()

    def _aggregate_requests_locked(self, date_str: str, requests: List[RequestMetrics]) -> None:
        self._ensure_stats_structure_locked(date_str)
        stats = self.daily_stats[date_str]
        latency = self.latency_stats[date_str]

        for req in requests:
            stats["total_requests"] += 1
            stats["unique_users"].add(req.user_hash)
            stats["endpoints"][req.endpoint] += 1
            stats["status_codes"][str(req.status_code)] += 1
            latency.add(req.latency_ms)

    def _record_session_end_locked(self, session: SessionInfo, duration: float) -> None:
        date_str = datetime.fromtimestamp(session.started_at).strftime("%Y-%m-%d")
        self._ensure_stats_structure_locked(date_str)

        sessions = self.daily_stats[date_str]["sessions"]
        sessions["count"] += 1
        sessions["total_duration"] += duration
        sessions["max_duration"] = max(sessions["max_duration"], duration)

    def get_or_create_session(self, ip: str, session_id: Optional[str] = None) -> str:
        user_hash = hash_ip(ip)

        with self._lock:
            for sid, session in self.sessions.items():
                if session.user_hash == user_hash:
                    session.last_activity = time.time()
                    return sid

            new_sid = session_id or str(uuid.uuid4())[:12]
            self.sessions[new_sid] = SessionInfo(
                session_id=new_sid,
                user_hash=user_hash,
                started_at=time.time(),
                last_activity=time.time(),
            )
            return new_sid

    def record_request(self, ip: str, endpoint: str, method: str, latency_ms: float, status_code: int) -> None:
        metric = RequestMetrics(
            timestamp=time.time(),
            endpoint=endpoint,
            method=method,
            latency_ms=latency_ms,
            status_code=status_code,
            user_hash=hash_ip(ip),
        )

        with self._lock:
            self.request_buffer.append(metric)
            if len(self.request_buffer) >= self.buffer_max_size:
                self._flush_buffer_locked()

    def record_action(self, session_id: str, action: str) -> None:
        with self._lock:
            session = self.sessions.get(session_id)
            if session:
                session.last_activity = time.time()
                session.actions[action] = session.actions.get(action, 0) + 1

    def record_event(self, event: str) -> None:
        today = datetime.now().strftime("%Y-%m-%d")
        with self._lock:
            self._ensure_stats_structure_locked(today)
            self.daily_stats[today]["events"][event] += 1

    def get_current_stats(self) -> dict:
        today = datetime.now().strftime("%Y-%m-%d")

        with self._lock:
            today_stats = self.daily_stats.get(today, {})

            buffer_today = [
                req for req in self.request_buffer
                if datetime.fromtimestamp(req.timestamp).strftime("%Y-%m-%d") == today
            ]

            unique_users = set(today_stats.get("unique_users", set()))
            unique_users.update(req.user_hash for req in buffer_today)

            live_latency = LatencyStats()
            for req in buffer_today:
                live_latency.add(req.latency_ms)
            latency_view = self.latency_stats.get(today, LatencyStats()).merged_with(live_latency)

            events_today = dict(today_stats.get("events", {}))
            top_events = dict(sorted(events_today.items(), key=lambda kv: kv[1], reverse=True)[:10])

            return {
                "timestamp": datetime.now().isoformat(),
                "active_sessions": len(self.sessions),
                "today": {
                    "unique_users": len(unique_users),
                    "total_requests": today_stats.get("total_requests", 0) + len(buffer_today),
                    "sessions_completed": today_stats.get("sessions", {}).get("count", 0),
                    "events": top_events,
                },
                "latency": latency_view.to_dict(),
            }

    def _daily_report_locked(self, date_str: str) -> dict:
        stats = self.daily_stats.get(date_str)
        if not stats:
            return {"date": date_str, "no_data": True}

        sessions = stats["sessions"]
        session_count = sessions["count"]

        return {
            "date": date_str,
            "unique_users": len(stats["unique_users"]),
            "total_requests": stats["total_requests"],
            "sessions": {
                "count": session_count,
                "avg_duration_min": round(sessions["total_duration"] / session_count / 60, 1)
                if session_count > 0 else 0,
                "max_duration_min": round(sessions["max_duration"] / 60, 1),
            },
            "latency": self.latency_stats.get(date_str, LatencyStats()).to_dict(),
            "top_endpoints": dict(sorted(stats["endpoints"].items(), key=lambda kv: kv[1], reverse=True)[:10]),
            "status_codes": dict(stats["status_codes"]),
            "events": dict(sorted(stats["events"].items(), key=lambda kv: kv[1], reverse=True)),
        }

    def get_daily_report(self, date_str: Optional[str] = None) -> dict:
        if date_str is None:
            date_str = datetime.now().strftime("%Y-%m-%d")

        self.flush()
        with self._lock:
            return self._daily_report_locked(date_str)

    def get_weekly_summary(self) -> dict:
        self.flush()

        with self._lock:
            reports: List[dict] = []
            period_users: set = set()
            for i in range(7):
                date_str = (datetime.now() - timedelta(days=i)).strftime("%Y-%m-%d")
                if date_str not in self.daily_stats:
                    continue
                reports.append(self._daily_report_locked(date_str))
                period_users |= self.daily_stats[date_str]["unique_users"]

        if not reports:
            return {"no_data": True}

        return {
            "period": f"{reports[-1]['date']} to {reports[0]['date']}",
            "days": len(reports),
            # Union des hashs sur la période : un même visiteur présent plusieurs jours
            # compte pour un, contrairement à la somme des uniques journaliers.
            "total_unique_users": len(period_users),
            "total_requests": sum(report["total_requests"] for report in reports),
            "total_sessions": sum(report["sessions"]["count"] for report in reports),
            "avg_daily_users": round(sum(report["unique_users"] for report in reports) / len(reports), 1),
            "daily_breakdown": reports,
        }

    def cleanup_old_data(self, keep_days: int = 30) -> None:
        cutoff = (datetime.now() - timedelta(days=keep_days)).strftime("%Y-%m-%d")

        with self._lock:
            old_dates = [date_str for date_str in self.daily_stats if date_str < cutoff]
            for date_str in old_dates:
                del self.daily_stats[date_str]
                self.latency_stats.pop(date_str, None)

        if old_dates:
            logger.info("Métriques purgées pour %d anciens jours", len(old_dates))
            self._save_stats()


metrics = MetricsCollector()
