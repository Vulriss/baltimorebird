"""Baltimore Bird - Ruff formatting of compiled Dashboard Builder modules.

This is the only place in the compile pipeline that shells out to a subprocess.
``compiler.compile_recipe`` stays pure and I/O-free (see its module docstring); formatting is a
presentation-layer step applied once, here, and reused by every API route so the source shown to
the user and the source executed by the sandbox are always the same bytes (EXIT-03 auditability).

A Ruff failure of any kind (missing interpreter module, timeout, non-zero exit, empty output)
never blocks compilation or execution: it falls back to the original, already-valid generated
source and surfaces a French warning to the caller.
"""

from __future__ import annotations

import logging
import subprocess
import sys
from dataclasses import dataclass
from typing import Optional, Tuple

from .compiler import CompiledModule

logger = logging.getLogger(__name__)

RUFF_TIMEOUT_SECONDS = 5
RUFF_LINE_LENGTH = 120

_WARNING_UNAVAILABLE = "Mise en forme automatique du code indisponible : le code affiché n'est pas reformaté."
_WARNING_TIMEOUT = "Mise en forme automatique du code interrompue (délai dépassé) : le code affiché n'est pas reformaté."
_WARNING_FAILED = "Mise en forme automatique du code refusée : le code affiché n'est pas reformaté."


@dataclass(frozen=True)
class FormattedModule:
    """Result of attempting to Ruff-format a :class:`CompiledModule`.

    Attributes:
        source: Final source to show and execute — Ruff-formatted, or the original
            ``CompiledModule.source`` unchanged if formatting failed for any reason.
        provenance_hash: Passed through from the compiled module, unchanged.
        result_marker: Passed through from the compiled module, unchanged.
        warning: A French, non-blocking message if formatting fell back to the original
            source; ``None`` if formatting succeeded.
    """

    source: str
    provenance_hash: str
    result_marker: str
    warning: Optional[str] = None


def format_module(module: CompiledModule) -> FormattedModule:
    """Apply Ruff's formatter to a compiled module. Never raises, never blocks.

    Args:
        module: The output of ``compile_recipe``.

    Returns:
        A ``FormattedModule`` with Ruff-formatted source, or the original source and a French
        warning if Ruff was unavailable, timed out, or failed.
    """
    formatted_source, warning = _run_ruff_format(module.source)
    return FormattedModule(
        source=formatted_source if formatted_source is not None else module.source,
        provenance_hash=module.provenance_hash,
        result_marker=module.result_marker,
        warning=warning,
    )


def _run_ruff_format(source: str) -> Tuple[Optional[str], Optional[str]]:
    """Run ``ruff format`` on ``source`` via stdin/stdout.

    Returns:
        A tuple of (formatted source or ``None``, French warning or ``None``). Exactly one of
        the two elements is ``None``.
    """
    command = [
        sys.executable,
        "-m",
        "ruff",
        "format",
        "--isolated",
        "--line-length",
        str(RUFF_LINE_LENGTH),
        "-",
    ]
    try:
        completed = subprocess.run(
            command,
            input=source,
            capture_output=True,
            text=True,
            # Ruff lit et ecrit de l'UTF-8 : sans cela, Python encoderait stdin avec la locale
            # du systeme (cp1252 sous Windows) et le code accentue serait rejete.
            encoding="utf-8",
            timeout=RUFF_TIMEOUT_SECONDS,
            check=False,
        )
    except FileNotFoundError:
        logger.warning("Ruff introuvable (interpréteur manquant) ; code non reformaté.")
        return None, _WARNING_UNAVAILABLE
    except subprocess.TimeoutExpired:
        logger.warning("Ruff a dépassé %ss ; code non reformaté.", RUFF_TIMEOUT_SECONDS)
        return None, _WARNING_TIMEOUT
    except OSError as exc:
        logger.warning("Erreur inattendue en appelant Ruff : %s", exc)
        return None, _WARNING_UNAVAILABLE

    if completed.returncode != 0:
        logger.warning("Ruff a échoué (code %s) : %s", completed.returncode, completed.stderr.strip())
        return None, _WARNING_FAILED

    if not completed.stdout.strip():
        logger.warning("Ruff a retourné une sortie vide ; code non reformaté.")
        return None, _WARNING_UNAVAILABLE

    return completed.stdout, None
