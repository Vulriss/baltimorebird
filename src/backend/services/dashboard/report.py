"""Baltimore Bird - Standalone HTML report builder.

Assembles the run artefacts of a dashboard into a single, self-contained HTML file that opens
with no network access (functional-specification.md, HTM-01..11). The Plotly rendering runtime
is embedded from a pinned, self-hosted vendored copy - no content delivery network is referenced.

Charts stay interactive offline (zoom, pan, hover, legend) through the embedded Plotly runtime;
tables stay interactive offline (sort, filter, pagination) through a small self-contained script.
Every value produced by a block and injected into the report is HTML-escaped at generation time
(SEC-15).
"""

from __future__ import annotations

import html
import json
from pathlib import Path
from typing import Any, Dict, List, Optional

VENDOR_PLOTLY_PATH = Path(__file__).resolve().parent / "vendor" / "plotly.min.js"
DEFAULT_TABLE_PAGE_SIZE = 25

_STYLE = """
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; font-family: 'Fira Code', ui-monospace, SFMono-Regular, Menlo, monospace;
       background: #1e1e2e; color: #cdd6f4; line-height: 1.5; }
main { max-width: 1080px; margin: 0 auto; padding: 32px 24px 96px; }
h1 { font-size: 1.9rem; margin: 0 0 4px; }
.subtitle { color: #a6adc8; margin: 0 0 4px; }
.author { color: #a6adc8; font-size: .9rem; margin: 0 0 24px; }
h2 { font-size: 1.4rem; margin: 32px 0 8px; border-bottom: 1px solid #45475a; padding-bottom: 4px; }
h3 { font-size: 1.15rem; margin: 24px 0 8px; }
h4 { font-size: 1.0rem; margin: 20px 0 6px; }
nav.toc { background: #181825; border: 1px solid #313244; border-radius: 8px; padding: 12px 20px; margin: 16px 0 24px; }
nav.toc ol { margin: 4px 0; }
nav.toc a { color: #89b4fa; text-decoration: none; }
.text-block { white-space: pre-wrap; margin: 12px 0; }
.figure { margin: 16px 0; }
.callout { border-left: 4px solid #89b4fa; background: #181825; border-radius: 6px; padding: 10px 16px; margin: 16px 0; }
.callout-title { margin: 0 0 4px; font-weight: 700; }
.callout-body { white-space: pre-wrap; }
.callout-info { border-left-color: #89b4fa; }
.callout-success { border-left-color: #a6e3a1; }
.callout-warning { border-left-color: #f9e2af; }
.callout-danger { border-left-color: #f38ba8; }
.metrics-grid { display: flex; flex-wrap: wrap; gap: 12px; margin: 16px 0; }
.metric-card { flex: 1 1 160px; background: #181825; border: 1px solid #313244; border-radius: 8px; padding: 12px 16px; }
.metric-label { display: block; color: #a6adc8; font-size: .8rem; }
.metric-value { display: block; font-size: 1.3rem; font-weight: 700; margin-top: 4px; }
.decimation { color: #a6adc8; font-size: .8rem; margin-top: 4px; }
table.bb-table { border-collapse: collapse; width: 100%; margin: 8px 0; font-size: .85rem; }
table.bb-table th, table.bb-table td { border: 1px solid #45475a; padding: 4px 8px; text-align: right; }
table.bb-table th { cursor: pointer; background: #313244; position: sticky; top: 0; }
.caption { color: #a6adc8; font-size: .85rem; margin: 4px 0 12px; }
.table-controls { margin: 8px 0 4px; }
.table-controls input { background: #181825; color: #cdd6f4; border: 1px solid #45475a;
                        border-radius: 4px; padding: 4px 8px; font: inherit; }
.table-toolbar { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; margin: 8px 0 4px; }
.table-toolbar label { display: inline-flex; align-items: center; gap: 6px; font-size: .85rem; color: #a6adc8; }
.table-toolbar input, .table-toolbar select, .table-toolbar button {
        background: #181825; color: #cdd6f4; border: 1px solid #45475a; border-radius: 4px; padding: 4px 8px; font: inherit;
}
.table-toolbar button[disabled] { opacity: .45; cursor: not-allowed; }
.table-columns { display: flex; flex-wrap: wrap; gap: 8px 12px; margin: 0 0 8px; }
.table-columns label { font-size: .8rem; color: #a6adc8; }
.table-page-status { font-size: .8rem; color: #a6adc8; min-width: 110px; }
.provenance { margin-top: 48px; padding: 16px 20px; background: #181825; border: 1px solid #313244;
              border-radius: 8px; font-size: .8rem; color: #a6adc8; }
.provenance code { color: #cdd6f4; word-break: break-all; }
.notice { background: #45341c; border: 1px solid #f9e2af; color: #f9e2af; padding: 10px 16px;
          border-radius: 6px; margin: 16px 0; }
.error-block { background: #3f1d2e; border: 1px solid #f38ba8; color: #f5c2e7; padding: 12px 16px;
                             border-radius: 8px; margin: 16px 0; }
.error-block code { color: #f9e2af; word-break: break-word; }
.skipped-block { background: #40391f; border: 1px solid #f9e2af; color: #f9e2af; padding: 12px 16px;
                                border-radius: 8px; margin: 16px 0; }
.skipped-block code { color: #f9e2af; word-break: break-word; }
@media print { body { background: #fff; color: #000; } th { background: #eee; } }
"""

