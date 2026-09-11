"""Tests for Ruff formatting of compiled Dashboard Builder modules.

Run from ``src/backend`` (``python -m pytest services/dashboard/test_formatting.py``).
"""

from __future__ import annotations

import ast
import subprocess
from unittest.mock import patch

from services.dashboard.compiler import CompiledModule
from services.dashboard.formatting import format_module

_UNFORMATTED_SOURCE = "def f( ):\n  x=1\n  return   x\n"


def _completed(returncode: int = 0, stdout: str = "", stderr: str = "") -> subprocess.CompletedProcess:
    return subprocess.CompletedProcess(args=[], returncode=returncode, stdout=stdout, stderr=stderr)


def test_format_module_success_reformats_and_preserves_metadata() -> None:
    module = CompiledModule(source=_UNFORMATTED_SOURCE, provenance_hash="abc123")

    result = format_module(module)

    assert result.warning is None
    assert result.provenance_hash == module.provenance_hash
    assert result.result_marker == module.result_marker
    assert result.source != module.source
    ast.parse(result.source)  # still valid Python


def test_format_module_falls_back_on_missing_interpreter() -> None:
    module = CompiledModule(source=_UNFORMATTED_SOURCE, provenance_hash="abc123")

    with patch("services.dashboard.formatting.subprocess.run", side_effect=FileNotFoundError()):
        result = format_module(module)

    assert result.source == module.source
    assert result.warning is not None


def test_format_module_falls_back_on_timeout() -> None:
    module = CompiledModule(source=_UNFORMATTED_SOURCE, provenance_hash="abc123")

    with patch(
        "services.dashboard.formatting.subprocess.run",
        side_effect=subprocess.TimeoutExpired(cmd="ruff", timeout=5),
    ):
        result = format_module(module)

    assert result.source == module.source
    assert result.warning is not None


def test_format_module_falls_back_on_nonzero_exit() -> None:
    module = CompiledModule(source=_UNFORMATTED_SOURCE, provenance_hash="abc123")

    with patch(
        "services.dashboard.formatting.subprocess.run",
        return_value=_completed(returncode=1, stderr="boom"),
    ):
        result = format_module(module)

    assert result.source == module.source
    assert result.warning is not None


def test_format_module_falls_back_on_empty_stdout() -> None:
    module = CompiledModule(source=_UNFORMATTED_SOURCE, provenance_hash="abc123")

    with patch(
        "services.dashboard.formatting.subprocess.run",
        return_value=_completed(returncode=0, stdout="   \n"),
    ):
        result = format_module(module)

    assert result.source == module.source
    assert result.warning is not None
