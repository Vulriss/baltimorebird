"""
Baltimore Bird - Time Series Server for Automotive Data
Supports multiple data sources: MF4 files with DBC decoding + synthetic data
"""

import threading
import time
import uuid
from pathlib import Path
from typing import Optional

import numpy as np
from dotenv import load_dotenv
from flask import Flask, g, jsonify, request, send_file
from flask_cors import CORS
from werkzeug.utils import secure_filename

load_dotenv()

from auth import admin_required, auth_bp, login_required, optional_auth, user_store
from converter import ConcatenationManager, ConversionManager, ConversionStatus, get_supported_conversions, is_conversion_supported
from metrics import metrics
from metrics_api import metrics_bp
from scripts_api import scripts_bp
from user_storage import storage, storage_bp

# Configuration

BASE_DIR = Path(__file__).parent
TEMP_DIR = BASE_DIR / "TEMP"
TEMP_DIR.mkdir(exist_ok=True)
REPORTS_DIR = BASE_DIR / "reports"
REPORTS_DIR.mkdir(exist_ok=True)

ALLOWED_EXTENSIONS = {".mf4", ".csv", ".mat", ".dat", ".blf", ".dbc"}

DATA_SOURCES = {
    "mf4": {
        "name": "OBD2 Data (MF4)",
        "description": "Real automotive data from MF4 file",
        "mf4_file": "data/default/mf4/00000002.mf4",
        "dbc_file": "data/default/dbc//11-bit-OBD2-v4.0.dbc",
    },
    "synthetic": {
        "name": "Synthetic Data",
        "description": "Generated test signals (20 signals, 3000s)",
    },
}

# Flask App

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 1500 * 1024 * 1024  # 1500 MB max

app.register_blueprint(scripts_bp)
app.register_blueprint(auth_bp)
app.register_blueprint(metrics_bp)
app.register_blueprint(storage_bp)
CORS(app)

# Managers

conversion_manager = ConversionManager(TEMP_DIR)
concatenation_manager = ConcatenationManager(TEMP_DIR)

# EDA sessions storage
eda_sessions = {}


# Metrics Middleware

@app.before_request
def before_request():
    """Track request start time."""
    g.start_time = time.time()
    ip = request.headers.get("X-Real-IP") or request.remote_addr or "unknown"
    g.session_id = metrics.get_or_create_session(ip)


@app.after_request
def after_request(response):
    """Record request metrics."""
    if hasattr(g, "start_time"):
        latency_ms = (time.time() - g.start_time) * 1000
        ip = request.headers.get("X-Real-IP") or request.remote_addr or "unknown"

        if not request.path.startswith("/api/metrics"):
            metrics.record_request(
                ip=ip,
                endpoint=request.path,
                method=request.method,
                latency_ms=latency_ms,
                status_code=response.status_code,
            )

    return response


# Cleanup Thread

def cleanup_loop():
    """Clean old files every 10 minutes."""
    while True:
        time.sleep(600)
        try:
            deleted_conv = conversion_manager.cleanup_old_tasks(max_age_hours=1)
            deleted_concat = concatenation_manager.cleanup_old_tasks(max_age_hours=1)
            if deleted_conv > 0 or deleted_concat > 0:
                print(f"  🧹 Cleanup: {deleted_conv} conversion(s), {deleted_concat} concatenation(s) deleted")
        except Exception as e:
            print(f"  ⚠ Cleanup error: {e}")


cleanup_thread = threading.Thread(target=cleanup_loop, daemon=True)
cleanup_thread.start()


# LTTB Downsampling

def _lttb_numpy(x, y, threshold):
    """Pure NumPy implementation of LTTB."""
    n = len(x)
    if threshold >= n or threshold <= 2:
        return x.copy(), y.copy()

    x = np.asarray(x, dtype=np.float32)
    y = np.asarray(y, dtype=np.float32)

    sampled_x = np.zeros(threshold, dtype=np.float32)
    sampled_y = np.zeros(threshold, dtype=np.float32)

    sampled_x[0] = x[0]
    sampled_y[0] = y[0]
    sampled_x[threshold - 1] = x[-1]
    sampled_y[threshold - 1] = y[-1]

    bucket_size = (n - 2) / (threshold - 2)
    a = 0

    for i in range(1, threshold - 1):
        avg_start = int((i + 1) * bucket_size) + 1
        avg_end = min(int((i + 2) * bucket_size) + 1, n)

        if avg_start < avg_end:
            avg_x = np.mean(x[avg_start:avg_end])
            avg_y = np.mean(y[avg_start:avg_end])
        else:
            avg_x, avg_y = x[-1], y[-1]

        range_start = int(i * bucket_size) + 1
        range_end = min(int((i + 1) * bucket_size) + 1, n)

        point_ax, point_ay = x[a], y[a]

        areas = np.abs(
            (point_ax - avg_x) * (y[range_start:range_end] - point_ay)
            - (point_ax - x[range_start:range_end]) * (avg_y - point_ay)
        )

        max_idx = range_start + np.argmax(areas)
        sampled_x[i] = x[max_idx]
        sampled_y[i] = y[max_idx]
        a = max_idx

    return sampled_x, sampled_y


