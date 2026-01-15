"""
Baltimore Bird - Loading data.

Fonctions pour charger les differents formats de donnees automobiles:
- MF4/MDF avec décodage DBC
- CSV
- Donnees syntheiques pour tests
"""

from pathlib import Path
from typing import Optional, Tuple

import numpy as np
from numpy.typing import NDArray


SignalData = dict[str, NDArray]
SignalMetadata = dict[str, str]
LoadResult = Tuple[list[SignalData], list[SignalMetadata], float, float]


def fetch_signal_multigroup(mdf, channel_name: str):
    """Récupère un signal qui peut exister dans plusieurs groupes."""
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


def load_mf4_with_dbc(mf4_path: Path, dbc_path: Optional[Path] = None) -> LoadResult:
    """Charge un fichier MF4 avec décodage DBC optionnel."""
    from asammdf import MDF

    print(f"  Loading MF4: {mf4_path.name}")
    mdf = MDF(mf4_path)

    if dbc_path and dbc_path.exists():
        print(f"  Applying DBC: {dbc_path.name}")
        try:
            extracted = mdf.extract_bus_logging(
                database_files={"CAN": [(str(dbc_path), 0)]}
            )
            mdf.close()
            mdf = extracted
        except Exception as e:
            print(f"  DBC decode failed: {e}")

    signal_names = list(mdf.channels_db.keys())
    exclude_patterns = ["time", "t_", "timestamp", "CAN_DataFrame"]
    filtered_names = [
        n for n in signal_names
        if not any(p.lower() in n.lower() for p in exclude_patterns)
    ]

    print(f"  Found {len(filtered_names)} channels, loading...")

    signals = []
    metadata = []
    t_min_global = float("inf")
    t_max_global = float("-inf")

    for i, name in enumerate(filtered_names):
        sig = fetch_signal_multigroup(mdf, name)
        if sig is None or sig.samples is None or len(sig.samples) == 0:
            continue

        if not np.issubdtype(sig.samples.dtype, np.number):
            continue

        timestamps = np.asarray(sig.timestamps, dtype=np.float64)
        values = np.asarray(sig.samples, dtype=np.float64)

        mask = ~np.isfinite(values)
        if mask.all():
            continue
        if mask.any():
            valid_mask = ~mask
            values[mask] = np.interp(
                timestamps[mask],
                timestamps[valid_mask],
                values[valid_mask],
                left=values[valid_mask][0],
                right=values[valid_mask][-1]
            )

        t_min_global = min(t_min_global, float(timestamps[0]))
        t_max_global = max(t_max_global, float(timestamps[-1]))

        unit = str(sig.unit) if sig.unit else ""
        hue = (len(signals) * 37) % 360

        signals.append({"timestamps": timestamps, "values": values})
        metadata.append({"name": name, "unit": unit, "color": f"hsl({hue}, 70%, 55%)"})

    mdf.close()

    if not signals:
        raise ValueError("Aucun signal numérique valide trouvé dans le fichier MF4")

    print(f"Loaded {len(signals)} signals, duration: {t_max_global - t_min_global:.1f}s")
    return signals, metadata, t_min_global, t_max_global


