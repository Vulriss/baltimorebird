"""Screen-space point selection for the first EDA view.

Server twin of ``src/frontend/src/eda/screen-decimation.js``: the leaves of the selection tree
are the pixel columns of the plot over the requested window, with a balanced binary tree above
them. Every node renders as the M4 of its range (first, argmin, argmax, last), so the envelope
stays exact whatever the selection. A node is scored by its pixel error (per column, the
symmetric difference between the rows its samples cover and the rows its M4 polyline covers);
the node with the largest error per added point is split first, and a node with zero error is
never split.

The client recomputes the selection from the full resolution data once it arrives. Both sides
run the same arithmetic in the same order on float32 values, with the same tie rule (earliest
index) and the same heap, so the first view and the later client renders select the same
points and the plot does not change when the full data lands. ``test_screen_decimation.py`` and
``test/screen-decimation-parity.test.js`` check both against the same reference cases.

Compiled with Numba when available; the same functions run as plain Python otherwise.
"""

from __future__ import annotations

import logging
import math
from typing import Callable, List, Optional, Sequence

import numpy as np
from numpy.typing import NDArray

logger = logging.getLogger(__name__)

# Plot height assumed when a request does not give one, same as DEFAULT_PLOT_HEIGHT_PX on the
# client (data-views.js). The height only sets how finely pixel errors are ranked.
DEFAULT_VIEW_HEIGHT = 400
MIN_VIEW_HEIGHT = 16
MAX_VIEW_HEIGHT = 8192

try:
    from numba import njit

    NUMBA_AVAILABLE = True
except ImportError:  # pragma: no cover - exercised only without numba
    NUMBA_AVAILABLE = False

    def njit(*args, **kwargs):  # type: ignore[no-redef]
        """Identity decorator used when Numba is not installed."""
        def wrap(func: Callable) -> Callable:
            return func
        return wrap


@njit(cache=True)
def _lower_bound(timestamps, t, lo, hi):
    while lo < hi:
        mid = (lo + hi) >> 1
        if timestamps[mid] < t:
            lo = mid + 1
        else:
            hi = mid
    return lo


@njit(cache=True)
def _row_of(v, y_min, row_scale, height):
    r = (v - y_min) * row_scale
    if not r > 0:
        return 0.0
    return r if r < height - 1 else float(height - 1)


@njit(cache=True)
def _node_knots(n, leaf_lo, leaf_hi, node_a, node_b, node_min, node_max, knots):
    first = leaf_lo[node_a[n]]
    last = leaf_hi[node_b[n] - 1] - 1
    a = min(node_min[n], node_max[n])
    b = max(node_min[n], node_max[n])
    k = 0
    knots[k] = first
    k += 1
    if first < a < last:
        knots[k] = a
        k += 1
    if first < b < last and b != a:
        knots[k] = b
        k += 1
    if last != first:
        knots[k] = last
        k += 1
    return k


@njit(cache=True)
def _segment_at(knot_x, knot_y, seg, x):
    x0 = knot_x[seg]
    x1 = knot_x[seg + 1]
    if not x1 > x0:
        return knot_y[seg + 1]
    f = (x - x0) / (x1 - x0)
    if f < 0:
        f = 0.0
    elif f > 1:
        f = 1.0
    return knot_y[seg] + (knot_y[seg + 1] - knot_y[seg]) * f


