# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Baltimore Bird: a web platform for exploring and reporting on automotive time-series data
(MF4/CAN bus). Flask backend + Vanilla JS (Vite) frontend, single-page app style. Live at
baltimorebird.cloud.

## Before generating code

Read (in order, as needed for the task):
- `docs/poc/functional-specification.md` — functional requirements for the **Dashboard Builder**
  PoC (the block-based report editor: recipes, compilation, sandboxed execution, HTML export).
  This is the authoritative spec for that subsystem — read it before touching anything under
  `services/dashboard/` or the `/api/scripts/*` routes.
- `docs/poc/coding-standards.md` and `docs/poc/performance-optimisation.md` — MINT engineering
  standards, summarized below.
- `docs/poc/business-context.md` — why the tool exists, who it's for.

## Commands

### Backend (`src/backend/`)

```bash
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env      # fill in AUTH_SECRET_KEY, CORS_ORIGINS for prod
python server.py          # http://localhost:5000, boots with 2 demo sources
```

Backend tests are plain scripts run with pytest or directly, not a single suite:
```bash
cd src/backend
python -m pytest api/test_computed_formula.py
python -m pytest api/test_zone_stats.py
python -m pytest services/dashboard/test_dashboard.py   # dashboard builder compiler pipeline
```
There is no root `pytest.ini`/`pyproject.toml` — run individual test files directly.

End-to-end smoke test (needs a running backend):
```bash
pip install -r tests/requirements-dev.txt
python tests/smoke_test.py [--base-url http://localhost:5000]
```
Exercises auth, uploads, lazy EDA sessions, and `/api/view` access control. Run before any
deployment. Test accounts are timestamped/disposable; reset by deleting
`src/backend/data/auth/users.db`.

### Frontend (`src/frontend/`)

```bash
bun install        # or npm install
bun run dev         # http://localhost:5173, proxies /api to :5000
bun run build        # emits dist/, copies views/ and components/ in via a Vite plugin
bun run test          # vitest run (jsdom env, config in vitest.config.js)
bun run test:watch
```

### Production

Single gunicorn worker only (`-w 1 --threads 8`) — conversion tasks and EDA sessions live in
process memory, so multiple workers would not share state. See README.md for the full
nginx/systemd deployment recipe.

## Architecture

### Backend layout (`src/backend/`)

- `server.py` — Flask app factory (`create_app`), registers CORS, middleware, blueprints, error
  handlers, and starts a daemon maintenance thread (purges expired lazy-EDA sessions, orphan temp
  files, old conversion/concat tasks every 10 min).
- `config.py` — all configuration constants in one module (paths, quotas, sandbox limits, CORS,
  auth). Loads `.env` via `python-dotenv`. No config elsewhere.
- `api/` — Flask blueprints, one per feature area, registered in `api/__init__.py`. Route
  handlers are thin; business logic lives in `data_management/` and `services/`.
  - **`api/scripts.py` implements the Dashboard Builder** (routes under `/api/scripts/*`): create/
    edit block-based "scripts" (= dashboard recipes), compile them to Python
    (`services/dashboard/compiler.py`), execute them in the sandbox, and export standalone HTML
    reports. The blueprint is named `scripts` for historical reasons — this is the block/recipe/
    compile/run system, not a code-snippet manager.
  - `api/computed.py` — reference implementation of the AST-allowlist static analyzer used to
    validate user-authored Python (formulas, dashboard Python blocks) before it ever runs. This
    is the security boundary referenced throughout the functional spec (`SEC-01..11`).
- `services/` — heavier business logic and I/O-adjacent code: `sandbox.py` (confined execution of
  user code: AST validation + subprocess), `dashboard/` (block catalogue, compiler, synthetic
  data generator, HTML report generator, escape-corpus security tests), `storage.py`
  (per-user file storage with quotas), `conversion.py`/`mat_ingest.py`/`blf_ingest.py` (format
  conversion), `metrics.py`.
- `data_management/` — the EDA data layer: `datastore.py` (multi-source registry: MF4 demo,
  synthetic, user uploads), `sessions.py` (`LazyEDAManager`/`LazySession` — signals are loaded
  from MF4 **on demand per channel**, not eagerly, to bound memory for multi-GB recordings;
  capped at `LAZY_EDA_MAX_SESSIONS`, evicted after `LAZY_EDA_SESSION_TIMEOUT`), `loaders.py`,
  `mf4_source.py`, `event_comments.py`, `maintenance.py`.
- `core/` — small cross-cutting utilities: security helpers (path/filename/UUID sanitization,
  JSON-bomb depth checks), time utils, exception types. Import from `core` rather than
  reimplementing sanitization.
- `middleware/` — security headers and request metrics, registered once in `server.py`.
- `dashboard/` — **not part of this branch's tree** (only stale `__pycache__` artifacts may be
  present on disk from switching branches). A newer, more elaborate dashboard-builder
  implementation (`catalogue/`, `report/`, `runtime/bbrt/`) exists on other branches
  (e.g. `gpo-first-run`); don't assume it's live here — check `git log --oneline -- <path>`
  before relying on anything under `src/backend/dashboard/`.