def load_synthetic_data() -> LoadResult:
    """Genere des donnees synthetiques pour les tests."""
    print("Generating synthetic data...")

    sample_rate = 100
    duration = 3000
    n_samples = sample_rate * duration
    timestamps = np.linspace(0, duration, n_samples, dtype=np.float64)

    signal_defs = [
        ("VehicleSpeed", "km/h", lambda t: 60 + 40 * np.sin(2 * np.pi * t / 300) + np.random.randn(len(t)) * 2),
        ("EngineRPM", "rpm", lambda t: 2500 + 1500 * np.sin(2 * np.pi * t / 120) + np.random.randn(len(t)) * 50),
        ("ThrottlePosition", "%", lambda t: 30 + 25 * np.sin(2 * np.pi * t / 60) + np.random.randn(len(t)) * 3),
        ("CoolantTemp", "C", lambda t: 85 + 10 * np.sin(2 * np.pi * t / 600) + np.random.randn(len(t)) * 0.5),
        ("IntakeAirTemp", "C", lambda t: 35 + 15 * np.sin(2 * np.pi * t / 400) + np.random.randn(len(t)) * 1),
        ("MAF", "g/s", lambda t: 15 + 10 * np.sin(2 * np.pi * t / 90) + np.random.randn(len(t)) * 0.5),
        ("FuelPressure", "kPa", lambda t: 350 + 30 * np.sin(2 * np.pi * t / 180) + np.random.randn(len(t)) * 5),
        ("O2Voltage", "V", lambda t: 0.45 + 0.4 * np.sin(2 * np.pi * t / 30) + np.random.randn(len(t)) * 0.02),
        ("TimingAdvance", "deg", lambda t: 15 + 10 * np.sin(2 * np.pi * t / 150) + np.random.randn(len(t)) * 1),
        ("BatteryVoltage", "V", lambda t: 13.8 + 0.5 * np.sin(2 * np.pi * t / 500) + np.random.randn(len(t)) * 0.1),
        ("EngineLoad", "%", lambda t: 40 + 30 * np.sin(2 * np.pi * t / 100) + np.random.randn(len(t)) * 2),
        ("FuelLevel", "%", lambda t: 75 - t / duration * 50 + np.random.randn(len(t)) * 0.5),
        ("OilTemp", "C", lambda t: 95 + 15 * np.sin(2 * np.pi * t / 800) + np.random.randn(len(t)) * 0.5),
        ("OilPressure", "bar", lambda t: 3.5 + 1 * np.sin(2 * np.pi * t / 200) + np.random.randn(len(t)) * 0.1),
        ("BoostPressure", "bar", lambda t: 0.8 + 0.5 * np.sin(2 * np.pi * t / 80) + np.random.randn(len(t)) * 0.05),
        ("EGT", "C", lambda t: 400 + 150 * np.sin(2 * np.pi * t / 250) + np.random.randn(len(t)) * 10),
        ("Lambda", "", lambda t: 1.0 + 0.1 * np.sin(2 * np.pi * t / 40) + np.random.randn(len(t)) * 0.01),
        ("AccelPedalPos", "%", lambda t: 25 + 20 * np.sin(2 * np.pi * t / 70) + np.random.randn(len(t)) * 2),
        ("BrakePressure", "bar", lambda t: np.maximum(0, 20 * np.sin(2 * np.pi * t / 50) ** 2 + np.random.randn(len(t)) * 1)),
        ("SteeringAngle", "deg", lambda t: 30 * np.sin(2 * np.pi * t / 200) + np.random.randn(len(t)) * 2),
    ]

    signals = []
    metadata = []

    for i, (name, unit, generator) in enumerate(signal_defs):
        values = generator(timestamps).astype(np.float64)
        signals.append({"timestamps": timestamps.copy(), "values": values})
        hue = (i * 37) % 360
        metadata.append({"name": name, "unit": unit, "color": f"hsl({hue}, 70%, 55%)"})

    t_min, t_max = float(timestamps.min()), float(timestamps.max())
    print(f"  Generated {len(signals)} signals, duration: {t_max - t_min:.1f}s")
    return signals, metadata, t_min, t_max


def load_csv_data(csv_path: Path) -> LoadResult:
    """Charge un fichier CSV avec premiere colonne timestamp."""
    import pandas as pd

    print(f"Loading CSV: {csv_path.name}")
    df = pd.read_csv(csv_path)

    if df.empty:
        raise ValueError("Fichier CSV vide")

    time_col = df.columns[0]
    timestamps = df[time_col].values.astype(np.float64)

    signals = []
    metadata = []

    for i, col in enumerate(df.columns[1:]):
        values = df[col].values
        if not np.issubdtype(values.dtype, np.number):
            continue

        values = values.astype(np.float64)
        mask = ~np.isfinite(values)
        if mask.all():
            continue
        if mask.any():
            valid_mask = ~mask
            values[mask] = np.interp(timestamps[mask], timestamps[valid_mask], values[valid_mask])

        hue = (len(signals) * 37) % 360
        signals.append({"timestamps": timestamps.copy(), "values": values})
        metadata.append({"name": col, "unit": "", "color": f"hsl({hue}, 70%, 55%)"})

    if not signals:
        raise ValueError("Aucun signal numérique trouvé dans le CSV")

    t_min, t_max = float(timestamps.min()), float(timestamps.max())
    print(f"Loaded {len(signals)} signals from CSV")
    return signals, metadata, t_min, t_max