@njit(cache=True)
def _node_error(n, timestamps, values, t_min, x_scale, y_min, row_scale, height, leaf_lo, leaf_hi,
                leaf_col, true_lo, true_hi, node_a, node_b, node_min, node_max, knots, knot_x, knot_y):
    k = _node_knots(n, leaf_lo, leaf_hi, node_a, node_b, node_min, node_max, knots)
    for j in range(k):
        knot_x[j] = (timestamps[knots[j]] - t_min) * x_scale
        knot_y[j] = _row_of(float(values[knots[j]]), y_min, row_scale, height)
    x_first = knot_x[0]
    x_last = knot_x[k - 1]

    # Columns, and the points evaluated inside a column, come in increasing x: the segment
    # cursor only moves forward. An internal node has at least two knots.
    seg = 0
    err = 0.0
    for leaf in range(node_a[n], node_b[n]):
        c = leaf_col[leaf]
        tl = true_lo[leaf]
        th = true_hi[leaf]
        xa = float(c) if c > x_first else x_first
        xb = float(c + 1) if c + 1 < x_last else x_last
        if xb < xa:
            err += th - tl + 1
            continue
        while seg < k - 2 and knot_x[seg + 1] < xa:
            seg += 1
        lo = _segment_at(knot_x, knot_y, seg, xa)
        hi = lo
        j = seg + 1
        while j < k and knot_x[j] < xb:
            if knot_x[j] > xa:
                if knot_y[j] < lo:
                    lo = knot_y[j]
                if knot_y[j] > hi:
                    hi = knot_y[j]
            j += 1
        while seg < k - 2 and knot_x[seg + 1] < xb:
            seg += 1
        yb = _segment_at(knot_x, knot_y, seg, xb)
        if yb < lo:
            lo = yb
        if yb > hi:
            hi = yb
        al = math.floor(lo)
        ah = math.floor(hi)
        inter = max(0, min(th, ah) - max(tl, al) + 1)
        err += (th - tl + 1) + (ah - al + 1) - 2 * inter
    return err


@njit(cache=True)
def _heap_push(keys, ids, size, key, node):
    i = size
    while i > 0:
        parent = (i - 1) >> 1
        if keys[parent] >= key:
            break
        keys[i] = keys[parent]
        ids[i] = ids[parent]
        i = parent
    keys[i] = key
    ids[i] = node
    return size + 1


@njit(cache=True)
def _heap_pop(keys, ids, size):
    top = ids[0]
    size -= 1
    if size > 0:
        key = keys[size]
        node = ids[size]
        i = 0
        while True:
            child = 2 * i + 1
            if child >= size:
                break
            if child + 1 < size and keys[child + 1] > keys[child]:
                child += 1
            if keys[child] <= key:
                break
            keys[i] = keys[child]
            ids[i] = ids[child]
            i = child
        keys[i] = key
        ids[i] = node
    return top, size


