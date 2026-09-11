"""Baltimore Bird - Deterministic recipe compiler.

Transforms a validated dashboard recipe into a single, self-contained Python module. The
compiler is a pure function: no side effects, no I/O, and it never executes what it produces
(functional-specification.md, GEN-01..16).

The generated module:

- imports only ``numpy`` (runner allowlist) plus ``json`` for result serialisation;
- defines one helper function per block, referencing a shared runtime preamble;
- exposes a ``build_report()`` entry point returning an ordered document of artefacts;
- prints ``MODULE_RESULT_MARKER`` followed by the JSON document, so the confined runner (which
  cannot expose dunder globals) returns artefacts through captured standard output.

Compilation is deterministic: the same recipe yields byte-identical source, whose SHA-256 hash
is recorded for report provenance.
"""

from __future__ import annotations

import ast
import hashlib
import textwrap
from dataclasses import dataclass, field
from typing import Any, Dict, List, Tuple

from .blocks import (
    BLOCK_REGISTRY,
    RESERVED_PREFIX,
    BlockCode,
    EmitContext,
    sanitise_author,
    sanitise_inline_text,
    validate_block,
)

MODULE_RESULT_MARKER = "<<<BB_ARTEFACTS>>>"
_DECIMATION_MAX_POINTS = 5000

_RUNTIME_PREAMBLE = f'''# numpy and json are provided as globals by the confined runner. The guards below let the
# module also run standalone (python module.py) without weakening the runner (GEN-09, EXIT-03).
try:
    np
except NameError:  # pragma: no cover - standalone execution
    import numpy as np
try:
    json
except NameError:  # pragma: no cover - standalone execution
    import json

{RESERVED_PREFIX}max_points = {_DECIMATION_MAX_POINTS}


def {RESERVED_PREFIX}as_list(array: np.ndarray) -> list:
    return [float(value) for value in array]


def {RESERVED_PREFIX}decimate(x_values: np.ndarray, y_values: np.ndarray, max_points: int) -> tuple:
    count = len(x_values)
    if count <= max_points:
        return x_values, y_values, 1
    step = int(np.ceil(count / max_points))
    return x_values[::step], y_values[::step], step


def {RESERVED_PREFIX}build_lineplot(data: dict, x: str, y: str, title: str, color: str, unit: str) -> dict:
    if x not in data:
        raise ValueError("line plot: unknown x column '" + str(x) + "'")
    if y not in data:
        raise ValueError("line plot: unknown y signal '" + str(y) + "'")
    x_array = np.asarray(data[x])
    y_array = np.asarray(data[y])
    if x_array.size == 0:
        raise ValueError("line plot: empty input for signal '" + str(y) + "'")
    x_array, y_array, ratio = {RESERVED_PREFIX}decimate(x_array, y_array, {RESERVED_PREFIX}max_points)
    trace = {{"type": "scatter", "mode": "lines", "name": y,
             "x": {RESERVED_PREFIX}as_list(x_array), "y": {RESERVED_PREFIX}as_list(y_array)}}
    if color:
        trace["line"] = {{"color": color}}
    y_title = (str(y) + " [" + str(unit) + "]") if unit else str(y)
    layout = {{"title": {{"text": title or str(y)}},
              "xaxis": {{"title": {{"text": "time [s]"}}}},
              "yaxis": {{"title": {{"text": y_title}}}}}}
    return {{"data": [trace], "layout": layout, "meta": {{"decimation_ratio": ratio}}}}


def {RESERVED_PREFIX}build_table(data: dict, caption: str, max_rows: int) -> dict:
    columns = list(data.keys())
    if not columns:
        return {{"columns": [], "rows": [], "caption": caption, "truncated": False, "total_rows": 0}}
    arrays = {{name: np.asarray(data[name]) for name in columns}}
    total_rows = min(int(arrays[name].shape[0]) for name in columns)
    limit = min(total_rows, max_rows)
    rows = [[float(arrays[name][index]) for name in columns] for index in range(limit)]
    return {{"columns": columns, "rows": rows, "caption": caption,
            "truncated": total_rows > max_rows, "total_rows": total_rows}}


# Failures are caught by explicit type at the block boundary, never by a bare ``except`` (DEF-03).
# Anything outside this tuple is a defect of the generated module itself, not of the recipe.
{RESERVED_PREFIX}block_errors = (
    ArithmeticError,
    AssertionError,
    AttributeError,
    LookupError,
    MemoryError,
    NotImplementedError,
    RecursionError,
    RuntimeError,
    StopIteration,
    TypeError,
    ValueError,
)


try:
    {RESERVED_PREFIX}BlockFailure
except NameError:  # pragma: no cover - standalone execution

    class {RESERVED_PREFIX}BlockFailure(Exception):
        """A failure attributed to one recipe block (DEF-01, DEF-03, DEF-12).

        Raised at a block boundary with the block context attached, and reported by the entry
        point; it never carries a filesystem path nor a platform stack frame. The confined runner
        provides this type, so the definition below only serves standalone execution.
        """

        block_id = ""
        block_type = ""
        kind = "error"
        message = ""


def {RESERVED_PREFIX}failure(block_id: str, block_type: str, kind: str, message: str) -> Exception:
    """Build a block failure. Attributes are set here rather than in ``__init__``, which the
    confined runner forbids (dunder access)."""
    failure = {RESERVED_PREFIX}BlockFailure(message)
    failure.block_id = block_id
    failure.block_type = block_type
    failure.kind = kind
    failure.message = message
    return failure


def {RESERVED_PREFIX}format_metric(value) -> str:
    if isinstance(value, bool):
        return str(value)
    if isinstance(value, float):
        return f"{{value:.4g}}"
    return str(value)


def {RESERVED_PREFIX}validate_figure(spec: dict) -> dict:
    if not isinstance(spec, dict) or "data" not in spec or "layout" not in spec:
        raise ValueError("a figure block must return a Plotly figure specification (dict with 'data'/'layout')")
    return spec


def {RESERVED_PREFIX}validate_table(spec: dict) -> dict:
    if not isinstance(spec, dict) or "columns" not in spec or "rows" not in spec:
        raise ValueError("a table block must return a table specification (dict with 'columns'/'rows')")
    return spec
'''


