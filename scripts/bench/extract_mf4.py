#!/usr/bin/env python3
"""Extract MF4 channels into raw arrays for the frontend decimation bench.

Each file contributes its first channel group: one float64 time base and one float32 array
per numeric channel, plus an entry in ``manifest.json``. The frontend bench
(``src/frontend/test/bench/screen-decimation-real.test.js``) reads this directory when
``BB_BENCH_DIR`` points to it. The output contains measurement data and must stay out of
the repository.

Usage:
    python scripts/bench/extract_mf4.py OUT_DIR FILE.mf4 [FILE.mf4 ...]
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path
from typing import Any, Dict, List

import numpy as np
from asammdf import MDF

logger = logging.getLogger("extract_mf4")


def extract_file(path: Path, out_dir: Path) -> Dict[str, Any]:
    """Write the time base and numeric channels of the first group of one MF4 file.

    Args:
        path: The MF4 file to read.
        out_dir: Directory receiving ``<key>.t.f64`` and ``<key>.<i>.f32`` files.

    Returns:
        The manifest entry: key, sample count, time span and channel descriptors.
    """
    key = path.stem
    mdf = MDF(str(path))
    group = mdf.groups[0]
    timestamps = None
    channels: List[Dict[str, Any]] = []
    for index, channel in enumerate(group.channels):
        if channel.channel_type == 2:  # master channel, read through the samples below
            continue
        signal = mdf.get(group=0, index=index, raw=False)
        samples = np.asarray(signal.samples)
        if samples.dtype.kind not in "fiub":
            logger.info("%s: non numeric channel %s skipped", key, channel.name)
            continue
        if timestamps is None:
            timestamps = np.asarray(signal.timestamps, dtype=np.float64)
            timestamps.tofile(out_dir / f"{key}.t.f64")
        file_name = f"{key}.{len(channels)}.f32"
        samples.astype(np.float32).tofile(out_dir / file_name)
        channels.append({"name": channel.name, "unit": signal.unit, "file": file_name})
    if timestamps is None:
        raise ValueError(f"{path}: no numeric channel in the first group")
    logger.info("%s: %d samples, %d channels", key, len(timestamps), len(channels))
    return {
        "key": key,
        "n": int(len(timestamps)),
        "tMin": float(timestamps[0]),
        "tMax": float(timestamps[-1]),
        "channels": channels,
    }


def main(argv: List[str]) -> int:
    """Extract every file given on the command line and write the manifest.

    Args:
        argv: Command line arguments, without the program name.

    Returns:
        The process exit code.
    """
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("out_dir", type=Path)
    parser.add_argument("files", type=Path, nargs="+")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")

    args.out_dir.mkdir(parents=True, exist_ok=True)
    manifest = [extract_file(path, args.out_dir) for path in args.files]
    (args.out_dir / "manifest.json").write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    logger.info("manifest written to %s", args.out_dir / "manifest.json")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