@njit(cache=True)
def _select(timestamps, values, start_idx, end_idx, t_min, t_max, cols, height, budget):
    cols = max(1, cols)
    height = max(1, height)
    span = t_max - t_min
    end = end_idx + 1
    x_scale = cols / span if span > 0 else 0.0

    # Leaves: non empty pixel columns. Left to right scan with strict comparisons, so the
    # earliest index wins on ties, as on the client.
    leaf_lo = np.empty(cols, dtype=np.int64)
    leaf_hi = np.empty(cols, dtype=np.int64)
    leaf_min = np.empty(cols, dtype=np.int64)
    leaf_max = np.empty(cols, dtype=np.int64)
    leaf_col = np.empty(cols, dtype=np.int64)
    leaves = 0
    lo = start_idx
    for c in range(cols):
        if lo >= end:
            break
        if c == cols - 1:
            hi = end
        else:
            hi = _lower_bound(timestamps, t_min + (span * (c + 1)) / cols, lo, end)
        if hi <= lo:
            continue
        i_min = lo
        i_max = lo
        v_min = values[lo]
        v_max = v_min
        for i in range(lo + 1, hi):
            v = values[i]
            if v < v_min:
                v_min = v
                i_min = i
            if v > v_max:
                v_max = v
                i_max = i
        leaf_lo[leaves] = lo
        leaf_hi[leaves] = hi
        leaf_min[leaves] = i_min
        leaf_max[leaves] = i_max
        leaf_col[leaves] = c
        leaves += 1
        lo = hi

    out = np.empty(max(1, budget + 4), dtype=np.int64)
    if leaves == 0:
        return out[:0]

    y_min = math.inf
    y_max = -math.inf
    for k in range(leaves):
        if values[leaf_min[k]] < y_min:
            y_min = float(values[leaf_min[k]])
        if values[leaf_max[k]] > y_max:
            y_max = float(values[leaf_max[k]])
    row_scale = height / (y_max - y_min) if y_max > y_min else 0.0

    true_lo = np.empty(leaves, dtype=np.int64)
    true_hi = np.empty(leaves, dtype=np.int64)
    for k in range(leaves):
        true_lo[k] = math.floor(_row_of(float(values[leaf_min[k]]), y_min, row_scale, height))
        true_hi[k] = math.floor(_row_of(float(values[leaf_max[k]]), y_min, row_scale, height))

    # Balanced binary tree with the client's shape (mid = (a + b) >> 1). Ids are given in
    # preorder, so every child has a larger id than its parent and the extrema can be merged
    # by walking the ids backwards. Ids never reach the output.
    capacity = 2 * leaves - 1
    node_a = np.empty(capacity, dtype=np.int64)
    node_b = np.empty(capacity, dtype=np.int64)
    left = np.full(capacity, -1, dtype=np.int64)
    right = np.full(capacity, -1, dtype=np.int64)
    node_min = np.empty(capacity, dtype=np.int64)
    node_max = np.empty(capacity, dtype=np.int64)
    node_err = np.full(capacity, np.nan)
    stack = np.empty(capacity, dtype=np.int64)
    node_a[0] = 0
    node_b[0] = leaves
    count = 1
    top = 0
    stack[0] = 0
    while top >= 0:
        n = stack[top]
        top -= 1
        a = node_a[n]
        b = node_b[n]
        if b - a == 1:
            node_min[n] = leaf_min[a]
            node_max[n] = leaf_max[a]
            node_err[n] = 0.0
            continue
        mid = (a + b) >> 1
        left[n] = count
        right[n] = count + 1
        node_a[count] = a
        node_b[count] = mid
        node_a[count + 1] = mid
        node_b[count + 1] = b
        count += 2
        top += 1
        stack[top] = right[n]
        top += 1
        stack[top] = left[n]
    for n in range(capacity - 1, -1, -1):
        if left[n] < 0:
            continue
        lm, rm = node_min[left[n]], node_min[right[n]]
        node_min[n] = rm if values[rm] < values[lm] else lm
        lx, rx = node_max[left[n]], node_max[right[n]]
        node_max[n] = rx if values[rx] > values[lx] else lx

    # Refinement: largest pixel error per added point first, zero error nodes never split.
    knots = np.empty(4, dtype=np.int64)
    knot_x = np.empty(4)
    knot_y = np.empty(4)
    keys = np.empty(capacity)
    ids = np.empty(capacity, dtype=np.int64)
    size = 0
    split = np.zeros(capacity, dtype=np.uint8)

    used = _node_knots(0, leaf_lo, leaf_hi, node_a, node_b, node_min, node_max, knots)
    pending = np.empty(2, dtype=np.int64)
    pending[0] = 0
    n_pending = 1
    while True:
        for p in range(n_pending):
            n = pending[p]
            if left[n] < 0:
                continue
            if math.isnan(node_err[n]):
                node_err[n] = _node_error(n, timestamps, values, t_min, x_scale, y_min, row_scale, height,
                                          leaf_lo, leaf_hi, leaf_col, true_lo, true_hi, node_a, node_b,
                                          node_min, node_max, knots, knot_x, knot_y)
            if node_err[n] > 0:
                cost = max(1, _node_knots(left[n], leaf_lo, leaf_hi, node_a, node_b, node_min, node_max, knots)
                           + _node_knots(right[n], leaf_lo, leaf_hi, node_a, node_b, node_min, node_max, knots)
                           - _node_knots(n, leaf_lo, leaf_hi, node_a, node_b, node_min, node_max, knots))
                size = _heap_push(keys, ids, size, node_err[n] / cost, n)
        n_pending = 0
        if size == 0:
            break
        n, size = _heap_pop(keys, ids, size)
        delta = max(1, _node_knots(left[n], leaf_lo, leaf_hi, node_a, node_b, node_min, node_max, knots)
                    + _node_knots(right[n], leaf_lo, leaf_hi, node_a, node_b, node_min, node_max, knots)
                    - _node_knots(n, leaf_lo, leaf_hi, node_a, node_b, node_min, node_max, knots))
        if used + delta > budget:
            continue
        split[n] = 1
        used += delta
        pending[0] = left[n]
        pending[1] = right[n]
        n_pending = 2

    # Frontier in order: depth first, left before right. Each unsplit node emits its M4
    # indices, sorted and deduplicated against the previous node's last index.
    m = 0
    top = 0
    stack[0] = 0
    while top >= 0:
        n = stack[top]
        top -= 1
        if split[n]:
            top += 1
            stack[top] = right[n]
            top += 1
            stack[top] = left[n]
            continue
        first = leaf_lo[node_a[n]]
        last = leaf_hi[node_b[n] - 1] - 1
        a = min(node_min[n], node_max[n])
        b = max(node_min[n], node_max[n])
        if m == 0 or out[m - 1] != first:
            out[m] = first
            m += 1
        if first < a < last:
            out[m] = a
            m += 1
        if first < b < last and b != a:
            out[m] = b
            m += 1
        if last != first:
            out[m] = last
            m += 1
    return out[:m]


