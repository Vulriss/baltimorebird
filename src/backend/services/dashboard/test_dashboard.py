"""Tests for the Dashboard Builder compilation pipeline.

Run from ``src/backend`` (``python -m pytest services/dashboard/test_dashboard.py``).
"""

from __future__ import annotations

import ast
import hashlib
import io
import json
import re
import subprocess
import sys
from contextlib import redirect_stdout
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, Dict, List

import polars as pl

from services.dashboard import (
    BLOCK_REGISTRY,
    build_html_report,
    compile_recipe,
    evaluate_escape_corpus,
    validate_generated_module_source,
    validate_recipe,
)
from services.dashboard.compiler import MODULE_RESULT_MARKER
from services.dashboard.formatting import format_module
from services.dashboard.synthetic import describe_synthetic_source, generate_synthetic_frame
from services.sandbox import check_code_safety, safe_execute


def _load_default_script(script_name: str) -> Dict[str, Any]:
    root = Path(__file__).resolve().parents[2]
    path = root / "data" / "default" / "scripts" / script_name
    return json.loads(path.read_text(encoding="utf-8"))


def _demo_recipe() -> Dict[str, Any]:
    return {
        "id": "script_demo",
        "name": "Demo",
        "settings": {"title": "Demo Report", "author": "PoC"},
        "blocks": [
            {
                "id": "b_src",
                "type": "synthetic_source",
                "config": {
                    "name": "df",
                    "samples": 200,
                    "period": 0.01,
                    "seed": 42,
                    "signals": [
                        {"name": "rpm", "unit": "rpm", "kind": "sine", "amplitude": 1000,
                         "frequency": 0.5, "offset": 2000, "noise": 10.0},
                        {"name": "speed", "unit": "kmh", "kind": "ramp", "amplitude": 120},
                    ],
                },
            },
            {"id": "b_title", "type": "title", "config": {"title": "Demo Report", "subtitle": "Synthetic", "author": "PoC"}},
            {"id": "b_sec", "type": "section", "config": {"title": "Overview", "level": 1}},
            {"id": "b_text", "type": "text", "config": {"content": "Hello world"}},
            {"id": "b_tbl", "type": "table", "config": {"source": "df", "caption": "Data", "max_rows": 5}},
            {"id": "b_fig", "type": "lineplot",
             "config": {"source": "df", "x": "time", "y": "rpm", "title": "RPM", "color": "#fab387", "unit": "rpm"}},
            {
                "id": "b_py",
                "type": "python",
                "config": {
                    "output": "figure",
                    "inputs": ["df"],
                    "code": (
                        "x = df['time']\n"
                        "y = df['speed']\n"
                            "return {\n"
                            "    'data': [{\n"
                            "        'type': 'scatter',\n"
                            "        'x': [float(v) for v in x],\n"
                            "        'y': [float(v) for v in y],\n"
                            "    }],\n"
                            "    'layout': {'title': {'text': 'Speed'}},\n"
                            "}"
                    ),
                },
            },
        ],
    }


def _run_module(source: str) -> Dict[str, Any]:
    """Execute a generated module with numpy/json injected (mimics the confined runner)."""
    namespace: Dict[str, Any] = {"np": __import__("numpy"), "json": json}
    buffer = io.StringIO()
    with redirect_stdout(buffer):
        exec(source, namespace)  # noqa: S102 - test harness executes generated, statically-checked code
    output = buffer.getvalue()
    marker_index = output.rfind(MODULE_RESULT_MARKER)
    assert marker_index != -1, "result marker missing from module output"
    return json.loads(output[marker_index + len(MODULE_RESULT_MARKER):])


def test_synthetic_frame_is_reproducible_with_correct_dtypes() -> None:
    config = _demo_recipe()["blocks"][0]["config"]
    first = generate_synthetic_frame(config)
    second = generate_synthetic_frame(config)
    assert first.equals(second)
    assert first["time"].dtype == pl.Float64
    assert first["rpm"].dtype == pl.Float32
    assert first.height == 200


def test_describe_synthetic_source_returns_schema() -> None:
    schema = describe_synthetic_source(_demo_recipe()["blocks"][0]["config"])
    names = [col["name"] for col in schema["columns"]]
    assert names == ["time", "rpm", "speed"]
    assert schema["columns"][0]["dtype"] == "float64"
    assert schema["columns"][1]["dtype"] == "float32"