try:
    from numba import jit

    @jit(nopython=True, cache=True)
    def _lttb_numba(x, y, threshold):
        """Numba JIT implementation of LTTB."""
        n = len(x)
        if threshold >= n or threshold <= 2:
            return x.copy(), y.copy()

        sampled_x = np.empty(threshold, dtype=np.float32)
        sampled_y = np.empty(threshold, dtype=np.float32)

        sampled_x[0] = x[0]
        sampled_y[0] = y[0]
        sampled_x[threshold - 1] = x[n - 1]
        sampled_y[threshold - 1] = y[n - 1]

        bucket_size = (n - 2) / (threshold - 2)
        a = 0

        for i in range(1, threshold - 1):
            avg_range_start = int((i + 1) * bucket_size) + 1
            avg_range_end = min(int((i + 2) * bucket_size) + 1, n)

            avg_x = np.float32(0.0)
            avg_y = np.float32(0.0)
            for j in range(avg_range_start, avg_range_end):
                avg_x += x[j]
                avg_y += y[j]
            avg_count = avg_range_end - avg_range_start
            if avg_count > 0:
                avg_x /= avg_count
                avg_y /= avg_count

            range_start = int(i * bucket_size) + 1
            range_end = min(int((i + 1) * bucket_size) + 1, n)

            point_ax = x[a]
            point_ay = y[a]

            max_area = np.float32(-1.0)
            max_area_point = range_start

            for j in range(range_start, range_end):
                area = abs((point_ax - avg_x) * (y[j] - point_ay) - (point_ax - x[j]) * (avg_y - point_ay))
                if area > max_area:
                    max_area = area
                    max_area_point = j

            sampled_x[i] = x[max_area_point]
            sampled_y[i] = y[max_area_point]
            a = max_area_point

        return sampled_x, sampled_y

    def lttb_downsample(x, y, threshold):
        """Downsample using Numba JIT."""
        return _lttb_numba(
            np.ascontiguousarray(x, dtype=np.float32),
            np.ascontiguousarray(y, dtype=np.float32),
            threshold,
        )

    print("✓ Numba JIT enabled (float32)")

except ImportError:
    print("⚠ Numba not installed - using NumPy (float32)")
    lttb_downsample = _lttb_numpy


# Multi-Group Channel Fetching

def fetch_signal_multigroup(mdf, channel_name: str):
    """
    Fetch signal data, handling channels that exist in multiple groups.
    When a channel exists in multiple CAN groups, we try each group and return the first with valid data.
    """
    try:
        groups = mdf.channels_db.get(channel_name, [])
        if not groups:
            return None

        if len(groups) == 1:
            group_idx, channel_idx = groups[0]
            return mdf.get(channel_name, group=group_idx, index=channel_idx)

        for group_idx, channel_idx in groups:
            try:
                sig = mdf.get(channel_name, group=group_idx, index=channel_idx)
                if sig is None or sig.samples is None or len(sig.samples) == 0:
                    continue
                if np.issubdtype(sig.samples.dtype, np.number):
                    if np.any(sig.samples != 0) or len(sig.timestamps) > 10:
                        return sig
                else:
                    return sig
            except Exception:
                continue
        return None
    except Exception:
        return None


# Data Loaders

