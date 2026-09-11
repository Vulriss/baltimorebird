# Performance & Optimisation — MINT / Baltimore Bird

> Source: `Document/Performance et optimisation…pdf` (MINT performance guidelines).
> These rules apply to all MINT projects, with particular attention to data pipelines and user
> interfaces. Related documents: `Document/coding-standards.md`, `functional-specification.md`.

Performance is not optional for a data-processing tool: it directly conditions user adoption. A
tool that loads an MF4 file in 45 seconds will be worked around, whatever its features.

---

## 1. Fundamental principle: measure before optimising

- **Any optimisation must be preceded by profiling.** An optimisation done without prior
  measurement is disguised technical debt.
- **Developer "feeling" is not a metric** (within reason — common sense applies: if it feels
  awful, there is a problem).

Recommended profiling tools:

| Tool | Use |
| --- | --- |
| `py-spy` | CPU profiling in production without modifying the code |
| `memory_profiler` | Line-by-line memory consumption analysis |
| `cProfile` | Function profiling during development |
| (load-testing web APIs) | Still under consideration |

---

## 2. Handling large data volumes

The following rules apply **without exception** on MINT data pipelines.

### 2.1 Polars by default

- **Polars is the MINT standard** for all tabular processing. Its native multithreading and lazy
  evaluation make it systematically more performant than Pandas on MINT data volumes.
- Pandas is accepted **only** in case of a proven incompatibility with a third-party dependency.

### 2.2 `scan_parquet` rather than `read_parquet().lazy()`

These two formulations are **not equivalent**:

- `scan_parquet` is a **true lazy scan**: it does not read the file until the execution plan is
  finalised, which lets Polars prune unnecessary columns and row groups **before any disk read**.
- `read_parquet().lazy()` loads the **entire file into memory** first, then applies the
  transformations. On files of several hundred MB, the difference is significant.

> Note: sometimes a `LazyFrame` is **simulated** to homogenise the API — in particular because
> ASAM MDF files older than 4.2 do not have the structure to allow direct lazy reading.

```python
# Avoid
df = pl.read_parquet(path).lazy().filter(pl.col("signal") == target).collect()

# Correct: Polars prunes unnecessary row groups before reading
df = (
    pl.scan_parquet(path)
    .filter(pl.col("signal") == target)
    .select(["timestamp", "signal", "value"])
    .collect()
)
```

### 2.3 LazyFrame by default

Switching to eager mode (`collect()`) must be **explicitly justified** and placed **as late as
possible** in the flow. Collect only what you need — **filter before**.

### 2.4 Streaming mandatory beyond 200 MB

- Loading files larger than **100 MB** fully into memory is **forbidden** without streaming or
  chunked reading.
- Production MF4 and BLF files frequently exceed this threshold. On Cloud Run, available memory
  is limited and shared between concurrent sessions.

---

## 3. User interfaces

**Perceived performance matters as much as real performance.** A 3-second operation with
immediate visual feedback is experienced better than a 1-second operation with no feedback.

Rules for all MINT interfaces:

- Any network call or potentially long processing must run **asynchronously**. The UI main thread
  must **never** be blocked.
- A loading indicator must appear within **200 ms** of triggering a long action.
- File reading, API calls and computation must be **decoupled from rendering** via workers or
  asynchronous tasks.

Desktop example (PyQt):

```python
# Blocks the UI :(
def on_file_selected(self, path: str) -> None:
    df = read_mf4(path)
    self.update_signal_list(df)

# Delegates to a worker :)
def on_file_selected(self, path: str) -> None:
    self.worker = MdfReaderWorker(path)
    self.worker.finished.connect(self.update_signal_list)
    self.worker.start()
```

Web example (FastAPI) — delegate heavy computation to an executor:

```python
@router.post("/signals/load")
async def load_signals(file: UploadFile) -> SignalCatalog:
    loop = asyncio.get_event_loop()
    catalog = await loop.run_in_executor(None, parse_mf4, file.file)
    return catalog
```

---

## 4. Vector operations and numerical computation

Signal processing involves data volumes that make Python loops prohibitive. A typical MF4 file
contains thousands of channels over hundreds of thousands of points: at this scale, the
difference between a Python loop and a vector operation can be several orders of magnitude in
execution time.

### 4.1 Principle: no loop over data

A Python loop iterating over rows or values of a numerical array is an **anti-pattern**.
NumPy, Polars and SciPy expose compiled vector operations that process a whole array in a single
native instruction.

```python
# Pas bueno
result = []
for i in range(len(signal)):
    result.append(signal[i] * 2.0 + offset)

# Vector operation, much bueno
result = signal * 2.0 + offset
```