def test_validate_recipe_accepts_valid_and_allows_unknown_source() -> None:
    """An unknown/absent `source` is no longer a whole-recipe error - it is resolved at
    runtime, inside the referencing block's own containment boundary (see the compiled-module
    tests below)."""
    assert validate_recipe(_demo_recipe()) == []

    unknown_source = _demo_recipe()
    unknown_source["blocks"][4]["config"]["source"] = "missing"
    assert validate_recipe(unknown_source) == []


def test_validate_recipe_still_flags_duplicate_source_names() -> None:
    recipe = _demo_recipe()
    duplicate_source = dict(recipe["blocks"][0])
    duplicate_source["id"] = "b_src_2"
    recipe["blocks"].insert(1, duplicate_source)
    errors = validate_recipe(recipe)
    assert any("duplicate data source name" in err["message"] for err in errors)


def test_compilation_is_deterministic() -> None:
    first = compile_recipe(_demo_recipe())
    second = compile_recipe(_demo_recipe())
    assert first.source == second.source
    assert first.provenance_hash == second.provenance_hash


def test_generated_module_passes_sandbox_safety() -> None:
    module = compile_recipe(_demo_recipe())
    safety = check_code_safety(module.source)
    assert safety["safe"], safety["errors"]


def test_generated_module_executes_and_produces_artefacts() -> None:
    module = compile_recipe(_demo_recipe())
    result = _run_module(module.source)
    kinds = [item["kind"] for item in result["document"]]
    assert kinds == ["title", "section", "text", "table", "figure", "figure"]

    table = next(item for item in result["document"] if item["kind"] == "table")
    assert table["spec"]["columns"] == ["time", "rpm", "speed"]
    assert len(table["spec"]["rows"]) == 5
    assert table["spec"]["truncated"] is True

    figure = next(item for item in result["document"] if item["kind"] == "figure")
    assert "data" in figure["spec"] and "layout" in figure["spec"]