_TABLE_SCRIPT = r"""
function bbSortTable(table, colIndex) {
    const state = bbGetTableState(table.id);
    const asc = state.sort.col !== colIndex || state.sort.dir !== 'asc';
    state.sort = { col: colIndex, dir: asc ? 'asc' : 'desc' };
    bbApplyTableState(table.id);
}
function bbFilterTable(input, tableId) {
    const state = bbGetTableState(tableId);
    state.filter = input.value.toLowerCase();
    state.page = 0;
    bbApplyTableState(tableId);
}
function bbToggleTableColumn(input, tableId, colIndex) {
    const table = document.getElementById(tableId);
    const index = Number(colIndex);
    const isVisible = input.checked;
    table.querySelectorAll('tr').forEach(function(row) {
        if (row.cells[index]) {
            row.cells[index].style.display = isVisible ? '' : 'none';
        }
    });
}
function bbSetTablePageSize(select, tableId) {
    const state = bbGetTableState(tableId);
    state.pageSize = Math.max(1, parseInt(select.value, 10) || 25);
    state.page = 0;
    bbApplyTableState(tableId);
}
function bbChangeTablePage(tableId, delta) {
    const table = document.getElementById(tableId);
    const state = bbGetTableState(tableId);
    const rows = bbFilteredRows(table, state.filter);
    const totalPages = Math.max(1, Math.ceil(rows.length / state.pageSize));
    state.page = Math.min(Math.max(state.page + delta, 0), totalPages - 1);
    bbApplyTableState(tableId);
}
function bbGetTableState(tableId) {
    window.__bbTableState = window.__bbTableState || {};
    if (!window.__bbTableState[tableId]) {
        const table = document.getElementById(tableId);
        const pageSize = Math.max(1, parseInt(table.getAttribute('data-page-size'), 10) || 25);
        window.__bbTableState[tableId] = {
            filter: '',
            page: 0,
            pageSize: pageSize,
            sort: { col: null, dir: 'asc' }
        };
    }
    return window.__bbTableState[tableId];
}
function bbFilteredRows(table, filterTerm) {
    const rows = Array.from(table.tBodies[0].rows);
    if (!filterTerm) {
        return rows;
    }
    return rows.filter(function(row) {
        return row.textContent.toLowerCase().indexOf(filterTerm) !== -1;
    });
}
function bbCompareCells(leftText, rightText) {
    const leftNum = parseFloat(leftText);
    const rightNum = parseFloat(rightText);
    const leftIsNum = !Number.isNaN(leftNum) && /^\\s*[-+]?\\d/.test(leftText);
    const rightIsNum = !Number.isNaN(rightNum) && /^\\s*[-+]?\\d/.test(rightText);
    if (leftIsNum && rightIsNum) {
        return leftNum - rightNum;
    }
    return leftText.localeCompare(rightText, undefined, { numeric: true, sensitivity: 'base' });
}
function bbApplyTableState(tableId) {
    const table = document.getElementById(tableId);
    const tbody = table.tBodies[0];
    const state = bbGetTableState(tableId);
    const rows = bbFilteredRows(table, state.filter);
    const sortCol = state.sort.col;
    const sortDir = state.sort.dir;

    rows.sort(function(a, b) {
        if (sortCol === null) {
            return Number(a.getAttribute('data-row-index')) - Number(b.getAttribute('data-row-index'));
        }
        const result = bbCompareCells(a.cells[sortCol].textContent, b.cells[sortCol].textContent);
        return sortDir === 'asc' ? result : -result;
    });

    Array.from(tbody.rows).forEach(function(row) {
        row.style.display = 'none';
        tbody.appendChild(row);
    });

    const totalPages = Math.max(1, Math.ceil(rows.length / state.pageSize));
    if (state.page >= totalPages) {
        state.page = totalPages - 1;
    }
    const start = state.page * state.pageSize;
    const end = start + state.pageSize;
    rows.forEach(function(row, index) {
        tbody.appendChild(row);
        row.style.display = (index >= start && index < end) ? '' : 'none';
    });

    const status = document.getElementById(tableId + '-page-status');
    if (status) {
        status.textContent = rows.length === 0
            ? '0 result'
            : ('Page ' + (state.page + 1) + ' / ' + totalPages + ' - ' + rows.length + ' result(s)');
    }

    const prevBtn = document.getElementById(tableId + '-prev');
    const nextBtn = document.getElementById(tableId + '-next');
    if (prevBtn) prevBtn.disabled = state.page <= 0;
    if (nextBtn) nextBtn.disabled = state.page >= totalPages - 1 || rows.length === 0;
}
function bbInitTable(tableId) {
    bbApplyTableState(tableId);
}
"""