def load_synthetic_data():
    """Generate synthetic test data."""
    print("  Generating synthetic data...")

    sample_rate = 100
    duration = 3000
    n_samples = sample_rate * duration
    timestamps = np.linspace(0, duration, n_samples, dtype=np.float64)

    signal_defs = [
        ("VehicleSpeed", "km/h", lambda t: 60 + 40 * np.sin(2 * np.pi * t / 300) + np.random.randn(len(t)) * 2),
        ("EngineRPM", "rpm", lambda t: 2500 + 1500 * np.sin(2 * np.pi * t / 120) + np.random.randn(len(t)) * 50),
        ("ThrottlePosition", "%", lambda t: 30 + 25 * np.sin(2 * np.pi * t / 60) + np.random.randn(len(t)) * 3),
        ("CoolantTemp", "°C", lambda t: 85 + 10 * np.sin(2 * np.pi * t / 600) + np.random.randn(len(t)) * 0.5),
        ("IntakeAirTemp", "°C", lambda t: 35 + 15 * np.sin(2 * np.pi * t / 400) + np.random.randn(len(t)) * 1),
        ("MAF", "g/s", lambda t: 15 + 10 * np.sin(2 * np.pi * t / 90) + np.random.randn(len(t)) * 0.5),
        ("FuelPressure", "kPa", lambda t: 350 + 30 * np.sin(2 * np.pi * t / 180) + np.random.randn(len(t)) * 5),
        ("O2Voltage", "V", lambda t: 0.45 + 0.4 * np.sin(2 * np.pi * t / 30) + np.random.randn(len(t)) * 0.02),
        ("TimingAdvance", "°", lambda t: 15 + 10 * np.sin(2 * np.pi * t / 150) + np.random.randn(len(t)) * 1),
        ("BatteryVoltage", "V", lambda t: 13.8 + 0.5 * np.sin(2 * np.pi * t / 500) + np.random.randn(len(t)) * 0.1),
        ("EngineLoad", "%", lambda t: 40 + 30 * np.sin(2 * np.pi * t / 100) + np.random.randn(len(t)) * 2),
        ("FuelLevel", "%", lambda t: 75 - t / duration * 50 + np.random.randn(len(t)) * 0.5),
        ("OilTemp", "°C", lambda t: 95 + 15 * np.sin(2 * np.pi * t / 800) + np.random.randn(len(t)) * 0.5),
        ("OilPressure", "bar", lambda t: 3.5 + 1 * np.sin(2 * np.pi * t / 200) + np.random.randn(len(t)) * 0.1),
        ("BoostPressure", "bar", lambda t: 0.8 + 0.5 * np.sin(2 * np.pi * t / 80) + np.random.randn(len(t)) * 0.05),
        ("EGT", "°C", lambda t: 400 + 150 * np.sin(2 * np.pi * t / 250) + np.random.randn(len(t)) * 10),
        ("Lambda", "", lambda t: 1.0 + 0.1 * np.sin(2 * np.pi * t / 40) + np.random.randn(len(t)) * 0.01),
        ("AccelPedalPos", "%", lambda t: 25 + 20 * np.sin(2 * np.pi * t / 70) + np.random.randn(len(t)) * 2),
        ("BrakePressure", "bar", lambda t: np.maximum(0, 20 * np.sin(2 * np.pi * t / 50) ** 2 + np.random.randn(len(t)) * 1)),
        ("SteeringAngle", "°", lambda t: 30 * np.sin(2 * np.pi * t / 200) + np.random.randn(len(t)) * 2),
    ]

    signals = []
    metadata = []

    for i, (name, unit, generator) in enumerate(signal_defs):
        values = generator(timestamps).astype(np.float64)
        signals.append({"timestamps": timestamps.copy(), "values": values})
        hue = (i * 37) % 360
        metadata.append({"name": name, "unit": unit, "color": f"hsl({hue}, 70%, 55%)"})

    t_min, t_max = float(timestamps[0]), float(timestamps[-1])
    print(f"  ✓ Generated {len(signals)} signals, {n_samples:,} samples each")

    return signals, metadata, t_min, t_max


def load_mf4_with_dbc(mf4_path, dbc_path=None):
    """Load MF4 file with DBC decoding."""
    from asammdf import MDF

    print(f"  Loading MF4: {mf4_path.name}")
    if dbc_path:
        print(f"  Using DBC: {dbc_path.name}")

    start_time = time.time()
    mdf = MDF(mf4_path)

    if dbc_path and dbc_path.exists():
        print("  Decoding CAN data...")
        extracted = mdf.extract_bus_logging(database_files={"CAN": [(str(dbc_path), 0)]})
        mdf.close()
        mdf = extracted
        print("  DBC decoding complete")

    signals, metadata, all_timestamps = [], [], []
    signal_names = list(mdf.channels_db.keys())
    exclude_patterns = ["time", "t_", "timestamp", "CAN_DataFrame"]
    filtered_names = [n for n in signal_names if not any(p.lower() in n.lower() for p in exclude_patterns)]
    print(f"  Processing {len(filtered_names)} channels...")

    for name in filtered_names:
        try:
            sig = fetch_signal_multigroup(mdf, name)
            if sig is None or sig.samples is None or len(sig.samples) == 0:
                continue
            if not np.issubdtype(sig.samples.dtype, np.number):
                continue

            timestamps = np.asarray(sig.timestamps, dtype=np.float64)
            values = np.asarray(sig.samples, dtype=np.float64)

            if len(timestamps) < 2:
                continue

            mask = ~np.isfinite(values)
            if mask.all():
                continue
            if mask.any():
                valid_mask = ~mask
                values[mask] = np.interp(
                    timestamps[mask], timestamps[valid_mask], values[valid_mask],
                    left=values[valid_mask][0], right=values[valid_mask][-1]
                )

            signals.append({"timestamps": timestamps, "values": values})
            unit = str(sig.unit) if sig.unit else ""
            hue = (len(metadata) * 37) % 360
            metadata.append({"name": name, "unit": unit, "color": f"hsl({hue}, 70%, 55%)"})
            all_timestamps.append(timestamps)
        except Exception:
            continue

    mdf.close()

    if not signals:
        raise ValueError("No valid signals found in MF4 file")

    t_min = min(ts.min() for ts in all_timestamps)
    t_max = max(ts.max() for ts in all_timestamps)
    print(f"Loaded {len(signals)} signals in {time.time() - start_time:.2f}s")

    return signals, metadata, float(t_min), float(t_max)