The rule also applies to conditional transformations. `np.where` and Polars conditional
expressions systematically replace loops with branching.

```python
# Pas bueno
result = []
for val in signal:
    result.append(val if val > threshold else 0.0)

# Correct
result = np.where(signal > threshold, signal, 0.0)

# Correct with Polars
df = df.with_columns(
    pl.when(pl.col("signal") > threshold)
    .then(pl.col("signal"))
    .otherwise(0.0)
    .alias("signal_clipped")
)
```

### 4.2 Nested loops

Nested loops are particularly costly. Their complexity is at least **O(n²)**, which quickly
becomes unmanageable. If an operation seems to require two levels of iteration, it can almost
always be reformulated as a matrix operation, a `groupby`, or a `join`.

```python
# O(n²) over two signal series — very no bueno
correlations = []
for i in range(len(signals_a)):
    for j in range(len(signals_b)):
        correlations.append(np.corrcoef(signals_a[i], signals_b[j])[0, 1])

# Correct: matrix computation in a single operation
correlation_matrix = np.corrcoef(np.stack(signals_a), np.stack(signals_b))
```

**Three or more nesting levels** are almost certainly a design problem to be reworked.

---

## 5. Density computation (KDE): FFTKDE is the reference

For any probability-density computation (KDE), **`KDEpy.FFTKDE` is the reference
implementation**. It relies on Fourier transforms for kernel evaluation, making it **linear** in
time rather than quadratic like naive implementations.

Indicative timings on typical volumes:

| Implementation | 50k points | 500k points |
| --- | --- | --- |
| `scipy.stats.gaussian_kde` | ~0.8 s | ~80 s |
| `sklearn.neighbors.KernelDensity` | ~1.2 s | >100 s |
| `KDEpy.FFTKDE` | ~0.02 s | ~0.2 s |

```python
from KDEpy import FFTKDE
import numpy as np


def compute_kde(
    signal: np.ndarray,
    n_points: int = 2048,
    bandwidth: str | float = "ISJ",
) -> tuple[np.ndarray, np.ndarray]:
    """Compute a kernel density estimate using an FFT-based algorithm.

    Args:
        signal: Input signal as a 1D NumPy array.
        n_points: Number of evaluation points. Must be a power of 2
            for optimal FFT performance.
        bandwidth: Bandwidth selection method or fixed value.
            'ISJ' (Improved Sheather-Jones) is recommended for
            automotive signals with multimodal distributions.

    Returns:
        Tuple of (x_values, density_values).
    """
    x, density = FFTKDE(bw=bandwidth).fit(signal).evaluate(n_points)
    return x, density
```

- The **ISJ** (Improved Sheather-Jones) bandwidth selector is recommended for signals that
  frequently present multimodal distributions (e.g. engine speed with several distinct operating
  points). Scott's or Silverman's selectors may underestimate the complexity of such
  distributions.
- `n_points` **must be a power of 2** for optimal FFT performance. Recommended values are 1024,
  2048 or 4096 depending on the desired resolution.
- To **limit boundary bias**, mirror the data below the min value and above the max value. This
  is valid for all density computations, independently of the method.

---

## 6. Polars operations: prefer expressions over `apply`

Using `.apply()` or `.map_elements()` in Polars runs a Python function on each individual value,
cancelling all the benefits of Polars. Reserve these methods for cases where **no native
expression exists**.

```python
# Bypasses the Polars vector engine — avoid
df = df.with_columns(
    pl.col("signal").map_elements(lambda x: x * 2.0 + offset)
)

# Correct: native compiled expression
df = df.with_columns(
    (pl.col("signal") * 2.0 + offset).alias("signal_scaled")
)
```

---

## Summary checklist

- [ ] **Profile before optimising** (`py-spy`, `memory_profiler`, `cProfile`).
- [ ] **Polars** by default; Pandas only on proven third-party incompatibility.
- [ ] Prefer `scan_parquet` over `read_parquet().lazy()`; `collect()` as late as possible, filter
      before.
- [ ] **Streaming** beyond 200 MB; never load > 100 MB fully into memory without streaming.
- [ ] UI: async for any long/network task, loading indicator within **200 ms**, never block the
      main thread.
- [ ] **No Python loop over data** — vectorise with NumPy/Polars/SciPy; avoid nested loops (O(n²)+).
- [ ] KDE: **`KDEpy.FFTKDE`**, `n_points` a power of 2, `ISJ` bandwidth, mirror at boundaries.
- [ ] Polars: **native expressions** over `.apply()` / `.map_elements()`.
