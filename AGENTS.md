# AGENTS.md

Entry point for coding agents. The durable knowledge lives in `.okf/`, an Open
Knowledge Format v0.2 bundle. Nothing reads that directory on its own, so start
here.

**Read `.okf/index.md` first.** It maps every concept: architecture, runbooks,
decision records, policies, and roadmap. Open the concepts your task touches
rather than the whole bundle. The bundle is written in French; the code and its
docstrings are in English.

Before writing any code, read `.okf/policies/agent-working-method.md`. It states
what to announce before editing and what to verify after.

## What this is

Baltimore Bird: a web platform for exploring and reporting on automotive
time-series data (MF4, CAN bus). Flask backend, vanilla JS frontend built by
Vite, single-page app. Live at baltimorebird.cloud.

## Traps you cannot infer from the code

These cost hours if you learn them the hard way. Each has a concept behind it.

- **nginx serves `src/frontend/dist/`, not your edit.** Without `npm run build`
  your change is invisible and nothing reports an error.
  See `.okf/workflows/build-and-deploy.md`.
- **There is no test suite.** No root `pytest.ini` or `pyproject.toml`; tests run
  file by file from `src/backend`. See `.okf/workflows/testing.md`.
- **`rust_mdf_parser` is an optional dependency absent from `requirements.txt`.**
  Without it everything still works, through the asammdf fallback, roughly two
  orders of magnitude slower and silently. Check an index's `backend` field
  before investigating any slowness. See `.okf/architecture/mf4-reading.md`.
- **Production runs a single gunicorn worker on purpose.** EDA sessions and
  conversion tasks live in process memory. Never propose adding workers.
  See `.okf/decisions/0002-single-gunicorn-worker.md`.
- **Views arrive by DOM mutation.** Fragments are injected after load, so a
  selector resolved at document load finds nothing.
  See `.okf/decisions/0003-vanilla-js-no-framework.md`.

## Hard rules

User-supplied code is never imported or evaluated by the application process.
Expressions go through the AST allowlist interpreter in `computed.py` and
nothing else. `.okf/policies/security-invariants.md` is not negotiable.

Python: PEP 8 with 120-character lines, PEP 484 type hints, Google-style
docstrings in English, logging over print, no boilerplate comments, no emoji
anywhere. User-facing strings and errors are in French. Full list in
`.okf/policies/code-conventions.md`.

## Editing the bundle

CI runs `python3 scripts/okf_validate.py .okf --strict`, where warnings are
errors. A new concept must be added to `.okf/index.md` in the same commit or it
is flagged as orphaned. See `.okf/workflows/okf-bundle.md` for the rest.