def load_csv_file(csv_path):
    """Load CSV file for EDA."""
    import pandas as pd

    print(f"  Loading CSV: {csv_path.name}")

    for sep in [";", ",", "\t"]:
        try:
            df = pd.read_csv(csv_path, sep=sep, nrows=5)
            if len(df.columns) > 1:
                df = pd.read_csv(csv_path, sep=sep)
                break
        except Exception:
            continue
    else:
        raise ValueError("Impossible de parser le CSV")

    time_col = None
    for col in df.columns:
        if any(t in col.lower() for t in ["time", "timestamp", "t_", "zeit"]):
            time_col = col
            break

    if time_col is None:
        time_col = df.columns[0]

    timestamps = np.asarray(df[time_col].values, dtype=np.float32)

    signals = []
    metadata = []

    for col in df.columns:
        if col == time_col:
            continue

        try:
            values = np.asarray(pd.to_numeric(df[col], errors="coerce").values, dtype=np.float32)
            if np.isnan(values).all():
                continue

            signals.append({"timestamps": timestamps.copy(), "values": values})

            unit = ""
            if "[" in col and "]" in col:
                unit = col[col.index("[") + 1 : col.index("]")]
                name = col[: col.index("[")].strip()
            else:
                name = col

            hue = (len(metadata) * 37) % 360
            metadata.append({"name": name, "unit": unit, "color": f"hsl({hue}, 70%, 55%)"})
        except Exception:
            continue

    if not signals:
        raise ValueError("Aucun signal numérique trouvé dans le CSV")

    t_min, t_max = float(timestamps.min()), float(timestamps.max())
    print(f"  ✓ Loaded {len(signals)} signals from CSV")

    return signals, metadata, t_min, t_max


# Multi-Source DataStore

class MultiSourceDataStore:
    """Manages multiple data sources for the application."""

    def __init__(self):
        self.current_source: Optional[str] = None
        self.signals: list = []
        self.metadata: list = []
        self.t_min: float = 0
        self.t_max: float = 0
        self.loaded: bool = False

    def get_available_sources(self):
        """Return all available sources (demo only, users added by endpoint)."""
        sources = []

        for key, config in DATA_SOURCES.items():
            available = True
            if key == "mf4":
                mf4_path = BASE_DIR / config.get("mf4_file", "")
                available = mf4_path.exists()
            elif key.startswith("session_"):
                session_id = config.get("session_id")
                available = session_id in eda_sessions

            sources.append({
                "id": key,
                "name": config["name"],
                "description": config["description"],
                "available": available,
                "category": "demo",
            })

        return sources

    def load(self, source_id=None):
        """Load a data source."""
        if source_id is None:
            if self.current_source:
                source_id = self.current_source
            else:
                mf4_config = DATA_SOURCES.get("mf4", {})
                mf4_path = BASE_DIR / mf4_config.get("mf4_file", "")
                source_id = "mf4" if mf4_path.exists() else "synthetic"

        if self.loaded and self.current_source == source_id:
            return

        print(f"\n{'=' * 50}")
        print(f"  Loading data source: {source_id}")
        print(f"{'=' * 50}")

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
            if session_id not in eda_sessions:
                raise ValueError(f"Session not found: {session_id}")
            session = eda_sessions[session_id]
            self.signals = session["signals"]
            self.metadata = session["metadata"]
            self.t_min = session["t_min"]
            self.t_max = session["t_max"]
            print(f"  ✓ Loaded session: {session['filename']}")
        else:
            raise ValueError(f"Unknown source: {source_id}")

        self.current_source = source_id
        self.loaded = True

        # Warm-up LTTB
        try:
            sig = self.signals[0]
            n = min(1000, len(sig["timestamps"]))
            _ = lttb_downsample(sig["timestamps"][:n], sig["values"][:n], 100)
        except Exception:
            pass

        print(f"  ✓ Ready: {len(self.signals)} signals")

    def reload(self, source_id):
        """Force reload a data source."""
        self.loaded = False
        self.current_source = None
        self.load(source_id)

    def load_user_file(self, mf4_path, dbc_path=None, source_id=None):
        """Load a user MF4 file."""
        print(f"\n{'=' * 50}")
        print(f"  Loading user file: {mf4_path.name}")
        if dbc_path:
            print(f"  Using DBC: {dbc_path.name}")
        print(f"{'=' * 50}")

        self.signals, self.metadata, self.t_min, self.t_max = load_mf4_with_dbc(mf4_path, dbc_path)
        self.current_source = source_id or f"user_{mf4_path.stem}"
        self.loaded = True

        # Warm-up LTTB
        try:
            sig = self.signals[0]
            n = min(1000, len(sig["timestamps"]))
            _ = lttb_downsample(sig["timestamps"][:n], sig["values"][:n], 100)
        except Exception:
            pass

        print(f"Ready: {len(self.signals)} signals")

    def get_view(self, signal_indices, start_time, end_time, max_points):
        """Get downsampled view of signals."""
        if not self.loaded:
            self.load()

        result = {
            "view": {"start": float(start_time), "end": float(end_time), "original_points": 0, "returned_points": 0},
            "signals": [],
        }

        for sig_idx in signal_indices:
            if sig_idx < 0 or sig_idx >= len(self.signals):
                continue

            sig = self.signals[sig_idx]
            meta = self.metadata[sig_idx]
            timestamps, values = sig["timestamps"], sig["values"]

            mask = (timestamps >= start_time) & (timestamps <= end_time)
            view_ts, view_vals = timestamps[mask], values[mask]

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
                "stats": {"min": float(np.min(view_vals)), "max": float(np.max(view_vals)), "lttb_ms": round(lttb_time, 2)},
            })

        return result if result["signals"] else None


