"""
Metrics Module - Anonymous usage tracking for infrastructure monitoring
No personal data stored, IPs are hashed for anonymity
"""

import time
import hashlib
import threading
import json
from pathlib import Path
from datetime import datetime, timedelta
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set
from collections import defaultdict
import statistics


# Salt for IP hashing (change this in production!)
IP_SALT = "baltimore_bird_2024_anonymous"


def hash_ip(ip: str) -> str:
    """Hash an IP address for anonymity"""
    salted = f"{IP_SALT}:{ip}"
    return hashlib.sha256(salted.encode()).hexdigest()[:16]


@dataclass
class SessionInfo:
    """Represents an anonymous user session"""
    session_id: str
    user_hash: str  # Hashed IP
    started_at: float
    last_activity: float
    page_views: int = 0
    actions: Dict[str, int] = field(default_factory=dict)


@dataclass
class RequestMetrics:
    """Metrics for a single request"""
    timestamp: float
    endpoint: str
    method: str
    latency_ms: float
    status_code: int
    user_hash: str


@dataclass
class LatencyStats:
    """Aggregated latency statistics"""
    count: int = 0
    total: float = 0.0
    min: float = float('inf')
    max: float = 0.0
    # Pour calculer p50/p95, on garde un échantillon limité
    samples: List[float] = field(default_factory=list)
    max_samples: int = 500  # Garde seulement 500 échantillons pour percentiles
    
    def add(self, latency: float):
        """Ajoute une mesure de latence"""
        self.count += 1
        self.total += latency
        self.min = min(self.min, latency)
        self.max = max(self.max, latency)
        
        # Échantillonnage réservoir pour les percentiles
        if len(self.samples) < self.max_samples:
            self.samples.append(latency)
        else:
            # Remplacement aléatoire avec probabilité décroissante
            import random
            idx = random.randint(0, self.count - 1)
            if idx < self.max_samples:
                self.samples[idx] = latency
    
    def to_dict(self) -> dict:
        """Convertit en dict pour JSON"""
        if self.count == 0:
            return {'count': 0}
        
        sorted_samples = sorted(self.samples)
        n = len(sorted_samples)
        
        return {
            'count': self.count,
            'min': round(self.min, 2),
            'max': round(self.max, 2),
            'avg': round(self.total / self.count, 2),
            'p50': round(sorted_samples[n // 2], 2) if n > 0 else 0,
            'p95': round(sorted_samples[int(n * 0.95)], 2) if n > 0 else 0,
            'p99': round(sorted_samples[int(n * 0.99)], 2) if n > 0 else 0,
        }
    
    @classmethod
    def from_dict(cls, data: dict) -> 'LatencyStats':
        """Reconstruit depuis un dict JSON"""
        stats = cls()
        stats.count = data.get('count', 0)
        if stats.count > 0:
            stats.total = data.get('avg', 0) * stats.count
            stats.min = data.get('min', float('inf'))
            stats.max = data.get('max', 0)
            # On ne peut pas reconstruire les samples, mais ce n'est pas grave
            # car on ne les utilise que pour calculer les percentiles à la fin de journée
        return stats


class MetricsCollector:
    """Collects and stores anonymous metrics"""
    
    def __init__(self, storage_path: Optional[Path] = None):
        self.storage_path = storage_path or Path(__file__).parent / "metrics_data"
        self.storage_path.mkdir(parents=True, exist_ok=True)
        
        self._lock = threading.Lock()
        
        # Active sessions (in memory)
        self.sessions: Dict[str, SessionInfo] = {}
        
        # Request metrics buffer (flushed periodically)
        self.request_buffer: List[RequestMetrics] = []
        self.buffer_max_size = 1000
        
        # Aggregated stats (in memory, persisted periodically)
        self.daily_stats: Dict[str, dict] = {}
        
        # Latency stats par jour (en mémoire pour calculs)
        self.latency_stats: Dict[str, LatencyStats] = {}
        
        # Load existing stats
        self._load_stats()
        
        # Start cleanup thread
        self._start_cleanup_thread()
    
    def _load_stats(self):
        """Load persisted stats from disk"""
        stats_file = self.storage_path / "daily_stats.json"
        if stats_file.exists():
            try:
                with open(stats_file, 'r') as f:
                    self.daily_stats = json.load(f)
                
                # Migrate et nettoyer les anciennes données
                for date_str, stats in self.daily_stats.items():
                    # Convertir unique_users list en set
                    if isinstance(stats.get('unique_users'), list):
                        stats['unique_users'] = set(stats['unique_users'])
                    
                    # Migrer les anciennes latences (liste) vers le nouveau format
                    if isinstance(stats.get('latencies'), list):
                        old_latencies = stats['latencies']
                        if old_latencies:
                            stats['latency'] = {
                                'count': len(old_latencies),
                                'min': round(min(old_latencies), 2),
                                'max': round(max(old_latencies), 2),
                                'avg': round(statistics.mean(old_latencies), 2),
                                'p50': round(statistics.median(old_latencies), 2),
                                'p95': round(sorted(old_latencies)[int(len(old_latencies) * 0.95)], 2) if len(old_latencies) > 20 else round(max(old_latencies), 2),
                                'p99': round(sorted(old_latencies)[int(len(old_latencies) * 0.99)], 2) if len(old_latencies) > 100 else round(max(old_latencies), 2),
                            }
                        del stats['latencies']
                    
                    # Reconstruire latency_stats depuis les données persistées
                    if 'latency' in stats:
                        self.latency_stats[date_str] = LatencyStats.from_dict(stats['latency'])
                
                print(f"  ✓ Metrics loaded: {len(self.daily_stats)} days")
                
            except Exception as e:
                print(f"  ⚠ Failed to load metrics: {e}")
                self.daily_stats = {}
    
    def _save_stats(self):
        """Persist stats to disk"""
        stats_file = self.storage_path / "daily_stats.json"
        try:
            # Préparer les données pour JSON
            serializable_stats = {}
            for date_str, stats in self.daily_stats.items():
                serializable_stats[date_str] = self._make_serializable(date_str, stats)
            
            with open(stats_file, 'w') as f:
                json.dump(serializable_stats, f, indent=2)
                
        except Exception as e:
            print(f"  ⚠ Failed to save metrics: {e}")
    
    def _make_serializable(self, date_str: str, stats: dict) -> dict:
        """Convert stats dict to JSON-serializable format"""
        result = {}
        for key, value in stats.items():
            if key == 'latencies':
                # Skip old format
                continue
            elif key == 'latency':
                # Déjà un dict
                result[key] = value
            elif isinstance(value, set):
                result[key] = list(value)
            elif isinstance(value, defaultdict):
                result[key] = dict(value)
            elif isinstance(value, dict):
                result[key] = {k: (list(v) if isinstance(v, set) else v) for k, v in value.items()}
            else:
                result[key] = value
        
        # Ajouter les stats de latence actuelles
        if date_str in self.latency_stats:
            result['latency'] = self.latency_stats[date_str].to_dict()
        
        return result
    
    def _start_cleanup_thread(self):
        """Start background thread for cleanup and persistence"""
        def cleanup_loop():
            while True:
                time.sleep(300)  # Every 5 minutes
                try:
                    self._cleanup_sessions()
                    self._flush_buffer()
                    self._save_stats()
                except Exception as e:
                    print(f"  ⚠ Metrics cleanup error: {e}")
        
        thread = threading.Thread(target=cleanup_loop, daemon=True)
        thread.start()
    
    def _cleanup_sessions(self):
        """Remove inactive sessions (> 30 min)"""
        now = time.time()
        timeout = 30 * 60
        
        with self._lock:
            expired = [
                sid for sid, session in self.sessions.items()
                if now - session.last_activity > timeout
            ]
            
            for sid in expired:
                session = self.sessions.pop(sid)
                duration = session.last_activity - session.started_at
                self._record_session_end(session, duration)
    
    def _flush_buffer(self):
        """Flush request buffer to aggregated stats"""
        with self._lock:
            if not self.request_buffer:
                return
            
            # Group by date
            by_date = defaultdict(list)
            for req in self.request_buffer:
                date_str = datetime.fromtimestamp(req.timestamp).strftime('%Y-%m-%d')
                by_date[date_str].append(req)
            
            # Aggregate
            for date_str, requests in by_date.items():
                self._aggregate_requests(date_str, requests)
            
            self.request_buffer.clear()
    
    def _ensure_stats_structure(self, date_str: str):
        """Ensure daily stats structure exists"""
        if date_str not in self.daily_stats:
            self.daily_stats[date_str] = {
                'total_requests': 0,
                'unique_users': set(),
                'endpoints': defaultdict(int),
                'status_codes': defaultdict(int),
                'sessions': {
                    'count': 0,
                    'total_duration': 0,
                    'max_duration': 0
                }
            }
            self.latency_stats[date_str] = LatencyStats()
        else:
            stats = self.daily_stats[date_str]
            if isinstance(stats.get('unique_users'), list):
                stats['unique_users'] = set(stats['unique_users'])
            elif stats.get('unique_users') is None:
                stats['unique_users'] = set()
            
            if not isinstance(stats.get('endpoints'), defaultdict):
                stats['endpoints'] = defaultdict(int, stats.get('endpoints', {}))
            
            if not isinstance(stats.get('status_codes'), defaultdict):
                stats['status_codes'] = defaultdict(int, stats.get('status_codes', {}))
            
            if date_str not in self.latency_stats:
                # Reconstruire depuis les données persistées
                if 'latency' in stats:
                    self.latency_stats[date_str] = LatencyStats.from_dict(stats['latency'])
                else:
                    self.latency_stats[date_str] = LatencyStats()
    
    def _aggregate_requests(self, date_str: str, requests: List[RequestMetrics]):
        """Aggregate requests into daily stats"""
        self._ensure_stats_structure(date_str)
        stats = self.daily_stats[date_str]
        latency = self.latency_stats[date_str]
        
        for req in requests:
            stats['total_requests'] += 1
            stats['unique_users'].add(req.user_hash)
            stats['endpoints'][req.endpoint] += 1
            stats['status_codes'][str(req.status_code)] += 1
            latency.add(req.latency_ms)
    
    def _record_session_end(self, session: SessionInfo, duration: float):
        """Record session end stats"""
        date_str = datetime.fromtimestamp(session.started_at).strftime('%Y-%m-%d')
        self._ensure_stats_structure(date_str)
        
        sessions = self.daily_stats[date_str]['sessions']
        sessions['count'] += 1
        sessions['total_duration'] += duration
        sessions['max_duration'] = max(sessions['max_duration'], duration)
    
    # =========================================================================
    # Public API
    # =========================================================================
    
    def get_or_create_session(self, ip: str, session_id: Optional[str] = None) -> str:
        """Get existing session or create new one"""
        user_hash = hash_ip(ip)
        
        with self._lock:
            for sid, session in self.sessions.items():
                if session.user_hash == user_hash:
                    session.last_activity = time.time()
                    return sid
            
            import uuid
            new_sid = session_id or str(uuid.uuid4())[:12]
            
            self.sessions[new_sid] = SessionInfo(
                session_id=new_sid,
                user_hash=user_hash,
                started_at=time.time(),
                last_activity=time.time()
            )
            
            return new_sid
    
    def record_request(self, ip: str, endpoint: str, method: str, 
                       latency_ms: float, status_code: int):
        """Record a request metric"""
        user_hash = hash_ip(ip)
        
        metric = RequestMetrics(
            timestamp=time.time(),
            endpoint=endpoint,
            method=method,
            latency_ms=latency_ms,
            status_code=status_code,
            user_hash=user_hash
        )
        
        with self._lock:
            self.request_buffer.append(metric)
            
            if len(self.request_buffer) >= self.buffer_max_size:
                self._flush_buffer()
    
    def record_action(self, session_id: str, action: str):
        """Record a user action"""
        with self._lock:
            if session_id in self.sessions:
                session = self.sessions[session_id]
                session.last_activity = time.time()
                session.actions[action] = session.actions.get(action, 0) + 1
    
    def get_current_stats(self) -> dict:
        """Get current real-time stats"""
        today = datetime.now().strftime('%Y-%m-%d')
        
        with self._lock:
            active_sessions = len(self.sessions)
            today_stats = self.daily_stats.get(today, {})
            
            # Latence du jour
            latency = self.latency_stats.get(today, LatencyStats())
            latency_dict = latency.to_dict()
            
            # Ajouter les requêtes du buffer
            buffer_today = [
                r for r in self.request_buffer
                if datetime.fromtimestamp(r.timestamp).strftime('%Y-%m-%d') == today
            ]
            
            unique_users_set = today_stats.get('unique_users', set())
            if isinstance(unique_users_set, list):
                unique_users_set = set(unique_users_set)
            for req in buffer_today:
                unique_users_set.add(req.user_hash)
            
            return {
                'timestamp': datetime.now().isoformat(),
                'active_sessions': active_sessions,
                'today': {
                    'unique_users': len(unique_users_set),
                    'total_requests': today_stats.get('total_requests', 0) + len(buffer_today),
                    'sessions_completed': today_stats.get('sessions', {}).get('count', 0)
                },
                'latency': latency_dict
            }
    
    def get_daily_report(self, date_str: Optional[str] = None) -> dict:
        """Get report for a specific day"""
        if date_str is None:
            date_str = datetime.now().strftime('%Y-%m-%d')
        
        self._flush_buffer()
        
        with self._lock:
            stats = self.daily_stats.get(date_str, {})
            
            if not stats:
                return {'date': date_str, 'no_data': True}
            
            # Unique users
            unique_users = stats.get('unique_users', set())
            if isinstance(unique_users, list):
                unique_users = set(unique_users)
            
            # Latence
            latency = self.latency_stats.get(date_str, LatencyStats()).to_dict()
            
            # Sessions
            sessions = stats.get('sessions', {})
            session_count = sessions.get('count', 0)
            total_duration = sessions.get('total_duration', 0)
            
            return {
                'date': date_str,
                'unique_users': len(unique_users),
                'total_requests': stats.get('total_requests', 0),
                'sessions': {
                    'count': session_count,
                    'avg_duration_min': round(total_duration / session_count / 60, 1) if session_count > 0 else 0,
                    'max_duration_min': round(sessions.get('max_duration', 0) / 60, 1)
                },
                'latency': latency,
                'top_endpoints': dict(sorted(
                    dict(stats.get('endpoints', {})).items(),
                    key=lambda x: x[1],
                    reverse=True
                )[:10]),
                'status_codes': dict(stats.get('status_codes', {}))
            }
    
    def get_weekly_summary(self) -> dict:
        """Get summary for the last 7 days"""
        self._flush_buffer()
        
        summaries = []
        for i in range(7):
            date = datetime.now() - timedelta(days=i)
            date_str = date.strftime('%Y-%m-%d')
            report = self.get_daily_report(date_str)
            if not report.get('no_data'):
                summaries.append(report)
        
        if not summaries:
            return {'no_data': True}
        
        return {
            'period': f"{summaries[-1]['date']} to {summaries[0]['date']}",
            'days': len(summaries),
            'total_unique_users': sum(s['unique_users'] for s in summaries),
            'total_requests': sum(s['total_requests'] for s in summaries),
            'total_sessions': sum(s['sessions']['count'] for s in summaries),
            'avg_daily_users': round(sum(s['unique_users'] for s in summaries) / len(summaries), 1),
            'daily_breakdown': summaries
        }
    
    def cleanup_old_data(self, keep_days: int = 30):
        """Supprime les données de plus de X jours"""
        cutoff = (datetime.now() - timedelta(days=keep_days)).strftime('%Y-%m-%d')
        
        with self._lock:
            old_dates = [d for d in self.daily_stats.keys() if d < cutoff]
            for date_str in old_dates:
                del self.daily_stats[date_str]
                if date_str in self.latency_stats:
                    del self.latency_stats[date_str]
            
            if old_dates:
                print(f"  🧹 Cleaned up metrics for {len(old_dates)} old days")
                self._save_stats()


# Global instance
metrics = MetricsCollector()