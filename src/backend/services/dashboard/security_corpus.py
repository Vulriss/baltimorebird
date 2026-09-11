"""Baltimore Bird - Escape corpus for PoC sandbox regression coverage.

Each case models a hostile Python snippet that must either be rejected by the static
analyser before execution or be contained by the isolated runner (EXIT-05).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Literal, Sequence

from services.sandbox import check_code_safety, safe_execute

ExpectedOutcome = Literal["rejected_static", "contained_runtime"]


@dataclass(frozen=True)
class EscapeCase:
    """One hostile-code regression case."""

    case_id: str
    title: str
    code: str
    expected: ExpectedOutcome
    rationale: str


def get_escape_corpus() -> Sequence[EscapeCase]:
    """Return the PoC escape corpus executed for EXIT-05 evidence."""
    return (
        EscapeCase(
            case_id="SEC-ESC-01",
            title="Filesystem write attempt",
            code="with open('owned.txt', 'w') as handle:\n    handle.write('x')",
            expected="rejected_static",
            rationale="The AST allowlist must reject filesystem APIs before execution.",
        ),
        EscapeCase(
            case_id="SEC-ESC-02",
            title="Process spawn attempt",
            code="import os\nos.system('whoami')",
            expected="rejected_static",
            rationale="Process-launching APIs are forbidden by import and attribute checks.",
        ),
        EscapeCase(
            case_id="SEC-ESC-03",
            title="Builtins escape attempt",
            code="print(globals())",
            expected="rejected_static",
            rationale="Introspection helpers exposing globals must be refused statically.",
        ),
        EscapeCase(
            case_id="SEC-ESC-04",
            title="Dunder traversal attempt",
            code="(1).__class__.__mro__",
            expected="rejected_static",
            rationale="Dunder attribute traversal must be blocked by the AST validator.",
        ),
        EscapeCase(
            case_id="SEC-ESC-05",
            title="Infinite loop",
            code="while True:\n    pass",
            expected="contained_runtime",
            rationale="The isolated runner must terminate non-cooperative code on timeout.",
        ),
    )


def evaluate_escape_corpus() -> List[Dict[str, str | bool]]:
    """Execute the escape corpus and classify each outcome.

    Returns:
        One result dictionary per case with the observed enforcement status and details.
    """
    results: List[Dict[str, str | bool]] = []
    for case in get_escape_corpus():
        safety = check_code_safety(case.code)
        observed = "rejected_static"
        details = "; ".join(safety["errors"]) if safety["errors"] else "accepted by static analyser"
        if safety["safe"]:
            runtime = safe_execute(case.code, timeout_seconds=1, max_memory_mb=64)
            observed = "contained_runtime" if not runtime.success else "executed"
            details = runtime.error or runtime.output or "runner completed successfully"
        results.append(
            {
                "case_id": case.case_id,
                "title": case.title,
                "expected": case.expected,
                "observed": observed,
                "details": str(details),
                "passed": observed == case.expected,
            }
        )
    return results