def _load_plotly_runtime() -> Optional[str]:
    """Return the vendored Plotly runtime source, or ``None`` if it is not installed."""
    if VENDOR_PLOTLY_PATH.exists():
        try:
            return VENDOR_PLOTLY_PATH.read_text(encoding="utf-8")
        except OSError:
            return None
    return None


def build_html_report(
    recipe: Dict[str, Any],
    document: List[Dict[str, Any]],
    provenance: Dict[str, Any],
) -> str:
    """Build a standalone HTML report from run artefacts.

    Args:
        recipe: The source recipe (used for the report title fallback).
        document: The ordered list of artefacts produced by ``build_report`` (sections, text,
            figures and tables).
        provenance: Provenance metadata (recipe id/version, module hash, timestamp, mapping).

    Returns:
        A complete, self-contained HTML document as a string.
    """
    figures: List[str] = []
    sections: List[Dict[str, Any]] = []
    body_parts: List[str] = []

    for index, item in enumerate(document):
        kind = item.get("kind")
        if kind == "title":
            body_parts.append(_render_title(item))
        elif kind == "section":
            anchor = f"section-{index}"
            sections.append({"anchor": anchor, "title": str(item.get("title", "")), "level": item.get("level", 1)})
            body_parts.append(_render_section(item, anchor))
        elif kind == "callout":
            body_parts.append(_render_callout(item))
        elif kind == "metrics":
            body_parts.append(_render_metrics(item))
        elif kind == "text":
            body_parts.append(_render_text(item))
        elif kind == "figure":
            div_id = f"figure-{index}"
            body_parts.append(_render_figure(item, div_id))
            figures.append(_figure_script(item, div_id))
        elif kind == "table":
            body_parts.append(_render_table(item, index))
        elif kind == "error":
            body_parts.append(_render_error(item))
        elif kind == "skipped":
            body_parts.append(_render_skipped(item))

    toc = _render_toc(sections)
    plotly_runtime = _load_plotly_runtime()
    runtime_tag = f"<script>{plotly_runtime}</script>" if plotly_runtime else ""
    runtime_notice = "" if plotly_runtime else (
        '<div class="notice">Plotly runtime not vendored: figures will not render. '
        "Add services/dashboard/vendor/plotly.min.js.</div>"
    )

    figures_script = "\n".join(figures)
    return _TEMPLATE.format(
        title=html.escape(str(provenance.get("title", recipe.get("name", "Dashboard")))),
        style=_STYLE,
        runtime_tag=runtime_tag,
        runtime_notice=runtime_notice,
        toc=toc,
        body="\n".join(body_parts),
        table_script=_TABLE_SCRIPT,
        figures_script=figures_script,
        provenance=_render_provenance(provenance),
    )


def _render_title(item: Dict[str, Any]) -> str:
    parts = [f"<h1>{html.escape(str(item.get('title', '')))}</h1>"]
    subtitle = str(item.get("subtitle", ""))
    author = str(item.get("author", ""))
    if subtitle:
        parts.append(f'<p class="subtitle">{html.escape(subtitle)}</p>')
    if author:
        parts.append(f'<p class="author">{html.escape(author)}</p>')
    return "\n".join(parts)


