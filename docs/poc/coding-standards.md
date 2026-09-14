# Coding Standards — MINT / Baltimore Bird

> Source: `Document/Bonnes pratiques python…pdf` (MINT Python best practices).
> These standards apply to all backend code and to compiler-emitted (generated) code in
> the Baltimore Bird Dashboard Builder. Developer documentation and comments are written in
> **English**; user-facing messages are in **French**.

---

## 1. Formatting and PEP 8 compliance

- Compliance with **PEP 8** is a fundamental prerequisite: it guarantees the consistency and
  readability of the code produced.
- Format code with **Black**.
- MINT uses a slightly relaxed PEP 8: **maximum line length is 120 characters** (not 80).

---

## 2. The Zen of Python (PEP 20)

PEP 20 is the founding philosophy of the language and must guide every design decision, beyond
syntax and formatting rules (`import this`). The most structuring principles for MINT:

- **Explicit is better than implicit.** Implicit behaviour confuses the reader and creates bugs
  for the maintainer. Hidden default values, undocumented side effects and *magic conventions*
  must be avoided.
- **Simple is better than complex.** The simplest solution that meets the need is always
  preferable. Complexity must be justified by a **real constraint**, not by anticipating
  hypothetical future needs.
- **Readability counts.** Code is read far more often than it is written. Code readable by a
  developer discovering the codebase is a quality deliverable; code only its author understands
  is technical debt.
- **Errors should never pass silently.** A silent failure is always worse than an explicit
  exception. This is the foundation of the *defensive programming* section below.
- **If the implementation is hard to explain, it's a bad idea.** If you cannot explain your
  implementation simply to a colleague, it must be rethought.

---

## 3. Static typing (PEP 484)

- **Type annotations are mandatory** on all functions and methods. They improve readability,
  enable error detection at edit time, and act as implicit documentation.
- Running **`mypy`** for static type checking before any commit is recommended.

```python
def compute_delta(signal: pl.Series, window: int = 5) -> pl.Series:
    ...
```

---

## 4. Technical documentation

- Code documentation **must be written in English**.
- It must:
  - Clarify the algorithmic behaviour.
  - Precisely describe the implemented functionality.
  - Facilitate long-term maintenance and technical support.
- **Classes and functions must be documented with Google Style Docstrings.**

```python
def resample_signal(series: pl.Series, target_freq: float, method: str = "lttb") -> pl.Series:
    """Resample a time series to a target frequency.

    Args:
        series: Input time series as a Polars Series.
        target_freq: Target frequency in Hz.
        method: Downsampling algorithm. Supported values are
            'lttb' and 'linear'.

    Returns:
        Resampled series at the target frequency.

    Raises:
        ValueError: If the target frequency exceeds the source frequency.
    """
    ...
```

---

## 5. Naming standards

Naming conventions must be respected consistently across all MINT projects.

| Element | Convention | Example |
| --- | --- | --- |
| Variables and functions | `snake_case` | `signal_buffer`, `read_mf4_file()` |
| Classes | `PascalCase` | `MdfReader`, `SignalBuffer` |
| Constants | `UPPERCASE` | `MAX_FILE_SIZE`, `DEFAULT_FREQ` |
| Modules and packages | `snake_case` | `file_interaction.py`, `signal_utils/` |
| Private arguments | `_` prefix | `_cache`, `_internal_state` |

Names must be explicit and self-documenting so the code is understandable without external
reference. **A single-letter variable name is forbidden** outside short loops and formal
mathematical expressions.

---

## 6. Architecture and modularity

- Respect the **Single Responsibility Principle**: each function performs one specific,
  well-defined task.
