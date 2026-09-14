"""Baltimore Bird - Dashboard Builder services.

This package turns a declarative dashboard *recipe* (a tree of typed blocks persisted as
JSON) into an auditable, self-contained Python module and a standalone HTML report.

The public surface is intentionally small:

- :func:`compile_recipe` - pure transformation of a validated recipe into a Python module.
- :func:`validate_recipe` - static validation of a recipe (blocks, configs, mapping).
- :func:`build_html_report` - assembles a standalone HTML report from run artefacts.
- :data:`BLOCK_REGISTRY` - the declarative catalogue of supported block types.

Design constraints (see docs/poc/functional-specification.md):

- The generated module imports only from the runner allowlist (numpy). Figure
  specifications are emitted as plain JSON-compatible dictionaries (Plotly schema), never
  as HTML or JavaScript, so rendering happens client-side.
- Compilation is deterministic: the same recipe yields byte-identical source, whose hash is
  recorded for report provenance.
"""

from .blocks import BLOCK_REGISTRY, BlockSpec, block_schema, validate_block
from .compiler import CompiledModule, compile_recipe, validate_generated_module_source, validate_recipe
from .report import build_html_report
from .security_corpus import EscapeCase, evaluate_escape_corpus, get_escape_corpus
from .synthetic import SyntheticSignal, describe_synthetic_source

__all__ = [
    "BLOCK_REGISTRY",
    "BlockSpec",
    "block_schema",
    "validate_block",
    "CompiledModule",
    "compile_recipe",
    "validate_generated_module_source",
    "validate_recipe",
    "build_html_report",
    "EscapeCase",
    "get_escape_corpus",
    "evaluate_escape_corpus",
    "SyntheticSignal",
    "describe_synthetic_source",
]