Downsampling for interactive plotting (LTTB, Numba-accelerated) lives in `core/downsampling.py`
and is what keeps multi-million-point signals responsive client-side.

### Frontend layout (`src/frontend/`)

Vanilla JS, no framework (deliberate choice per the functional spec — a React design system is
Renault's longer-term plan, out of scope for now). Vite bundles `src/main.js`, which imports
modules in a **preserved order** (see comments in that file) rather than relying on a router.

- `src/core/` — cross-cutting: `state.js`, `view-loader.js` (lazy-loads `views/*.html` fragments
  on demand/hover, calls a per-view `init*()` function), `auth.js`, `nav.js`, `telemetry.js`.
- `src/eda/` — the EDA (signal exploration) view, the largest and oldest part of the frontend;
  split out of a former monolithic `app.js`. Modules communicate via ESM imports internally, and
  via `window.*` globals (declared in `.eslintrc.json`) for legacy code not yet migrated.
- `src/views/` — the other top-level views (`dashboard.js`, `reports.js`, `settings.js`,
  `storage.js`), each paired with an HTML fragment in `views/*.html` loaded by `ViewLoader`.
- `views/*.html` and `components/modals/*.html` — HTML fragments, not full pages; fetched and
  injected by `ViewLoader`, then copied into `dist/` by a custom Vite plugin at build time (Vite
  doesn't do this by default since they're not referenced from `index.html`).
- `styles/` — SCSS, structured by view/abstraction (`abstracts/`, `core/`, `eda/`, `views/`).

### Dashboard Builder concepts (if working in this area)

The Dashboard Builder compiles a user-composed graph ("recipe": blocks + typed links + variable
mapping) into a Python module, then executes that module **outside the Flask process** — in a
sandboxed subprocess — before rendering a standalone HTML report. Two invariants drive every
design decision here (see functional spec §1, §10):
- **Auditability**: the generated Python is always shown to the user; no hidden runtime step.
- **Containment**: user-authored Python (in a "Python block") is hostile input by construction —
  it's statically AST-validated against an allowlist (see `api/computed.py`,
  `services/sandbox.py`), then run in a child process, never imported/eval'd by the app.
- Data blocks in the PoC are **synthetic only** — no real MF4/CAN ingestion in dashboards yet;
  see functional-spec §3.2 for what's explicitly excluded from scope.

## MINT coding standards (backend Python)

Full detail in `docs/poc/coding-standards.md`; the load-bearing rules:
- PEP 8 via Black, **120-char line limit**.
- **Type hints mandatory** on every function/method (PEP 484).
- **Google-style docstrings, in English.** User-facing strings/errors are in **French**
  (see the `jsonify({"error": "..."})` messages in `server.py` for the pattern).
- Polars over Pandas for tabular data; lazy (`LazyFrame`) only when needed for out-of-core work.
  Never fully load a file > 100 MB into memory without streaming.
- Functions ≤ ~40 lines; decompose rather than grow. Apply DRY and the Single
  Responsibility Principle: one module/class/function, one reason to change.
- `eval`/`exec` forbidden outside the sandboxed dashboard runner's own controlled entry point.
- No secrets in source — `.env` only. No bare `except Exception` without a re-raise; exceptions
  are typed and specific.
- Fail fast: raise on invalid precondition rather than propagating `None`/empty defaults;
  `assert` is for internal invariants only, never for validating external/user input.

## Working method

Before coding, state briefly: the impacted requirements (by spec reference), an implementation
plan, the acceptance criteria, and the list of impacted modules.

After coding: verify the result against those requirements, propose unit tests for what you
added, and explain the design choices you made.

## Codacy MCP server

When the Codacy MCP server is available, treat its analysis as part of finishing an edit:

- After a successful file edit, run `codacy_cli_analyze` for that file (`rootPath` = workspace
  path as a plain, non-URL-encoded filesystem path; `file` = edited file; leave `tool` unset),
  and fix any issues it reports on the new code. Repeat per modified file; don't wait to be asked.
- After any dependency change (`npm/yarn/pnpm install`, `requirements.txt`, `package.json`,
  `pom.xml`, `build.gradle`), run `codacy_cli_analyze` with `tool: "trivy"` and no `file`. If it
  finds vulnerabilities in the newly added packages, stop and resolve them before continuing.
- Only send `provider`/`organization`/`repository` when the project is a git repository. On a 404
  from a call using those, offer to run `codacy_setup_repository` (never run it unprompted), then
  retry the failed action once.
- If the CLI is not installed, ask the user before running `codacy_cli_install`, and wait for the
  answer. Never install it via brew/npm/npx.
- Skip analysis of duplication, complexity *metrics*, and coverage — complexity *issues* are in
  scope, the metric is not.
- If the MCP server is unreachable, suggest resetting the MCP in the extension, checking
  Settings > Copilot > Enable MCP servers (https://github.com/settings/copilot/features, which
  may require an org admin), then contacting Codacy support.