def _render_section(item: Dict[str, Any], anchor: str) -> str:
    level = int(item.get("level", 1))
    tag = {1: "h2", 2: "h3", 3: "h4"}.get(level, "h2")
    return f'<{tag} id="{anchor}">{html.escape(str(item.get("title", "")))}</{tag}>'


def _render_text(item: Dict[str, Any]) -> str:
    return f'<div class="text-block">{html.escape(str(item.get("content", "")))}</div>'


def _render_callout(item: Dict[str, Any]) -> str:
    callout_type = str(item.get("type", "info"))
    if callout_type not in ("info", "success", "warning", "danger"):
        callout_type = "info"
    title = str(item.get("title", ""))
    heading = f'<p class="callout-title">{html.escape(title)}</p>' if title else ""
    content = html.escape(str(item.get("content", "")))
    return f'<div class="callout callout-{callout_type}">{heading}<div class="callout-body">{content}</div></div>'


def _render_metrics(item: Dict[str, Any]) -> str:
    items = item.get("spec", {}).get("items", [])
    cards = "".join(
        f'<div class="metric-card"><span class="metric-label">{html.escape(str(entry.get("label", "")))}</span>'
        f'<span class="metric-value">{html.escape(str(entry.get("value", "")))}</span></div>'
        for entry in items
    )
    return f'<div class="metrics-grid">{cards}</div>'


def _render_figure(item: Dict[str, Any], div_id: str) -> str:
    spec = item.get("spec", {})
    ratio = spec.get("meta", {}).get("decimation_ratio", 1)
    note = f'<p class="decimation">Decimation ratio: 1/{ratio}</p>' if ratio and ratio > 1 else ""
    return f'<div class="figure"><div id="{div_id}"></div>{note}</div>'


def _figure_script(item: Dict[str, Any], div_id: str) -> str:
    spec = item.get("spec", {})
    data = json.dumps(spec.get("data", []))
    layout = json.dumps({**spec.get("layout", {}), "paper_bgcolor": "rgba(0,0,0,0)", "plot_bgcolor": "rgba(0,0,0,0)",
                         "font": {"color": "#cdd6f4"}})
    return (
        f'if (window.Plotly) {{ Plotly.newPlot("{div_id}", {data}, {layout}, '
        f'{{responsive: true, displaylogo: false}}); }}'
    )


def _render_table(item: Dict[str, Any], index: int) -> str:
    spec = item.get("spec", {})
    columns = spec.get("columns", [])
    rows = spec.get("rows", [])
    caption = html.escape(str(spec.get("caption", "")))
    table_id = f"table-{index}"
    page_size = _page_size_for_rows(len(rows), bool(spec.get("truncated")))

    header = "".join(
        f'<th onclick="bbSortTable(document.getElementById(\'{table_id}\'), {col})">{html.escape(str(name))}</th>'
        for col, name in enumerate(columns)
    )
    body_rows = "".join(
        f'<tr data-row-index="{row_index}">' + "".join(f"<td>{html.escape(_format_cell(cell))}</td>" for cell in row) + "</tr>"
        for row_index, row in enumerate(rows)
    )
    truncated = ""
    if spec.get("truncated"):
        truncated = f'<p class="caption">Showing {len(rows)} of {spec.get("total_rows", len(rows))} rows.</p>'
    controls = _render_table_controls(table_id, columns, page_size)
    caption_html = f'<p class="caption">{caption}</p>' if caption else ""
    return (
        f"{caption_html}{controls}"
        f'<table class="bb-table" id="{table_id}" data-page-size="{page_size}"><thead><tr>{header}</tr></thead>'
        f"<tbody>{body_rows}</tbody></table>{truncated}<script>bbInitTable(\"{table_id}\");</script>"
    )


def _format_cell(cell: Any) -> str:
    if isinstance(cell, float):
        return f"{cell:.6g}"
    return str(cell)


def _render_table_controls(table_id: str, columns: List[Any], page_size: int) -> str:
    filter_control = (
        f'<label>Filter <input type="text" placeholder="Filter..." '
        f'oninput="bbFilterTable(this, \'{table_id}\')"></label>'
    )
    page_size_control = (
        f'<label>Rows <select onchange="bbSetTablePageSize(this, \'{table_id}\')">'
        f'{_render_page_size_options(page_size)}</select></label>'
    )
    pagination = (
        f'<button type="button" id="{table_id}-prev" onclick="bbChangeTablePage(\'{table_id}\', -1)">Prev</button>'
        f'<span class="table-page-status" id="{table_id}-page-status"></span>'
        f'<button type="button" id="{table_id}-next" onclick="bbChangeTablePage(\'{table_id}\', 1)">Next</button>'
    )
    columns_html = "".join(
        f'<label><input type="checkbox" checked onchange="bbToggleTableColumn(this, \'{table_id}\', {index})">'
        f'{html.escape(str(name))}</label>'
        for index, name in enumerate(columns)
    )
    return (
        f'<div class="table-toolbar">{filter_control}{page_size_control}{pagination}</div>'
        f'<div class="table-columns">{columns_html}</div>'
    )