- Avoid code duplication — **DRY (Don't Repeat Yourself)**.
- Structure the code into **reusable modules** to favour maintainability and evolvability.
- **A function must not exceed 40 lines.** Beyond that, decompose the logic into explicitly
  named sub-functions.

---

## 7. Big-data handling

- **Polars is the MINT standard** for all tabular processing. Pandas is used **only** in case
  of a proven incompatibility with a third-party dependency.
- **Lazy evaluation (`LazyFrame`)** is the default for data pipelines.
- Use `LazyFrame` **only when necessary** — big-data out-of-core work, or API consistency.
  Otherwise prefer a `Polars DataFrame`.
- **Loading files larger than 100 MB fully into memory is forbidden** without streaming or
  chunked reading.
- **Profiling with `py-spy` or `memory_profiler` is mandatory before any performance
  optimisation.**

---

## 8. Security and robustness

Input validation and sanitisation are essential security measures. Appropriate exception
handling ensures system robustness. Detailed error logs must be in place to facilitate
debugging and maintenance.

The following rules apply **without exception**:

- **`eval()` and `exec()` are forbidden.**
- **No secret** (API key, password, token) may appear in source code. The only acceptable
  alternatives are GCP environment variables or uncommitted `.env` files.
- **Exceptions must be typed.** A generic `except Exception` without re-raise is forbidden.

```python
# No bueno
try:
    result = parse_mf4(path)
except Exception:
    pass

# Bueno
try:
    result = parse_mf4(path)
except FileNotFoundError as e:
    logger.error("MF4 file not found: %s", path)
    raise
```

---

## 9. Defensive programming

Defensive programming means anticipating unexpected behaviour rather than suffering it. Each
component must be designed to work correctly even if its environment does not behave as expected.

### 9.1 Preconditions and assertions

Preconditions must be checked explicitly on entry. This documents the developer's assumptions
and protects against incorrect usage.

```python
def compute_lttb(series: pl.Series, n_points: int) -> pl.Series:
    if n_points < 2:
        raise ValueError(f"n_points must be >= 2, got {n_points}")
    if series.is_empty():
        raise ValueError("Input series must not be empty")
    if n_points >= len(series):
        return series
    ...
```

**`assert` is reserved for internal development invariants.** It must **never** be used to
validate external data or user input, because assertions can be disabled at runtime.

### 9.2 Explicit return values

A function must always return a consistent type. Implicitly returning `None` on some execution
paths and a value on others is forbidden. If the absence of a result is a valid case, it must be
modelled explicitly with `Optional` or a documented sentinel object.

```python
# Pas bueno
def find_signal(name: str, signals: list[str]) -> str:
    for s in signals:
        if s == name:
            return s

# Bueno
def find_signal(name: str, signals: list[str]) -> str | None:
    for s in signals:
        if s == name:
            return s
    return None
```

### 9.3 Fail fast, die young

Errors must be detected and surfaced as early as possible in the execution flow. A component
that fails silently and propagates a corrupt state is more dangerous than one that raises an
exception immediately.

```python
# No bueno: the error will surface much later in the pipeline
def load_file(path: str) -> pl.DataFrame:
    if not os.path.exists(path):
        return pl.DataFrame()

# Correct
def load_file(path: str) -> pl.DataFrame:
    if not os.path.exists(path):
        raise FileNotFoundError(f"File not found: {path}")
    ...
```

### 9.4 Robustness of external interfaces

Any call to an external dependency (file read, API call, database access) must be wrapped with
explicit error handling. Assuming an external dependency always behaves as expected is a
recurring source of production incidents.

```python
def fetch_signal_metadata(signal_id: str) -> dict:
    try:
        response = requests.get(f"{API_BASE}/signals/{signal_id}", timeout=5)
        response.raise_for_status()
        return response.json()
    except requests.Timeout:
        logger.error("Signal metadata fetch timed out for id=%s", signal_id)
        raise
    except requests.HTTPError as e:
        logger.error("HTTP error fetching signal %s: %s", signal_id, e)
        raise
```

---

## 10. Versioning

- **GitLab is mandatory** for all development.
- Commit messages follow the **Conventional Commits** convention:
  `type: description` (e.g. `feat: ajout du lazy loader MF4`).
- **Each feature or fix must have a dedicated branch** to preserve the integrity of the main
  branch.

---

## Summary checklist

- [ ] PEP 8, formatted with Black, max line length **120**.
- [ ] **PEP 484** type hints on every function/method; `mypy` clean before commit.
- [ ] **Google Style Docstrings**, in English.
- [ ] Naming conventions respected; no single-letter names.
- [ ] Single Responsibility + DRY; functions **≤ 40 lines**.
- [ ] **Polars** over Pandas; `LazyFrame` when needed; no full load > 100 MB without streaming.
- [ ] Profile before optimising.
- [ ] **No `eval` / `exec`**; no secrets in source; typed exceptions with re-raise.
- [ ] Explicit preconditions (`raise`, not `assert` for external data); explicit return types;
      fail fast; wrap external calls.
- [ ] Dedicated branch per change; Conventional Commit messages.