def test_generated_module_is_standalone_executable() -> None:
    module = compile_recipe(_demo_recipe())
    with TemporaryDirectory() as temp_dir:
        module_path = Path(temp_dir) / "dashboard_module.py"
        module_path.write_text(module.source, encoding="utf-8")
        completed = subprocess.run(
            [sys.executable, str(module_path)],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    assert completed.returncode == 0, completed.stderr
    assert MODULE_RESULT_MARKER in completed.stdout


def test_generated_module_validation_is_clean() -> None:
    module = compile_recipe(_demo_recipe())
    assert validate_generated_module_source(module.source) == []


def test_confined_runner_handles_dashboard_artefact_payload() -> None:
    module = compile_recipe(_demo_recipe())
    runtime = safe_execute(module.source, timeout_seconds=5, max_memory_mb=256)
    assert runtime.success, runtime.error
    assert runtime.metadata and runtime.metadata.get("transport") == "tempfile"
    assert runtime.metadata.get("output_bytes", 0) > 1000
    marker_index = runtime.output.rfind(MODULE_RESULT_MARKER)
    assert marker_index != -1, "result marker missing from sandbox output"
    artefacts = json.loads(runtime.output[marker_index + len(MODULE_RESULT_MARKER):])
    kinds = [item["kind"] for item in artefacts["document"]]
    assert kinds == ["title", "section", "text", "table", "figure", "figure"]


def test_confined_runner_keeps_small_stdout_behavior() -> None:
    runtime = safe_execute("print('ok')", timeout_seconds=5, max_memory_mb=64)
    assert runtime.success, runtime.error
    assert runtime.output == "ok\n"
    assert runtime.metadata and runtime.metadata.get("output_bytes") == len("ok\n".encode("utf-8"))


def test_confined_runner_allows_restricted_polars_imports() -> None:
    runtime = safe_execute(
        "import polars as pl\nframe = pl.DataFrame({'value': [1, 2, 3]})\nprint(frame.height)",
        timeout_seconds=5,
        max_memory_mb=64,
    )
    assert runtime.success, runtime.error
    assert runtime.output == "3\n"


def test_python_block_failure_is_contained_as_partial_run() -> None:
    recipe = _demo_recipe()
    recipe["blocks"][6]["config"]["code"] = "return 42"  # not a figure spec
    module = compile_recipe(recipe)
    result = _run_module(module.source)
    kinds = [item["kind"] for item in result["document"]]
    # The failing block is reported; upstream blocks still render (DEF-11).
    assert "error" in kinds
    assert kinds.count("figure") == 1
    error = next(item for item in result["document"] if item["kind"] == "error")
    assert error["block_id"] == "b_py"


def test_unknown_named_source_is_contained_without_cascading() -> None:
    recipe = _demo_recipe()
    recipe["blocks"][5]["config"]["source"] = "missing"  # b_fig lineplot, non-existent source
    module = compile_recipe(recipe)
    result = _run_module(module.source)
    document = result["document"]
    kinds_by_id = {item["block_id"]: item["kind"] for item in document if isinstance(item, dict)}

    assert kinds_by_id["b_fig"] == "error"
    error = next(item for item in document if item["block_id"] == "b_fig")
    assert error["message"] == "Source 'missing' not found."

    # Nothing depends on the name "missing": siblings render normally, nothing cascades.
    assert kinds_by_id["b_title"] == "title"
    assert kinds_by_id["b_text"] == "text"
    assert kinds_by_id["b_tbl"] == "table"
    assert "skipped" not in kinds_by_id.values()


def test_source_runtime_failure_marks_dependents_skipped() -> None:
    recipe = _demo_recipe()
    module = compile_recipe(recipe)

    # The static config is valid; simulate a failure that only happens when the source's own
    # generated code runs, by rewriting its function body after compilation.
    fn_name = "_bb_source_b_src"
    pattern = re.compile(rf"def {fn_name}\(\) -> dict:\n(?:    .*\n)+")
    broken_source, count = pattern.subn(
        f"def {fn_name}() -> dict:\n    raise ValueError('synthetic source exploded')\n\n",
        module.source,
        count=1,
    )
    assert count == 1, "source function body was not found for rewriting"

    result = _run_module(broken_source)
    document = result["document"]
    kinds_by_id = {item["block_id"]: item["kind"] for item in document if isinstance(item, dict)}

    assert kinds_by_id["b_src"] == "error"
    assert kinds_by_id["b_tbl"] == "skipped"
    assert kinds_by_id["b_fig"] == "skipped"
    assert kinds_by_id["b_py"] == "skipped"
    # Independent blocks - no dependency on the failed source - still render normally.
    assert kinds_by_id["b_title"] == "title"
    assert kinds_by_id["b_text"] == "text"

    skipped = next(item for item in document if item["block_id"] == "b_tbl")
    assert skipped["message"] == "Skipped: dependency failed: df"


def test_build_html_report_embeds_provenance_and_figures() -> None:
    module = compile_recipe(_demo_recipe())
    result = _run_module(module.source)
    provenance = {
        "title": "Demo Report",
        "recipe_id": "script_demo",
        "recipe_version": 1,
        "module_hash": module.provenance_hash,
        "platform_version": "poc",
        "generated_at": "2026-09-02T00:00:00Z",
        "mapping": ["df"],
    }
    html = build_html_report(_demo_recipe(), result["document"], provenance)
    assert "<!DOCTYPE html>" in html
    assert "Plotly.newPlot" in html
    assert module.provenance_hash in html
    assert "Demo Report" in html
    assert "bbToggleTableColumn" in html
    assert "bbChangeTablePage" in html
    assert "<script src=" not in html
    assert '<link rel="stylesheet" href="https://' not in html
    assert "<link rel='stylesheet' href='https://" not in html


def test_build_html_report_renders_contained_block_failures() -> None:
    recipe = _demo_recipe()
    recipe["blocks"][6]["config"]["code"] = "return 42"
    module = compile_recipe(recipe)
    result = _run_module(module.source)
    provenance = {
        "title": "Demo Report",
        "recipe_id": "script_demo",
        "recipe_version": 1,
        "module_hash": module.provenance_hash,
        "platform_version": "poc",
        "generated_at": "2026-09-03T00:00:00Z",
        "mapping": ["df"],
    }
    html = build_html_report(recipe, result["document"], provenance)
    # A business-friendly message replaces the technical one (DEF-12): no block id, no raw
    # exception text, no mention of "Python" or "block" leaks into the user-facing report.
    assert "Étape indisponible" in html
    assert "Le calcul associé à cette section" in html
    assert "b_py" not in html
    assert "figure block must return a Plotly figure specification" not in html
    assert "Traceback" not in html
    assert "Python block failed" not in html


def test_build_html_report_renders_skipped_blocks() -> None:
    document = [
        {"block_id": "b_tbl", "block_type": "table", "kind": "skipped", "message": "Skipped: dependency failed: df"},
    ]
    provenance = {
        "title": "Demo Report",
        "recipe_id": "script_demo",
        "recipe_version": 1,
        "module_hash": "deadbeef",
        "platform_version": "poc",
        "generated_at": "2026-09-07T00:00:00Z",
        "mapping": ["df"],
    }
    html = build_html_report(_demo_recipe(), document, provenance)
    assert "Étape non calculée" in html
    assert "Une partie du rapport" in html
    assert "b_tbl" not in html
    assert "dependency failed" not in html
    assert "Skipped: dependency failed: df" not in html


def test_business_message_ignores_raw_message_content_for_any_block_type() -> None:
    """The mapping keys only on block_type - never on the raw message - so arbitrary sandbox
    output (attacker-influenced Python block exceptions included) can never leak verbatim."""
    document = [
        {
            "block_id": "internal_secret_id_42",
            "block_type": "python",
            "kind": "error",
            "message": "Traceback (most recent call last):\n  File \"/tmp/run123/module.py\", line 7\nKeyError: 'rpm'",
        },
        {
            "block_id": "b_src_hidden",
            "block_type": "synthetic_source",
            "kind": "error",
            "message": "OSError: [Errno 2] No such file or directory: '/tmp/run123/data.mf4'",
        },
        {
            "block_id": "b_fig_hidden",
            "block_type": "lineplot",
            "kind": "error",
            "message": "Source 'zzz_leak_marker_9f3a' not found.",
        },
    ]
    provenance = {
        "title": "Demo Report",
        "recipe_id": "script_demo",
        "recipe_version": 1,
        "module_hash": "deadbeef",
        "platform_version": "poc",
        "generated_at": "2026-09-07T00:00:00Z",
        "mapping": ["df"],
    }
    html = build_html_report(_demo_recipe(), document, provenance)
    for leaked in (
        "internal_secret_id_42",
        "b_src_hidden",
        "b_fig_hidden",
        "Traceback",
        "KeyError",
        "OSError",
        "/tmp/run123",
        "Errno 2",
        "zzz_leak_marker_9f3a",
    ):
        assert leaked not in html, f"technical detail {leaked!r} leaked into the user-facing report"
    assert "Le calcul associé à cette section" in html
    assert "Les données nécessaires à cette section ne sont pas disponibles" in html
    assert "Une partie du rapport" in html


def test_escape_corpus_cases_are_rejected_or_contained() -> None:
    results = evaluate_escape_corpus()
    assert results, "escape corpus must not be empty"
    assert all(result["passed"] for result in results), results


def test_default_standard_recipe_covers_every_block_type() -> None:
    """The default report must showcase one instance of every implemented block type."""
    recipe = _load_default_script("script_analyse_standard.json")
    used_types = {block["type"] for block in recipe["blocks"]}
    assert used_types == set(BLOCK_REGISTRY), f"missing block types: {set(BLOCK_REGISTRY) - used_types}"
    assert validate_recipe(recipe) == []


def test_default_standard_recipe_exports_standalone_html() -> None:
    recipe = _load_default_script("script_analyse_standard.json")
    module = compile_recipe(recipe)
    runtime = safe_execute(module.source, timeout_seconds=5, max_memory_mb=256)
    assert runtime.success, runtime.error
    marker_index = runtime.output.rfind(MODULE_RESULT_MARKER)
    assert marker_index != -1, "result marker missing from sandbox output"
    artefacts = json.loads(runtime.output[marker_index + len(MODULE_RESULT_MARKER):])
    provenance = {
        "title": recipe["settings"]["title"],
        "recipe_id": recipe["id"],
        "recipe_version": recipe.get("version", 1),
        "module_hash": module.provenance_hash,
        "platform_version": "poc",
        "generated_at": "2026-09-03T00:00:00Z",
        "mapping": ["df"],
    }
    html = build_html_report(recipe, artefacts["document"], provenance)
    assert "<!DOCTYPE html>" in html
    assert "Plotly.newPlot" in html
    assert "Dynamique véhicule" in html
    assert "Vitesse max (km/h)" in html
    assert "Statistiques descriptives par signal" in html
    # Le titre contient une apostrophe, echappee en entite HTML dans le rapport rendu.
    assert "Analyse standard" in html


_LONG_TEXT = (
    "Une phrase interminable saisie par l'auteur du rapport, qui depasse tres largement la limite "
    "des cent vingt caracteres imposee par la norme de codage MINT, et que l'utilisateur ne peut "
    "pas couper lui-meme depuis l'editeur de blocs."
)


def _long_text_recipe() -> Dict[str, Any]:
    """Return a recipe whose every author-supplied string is far longer than one source line."""
    return {
        "id": "script_long_text",
        "name": "Recette " + _LONG_TEXT,
        "settings": {"title": "Titre " + _LONG_TEXT, "author": _LONG_TEXT},
        "blocks": [
            {
                "id": "src",
                "type": "synthetic_source",
                "config": {
                    "name": "df",
                    "samples": 50,
                    "period": 0.1,
                    "seed": 1,
                    "signals": [{"name": "sig", "unit": "V", "kind": "sine"}],
                },
            },
            {"id": "ti", "type": "title", "config": {"title": _LONG_TEXT, "subtitle": _LONG_TEXT, "author": "a"}},
            {"id": "se", "type": "section", "config": {"title": _LONG_TEXT, "level": 1}},
            # A 400-character word has no whitespace to break on: it must still be split.
            {"id": "tx", "type": "text", "config": {"content": _LONG_TEXT + "\n\n" + "x" * 400}},
            {"id": "ca", "type": "callout", "config": {"type": "info", "title": _LONG_TEXT, "content": _LONG_TEXT}},
            {"id": "me", "type": "metrics", "config": {"source": "df", "metrics": f"{_LONG_TEXT}: len(df['time'])"}},
            {"id": "ta", "type": "table", "config": {"source": "df", "caption": _LONG_TEXT, "max_rows": 3}},
            {
                "id": "lp",
                "type": "lineplot",
                "config": {"source": "df", "x": "time", "y": "sig", "title": _LONG_TEXT, "unit": _LONG_TEXT},
            },
        ],
    }


def test_long_author_text_fits_the_line_limit_before_and_after_formatting() -> None:
    """Author-supplied text is split across lines: the user cannot fix an over-long line (GEN-16)."""
    module = compile_recipe(_long_text_recipe())
    assert validate_generated_module_source(module.source) == []

    formatted = format_module(module)
    assert formatted.warning is None
    assert validate_generated_module_source(formatted.source) == []


def test_long_author_text_is_preserved_verbatim_once_executed() -> None:
    """Splitting a literal is a source-layout concern only: the runtime value is unchanged."""
    formatted = format_module(compile_recipe(_long_text_recipe()))
    runtime = safe_execute(formatted.source, timeout_seconds=10, max_memory_mb=256)
    assert runtime.success, runtime.error
    marker_index = runtime.output.rfind(MODULE_RESULT_MARKER)
    document = json.loads(runtime.output[marker_index + len(MODULE_RESULT_MARKER):])["document"]

    by_id = {item["block_id"]: item for item in document}
    assert by_id["se"]["title"] == _LONG_TEXT
    assert by_id["tx"]["content"] == _LONG_TEXT + "\n\n" + "x" * 400
    assert by_id["ca"]["content"] == _LONG_TEXT
    assert by_id["me"]["spec"]["items"][0]["label"] == _LONG_TEXT
    assert by_id["ta"]["spec"]["caption"] == _LONG_TEXT


def _many_blocks_recipe(block_count: int) -> Dict[str, Any]:
    """Return a recipe with one source and ``block_count`` consumer blocks."""
    blocks: List[Dict[str, Any]] = [
        {
            "id": "src",
            "type": "synthetic_source",
            "config": {
                "name": "df",
                "samples": 20,
                "period": 0.1,
                "seed": 1,
                "signals": [{"name": "sig", "unit": "V", "kind": "sine"}],
            },
        }
    ]
    for index in range(block_count):
        blocks.append({"id": f"b{index}", "type": "text", "config": {"content": f"Paragraphe {index}."}})
    return {"id": "many", "name": "Many", "settings": {"title": "Many"}, "blocks": blocks}


def _function_lengths(source: str) -> Dict[str, int]:
    return {
        node.name: node.end_lineno - node.lineno + 1
        for node in ast.parse(source).body
        if isinstance(node, ast.FunctionDef)
    }


def test_build_report_stays_short_whatever_the_block_count() -> None:
    """Blocks are compiled to one function each, so the entry point does not grow (GEN-16)."""
    small = _function_lengths(compile_recipe(_many_blocks_recipe(2)).source)
    large = _function_lengths(compile_recipe(_many_blocks_recipe(60)).source)

    assert small["build_report"] == large["build_report"]
    assert large["build_report"] <= 25, large["build_report"]

    block_functions = {name: length for name, length in large.items() if name.startswith("_bb_block_")}
    assert len(block_functions) == 61
    assert max(block_functions.values()) <= 40, block_functions


def test_each_block_runs_in_its_own_function() -> None:
    """A failing block must not prevent the next ones from running (DEF-11)."""
    recipe = _many_blocks_recipe(2)
    recipe["blocks"].append(
        {"id": "boom", "type": "python", "config": {"code": "raise ValueError('boom')", "inputs": ["df"]}}
    )
    recipe["blocks"].append({"id": "after", "type": "text", "config": {"content": "Toujours la."}})

    formatted = format_module(compile_recipe(recipe))
    runtime = safe_execute(formatted.source, timeout_seconds=10, max_memory_mb=256)
    assert runtime.success, runtime.error
    marker_index = runtime.output.rfind(MODULE_RESULT_MARKER)
    document = json.loads(runtime.output[marker_index + len(MODULE_RESULT_MARKER):])["document"]

    by_id = {item["block_id"]: item for item in document}
    assert by_id["boom"]["kind"] == "error"
    assert "boom" in by_id["boom"]["message"]
    assert by_id["after"]["kind"] == "text"


def _python_block_recipe(author: str, code: str = "return {'columns': [], 'rows': []}") -> Dict[str, Any]:
    """Return a minimal recipe holding one inlined Python block, authored by ``author``."""
    return {
        "id": "authored",
        "name": "Authored",
        "settings": {"title": "Authored", "author": author},
        "blocks": [
            {
                "id": "src",
                "type": "synthetic_source",
                "config": {
                    "name": "df",
                    "samples": 10,
                    "period": 0.1,
                    "seed": 1,
                    "signals": [{"name": "sig", "unit": "V", "kind": "sine"}],
                },
            },
            {"id": "py", "type": "python", "config": {"code": code, "inputs": ["df"], "output": "table"}},
        ],
    }


def test_inlined_region_marker_carries_block_author_and_hash() -> None:
    """A reviewer must be able to trace an inlined region back to its three identifiers (GEN-15)."""
    code = "return {'columns': ['a'], 'rows': [[1.0]]}"
    source = compile_recipe(_python_block_recipe("Jane Doe", code)).source
    expected_hash = hashlib.sha256(code.encode("utf-8")).hexdigest()

    assert "# >>> user region: block 'py' (author-supplied, reviewed by AST allowlist)" in source
    assert "# author: Jane Doe" in source
    assert f"# source sha256: {expected_hash}" in source
    assert "# <<< user region: block 'py'" in source


def test_inlined_region_marker_falls_back_to_a_placeholder_author() -> None:
    source = compile_recipe(_python_block_recipe("   ")).source
    assert "# author: unknown" in source


def test_author_label_cannot_inject_code_in_the_marker() -> None:
    """The author label is free text from the recipe: it must never end the comment (SEC-03)."""
    hostile = "Jane\nimport os\nos.system('id')  #"
    module = compile_recipe(_python_block_recipe(hostile))

    # The hostile text survives as inert words in a comment, never as a statement.
    assert "# author: Jane import os os.system('id') #" in module.source
    imported = {
        alias.name
        for node in ast.walk(ast.parse(module.source))
        if isinstance(node, ast.Import)
        for alias in node.names
    }
    assert "os" not in imported, imported
    assert validate_generated_module_source(module.source) == []
    assert check_code_safety(module.source)["safe"]


def test_recipe_text_cannot_escape_the_module_docstring() -> None:
    """Title and author are attacker-controlled: a quote run must not end the header (SEC-03)."""
    hostile = 'X """\nprint(1)\n"""'
    recipe = _python_block_recipe(hostile)
    recipe["settings"]["title"] = hostile

    module = compile_recipe(recipe)
    header = ast.get_docstring(ast.parse(module.source))

    assert header is not None
    assert "print(1)" in header, header
    assert validate_generated_module_source(module.source) == []
    assert check_code_safety(module.source)["safe"]


def test_author_label_is_truncated_to_keep_the_marker_on_one_line() -> None:
    source = compile_recipe(_python_block_recipe("A" * 400)).source
    marker = next(line for line in source.splitlines() if line.strip().startswith("# author:"))
    assert len(marker) <= 120