@dataclass
class CompiledModule:
    """Result of compiling a recipe.

    Attributes:
        source: The complete, deterministic Python module source.
        provenance_hash: SHA-256 hash of the module body (excluding the header docstring).
        result_marker: Sentinel printed before the JSON artefacts on standard output.
    """

    source: str
    provenance_hash: str
    result_marker: str = MODULE_RESULT_MARKER


@dataclass
class _Plan:
    sources: List[Dict[str, Any]] = field(default_factory=list)
    ordered: List[Dict[str, Any]] = field(default_factory=list)


def _flatten(blocks: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Return blocks in document order, descending into ``children`` containers."""
    flat: List[Dict[str, Any]] = []
    for block in blocks:
        if isinstance(block, dict):
            flat.append(block)
            children = block.get("children")
            if isinstance(children, list):
                flat.extend(_flatten(children))
    return flat


def validate_recipe(recipe: Dict[str, Any]) -> List[Dict[str, str]]:
    """Statically validate a recipe in a single pass (GRF-04).

    Args:
        recipe: The recipe document with a ``blocks`` list.

    Returns:
        A list of ``{"block_id", "message"}`` errors; empty if the recipe is valid.
    """
    errors: List[Dict[str, str]] = []
    blocks = _flatten(recipe.get("blocks", []) or [])

    source_names: Dict[str, int] = {}
    for block in blocks:
        block_id = str(block.get("id", "?"))
        for message in validate_block(block):
            errors.append({"block_id": block_id, "message": message})
        if block.get("type") == "synthetic_source":
            name = str(block.get("config", {}).get("name", "")).strip()
            if name:
                source_names[name] = source_names.get(name, 0) + 1

    for name, occurrences in source_names.items():
        if occurrences > 1:
            errors.append({"block_id": name, "message": f"duplicate data source name {name!r}"})

    # An unknown/absent `source` name or unmapped `python` input is no longer a whole-recipe
    # error: it is resolved at runtime, inside the referencing block's own containment
    # boundary (DEF-11) - see EmitContext.resolve_source and _emit_python.
    return errors


def _build_context(sources: List[Dict[str, Any]], recipe: Dict[str, Any]) -> EmitContext:
    """Map each source name to the expressions consumers use to read it and to test it.

    Frames live in the ``state`` dict threaded through every generated block function, so a
    consumer reads ``state['df']`` and a dependant is skipped while ``'df'`` is absent from it.
    """
    settings = recipe.get("settings", {}) if isinstance(recipe.get("settings"), dict) else {}
    ctx = EmitContext(author=sanitise_author(settings.get("author", "")))
    for index, block in enumerate(sources):
        name = str(block.get("config", {}).get("name", "")).strip() or f"source_{index}"
        var_name = f"state[{name!r}]"
        ctx.source_vars_by_name[name] = var_name
        if ctx.default_source_var is None:
            ctx.default_source_var = var_name
            ctx.default_source_name = name
    return ctx


def compile_recipe(recipe: Dict[str, Any]) -> CompiledModule:
    """Compile a validated recipe into a deterministic Python module.

    Args:
        recipe: A recipe document with ``blocks`` and optional ``settings``.

    Returns:
        The :class:`CompiledModule` with source and provenance hash.

    Raises:
        ValueError: If the recipe is statically invalid.
    """
    errors = validate_recipe(recipe)
    if errors:
        summary = "; ".join(f"{err['block_id']}: {err['message']}" for err in errors)
        raise ValueError(f"invalid recipe: {summary}")

    blocks = _flatten(recipe.get("blocks", []) or [])
    sources = [block for block in blocks if block.get("type") == "synthetic_source"]
    consumers = [block for block in blocks if block.get("type") != "synthetic_source"]
    ctx = _build_context(sources, recipe)

    helpers: List[str] = []
    seen_helpers: set = set()
    source_blocks: List[_EmittedBlock] = []
    consumer_blocks: List[_EmittedBlock] = []

    for block in sources:
        code = BLOCK_REGISTRY[block["type"]].emit(block, ctx)
        _collect_helpers(code.helpers, helpers, seen_helpers)
        source_blocks.append(_emitted_block(block, code, ctx))

    for block in consumers:
        code = BLOCK_REGISTRY[block["type"]].emit(block, ctx)
        _collect_helpers(code.helpers, helpers, seen_helpers)
        consumer_blocks.append(_emitted_block(block, code, ctx))

    body_source = _assemble_body(helpers, source_blocks + consumer_blocks)
    provenance_hash = hashlib.sha256(body_source.encode("utf-8")).hexdigest()
    header = _render_header(recipe, provenance_hash)
    return CompiledModule(source=header + body_source, provenance_hash=provenance_hash)


def _collect_helpers(new_helpers: List[str], helpers: List[str], seen: set) -> None:
    for helper in new_helpers:
        if helper not in seen:
            seen.add(helper)
            helpers.append(helper)


@dataclass(frozen=True)
class _EmittedBlock:
    """One block, ready to be rendered as its own function in the generated module.

    Attributes:
        block_id: Recipe identifier of the block.
        block_type: Registered block type, reported alongside runtime failures.
        fn_name: Name of the generated function that runs this block.
        statements: Statements produced by the block's emitter.
        depends_on: Names of the sources guarding the statements.
    """

    block_id: str
    block_type: str
    fn_name: str
    statements: List[str]
    depends_on: Tuple[str, ...]


def _emitted_block(block: Dict[str, Any], code: BlockCode, ctx: EmitContext) -> _EmittedBlock:
    """Pair one block's emitted code with the name of the function that will carry it."""
    block_id = str(block["id"])
    return _EmittedBlock(
        block_id=block_id,
        block_type=str(block["type"]),
        fn_name=f"{RESERVED_PREFIX}block_{ctx.slug(block_id)}",
        statements=code.body,
        depends_on=code.depends_on,
    )


def _assemble_body(helpers: List[str], blocks: List[_EmittedBlock]) -> str:
    """Render the module body: preamble, helpers, one function per block, then the entry point.

    Each block gets its own function rather than being inlined, so ``build_report`` stays a short
    loop over an explicit, ordered step list whatever the recipe size (MINT coding standard).
    """
    parts: List[str] = [_RUNTIME_PREAMBLE, ""]
    for helper in helpers:
        parts.append(helper)
        parts.append("")
    for block in blocks:
        parts.append(_render_block_function(block))
        parts.append("")

    parts.append(_render_steps(blocks))
    parts.append("")
    parts.append(_ENTRY_POINT)
    parts.append("")
    parts.append(f"print({MODULE_RESULT_MARKER!r} + json.dumps(build_report()))")
    parts.append("")
    return "\n".join(parts)


def _render_block_function(block: _EmittedBlock) -> str:
    """Render the function that runs one block: dependency guard, then typed error boundary."""
    lines = [
        f"def {block.fn_name}(document: list, state: dict) -> None:",
        f'    """Run block {block.block_id!r} ({block.block_type})."""',
    ]
    lines.extend(_emit_dependency_guard(block, "    "))
    lines.append("    try:")
    for statement in block.statements:
        lines.extend(_indent_statement(statement, "        "))
    lines.append(f"    except {RESERVED_PREFIX}block_errors as exc:")
    # Only the message crosses back to the user: no type name, no path, no stack frame (DEF-12).
    lines.extend(_emit_raise_failure(block, "error", "str(exc)", "        "))
    lines.append("        ) from exc")
    return "\n".join(lines) + "\n"


def _emit_dependency_guard(block: _EmittedBlock, indent: str) -> List[str]:
    """Emit the precondition on the block's sources: absent source, block skipped (DEF-11, DEF-12)."""
    if not block.depends_on:
        return []
    names = ", ".join(repr(name) for name in block.depends_on) + ("," if len(block.depends_on) == 1 else "")
    message = f"'Skipped: dependency failed: ' + ', '.join({RESERVED_PREFIX}missing)"
    lines = [f"{indent}{RESERVED_PREFIX}missing = [name for name in ({names}) if name not in state]"]
    lines.append(f"{indent}if {RESERVED_PREFIX}missing:")
    lines.extend(_emit_raise_failure(block, "skipped", message, indent + "    "))
    lines.append(f"{indent}    )")
    return lines


def _emit_raise_failure(block: _EmittedBlock, kind: str, message_expr: str, indent: str) -> List[str]:
    """Emit an unterminated ``raise _bb_BlockFailure(...)`` call, one argument per line.

    The caller closes the call, so it can append ``) from exc`` where a cause is available.
    """
    return [
        f"{indent}raise {RESERVED_PREFIX}failure(",
        f"{indent}    {block.block_id!r},",
        f"{indent}    {block.block_type!r},",
        f"{indent}    {kind!r},",
        f"{indent}    {message_expr},",
    ]


def _render_steps(blocks: List[_EmittedBlock]) -> str:
    """Render the ordered step list build_report walks through (sources first, document order)."""
    if not blocks:
        return f"{RESERVED_PREFIX}steps = ()\n"
    lines = [f"{RESERVED_PREFIX}steps = ("]
    lines.extend(f"    {block.fn_name}," for block in blocks)
    lines.append(")")
    return "\n".join(lines) + "\n"


_ENTRY_POINT = (
    "def build_report() -> dict:\n"
    '    """Run every block in order and return the ordered artefact document.\n'
    "\n"
    "    A block failure is contained here, and only here: the block is reported in the document\n"
    "    and the following ones still run (DEF-11).\n"
    '    """\n'
    "    document = []\n"
    "    state = {}\n"
    f"    for step in {RESERVED_PREFIX}steps:\n"
    "        try:\n"
    "            step(document, state)\n"
    f"        except {RESERVED_PREFIX}BlockFailure as failure:\n"
    "            document.append(\n"
    "                {\n"
    '                    "block_id": failure.block_id,\n'
    '                    "block_type": failure.block_type,\n'
    '                    "kind": failure.kind,\n'
    '                    "message": failure.message,\n'
    "                }\n"
    "            )\n"
    '    return {"document": document}\n'
)


def _indent_statement(statement: str, prefix: str) -> List[str]:
    """Indent one generated statement, preserving explicit line breaks."""
    return [f"{prefix}{line}" if line else prefix.rstrip() for line in statement.splitlines()]


def _wrap_header_line(label: str, value: str, max_length: int = 120) -> List[str]:
    """Wrap one docstring header line so a long report title cannot overflow the line limit.

    Args:
        label: Prefix of the first line (e.g. ``"Report: "``).
        value: Author-supplied value, of unbounded length.
        max_length: Maximum accepted source line length.

    Returns:
        The rendered lines, continuation lines indented under the label.
    """
    indent = " " * len(label)
    wrapped = textwrap.wrap(
        value,
        width=max_length,
        initial_indent=label,
        subsequent_indent=indent,
        break_long_words=True,
        break_on_hyphens=False,
    )
    return wrapped or [label.rstrip()]


def _docstring_safe(text: str) -> str:
    """Return free text that cannot escape the module docstring it is inserted into.

    Title and author come from the recipe, so they are attacker-controlled: a quote run or a
    trailing backslash would end the docstring and turn the rest of the line into code.

    Args:
        text: Raw, single-line text (already collapsed by the caller).

    Returns:
        The same text with double quotes downgraded to single quotes and backslashes removed.
    """
    return text.replace('"', "'").replace("\\", "")


def _render_header(recipe: Dict[str, Any], provenance_hash: str) -> str:
    settings = recipe.get("settings", {}) if isinstance(recipe.get("settings"), dict) else {}
    title = sanitise_inline_text(settings.get("title", recipe.get("name", "Dashboard")))
    lines = [
        '"""Auto-generated Baltimore Bird dashboard module.',
        "",
        *_wrap_header_line("Report: ", _docstring_safe(title)),
        *_wrap_header_line("Author: ", _docstring_safe(sanitise_author(settings.get("author", "")))),
        f"Provenance (sha256 of module body): {provenance_hash}",
        f"Dependencies: {', '.join(module_dependencies())}",
        "",
        "This module is generated from a declarative recipe. It contains author-supplied Python",
        "regions delimited by markers and MUST be reviewed before being executed outside a confined",
        "environment.",
        '"""',
        "",
    ]
    return "\n".join(lines)


def module_dependencies() -> Tuple[str, ...]:
    """Return the import surface of generated modules (GEN-09).

    Names only, not version-pinned: pinning would require reading the backend's own
    ``requirements.txt`` at compile time, which is out of scope for the compiler (a pure
    function of the recipe, per this module's docstring).
    """
    return ("numpy",)


def validate_generated_module_source(source: str, max_line_length: int = 120) -> List[str]:
    """Validate the generated module against the PoC syntax and lint baseline.

    Args:
        source: Generated Python module source.
        max_line_length: Maximum accepted source line length.

    Returns:
        A list of validation errors. An empty list means the module is ready to show/export.
    """
    errors: List[str] = []
    try:
        ast.parse(source)
    except SyntaxError as exc:
        errors.append(f"syntax error line {exc.lineno}: {exc.msg}")
        return errors

    for index, line in enumerate(source.splitlines(), start=1):
        if len(line) > max_line_length:
            errors.append(f"line {index} exceeds {max_line_length} characters")
    return errors
