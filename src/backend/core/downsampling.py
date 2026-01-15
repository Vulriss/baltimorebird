"""
Baltimore Bird - Algorithme LTTB (Largest Triangle Three Buckets).

Implementation optimisee du downsampling pour la visualisation de series temporelles.
Utilise Numba JIT si disponible (~345k points/ms), sinon fallback NumPy.
"""

import logging
from typing import Tuple

import numpy as np
from numpy.typing import NDArray

logger = logging.getLogger(__name__)


def _lttb_numpy(x: NDArray[np.float32], y: NDArray[np.float32], threshold: int) -> Tuple[NDArray[np.float32], NDArray[np.float32]]:
    """NumPy LTTB (fallback)."""
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
    def _lttb_numba(x: NDArray[np.float32], y: NDArray[np.float32], threshold: int) -> Tuple[NDArray[np.float32], NDArray[np.float32]]:
        """Numba JIT LTTB (fast as fuck)."""
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
                area = abs(
                    (point_ax - avg_x) * (y[j] - point_ay)
                    - (point_ax - x[j]) * (avg_y - point_ay)
                )
                if area > max_area:
                    max_area = area
                    max_area_point = j

            sampled_x[i] = x[max_area_point]
            sampled_y[i] = y[max_area_point]
            a = max_area_point

        return sampled_x, sampled_y

    def lttb_downsample(x: NDArray, y: NDArray, threshold: int) -> Tuple[NDArray[np.float32], NDArray[np.float32]]:
        """LTTB timeserie downsampling (Numba JIT)."""
        return _lttb_numba(
            np.ascontiguousarray(x, dtype=np.float32),
            np.ascontiguousarray(y, dtype=np.float32),
            threshold,
        )

    NUMBA_AVAILABLE = True
    logger.info("Numba JIT enabled for LTTB (f32)")

except ImportError:
    def lttb_downsample(x: NDArray, y: NDArray, threshold: int) -> Tuple[NDArray[np.float32], NDArray[np.float32]]:
        """LTTB timeserie downsampling (NumPy fallback)."""
        return _lttb_numpy(
            np.asarray(x, dtype=np.float32),
            np.asarray(y, dtype=np.float32),
            threshold,
        )

    NUMBA_AVAILABLE = False
    logger.warning("Numba not installed - fallback to NumPy LTTB (f32)")