"""Baltimore Bird - Deterministic synthetic data source for the Dashboard Builder PoC.

The PoC runs on synthetic data only (functional-specification.md, BLK-DAT-01..04). A synthetic
source is defined by a sample count, a sampling period, a random seed and a list of signal
definitions. Generation is reproducible: the same configuration and seed produce identical
values across runs and hosts.

Two representations coexist and must stay consistent:

- :func:`generate_synthetic_frame` builds a Polars ``DataFrame`` host-side (float64 time column,
  float32 value columns). It is used for schema/metadata previews and for tests.
- :func:`render_synthetic_numpy` emits the numpy source inlined into the generated module, so
  the module stays self-contained and executable inside the confined runner (which allowlists
  numpy). Both implementations follow the same waveform formulas.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Dict, List, Tuple

import polars as pl

MAX_SAMPLES = 500_000
MAX_SIGNALS = 32
_ALLOWED_KINDS = ("sine", "cosine", "ramp", "square", "noise")


@dataclass(frozen=True)
class SyntheticSignal:
    """Definition of a single synthetic signal.

    Attributes:
        name: Column name exposed in the output schema. Must be a valid identifier.
        unit: Physical unit propagated to figure labels (e.g. ``"rpm"``, ``"degC"``).
        kind: Waveform family, one of ``sine``, ``cosine``, ``ramp``, ``square`` or ``noise``.
        amplitude: Peak amplitude of the waveform.
        frequency: Frequency in hertz (ignored by ``ramp`` and ``noise``).
        offset: Constant value added to the waveform.
        noise: Standard deviation of additive Gaussian noise.
    """

    name: str
    unit: str = ""
    kind: str = "sine"
    amplitude: float = 1.0
    frequency: float = 0.1
    offset: float = 0.0
    noise: float = 0.0


@dataclass(frozen=True)
class SyntheticSourceConfig:
    """Validated configuration of a synthetic source block."""

    samples: int
    period: float
    seed: int
    signals: Tuple[SyntheticSignal, ...]


def parse_source_config(config: Dict[str, Any]) -> SyntheticSourceConfig:
    """Validate and normalise a raw synthetic-source configuration.

    Args:
        config: Raw block configuration (from the recipe JSON).

    Returns:
        A validated :class:`SyntheticSourceConfig`.

    Raises:
        ValueError: If any field is missing, out of range or inconsistent.
    """
    samples = int(config.get("samples", 0))
    if not 1 <= samples <= MAX_SAMPLES:
        raise ValueError(f"samples must be in [1, {MAX_SAMPLES}], got {samples}")

    period = float(config.get("period", 0.0))
    if not math.isfinite(period) or period <= 0.0:
        raise ValueError(f"period must be a positive finite number, got {period}")

    seed = int(config.get("seed", 0))
    if not 0 <= seed <= 2**32 - 1:
        raise ValueError(f"seed must be in [0, 2^32 - 1], got {seed}")

    raw_signals = config.get("signals") or []
    if not isinstance(raw_signals, list) or not raw_signals:
        raise ValueError("signals must be a non-empty list")
    if len(raw_signals) > MAX_SIGNALS:
        raise ValueError(f"too many signals (max {MAX_SIGNALS})")

    signals = tuple(_parse_signal(index, raw) for index, raw in enumerate(raw_signals))
    names = [signal.name for signal in signals]
    if len(set(names)) != len(names):
        raise ValueError("signal names must be unique")

    return SyntheticSourceConfig(samples=samples, period=period, seed=seed, signals=signals)


def _parse_signal(index: int, raw: Dict[str, Any]) -> SyntheticSignal:
    if not isinstance(raw, dict):
        raise ValueError(f"signal {index} must be an object")

    name = str(raw.get("name", "")).strip()
    if not name.isidentifier():
        raise ValueError(f"signal {index} name must be a valid identifier, got {name!r}")

    kind = str(raw.get("kind", "sine"))
    if kind not in _ALLOWED_KINDS:
        raise ValueError(f"signal {name!r} has unknown kind {kind!r}")

    amplitude = _finite_float(raw.get("amplitude", 1.0), f"signal {name!r} amplitude")
    frequency = _finite_float(raw.get("frequency", 0.1), f"signal {name!r} frequency")
    offset = _finite_float(raw.get("offset", 0.0), f"signal {name!r} offset")
    noise = _finite_float(raw.get("noise", 0.0), f"signal {name!r} noise")
    if noise < 0.0:
        raise ValueError(f"signal {name!r} noise must be non-negative")

    return SyntheticSignal(
        name=name,
        unit=str(raw.get("unit", "")),
        kind=kind,
        amplitude=amplitude,
        frequency=frequency,
        offset=offset,
        noise=noise,
    )


def _finite_float(value: Any, label: str) -> float:
    number = float(value)
    if not math.isfinite(number):
        raise ValueError(f"{label} must be a finite number")
    return number


def generate_synthetic_frame(config: Dict[str, Any]) -> pl.DataFrame:
    """Generate a reproducible synthetic dataset as a Polars ``DataFrame``.

    Args:
        config: Raw synthetic-source configuration.

    Returns:
        A ``DataFrame`` with a float64 ``time`` column and one float32 column per signal.

    Raises:
        ValueError: If the configuration is invalid.
    """
    parsed = parse_source_config(config)
    import numpy as np

    time = np.arange(parsed.samples, dtype=np.float64) * parsed.period
    columns: Dict[str, Any] = {"time": pl.Series("time", time, dtype=pl.Float64)}
    for signal in parsed.signals:
        values = _waveform(np, time, signal, parsed.seed)
        columns[signal.name] = pl.Series(signal.name, values.astype(np.float32), dtype=pl.Float32)
    return pl.DataFrame(columns)


def _waveform(np: Any, time: Any, signal: SyntheticSignal, base_seed: int) -> Any:
    angle = 2.0 * np.pi * signal.frequency * time
    if signal.kind == "sine":
        base = np.sin(angle)
    elif signal.kind == "cosine":
        base = np.cos(angle)
    elif signal.kind == "square":
        base = np.sign(np.sin(angle))
    elif signal.kind == "ramp":
        span = time[-1] - time[0] if time.size > 1 and time[-1] != time[0] else 1.0
        base = (time - time[0]) / span
    else:  # noise
        base = np.zeros_like(time)

    result = signal.offset + signal.amplitude * base
    if signal.noise > 0.0:
        rng = np.random.default_rng(base_seed + _name_seed(signal.name))
        result = result + rng.normal(0.0, signal.noise, size=time.shape)
    return result


def _name_seed(name: str) -> int:
    """Derive a stable per-signal seed offset from its name (deterministic across hosts)."""
    return sum((index + 1) * ord(char) for index, char in enumerate(name)) % 100_000


def describe_synthetic_source(config: Dict[str, Any]) -> Dict[str, Any]:
    """Return the output schema of a synthetic source without materialising values.

    Args:
        config: Raw synthetic-source configuration.

    Returns:
        A schema dict with the sample count and per-column name, dtype and unit.

    Raises:
        ValueError: If the configuration is invalid.
    """
    parsed = parse_source_config(config)
    schema: List[Dict[str, str]] = [{"name": "time", "dtype": "float64", "unit": "s"}]
    for signal in parsed.signals:
        schema.append({"name": signal.name, "dtype": "float32", "unit": signal.unit})
    return {"samples": parsed.samples, "period": parsed.period, "columns": schema}


def render_synthetic_numpy(fn_name: str, config: Dict[str, Any]) -> str:
    """Render the numpy source of a self-contained synthetic-source function.

    The emitted function reproduces :func:`generate_synthetic_frame` using only numpy, so the
    generated dashboard module stays runnable inside the confined runner (numpy allowlist) and
    standalone. It returns a ``dict`` of column name to numpy array.

    Args:
        fn_name: Name of the generated function (a compiler-reserved identifier).
        config: Raw synthetic-source configuration.

    Returns:
        The Python source of the function, terminated by a newline.

    Raises:
        ValueError: If the configuration is invalid.
    """
    parsed = parse_source_config(config)
    lines: List[str] = [
        f"def {fn_name}() -> dict:",
        f"    time = np.arange({parsed.samples}, dtype=np.float64) * {parsed.period!r}",
        "    columns = {\"time\": time}",
    ]
    for signal in parsed.signals:
        lines.extend(_render_signal_numpy(signal, parsed.seed))
    lines.append("    return columns")
    lines.append("")
    return "\n".join(lines)


def _render_signal_numpy(signal: SyntheticSignal, base_seed: int) -> List[str]:
    lines: List[str] = [f"    angle = 2.0 * np.pi * {signal.frequency!r} * time"]
    if signal.kind == "sine":
        base_expr = "np.sin(angle)"
    elif signal.kind == "cosine":
        base_expr = "np.cos(angle)"
    elif signal.kind == "square":
        base_expr = "np.sign(np.sin(angle))"
    elif signal.kind == "ramp":
        lines.append("    _span = time[-1] - time[0] if time.size > 1 and time[-1] != time[0] else 1.0")
        base_expr = "(time - time[0]) / _span"
    else:  # noise
        base_expr = "np.zeros_like(time)"

    lines.append(f"    _series = {signal.offset!r} + {signal.amplitude!r} * ({base_expr})")
    if signal.noise > 0.0:
        seed = base_seed + _name_seed(signal.name)
        lines.append(f"    _rng = np.random.default_rng({seed})")
        lines.append(f"    _series = _series + _rng.normal(0.0, {signal.noise!r}, size=time.shape)")
    lines.append(f"    columns[{signal.name!r}] = _series.astype(np.float32)")
    return lines