def _render_page_size_options(selected: int) -> str:
    options = [10, 25, 50, 100]
    if selected not in options:
        options.append(selected)
        options.sort()
    return "".join(
        f'<option value="{value}"{" selected" if value == selected else ""}>{value}</option>'
        for value in options
    )


def _page_size_for_rows(row_count: int, truncated: bool) -> int:
    if row_count <= 10 and not truncated:
        return row_count or DEFAULT_TABLE_PAGE_SIZE
    return min(DEFAULT_TABLE_PAGE_SIZE, max(row_count, 1))


_ERROR_MESSAGE_BY_BLOCK_TYPE: Dict[str, str] = {
    "python": (
        "Le calcul associé à cette section n'a pas abouti. "
        "Veuillez vérifier la configuration de cette analyse et relancer l'exécution."
    ),
    "synthetic_source": "Les données nécessaires à cette section ne sont pas disponibles.",
}
_DEFAULT_ERROR_MESSAGE = "Une partie du rapport n'a pas pu être générée."
_SKIPPED_MESSAGE = (
    "Une partie du rapport n'a pas pu être générée car une étape nécessaire à son calcul n'a pas abouti."
)


def _business_message_for_error(item: Dict[str, Any]) -> str:
    """Map a block failure to a user-facing business message (DEF-12).

    The mapping keys only on ``block_type`` - a closed, compiler-controlled vocabulary - and
    never reads ``block_id`` or ``message``, so no internal id, traceback, exception type/text
    or filesystem path can ever reach the HTML report, regardless of what the sandbox actually
    raised. Full technical detail remains available server-side via ``block_status``/
    ``block_errors`` (see ``api/scripts.py::_execute_recipe``) for logs and diagnostics.
    """
    block_type = str(item.get("block_type", ""))
    return _ERROR_MESSAGE_BY_BLOCK_TYPE.get(block_type, _DEFAULT_ERROR_MESSAGE)


def _render_error(item: Dict[str, Any]) -> str:
    message = html.escape(_business_message_for_error(item))
    return (
        '<section class="error-block">'
        '<strong>Étape indisponible</strong>'
        f'<div>{message}</div>'
        '</section>'
    )


def _render_skipped(item: Dict[str, Any]) -> str:
    message = html.escape(_SKIPPED_MESSAGE)
    return (
        '<section class="skipped-block">'
        '<strong>Étape non calculée</strong>'
        f'<div>{message}</div>'
        '</section>'
    )


def _render_toc(sections: List[Dict[str, Any]]) -> str:
    if not sections:
        return ""
    items = "".join(
        f'<li><a href="#{section["anchor"]}">{html.escape(str(section["title"]))}</a></li>' for section in sections
    )
    return f'<nav class="toc"><strong>Contents</strong><ol>{items}</ol></nav>'


def _render_provenance(provenance: Dict[str, Any]) -> str:
    rows = [
        ("Recipe", str(provenance.get("recipe_id", ""))),
        ("Recipe version", str(provenance.get("recipe_version", ""))),
        ("Module hash", str(provenance.get("module_hash", ""))),
        ("Platform version", str(provenance.get("platform_version", ""))),
        ("Generated", str(provenance.get("generated_at", ""))),
    ]
    mapping = provenance.get("mapping", [])
    mapping_html = ""
    if mapping:
        entries = ", ".join(html.escape(str(name)) for name in mapping)
        mapping_html = f"<div>Variable mapping: <code>{entries}</code></div>"
    body = "".join(f"<div>{html.escape(label)}: <code>{html.escape(value)}</code></div>" for label, value in rows)
    return f'<section class="provenance"><strong>Provenance</strong>{body}{mapping_html}</section>'


_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<style>{style}</style>
{runtime_tag}
</head>
<body>
<main>
{runtime_notice}
{toc}
{body}
{provenance}
</main>
<script>{table_script}</script>
<script>{figures_script}</script>
</body>
</html>
"""
