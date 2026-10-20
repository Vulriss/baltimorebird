"""Tests of the binary envelope shared by /view and /raw (``_encode_signals_binary``).

Signals with identical timestamps carry ``ts_ref`` and send their values only: a group of
signals from one raster pays its timestamps once. Decoded here exactly as ``render.js`` does.
"""

import json
import struct

import numpy as np

from api.sources import _encode_signals_binary


def _decode(body: bytes) -> list[dict]:
    header_len = struct.unpack_from("<I", body, 0)[0]
    header = json.loads(body[4:4 + header_len].decode("utf-8"))
    offset = 4 + header_len
    for sig in header["signals"]:
        n = sig.pop("n")
        if "ts_ref" in sig:
            sig["timestamps"] = header["signals"][sig.pop("ts_ref")]["timestamps"]
        else:
            sig["timestamps"] = np.frombuffer(body, dtype="<f8", count=n, offset=offset)
            offset += 8 * n
        sig["values"] = np.frombuffer(body, dtype="<f4", count=n, offset=offset)
        offset += 4 * n
    assert offset == len(body)
    return header["signals"]


def _payload(signals: list[dict]) -> bytes:
    return _encode_signals_binary({}, signals).get_data()


def _blocks_size(body: bytes) -> int:
    return len(body) - 4 - struct.unpack_from("<I", body, 0)[0]


def test_signals_sharing_timestamps_send_them_once() -> None:
    t = np.linspace(0.0, 10.0, 1000)
    signals = [
        {"index": 0, "timestamps": t, "values": np.sin(t)},
        {"index": 1, "timestamps": t.copy(), "values": np.cos(t)},
        {"index": 2, "timestamps": t[::2], "values": t[::2]},
        {"index": 3, "timestamps": t, "values": -t},
    ]
    body = _payload(signals)
    decoded = _decode(body)
    header = json.loads(body[4:4 + struct.unpack_from("<I", body, 0)[0]])
    assert [s.get("ts_ref") for s in header["signals"]] == [None, 0, None, 0]
    for original, got in zip(signals, decoded):
        assert np.array_equal(got["timestamps"], original["timestamps"])
        assert np.array_equal(got["values"], original["values"].astype(np.float32))
    unshared = _payload([{**s, "timestamps": s["timestamps"] + i * 1e-9} for i, s in enumerate(signals)])
    assert _blocks_size(unshared) - _blocks_size(body) == 2 * 1000 * 8


def test_equal_length_but_different_timestamps_are_not_shared() -> None:
    t = np.arange(100, dtype=np.float64)
    shifted = t.copy()
    shifted[50] += 0.5  # differs on the middle witness: rejected by the raster heuristic
    other = t.copy()
    other[10] += 0.25  # same three witnesses, differs elsewhere: rejected by the exact comparison
    body = _payload([
        {"index": 0, "timestamps": t, "values": t},
        {"index": 1, "timestamps": shifted, "values": t},
        {"index": 2, "timestamps": other, "values": t},
    ])
    header = json.loads(body[4:4 + struct.unpack_from("<I", body, 0)[0]])
    assert all("ts_ref" not in s for s in header["signals"])
    decoded = _decode(body)
    assert np.array_equal(decoded[2]["timestamps"], other)


def test_timestamps_held_by_the_client_are_not_sent() -> None:
    t = np.arange(500, dtype=np.float64)
    body = _payload([
        {"index": 7, "timestamps": t, "values": t, "timestamps_from": 3},
        {"index": 8, "timestamps": t, "values": -t},
    ])
    header = json.loads(body[4:4 + struct.unpack_from("<I", body, 0)[0]])
    assert header["signals"][0]["timestamps_from"] == 3 and "ts_ref" not in header["signals"][1]
    assert _blocks_size(body) == 500 * 4 + 500 * (8 + 4)
