"""Baltimore Bird - Declarative block catalogue for the Dashboard Builder.

Each supported block type is described once, declaratively, by a :class:`BlockSpec`: its
configuration fields, a validator and a code emitter. Registering a new block type therefore
requires no change to the compiler or the executor (functional-specification.md, BLK-GEN-04).

Emitters return a :class:`BlockCode` fragment (module-level helper definitions plus statements
executed inside the generated ``build_report`` entry point). Shared runtime helpers (decimation,
output validation) are provided by the compiler preamble and referenced through the reserved
``_bb_`` prefix.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Tuple

from .synthetic import parse_source_config, render_synthetic_numpy

RESERVED_PREFIX = "_bb_"
MAX_TEXT_LENGTH = 20_000
_PYTHON_OUTPUTS = ("figure", "table")


@dataclass
class FieldSpec:
    """Declarative description of a single configuration field."""

    id: str
    label: str
    type: str
    required: bool = True
    default: Any = None


@dataclass
class BlockCode:
    """A fragment of generated code contributed by one block.

    Attributes:
        helpers: Module-level function definitions (deduplicated by the compiler).
        body: Statements executed inside ``build_report`` in document order.
        depends_on: Names of the sources that must be present in ``state`` at runtime before
            ``body`` is safe to run (empty for blocks with no source dependency).
    """

    helpers: List[str] = field(default_factory=list)
    body: List[str] = field(default_factory=list)
    depends_on: Tuple[str, ...] = ()


@dataclass
class SourceResolution:
    """Outcome of resolving a consumer block's ``source`` configuration.

    Either ``var_name``/``source_name`` are set (success), or ``error`` holds a ready-to-emit,
    user-facing message (unknown/absent source) - never both.
    """

    var_name: Optional[str] = None
    source_name: Optional[str] = None
    error: Optional[str] = None


@dataclass
class EmitContext:
    """Mutable state shared by block emitters during a single compilation."""

    default_source_var: Optional[str] = None
    default_source_name: Optional[str] = None
    source_vars_by_name: Dict[str, str] = field(default_factory=dict)
    author: str = ""

    def slug(self, block_id: str) -> str:
        """Return a deterministic identifier-safe slug for a block id."""
        cleaned = "".join(char if char.isalnum() else "_" for char in block_id)
        if not cleaned or cleaned[0].isdigit():
            cleaned = f"b_{cleaned}"
        return cleaned

    def resolve_source(self, config: Dict[str, Any]) -> SourceResolution:
        """Resolve the source a consumer block reads from.

        Args:
            config: The consumer block configuration (may hold a ``source`` name).

        Returns:
            A :class:`SourceResolution`: a resolved variable/flag/name on success, or a
            ready-to-emit error message when the name is unknown or no default source exists.
            No exception is raised here - resolution failures are reported at runtime, inside
            the block's own containment boundary (DEF-11), not at compile time.
        """
        name = str(config.get("source", "")).strip()
        if name:
            if name not in self.source_vars_by_name:
                return SourceResolution(error=f"Source {name!r} not found.")
            return SourceResolution(var_name=self.source_vars_by_name[name], source_name=name)
        if self.default_source_var is None:
            return SourceResolution(error="No data source available for this block.")
        return SourceResolution(var_name=self.default_source_var, source_name=self.default_source_name)


BlockValidator = Callable[[Dict[str, Any]], List[str]]
BlockEmitter = Callable[[Dict[str, Any], EmitContext], BlockCode]


@dataclass
class BlockSpec:
    """Declarative specification of a block type."""

    type: str
    title: str
    category: str  # data | layout | viz | code
    fields: Tuple[FieldSpec, ...]
    validate: BlockValidator
    emit: BlockEmitter
    output: Optional[str] = None  # frame | figure | table | None


# --------------------------------------------------------------------------------------------
# Validators
# --------------------------------------------------------------------------------------------


def _require_fields(config: Dict[str, Any], names: Tuple[str, ...]) -> List[str]:
    return [f"missing required field '{name}'" for name in names if not str(config.get(name, "")).strip()]


def _validate_synthetic(config: Dict[str, Any]) -> List[str]:
    errors: List[str] = []
    name = str(config.get("name", "")).strip()
    if not name:
        errors.append("missing required field 'name'")
    elif not name.isidentifier():
        errors.append(f"source name must be a valid identifier, got {name!r}")
    elif name.startswith(RESERVED_PREFIX):
        errors.append(f"source name must not start with the reserved prefix {RESERVED_PREFIX!r}")
    try:
        parse_source_config(config)
    except ValueError as exc:
        errors.append(str(exc))
    return errors


def _validate_title(config: Dict[str, Any]) -> List[str]:
    return _require_fields(config, ("title",))


def _validate_section(config: Dict[str, Any]) -> List[str]:
    errors = _require_fields(config, ("title",))
    level = config.get("level", 1)
    if level not in (1, 2, 3, "1", "2", "3"):
        errors.append("level must be 1, 2 or 3")
    return errors


_CALLOUT_TYPES = ("info", "success", "warning", "danger")


def _validate_callout(config: Dict[str, Any]) -> List[str]:
    errors = _require_fields(config, ("content",))
    callout_type = config.get("type", "info")
    if callout_type not in _CALLOUT_TYPES:
        errors.append(f"type must be one of {_CALLOUT_TYPES}")
    content = str(config.get("content", ""))
    if len(content) > MAX_TEXT_LENGTH:
        errors.append(f"content too long (max {MAX_TEXT_LENGTH} characters)")
    return errors


def _parse_metrics(config: Dict[str, Any]) -> List[Tuple[str, str]]:
    """Parse the ``label: expression`` lines of a metrics block."""
    entries: List[Tuple[str, str]] = []
    for line in str(config.get("metrics", "")).replace("\r\n", "\n").split("\n"):
        if not line.strip() or ":" not in line:
            continue
        label, expression = line.split(":", 1)
        entries.append((label.strip(), expression.strip()))
    return entries


def _validate_metrics(config: Dict[str, Any]) -> List[str]:
    entries = _parse_metrics(config)
    if not entries:
        return ["missing required field 'metrics' (one 'label: expression' per line)"]
    errors: List[str] = []
    for label, expression in entries:
        if not label:
            errors.append("each metric needs a non-empty label")
        if not expression:
            errors.append(f"metric {label!r} has no expression")
            continue
        # The expressions run in the generated module: same AST allowlist as Python blocks.
        errors.extend(f"metric {label!r}: {message}" for message in _static_check_user_code(f"value = ({expression})"))
    return errors


def _validate_text(config: Dict[str, Any]) -> List[str]:
    content = str(config.get("content", ""))
    if not content.strip():
        return ["missing required field 'content'"]
    if len(content) > MAX_TEXT_LENGTH:
        return [f"text too long (max {MAX_TEXT_LENGTH} characters)"]
    return []


def _validate_table(config: Dict[str, Any]) -> List[str]:
    errors: List[str] = []
    max_rows = config.get("max_rows", 20)
    try:
        if not 1 <= int(max_rows) <= 10_000:
            errors.append("max_rows must be in [1, 10000]")
    except (TypeError, ValueError):
        errors.append("max_rows must be an integer")
    return errors


def _validate_lineplot(config: Dict[str, Any]) -> List[str]:
    return _require_fields(config, ("y",))


def _validate_python(config: Dict[str, Any]) -> List[str]:
    errors: List[str] = []
    code = str(config.get("code", ""))
    if not code.strip():
        errors.append("missing required field 'code'")

    output = config.get("output", "figure")
    if output not in _PYTHON_OUTPUTS:
        errors.append(f"output must be one of {_PYTHON_OUTPUTS}")

    inputs = config.get("inputs", [])
    if not isinstance(inputs, list):
        errors.append("inputs must be a list of variable names")
    else:
        for name in inputs:
            if not isinstance(name, str) or not name.isidentifier():
                errors.append(f"invalid input variable name {name!r}")

    if code.strip():
        errors.extend(_static_check_user_code(code))
    return errors


def _static_check_user_code(code: str) -> List[str]:
    """Run the AST allowlist analyser on an inlined Python block (GEN-14, SEC-01..03)."""
    from services.sandbox import check_code_safety

    wrapped_code = "def _bb_user_block():\n" + "\n".join(f"    {line}" for line in code.splitlines())
    safety = check_code_safety(wrapped_code)
    if safety["safe"]:
        return []
    return [f"unsafe code: {message}" for message in safety["errors"]]


# --------------------------------------------------------------------------------------------
# Line-length-safe literal rendering
# --------------------------------------------------------------------------------------------

MAX_LINE_LENGTH = 120
# Indentation a rendered literal can gain before reaching its final form: up to 12 columns from
# the compiler (guarded block > else > try > statement), plus up to 8 more from Ruff, which
# re-nests a long ``document.append({...})`` call over several levels. Budgeted for here so a
# literal never overflows once re-indented and reformatted.
_COMPILER_INDENT_BUDGET = 24


def _escaped_length(char: str) -> int:
    """Return the number of source characters ``char`` occupies inside a string literal."""
    return len(repr(char)) - 2


def _split_for_literal(value: str, budget: int) -> List[str]:
    """Split ``value`` into chunks whose literal form fits within ``budget`` characters.

    Splitting prefers whitespace boundaries so the generated source stays readable; a word longer
    than the budget is cut mid-word rather than overflowing. Concatenating the chunks reproduces
    ``value`` exactly.

    Args:
        value: The text to split.
        budget: Maximum length of one rendered chunk, surrounding quotes included.

    Returns:
        A non-empty list of chunks.
    """
    limit = max(budget - 2, 8)  # the surrounding quotes cost two characters
    chunks: List[str] = []
    current: List[str] = []
    length = 0
    last_break = -1

    for char in value:
        cost = _escaped_length(char)
        if current and length + cost > limit:
            if last_break > 0:
                chunks.append("".join(current[:last_break]))
                current = current[last_break:]
                length = sum(_escaped_length(item) for item in current)
            else:
                chunks.append("".join(current))
                current = []
                length = 0
            last_break = -1
        current.append(char)
        length += cost
        if char in (" ", "\n"):
            last_break = len(current)

    if current:
        chunks.append("".join(current))
    return chunks or [""]


def _literal(value: str, prefix: str, indent_budget: int = _COMPILER_INDENT_BUDGET) -> str:
    """Render ``value`` as a Python literal that respects the 120-character limit (GEN-16).

    Ruff never splits a string literal, so a long author-supplied text would otherwise produce an
    over-long line that the user has no way to fix from the editor. Such a value is emitted as a
    parenthesised group of implicitly concatenated chunks instead.

    Args:
        value: The text to render.
        prefix: Source text preceding the literal on its line, used to compute the budget.
        indent_budget: Extra indentation the compiler may prepend to the statement.

    Returns:
        Either ``repr(value)`` or a multi-line parenthesised concatenation.
    """
    single_line = repr(value)
    budget = MAX_LINE_LENGTH - indent_budget
    if len(prefix) + len(single_line) + 1 <= budget:  # +1 for the trailing comma
        return single_line

    outer_indent = " " * (len(prefix) - len(prefix.lstrip()))
    inner_indent = outer_indent + "    "
    chunks = _split_for_literal(value, budget - len(inner_indent))
    rendered = "\n".join(f"{inner_indent}{chunk!r}" for chunk in chunks)
    return f"(\n{rendered}\n{outer_indent})"


def _document_append(block_id: str, kind: str, entries: Tuple[Tuple[str, str], ...]) -> str:
    """Render a ``document.append({...})`` statement with one entry per line.

    Args:
        block_id: Identifier of the emitting block.
        kind: Artefact kind consumed by the report renderer.
        entries: ``(key, rendered value expression)`` pairs, in output order.

    Returns:
        The statement source.
    """
    lines = ["document.append({", f"    'block_id': {block_id!r},", f"    'kind': {kind!r},"]
    lines.extend(f"    {key!r}: {expression}," for key, expression in entries)
    lines.append("})")
    return "\n".join(lines)


def _text_entry(key: str, value: Any) -> Tuple[str, str]:
    """Return a :func:`_document_append` entry holding a line-length-safe string literal."""
    return key, _literal(str(value), f"    {key!r}: ")


# --------------------------------------------------------------------------------------------
# Emitters
# --------------------------------------------------------------------------------------------

MAX_AUTHOR_LENGTH = 80
_UNKNOWN_AUTHOR = "unknown"


def sanitise_inline_text(text: Any, max_length: Optional[int] = None) -> str:
    """Return free recipe text reduced to a single, printable line.

    Such text is inlined in generated comments and docstrings, so anything that could end the
    surrounding construct or start a new statement is dropped: control characters and line breaks
    become spaces, runs of whitespace collapse, and the result is optionally truncated.

    Args:
        text: Raw text from the recipe.
        max_length: Maximum length of the result, or ``None`` to keep it whole.

    Returns:
        The collapsed text, possibly empty.
    """
    kept = [char if char.isprintable() and char not in "\r\n" else " " for char in str(text)]
    collapsed = " ".join("".join(kept).split())
    if max_length is None:
        return collapsed
    return collapsed[:max_length].strip()


def sanitise_author(author: Any) -> str:
    """Return an author label safe to inline in a generated comment (GEN-15).

    Args:
        author: Raw author label, from the recipe settings or the block configuration.

    Returns:
        A single-line label, or ``"unknown"`` when nothing usable remains.
    """
    return sanitise_inline_text(author, MAX_AUTHOR_LENGTH) or _UNKNOWN_AUTHOR


def _region_markers(block: Dict[str, Any], ctx: EmitContext, source: str) -> Tuple[List[str], str]:
    """Return the opening marker lines and the closing marker of an inlined user region.

    A reviewer must be able to tell compiler-emitted code from user-authored code, and to trace
    the latter back to its block, its author and the exact text that was inlined (GEN-15).

    Args:
        block: The block owning the region.
        ctx: Emission context, holding the recipe-level author.
        source: The exact user text being inlined, hashed as-is.

    Returns:
        A ``(opening lines, closing line)`` tuple, indented one level.
    """
    block_id = str(block["id"])
    author = sanitise_author(block.get("config", {}).get("author") or ctx.author)
    source_hash = hashlib.sha256(source.encode("utf-8")).hexdigest()
    opening = [
        f"    # >>> user region: block {block_id!r} (author-supplied, reviewed by AST allowlist)",
        f"    # author: {author}",
        f"    # source sha256: {source_hash}",
    ]
    return opening, f"    # <<< user region: block {block_id!r}"


def _emit_synthetic(block: Dict[str, Any], ctx: EmitContext) -> BlockCode:
    config = block.get("config", {})
    slug = ctx.slug(block["id"])
    fn_name = f"{RESERVED_PREFIX}source_{slug}"
    name = str(config.get("name", "")).strip()
    helper = render_synthetic_numpy(fn_name, config)
    # Publishing the frame in ``state`` is what makes the source available to later blocks; a
    # source missing from ``state`` is exactly what marks its dependants as skipped (DEF-12).
    return BlockCode(helpers=[helper], body=[f"state[{name!r}] = {fn_name}()"])


def _emit_title(block: Dict[str, Any], ctx: EmitContext) -> BlockCode:
    config = block.get("config", {})
    entries = (
        _text_entry("title", config.get("title", "")),
        _text_entry("subtitle", config.get("subtitle", "")),
        _text_entry("author", config.get("author", "")),
    )
    return BlockCode(body=[_document_append(block["id"], "title", entries)])


def _emit_section(block: Dict[str, Any], ctx: EmitContext) -> BlockCode:
    config = block.get("config", {})
    entries = (
        _text_entry("title", config.get("title", "")),
        ("level", str(int(config.get("level", 1)))),
    )
    return BlockCode(body=[_document_append(block["id"], "section", entries)])


def _emit_text(block: Dict[str, Any], ctx: EmitContext) -> BlockCode:
    config = block.get("config", {})
    entries = (_text_entry("content", config.get("content", "")),)
    return BlockCode(body=[_document_append(block["id"], "text", entries)])


def _emit_callout(block: Dict[str, Any], ctx: EmitContext) -> BlockCode:
    config = block.get("config", {})
    entries = (
        _text_entry("type", config.get("type", "info")),
        _text_entry("title", config.get("title", "")),
        _text_entry("content", config.get("content", "")),
    )
    return BlockCode(body=[_document_append(block["id"], "callout", entries)])


def _render_metric_append(label: str, expression: str) -> List[str]:
    """Render the statement appending one metric, on a single line when it fits.

    Args:
        label: Metric label, as typed by the author.
        expression: Metric expression, already checked against the AST allowlist.

    Returns:
        The statement lines.
    """
    value = f"{RESERVED_PREFIX}format_metric(({expression}))"
    single_line = f"    items.append({{'label': {label!r}, 'value': {value}}})"
    if len(single_line) <= MAX_LINE_LENGTH - _COMPILER_INDENT_BUDGET:
        return [single_line]
    label_literal = _literal(label, "        'label': ")
    return [
        "    items.append({",
        f"        'label': {label_literal},",
        f"        'value': {value},",
        "    })",
    ]


def _emit_metrics(block: Dict[str, Any], ctx: EmitContext) -> BlockCode:
    slug = ctx.slug(block["id"])
    config = block.get("config", {})
    resolution = ctx.resolve_source(config)
    param = str(config.get("source", "") or "df").strip()
    if not param.isidentifier() or param.startswith(RESERVED_PREFIX):
        param = "df"
    fn_name = f"{RESERVED_PREFIX}metrics_{slug}"

    # The metric expressions are user-authored too: the region carries the same marker (GEN-15).
    opening, closing = _region_markers(block, ctx, str(config.get("metrics", "")))
    helper_lines = [f"def {fn_name}({param}: dict) -> dict:", "    items = []", *opening]
    for label, expression in _parse_metrics(config):
        helper_lines.extend(_render_metric_append(label, expression))
    helper_lines.append(closing)
    helper_lines.append("    return {'items': items}")
    helper = "\n".join(helper_lines) + "\n"

    if resolution.error:
        return BlockCode(helpers=[helper], body=[f"raise ValueError({resolution.error!r})"])

    body = (
        "document.append({\n"
        f"    'block_id': {block['id']!r},\n"
        "    'kind': 'metrics',\n"
        f"    'spec': {fn_name}({resolution.var_name}),\n"
        "})"
    )
    depends_on = (resolution.source_name,)
    return BlockCode(helpers=[helper], body=[body], depends_on=depends_on)


def _emit_table(block: Dict[str, Any], ctx: EmitContext) -> BlockCode:
    slug = ctx.slug(block["id"])
    config = block.get("config", {})
    resolution = ctx.resolve_source(config)
    fn_name = f"{RESERVED_PREFIX}table_{slug}"
    caption = str(config.get("caption", ""))
    max_rows = int(config.get("max_rows", 20))
    caption_literal = _literal(caption, "        caption=")
    helper = (
        f"def {fn_name}(data: dict) -> dict:\n"
        f"    return {RESERVED_PREFIX}build_table(\n"
        f"        data,\n"
        f"        caption={caption_literal},\n"
        f"        max_rows={max_rows},\n"
        f"    )\n"
    )
    if resolution.error:
        return BlockCode(helpers=[helper], body=[f"raise ValueError({resolution.error!r})"])

    body = [
        "document.append({\n"
        f"    'block_id': {block['id']!r},\n"
        "    'kind': 'table',\n"
        f"    'spec': {fn_name}({resolution.var_name}),\n"
        "})"
    ]
    depends_on = (resolution.source_name,)
    return BlockCode(helpers=[helper], body=body, depends_on=depends_on)


def _emit_lineplot(block: Dict[str, Any], ctx: EmitContext) -> BlockCode:
    slug = ctx.slug(block["id"])
    config = block.get("config", {})
    resolution = ctx.resolve_source(config)
    fn_name = f"{RESERVED_PREFIX}figure_{slug}"
    x_col = str(config.get("x", "time"))
    y_col = str(config.get("y", ""))
    title = str(config.get("title", ""))
    color = str(config.get("color", ""))
    unit = str(config.get("unit", ""))
    helper = (
        f"def {fn_name}(data: dict) -> dict:\n"
        f"    return {RESERVED_PREFIX}build_lineplot(\n"
        f"        data,\n"
        f"        x={_literal(x_col, '        x=')},\n"
        f"        y={_literal(y_col, '        y=')},\n"
        f"        title={_literal(title, '        title=')},\n"
        f"        color={_literal(color, '        color=')},\n"
        f"        unit={_literal(unit, '        unit=')},\n"
        f"    )\n"
    )
    if resolution.error:
        return BlockCode(helpers=[helper], body=[f"raise ValueError({resolution.error!r})"])

    body = [
        "document.append({\n"
        f"    'block_id': {block['id']!r},\n"
        "    'kind': 'figure',\n"
        f"    'spec': {fn_name}({resolution.var_name}),\n"
        "})"
    ]
    depends_on = (resolution.source_name,)
    return BlockCode(helpers=[helper], body=body, depends_on=depends_on)


def _emit_python(block: Dict[str, Any], ctx: EmitContext) -> BlockCode:
    slug = ctx.slug(block["id"])
    config = block.get("config", {})
    inputs = [name for name in config.get("inputs", []) if isinstance(name, str)]
    output = str(config.get("output", "figure"))
    fn_name = f"{RESERVED_PREFIX}python_{slug}"
    validator = f"{RESERVED_PREFIX}validate_{output}"

    signature = ", ".join(f"{name}: dict" for name in inputs)
    source_code = str(config.get("code", ""))
    opening, closing = _region_markers(block, ctx, source_code)
    helper_lines = [f"def {fn_name}({signature}) -> dict:", *opening]
    helper_lines.extend(f"    {line}" for line in _normalise_user_code(source_code))
    helper_lines.append(closing)
    helper = "\n".join(helper_lines) + "\n"

    unmapped = next((name for name in inputs if name not in ctx.source_vars_by_name), None)
    if unmapped is not None:
        message = f"Source {unmapped!r} not found."
        return BlockCode(helpers=[helper], body=[f"raise ValueError({message!r})"])

    resolved_args = ", ".join(ctx.source_vars_by_name[name] for name in inputs)
    call_expr = f"{validator}({fn_name}({resolved_args}))"
    body = (
        "document.append({\n"
        f"    'block_id': {block['id']!r},\n"
        f"    'kind': {output!r},\n"
        f"    'spec': {call_expr},\n"
        "})"
    )
    depends_on = tuple(inputs)
    return BlockCode(helpers=[helper], body=[body], depends_on=depends_on)


def _normalise_user_code(code: str) -> List[str]:
    """Normalise indentation of an inlined user block to a flat statement list (GEN-11)."""
    raw_lines = code.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    stripped = [line.rstrip() for line in raw_lines]
    while stripped and not stripped[0].strip():
        stripped.pop(0)
    while stripped and not stripped[-1].strip():
        stripped.pop()
    if not stripped:
        return ["return {}"]
    indents = [len(line) - len(line.lstrip()) for line in stripped if line.strip()]
    common = min(indents) if indents else 0
    return [line[common:] if line.strip() else "" for line in stripped]


# --------------------------------------------------------------------------------------------
# Registry
# --------------------------------------------------------------------------------------------

BLOCK_REGISTRY: Dict[str, BlockSpec] = {
    "synthetic_source": BlockSpec(
        type="synthetic_source",
        title="Synthetic source",
        category="data",
        output="frame",
        fields=(
            FieldSpec("name", "Variable name", "text"),
            FieldSpec("samples", "Samples", "number", default=1000),
            FieldSpec("period", "Period (s)", "number", default=0.01),
            FieldSpec("seed", "Seed", "number", default=0),
            FieldSpec("signals", "Signals", "signals"),
        ),
        validate=_validate_synthetic,
        emit=_emit_synthetic,
    ),
    "title": BlockSpec(
        type="title",
        title="Title",
        category="layout",
        fields=(
            FieldSpec("title", "Title", "text"),
            FieldSpec("subtitle", "Subtitle", "text", required=False),
            FieldSpec("author", "Author", "text", required=False),
        ),
        validate=_validate_title,
        emit=_emit_title,
    ),
    "section": BlockSpec(
        type="section",
        title="Section",
        category="layout",
        fields=(
            FieldSpec("title", "Title", "text"),
            FieldSpec("level", "Level", "select", default=1),
        ),
        validate=_validate_section,
        emit=_emit_section,
    ),
    "text": BlockSpec(
        type="text",
        title="Text",
        category="layout",
        fields=(FieldSpec("content", "Content", "textarea"),),
        validate=_validate_text,
        emit=_emit_text,
    ),
    "callout": BlockSpec(
        type="callout",
        title="Callout",
        category="layout",
        fields=(
            FieldSpec("type", "Type", "select", default="info"),
            FieldSpec("title", "Title", "text", required=False),
            FieldSpec("content", "Content", "textarea"),
        ),
        validate=_validate_callout,
        emit=_emit_callout,
    ),
    "metrics": BlockSpec(
        type="metrics",
        title="Metrics",
        category="viz",
        fields=(
            FieldSpec("source", "Source", "source", required=False),
            FieldSpec("metrics", "Metrics", "textarea"),
        ),
        validate=_validate_metrics,
        emit=_emit_metrics,
    ),
    "table": BlockSpec(
        type="table",
        title="Table",
        category="viz",
        output="table",
        fields=(
            FieldSpec("source", "Source", "source", required=False),
            FieldSpec("caption", "Caption", "text", required=False),
            FieldSpec("max_rows", "Max rows", "number", default=20),
        ),
        validate=_validate_table,
        emit=_emit_table,
    ),
    "lineplot": BlockSpec(
        type="lineplot",
        title="Line plot",
        category="viz",
        output="figure",
        fields=(
            FieldSpec("source", "Source", "source", required=False),
            FieldSpec("x", "X axis", "text", default="time"),
            FieldSpec("y", "Y signal", "text"),
            FieldSpec("title", "Title", "text", required=False),
            FieldSpec("color", "Color", "color", required=False),
            FieldSpec("unit", "Unit", "text", required=False),
        ),
        validate=_validate_lineplot,
        emit=_emit_lineplot,
    ),
    "python": BlockSpec(
        type="python",
        title="Python block",
        category="code",
        fields=(
            FieldSpec("code", "Code", "code"),
            FieldSpec("inputs", "Inputs", "inputs", required=False),
            FieldSpec("output", "Output", "select", default="figure"),
        ),
        validate=_validate_python,
        emit=_emit_python,
    ),
}


def validate_block(block: Dict[str, Any]) -> List[str]:
    """Validate one block's type and configuration.

    Args:
        block: A recipe block with ``type`` and ``config`` keys.

    Returns:
        A list of human-readable error messages; empty if the block is valid.
    """
    if not isinstance(block, dict):
        return ["block must be an object"]
    block_type = block.get("type")
    spec = BLOCK_REGISTRY.get(block_type)
    if spec is None:
        return [f"unknown block type {block_type!r}"]
    config = block.get("config", {})
    if not isinstance(config, dict):
        return ["block config must be an object"]
    return spec.validate(config)


def block_schema() -> List[Dict[str, Any]]:
    """Return a JSON-serialisable description of the catalogue for the front-end."""
    catalogue: List[Dict[str, Any]] = []
    for spec in BLOCK_REGISTRY.values():
        catalogue.append(
            {
                "type": spec.type,
                "title": spec.title,
                "category": spec.category,
                "output": spec.output,
                "fields": [
                    {"id": f.id, "label": f.label, "type": f.type, "required": f.required, "default": f.default}
                    for f in spec.fields
                ],
            }
        )
    return catalogue