datastore = MultiSourceDataStore()


# Utility Functions

def allowed_file(filename):
    """Check if file extension is allowed."""
    return Path(filename).suffix.lower() in ALLOWED_EXTENSIONS


# API Routes - Data Sources

@app.route("/api/sources")
@optional_auth
def get_sources():
    """List all available sources, including user files."""
    sources = datastore.get_available_sources()

    user = getattr(g, "current_user", None)
    if user:
        user_files = storage.list_files(user.id, category="mf4", include_default=False)
        user_dbc_dir = BASE_DIR / "data" / "users" / user.id / "dbc"
        has_dbc = user_dbc_dir.exists() and any(user_dbc_dir.glob("*.dbc"))

        for f in user_files:
            file_path = storage.get_file_path(f.id, user.id)
            if file_path and file_path.exists():
                source_id = f"user_mf4_{file_path.stem}"
                sources.append({
                    "id": source_id,
                    "name": f.original_name,
                    "description": f.description or "Fichier personnel",
                    "available": True,
                    "category": "user",
                    "file_path": str(file_path),
                    "file_id": f.id,
                    "has_dbc": has_dbc,
                    "size_human": f.to_dict()["size_human"],
                })

    return jsonify({"sources": sources, "current": datastore.current_source})


@app.route("/api/source/<source_id>", methods=["POST"])
@optional_auth
def set_source(source_id):
    """Change active data source."""
    try:
        if source_id.startswith("user_mf4_"):
            user = getattr(g, "current_user", None)
            if not user:
                return jsonify({"error": "Authentification requise"}), 401

            user_id = user.id
            file_stem = source_id.replace("user_mf4_", "")
            user_mf4_dir = BASE_DIR / "data" / "users" / user_id / "mf4"

            mf4_path = None
            for f in user_mf4_dir.glob("*.mf4"):
                if f.stem == file_stem:
                    mf4_path = f
                    break

            if not mf4_path or not mf4_path.exists():
                return jsonify({"error": "Fichier introuvable"}), 404

            dbc_path = None
            user_dbc_dir = BASE_DIR / "data" / "users" / user_id / "dbc"
            if user_dbc_dir.exists():
                dbc_files = list(user_dbc_dir.glob("*.dbc"))
                if dbc_files:
                    dbc_path = dbc_files[0]

            datastore.load_user_file(mf4_path, dbc_path, source_id)
        else:
            datastore.reload(source_id)

        return jsonify({
            "success": True,
            "source": source_id,
            "n_signals": len(datastore.signals),
            "time_range": {"min": datastore.t_min, "max": datastore.t_max},
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/info")
def get_info():
    """Get current data info."""
    try:
        datastore.load()
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    return jsonify({
        "source": datastore.current_source,
        "n_signals": len(datastore.signals),
        "duration": datastore.t_max - datastore.t_min,
        "time_range": {"min": datastore.t_min, "max": datastore.t_max},
        "signals": [
            {"index": i, "name": m["name"], "unit": m["unit"], "color": m["color"]}
            for i, m in enumerate(datastore.metadata)
        ],
    })


@app.route("/api/view")
def get_view():
    """Get downsampled signal data."""
    try:
        datastore.load()
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    signals_param = request.args.get("signals", "0")
    signal_indices = (
        list(range(len(datastore.signals))) if signals_param == "all" else [int(x) for x in signals_param.split(",")]
    )

    start = float(request.args.get("start", datastore.t_min))
    end = float(request.args.get("end", datastore.t_max))
    max_points = max(100, min(int(request.args.get("max_points", 2000)), 10000))

    result = datastore.get_view(signal_indices, start, end, max_points)
    return jsonify(result) if result else (jsonify({"error": "No data in range"}), 404)


@app.route("/health")
def health():
    """Health check endpoint."""
    return jsonify({
        "status": "ok",
        "source": datastore.current_source,
        "loaded": datastore.loaded,
        "n_signals": len(datastore.signals) if datastore.loaded else 0,
    })


# API Routes - Reports

@app.route("/api/reports")
def list_reports():
    """List all available HTML reports."""
    reports = []

    for f in REPORTS_DIR.glob("*.html"):
        try:
            stat = f.stat()
            name = f.stem.replace("_", " ").replace("-", " ").title()
            reports.append({
                "id": f.stem,
                "name": name,
                "filename": f.name,
                "size_kb": round(stat.st_size / 1024, 1),
                "created": stat.st_mtime,
            })
        except Exception as e:
            print(f"Error reading report {f}: {e}")
            continue

    reports.sort(key=lambda x: x["created"], reverse=True)
    return jsonify({"reports": reports})


@app.route("/api/reports/<report_id>")
def get_report(report_id):
    """Return HTML content of a report."""
    safe_id = secure_filename(report_id)
    report_path = REPORTS_DIR / f"{safe_id}.html"

    if not report_path.exists():
        return jsonify({"error": "Report not found"}), 404

    return send_file(report_path, mimetype="text/html")


@app.route("/api/reports/<report_id>/download")
def download_report(report_id):
    """Download a report as file."""
    safe_id = secure_filename(report_id)
    report_path = REPORTS_DIR / f"{safe_id}.html"

    if not report_path.exists():
        return jsonify({"error": "Report not found"}), 404

    return send_file(report_path, as_attachment=True, download_name=f"{safe_id}.html")


@app.route("/api/reports/<report_id>", methods=["DELETE"])
def delete_report(report_id):
    """Delete a report."""
    safe_id = secure_filename(report_id)
    report_path = REPORTS_DIR / f"{safe_id}.html"

    if not report_path.exists():
        return jsonify({"error": "Report not found"}), 404

    try:
        report_path.unlink()
        return jsonify({"success": True, "message": f"Report {safe_id} deleted"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/reports/upload", methods=["POST"])
def upload_report():
    """Upload an external HTML report."""
    if "file" not in request.files:
        return jsonify({"error": "No file provided"}), 400

    file = request.files["file"]
    if not file.filename:
        return jsonify({"error": "Empty filename"}), 400

    if not file.filename.lower().endswith(".html"):
        return jsonify({"error": "Only HTML files accepted"}), 400

    filename = secure_filename(file.filename)
    report_path = REPORTS_DIR / filename

    if report_path.exists():
        base = report_path.stem
        counter = 1
        while report_path.exists():
            report_path = REPORTS_DIR / f"{base}_{counter}.html"
            counter += 1

    file.save(report_path)

    return jsonify({
        "success": True,
        "id": report_path.stem,
        "filename": report_path.name,
        "size_kb": round(report_path.stat().st_size / 1024, 1),
    })


# API Routes - Conversion

@app.route("/api/convert/formats")
def get_conversion_formats():
    """Return supported conversion formats."""
    return jsonify({
        "supported": get_supported_conversions(),
        "input_extensions": list(ALLOWED_EXTENSIONS - {".dbc"}),
        "dbc_supported": True,
    })


@app.route("/api/convert/upload", methods=["POST"])
def upload_for_conversion():
    """Upload a file for conversion."""
    if "file" not in request.files:
        return jsonify({"error": "Aucun fichier fourni"}), 400

    file = request.files["file"]
    if not file.filename:
        return jsonify({"error": "Nom de fichier vide"}), 400

    if not allowed_file(file.filename):
        return jsonify({"error": f"Extension non supportée. Extensions autorisées: {ALLOWED_EXTENSIONS}"}), 400

    unique_id = str(uuid.uuid4())[:8]
    filename = secure_filename(file.filename)
    input_path = TEMP_DIR / f"{unique_id}_{filename}"
    file.save(input_path)

    print(f"  ✓ Uploaded: {input_path} ({input_path.stat().st_size / 1024 / 1024:.2f} MB)")

    dbc_path = None
    if "dbc" in request.files:
        dbc_file = request.files["dbc"]
        if dbc_file.filename and dbc_file.filename.lower().endswith(".dbc"):
            dbc_filename = secure_filename(dbc_file.filename)
            dbc_path = TEMP_DIR / f"{unique_id}_{dbc_filename}"
            dbc_file.save(dbc_path)
            print(f"  ✓ Uploaded DBC: {dbc_path}")

    return jsonify({
        "success": True,
        "file_id": unique_id,
        "filename": filename,
        "file_path": str(input_path),
        "dbc_path": str(dbc_path) if dbc_path else None,
        "size_mb": round(input_path.stat().st_size / 1024 / 1024, 2),
    })


@app.route("/api/convert/start", methods=["POST"])
def start_conversion():
    """Start a conversion task."""
    data = request.get_json()

    if not data:
        return jsonify({"error": "Données JSON requises"}), 400

    file_path = data.get("file_path")
    output_format = data.get("output_format")
    dbc_path = data.get("dbc_path")
    resample_raster = data.get("resample_raster")

    if not file_path or not output_format:
        return jsonify({"error": "file_path et output_format requis"}), 400

    input_path = Path(file_path)
    if not input_path.exists():
        return jsonify({"error": "Fichier introuvable"}), 404

    input_ext = input_path.suffix.lower().lstrip(".")
    if not is_conversion_supported(input_ext, output_format):
        return jsonify({
            "error": f"Conversion .{input_ext} → .{output_format} non supportée",
            "supported": get_supported_conversions(),
        }), 400

    dbc = Path(dbc_path) if dbc_path else None
    task = conversion_manager.create_task(input_path, output_format, dbc, resample_raster)
    conversion_manager.run_conversion(task.id)

    if hasattr(g, "session_id"):
        metrics.record_action(g.session_id, "conversion_started")

    print(f"  → Conversion started: {task.id} ({input_path.name} → .{output_format}, raster={resample_raster})")

    return jsonify({"success": True, "task_id": task.id, "status": task.status.value, "message": "Conversion démarrée"})


@app.route("/api/convert/status/<task_id>")
def get_conversion_status(task_id):
    """Get conversion task status."""
    task = conversion_manager.get_task(task_id)

    if not task:
        return jsonify({"error": "Tâche introuvable"}), 404

    response = {
        "task_id": task.id,
        "status": task.status.value,
        "progress": round(task.progress, 1),
        "message": task.message,
    }

    if task.status == ConversionStatus.COMPLETED:
        response["output_file"] = task.output_file.name if task.output_file else None
        response["download_url"] = f"/api/convert/download/{task.id}"

    if task.status == ConversionStatus.FAILED:
        response["error"] = task.error

    return jsonify(response)


@app.route("/api/convert/download/<task_id>")
def download_converted_file(task_id):
    """Download converted file."""
    task = conversion_manager.get_task(task_id)

    if not task:
        return jsonify({"error": "Tâche introuvable"}), 404

    if task.status != ConversionStatus.COMPLETED:
        return jsonify({"error": "Conversion non terminée"}), 400

    if not task.output_file or not task.output_file.exists():
        return jsonify({"error": "Fichier de sortie introuvable"}), 404

    return send_file(task.output_file, as_attachment=True, download_name=task.output_file.name)


@app.route("/api/convert/cleanup", methods=["POST"])
def cleanup_conversions():
    """Cleanup old conversion tasks."""
    max_age = request.args.get("max_age_hours", 24, type=int)
    deleted = conversion_manager.cleanup_old_tasks(max_age)
    return jsonify({"success": True, "deleted_tasks": deleted})


# API Routes - Concatenation

@app.route("/api/concat/upload-single", methods=["POST"])
def upload_concat_single_file():
    """Upload a single MF4 file for concatenation."""
    if "file" not in request.files:
        return jsonify({"error": "Aucun fichier fourni"}), 400

    file = request.files["file"]
    index = request.form.get("index", "0")

    if not file.filename:
        return jsonify({"error": "Nom de fichier vide"}), 400

    if not file.filename.lower().endswith(".mf4"):
        return jsonify({"error": "Seuls les fichiers MF4 sont acceptés"}), 400

    file_id = str(uuid.uuid4())[:8]
    filename = secure_filename(file.filename)
    file_path = TEMP_DIR / f"concat_{file_id}_{index}_{filename}"
    file.save(file_path)

    print(f"  ✓ Concat upload single [{index}]: {filename} ({file_path.stat().st_size / 1024 / 1024:.1f} MB)")

    return jsonify({
        "success": True,
        "file_id": file_id,
        "file_path": str(file_path),
        "filename": filename,
        "index": index,
    })


@app.route("/api/concat/start", methods=["POST"])
def start_concatenation():
    """Start a concatenation task."""
    data = request.get_json()

    if not data:
        return jsonify({"error": "Données JSON requises"}), 400

    file_paths = data.get("file_paths", [])

    if len(file_paths) < 2:
        return jsonify({"error": "Au moins 2 fichiers requis"}), 400

    input_paths = []
    for fp in file_paths:
        p = Path(fp)
        if not p.exists():
            return jsonify({"error": f"Fichier introuvable: {p.name}"}), 404
        input_paths.append(p)

    task = concatenation_manager.create_task(input_paths)
    concatenation_manager.run_concatenation(task.id)

    if hasattr(g, "session_id"):
        metrics.record_action(g.session_id, "concatenation_started")

    print(f"  → Concatenation started: {task.id} ({len(input_paths)} files)")

    return jsonify({"success": True, "task_id": task.id, "status": task.status.value, "message": "Concaténation démarrée"})


@app.route("/api/concat/status/<task_id>")
def get_concat_status(task_id):
    """Get concatenation task status."""
    task = concatenation_manager.get_task(task_id)

    if not task:
        return jsonify({"error": "Tâche introuvable"}), 404

    response = {
        "task_id": task.id,
        "status": task.status.value,
        "progress": round(task.progress, 1),
        "message": task.message,
    }

    if task.status == ConversionStatus.COMPLETED:
        response["output_file"] = task.output_file.name if task.output_file else None
        response["download_url"] = f"/api/concat/download/{task.id}"
        response["stats"] = task.stats

    if task.status == ConversionStatus.FAILED:
        response["error"] = task.error

    return jsonify(response)


@app.route("/api/concat/download/<task_id>")
def download_concat_file(task_id):
    """Download concatenated file."""
    task = concatenation_manager.get_task(task_id)

    if not task:
        return jsonify({"error": "Tâche introuvable"}), 404

    if task.status != ConversionStatus.COMPLETED:
        return jsonify({"error": "Concaténation non terminée"}), 400

    if not task.output_file or not task.output_file.exists():
        return jsonify({"error": "Fichier de sortie introuvable"}), 404

    return send_file(task.output_file, as_attachment=True, download_name=task.output_file.name)


# API Routes - Metrics

@app.route("/api/metrics/current")
def get_current_metrics():
    """Get current real-time metrics."""
    return jsonify(metrics.get_current_stats())


@app.route("/api/metrics/daily")
@app.route("/api/metrics/daily/<date_str>")
def get_daily_metrics(date_str=None):
    """Get metrics for a specific day."""
    return jsonify(metrics.get_daily_report(date_str))


@app.route("/api/metrics/weekly")
def get_weekly_metrics():
    """Get weekly summary."""
    return jsonify(metrics.get_weekly_summary())


@app.route("/api/metrics/health")
def health_check():
    """Simple health check endpoint."""
    return jsonify({"status": "healthy", "timestamp": time.time(), "uptime": "N/A"})


# API Routes - EDA Upload

@app.route("/api/eda/upload", methods=["POST"])
@login_required
def upload_eda_file():
    """Upload MF4 file for interactive EDA."""
    if "file" not in request.files:
        return jsonify({"error": "Aucun fichier fourni"}), 400

    file = request.files["file"]
    if not file.filename:
        return jsonify({"error": "Nom de fichier vide"}), 400

    if not allowed_file(file.filename):
        return jsonify({"error": "Extension non supportée"}), 400

    user = g.current_user
    user_id = user.id
    filename = secure_filename(file.filename)
    file_ext = Path(filename).suffix.lower()

    if file_ext == ".mf4":
        dest_dir = BASE_DIR / "data" / "users" / user_id / "mf4"
    elif file_ext == ".dbc":
        dest_dir = BASE_DIR / "data" / "users" / user_id / "dbc"
    else:
        dest_dir = BASE_DIR / "data" / "users" / user_id / "other"

    dest_dir.mkdir(parents=True, exist_ok=True)

    file_id = str(uuid.uuid4())[:8]
    file_path = dest_dir / f"{file_id}_{filename}"
    file.save(file_path)
    print(f"EDA Upload: {file_path} ({file_path.stat().st_size / 1024 / 1024:.2f} MB)")

    dbc_path = None
    if "dbc" in request.files:
        dbc_file = request.files["dbc"]
        if dbc_file.filename and dbc_file.filename.lower().endswith(".dbc"):
            dbc_filename = secure_filename(dbc_file.filename)
            dbc_dir = BASE_DIR / "data" / "users" / user_id / "dbc"
            dbc_dir.mkdir(parents=True, exist_ok=True)

            dbc_id = str(uuid.uuid4())[:8]
            dbc_path = dbc_dir / f"{dbc_id}_{dbc_filename}"
            dbc_file.save(dbc_path)
            print(f"EDA DBC saved: {dbc_path}")

    if not dbc_path:
        user_dbc_dir = BASE_DIR / "data" / "users" / user_id / "dbc"
        if user_dbc_dir.exists():
            dbc_files = list(user_dbc_dir.glob("*.dbc"))
            if dbc_files:
                dbc_path = dbc_files[0]
                print(f"EDA using existing DBC: {dbc_path}")

    try:
        if file_ext == ".mf4":
            signals, metadata, t_min, t_max = load_mf4_with_dbc(file_path, dbc_path)
        elif file_ext == ".csv":
            signals, metadata, t_min, t_max = load_csv_file(file_path)
        else:
            return jsonify({"error": f"Format {file_ext} non supporté pour EDA"}), 400

        source_id = f"user_mf4_{file_path.stem}"

        datastore.signals = signals
        datastore.metadata = metadata
        datastore.t_min = t_min
        datastore.t_max = t_max
        datastore.current_source = source_id
        datastore.loaded = True

        print(f"EDA file loaded: {source_id} ({len(signals)} signals)")

        return jsonify({
            "success": True,
            "source_id": source_id,
            "filename": file_path.name,
            "n_signals": len(signals),
            "duration": t_max - t_min,
            "saved_to": str(file_path.relative_to(BASE_DIR)),
        })

    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


# API Routes - Debug

@app.route("/api/debug/user-files")
@optional_auth
def debug_user_files():
    """Debug: check user files."""
    user = getattr(g, "current_user", None)

    if not user:
        return jsonify({
            "error": "Non connecté",
            "g_has_current_user": hasattr(g, "current_user"),
            "auth_header": request.headers.get("Authorization", "None")[:50],
        })

    user_id = user.id
    user_mf4_dir = BASE_DIR / "data" / "users" / user_id / "mf4"

    result = {
        "user_id": user_id,
        "user_email": user.email,
        "mf4_dir": str(user_mf4_dir),
        "dir_exists": user_mf4_dir.exists(),
        "files": [],
    }

    if user_mf4_dir.exists():
        for f in user_mf4_dir.iterdir():
            result["files"].append({
                "name": f.name,
                "is_file": f.is_file(),
                "suffix": f.suffix,
                "size": f.stat().st_size if f.is_file() else 0,
            })

    return jsonify(result)


# Main

if __name__ == "__main__":
    print("=" * 60)
    print("  BALTIMORE BIRD - Automotive Time Series Viewer")
    print("=" * 60)
    print(f"\n  TEMP directory: {TEMP_DIR}")
    print("\n  Available data sources:")
    for src in datastore.get_available_sources():
        print(f"    {'✓' if src['available'] else '✗'} {src['id']:12s} - {src['name']}")
    print("\n  Supported conversions:")
    for input_fmt, output_fmts in get_supported_conversions().items():
        print(f"    .{input_fmt} → {', '.join('.' + f for f in output_fmts)}")
    print()
    try:
        datastore.load()
    except Exception as e:
        print(f"  ⚠ Error: {e}")
    print(f"\n  http://localhost:5000")
    print("=" * 60)
    app.run(debug=False, port=5000, host="0.0.0.0", threaded=True)