def screen_select(
    timestamps: NDArray[np.float64],
    values: NDArray,
    start_idx: int,
    end_idx: int,
    t_min: float,
    t_max: float,
    cols: int,
    height: int,
    budget: int,
) -> Optional[NDArray[np.int64]]:
    """Select the raw indices to render for the window [start_idx, end_idx].

    Args:
        timestamps: Sorted float64 timestamps of the signal.
        values: Values of the signal, same length; ranked as float32, as the client receives them.
        start_idx: First raw index of the window, inclusive (one sample before the view).
        end_idx: Last raw index of the window, inclusive (one sample after the view).
        t_min: Time at the left edge of the plot (the requested view start).
        t_max: Time at the right edge of the plot (the requested view end).
        cols: Pixel columns of the plot, the ``max_points`` of the request.
        height: Plot height in physical pixels.
        budget: Maximum number of points to return.

    Returns:
        Strictly increasing raw indices (at most ``budget``), or None when the window already
        fits the budget and should be returned as is.
    """
    if end_idx - start_idx + 1 <= budget:
        return None
    window = np.ascontiguousarray(values[start_idx:end_idx + 1], dtype=np.float32)
    selected = _select(
        np.ascontiguousarray(timestamps[start_idx:end_idx + 1], dtype=np.float64), window,
        0, end_idx - start_idx, float(t_min), float(t_max), int(cols), int(height), int(budget),
    )
    return selected + start_idx


def same_raster(a: NDArray[np.float64], b: NDArray[np.float64]) -> bool:
    """Same heuristic as ``sameRaster`` on the client: length and three witness samples.

    Args:
        a: Timestamps of the first signal.
        b: Timestamps of the second signal.

    Returns:
        True when both signals are taken to share one time base.
    """
    n = len(a)
    if len(b) != n or n == 0:
        return False
    mid = n >> 1
    return bool(a[0] == b[0] and a[n - 1] == b[n - 1] and a[mid] == b[mid])


def group_by_raster(timestamps: Sequence[NDArray[np.float64]]) -> List[List[int]]:
    """Group signal positions by shared time base, in first appearance order (client order).

    Args:
        timestamps: Full timestamps of each signal of the request.

    Returns:
        Lists of positions into ``timestamps``, one list per time base.
    """
    groups: List[List[int]] = []
    for pos, ts in enumerate(timestamps):
        for group in groups:
            if same_raster(timestamps[group[0]], ts):
                group.append(pos)
                break
        else:
            groups.append([pos])
    return groups


def warmup() -> None:
    """Compile the Numba kernels on a tiny signal, so the first real view does not pay it."""
    t = np.linspace(0.0, 1.0, 256)
    v = np.sin(t * 40.0).astype(np.float32)
    try:
        screen_select(t, v, 0, len(t) - 1, 0.0, 1.0, 16, 16, 32)
    except Exception:  # pragma: no cover - warmup must never break startup
        logger.warning("screen_decimation warmup failed", exc_info=True)
