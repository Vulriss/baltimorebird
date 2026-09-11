# Baltimore Bird — Hybrid Dashboard Builder — Functional Specification (PoC)

> **Purpose of this file.** This is the consolidated, development-facing functional
> specification for the Baltimore Bird **Dashboard Builder** Proof of Concept (PoC).
> It is written to be read by GitHub Copilot (and human developers) while implementing
> the requested features. It merges the formal software specification
> (`baltimore_bird_capge.pdf`, v0.2), the framing/kick-off meeting
> (`POC développement outil Renault pour lot B WP745.pdf`), the client review notes
> (`mail.docx`), and the MINT engineering standards for Python, performance and UX/UI.
>
> **Language convention.** Developer documentation and code comments are written in
> **English**; user-facing documentation and error messages shown to end users are in
> **French** (see [§14](#14-non-functional-requirements) and [§16](#16-uxui-guidelines)).
>
> **Golden rule for implementation.** Implement **only** what is inside the PoC
> perimeter ([§3](#3-poc-perimeter)). Several chapters of the source specification are
> *informative only* and **must NOT be implemented** for the PoC (roles, real data
> sources, the data-dictionary variable mapping). These are called out explicitly below.

---

## 1. Context and vision

Baltimore Bird provides interactive exploration of automotive time-series measurements
(MF4, BLF/CAN). Today the exploration is transient: an engineer opens a file, builds a
layout, reads the signals, closes the session. Anything that must be **repeated** across
measurement campaigns or **shared** as a deliverable currently falls back to external
tooling (Excel, notebooks, screenshots) or to **ORIOLE**, the legacy desktop report
builder that Baltimore Bird is expected to replace in a web form.

The **Dashboard** area of the web application is currently a placeholder. The targeted
capability is the **dynamic construction of reports**: a user assembles a directed graph
of typed **blocks** (data, transformations, figures, layout); the platform compiles that
graph into auditable Python; the module is executed **outside** the application process;
and a **standalone HTML report** is produced.

The builder is **hybrid**: the declarative block catalogue covers common analyses with
no code, and a **Python block** covers everything else at the price of a stricter
execution regime. Both coexist in the same graph and compile into the same module.

Two properties are non-negotiable and drive the whole design:

- **Auditability** — the code executed for a dashboard is always inspectable by the user.
  No hidden runtime, no opaque interpreter step.
- **Containment** — user-supplied Python is treated as **hostile input**. The application
  process never evaluates it.

---

## 2. Users and roles — INFORMATIVE ONLY 

> **Client clarification :** the entire roles/authorization chapter is
> informative in the specification. It is **not implemented today and must not be
> implemented for the PoC.** Because the PoC uses synthetic data with no access control,
> persisted recipes are shared across all users.

For reference/target only (not PoC work):

| Role | Authorization |
| --- | --- |
| Anonymous session | No access to declarative dashboards |
| Author | Read & Write — personal only (default authenticated user) |
| Advanced author | Read & Write — global (per-user grant, off by default) |
| Administrator | Full admin, reads execution audit log |

Target requirements `ROL-01..04` (server-side role checks, per-user grants, separation of
"author a Python block" vs "execute a dashboard with one") are **out of PoC scope**.

---

## 3. PoC perimeter

### 3.1 The four pillars

| # | Pillar | Content | Req. groups |
| --- | --- | --- | --- |
| 01 | **Graphical editor** | Block system with intuitive drag-and-drop, formatting blocks, table blocks, line-plot blocks, Python code blocks | `EDT`, `BLK` |
| 02 | **Code generation** | Variable mapping (a name for every input datum), generation of each block's Python using the right library, inclusion of user code blocks as written | `MAP`, `GEN`, `DEF` |
| 03 | **Confined execution** | Isolation between users (no data leakage) and from the system (no secret leakage, no malicious action, no privilege escalation). Resource limits deferred (see §3.3) | `SEC` |
| 04 | **HTML report** | Standalone HTML file needing no server data load, interactive charts, interactive tables | `HTM` |

### 3.2 Explicitly EXCLUDED from the PoC (do NOT implement)

- **Real measurement sources**: MF4, BLF/CAN, computed variables, events, tabular import.
  → The PoC runs on **synthetic data generated at run time** (behind the same port
  contract, so real sources can slot in later unchanged).
- **Figure families other than line plot and table**: bar, scatter, 1D/2D histogram, box plot.
- **Numerical analysis blocks**: FFT, KDE, filtering, smoothing.
- **Confinement by hardened container or micro-VM** (Archi #2 / #3 — see §11).
- **Runner resource limits**: CPU time, memory ceiling, execution duration, concurrency.
  A Python block may consume PoC-host resources until cancelled manually. Accepted for the
  PoC on a dedicated host; first item of the post-PoC sequence.
- **A4 print layout** of the report.
- **Exports other than HTML**: PDF, XLSX, PPTX, CSV, Parquet.
- Parameters/interactive controls, result caching, sharing model, template gallery,
  scheduling, multi-run comparison.
- The **data-dictionary / internal-name variable mapping feature** (renaming an internal
  parameter name to propagate across reports) — this feature does not exist and, with
  synthetic data only, **does not apply to the PoC** (`mail.docx`).

### 3.3 PoC exit criteria

| ID | Criterion |
| --- | --- |
| `EXIT-01` | A user composes, **by drag and drop only**, a document made of a title, a text section, a table and a line chart bound to a synthetic dataset. |
| `EXIT-02` | The same document contains at least one **Python code block** consuming the mapped variables and producing a figure or a table. |
| `EXIT-03` | The generated Python module is **shown to the user**, is syntactically valid, passes the project linting rules, and is executable outside the platform. |
| `EXIT-04` | The module executes in the **confined runner**, outside the application process; a failing block is reported with an explicit cause and does not bring down the platform. |
| `EXIT-05` | The **escape corpus** is executed against the static analyser and the runner; every case is refused before execution or contained, and each result is documented (including cases known to be uncontained under Archi #1). |
| `EXIT-06` | A **standalone HTML report** is produced, opens in a browser, and its charts and tables remain interactive. |

---

## 4. Vocabulary

| Term | Definition |
| --- | --- |
| **Dashboard** | A named, persisted analysis surface owned by a user. |
| **Block** | The atomic unit of computation: a type, a validated configuration, typed input ports, typed output ports. |
| **Port** | A typed connection point carrying one of: `Frame`, `Series`, `Scalar`, `Figure`, `Table`. |
| **Link** | A directed edge between an output port and a compatible input port. |
| **Graph** | The directed acyclic graph formed by the blocks and links of a dashboard. |
| **Recipe** | The serialised, versioned **JSON** description of a dashboard: blocks, configurations, links, layout, mapping. Contains no executable code outside the declared code blocks. |
| **Mapping** | The association between an input datum and the variable name under which it is exposed to generated code and user code blocks. |
| **Compilation** | The pure transformation of a recipe into a Python module. |
| **Generated module** | The Python module produced by compilation. Once it inlines a user code block, it is **untrusted as a whole**. |
| **Run** | One execution of a compiled module, producing artefacts. |
| **Artefact** | Any output of a run: figure specification, table, scalar, report file. |
| **Runner** | The isolated OS process in which the generated module is executed. |

---

## 5. Run states

| State | Meaning |
| --- | --- |
| `Invalid` | Static validation failed. No code generated, nothing executed. |
| `Running` | Executing. Per-block progress reported. |
| `Partial` | At least one block failed; upstream results remain available, downstream blocks reported as skipped, failure cause attached to the failing block. |
| `Succeeded` | Every block produced its declared outputs. |
| `Failed` | The run aborted: runner failure or engine error. |
| `Cancelled` | Interrupted by the user or by session teardown. |

| ID | Requirement | Pr. |
| --- | --- | --- |
| `LIF-01` | A run is cancellable at any time; cancellation terminates the runner's process group within **1 s**. | M |
| `LIF-02` | A failed block never blocks rendering of the document parts that do not depend on it. | M |
| `LIF-03` | A run leaves the recipe unchanged. Executing never rewrites what the user composed. | M |

---

## 6. Graphical editor (Pillar 01)

The editor manipulates **the recipe only**; it never compiles, never executes and never
decides an authorization.

| ID | Requirement | Pr. |
| --- | --- | --- |
| `EDT-01` | A categorised, searchable block palette; a block is added by **drag and drop** onto the canvas. | M |
| `EDT-02` | Blocks are moved by drag; links are created by dragging from an output port to an input port; an **incompatible target is visually refused during the drag, before the drop**. | M |
| `EDT-03` | An inspector panel edits the configuration of the selected block, with **per-field** validation feedback attached to the field. | M |
| `EDT-04` | Validation errors are rendered **on the block** in the canvas and aggregated in a problem list that navigates to the offending block. | M |
| `EDT-05` | **Undo/redo** cover every editing operation, including block deletion and link removal. | M |
| `EDT-06` | Copy, paste and duplicate of a block or selection, preserving internal links and remapping identifiers deterministically. | S |
| `EDT-07` | Canvas pan, zoom and fit-to-content. | S |
| `EDT-08` | A block displays its state (valid, invalid, running, succeeded, failed, skipped) without opening it. | M |
| `EDT-09` | The document preview and the canvas are two views of the **same recipe**; the preview reflects the layout blocks in document order. | M |
| `EDT-10` | The editor never sends a partially typed configuration to the compiler; compilation is triggered explicitly or on a debounced valid state. | M |

---

## 7. Block catalogue (Pillar 01 / 02)

Each block declares a stable type identifier, a configuration schema, and its input/output
port types. Priority uses MoSCoW: **M = Must**, **S = Should**, **C = Could**.

### 7.1 General block requirements

| ID | Requirement | Pr. |
| --- | --- | --- |
| `BLK-GEN-01` | Every block declares its configuration as a typed schema **validated server-side before compilation**. Unknown/malformed field = validation error, never silently ignored. | M |
| `BLK-GEN-02` | Every block is a **pure function** of its inputs and configuration. No block mutates inputs, reads global state, or writes to the filesystem outside its declared artefact outputs. | M |
| `BLK-GEN-03` | Every block declares the **output schema** it produces from its input schema, so the graph can be validated statically without reading data. | M |
| `BLK-GEN-04` | Adding a block type requires no change to the compiler, executor or front-end catalogue: **registration is declarative**. | M |
| `BLK-GEN-05` | A block declares the Python library it compiles against and never emits code for a library absent from the runner's pinned dependency set. | M |

### 7.2 Data blocks — synthetic only for the PoC

| ID | Requirement | Pr. |
| --- | --- | --- |
| `BLK-DAT-01` | **Synthetic source block**: generates a deterministic dataset from a declared shape (sample count, sampling period, signal definitions) and a declared **seed**, producing a `Frame` with a `float64` time column and `float32` value columns. | M |
| `BLK-DAT-02` | The generated dataset is **reproducible**: same configuration + seed ⇒ identical values across runs and hosts. | M |
| `BLK-DAT-03` | The block exposes signal **names and units** in its output schema, so downstream blocks and figure labels behave as with a real source. | M |
| `BLK-DAT-04` | Every data block output is exposed through the variable mapping (`MAP-01`) under a user-controlled name. | M |

### 7.3 Transformation blocks (Polars)

| ID | Requirement | Pr. |
| --- | --- | --- |
| `BLK-TRF-01` | Select and rename columns. | M |
| `BLK-TRF-02` | Filter rows by a **declarative** predicate (column, operator from a fixed set, literal or second column). Predicates combine with explicit AND/OR. **No free-text expression is evaluated.** | M |
| `BLK-TRF-03` | Derive a column from a **declarative arithmetic** combination of columns/literals, with explicit output name and dtype. | M |
| `BLK-TRF-04` | Resample to a fixed time step with an explicit interpolation policy (previous, linear, none) and explicit gap handling. | M |
| `BLK-TRF-05` | No transformation drops nulls implicitly. Null handling is declared per block. | M |
| `BLK-TRF-06` | Every transformation compiles to **Polars lazy expressions**; the chain collects once, at the boundary where materialisation is required. | M |

### 7.4 Visualisation blocks (Plotly)

| ID | Requirement | Pr. |
| --- | --- | --- |
| `BLK-VIZ-01` | **Time-series chart** with multiple traces, dual axis, declared units, legend configuration. | M |
| `BLK-VIZ-02` | **Data table** with column formatting, sorting, and a hard row cap with explicit truncation notice. | M |
| `BLK-VIZ-03` | Every visualisation block emits a **Plotly figure specification as data (JSON)**, never as HTML or JavaScript. Rendering is client-side from that spec. | M |
| `BLK-VIZ-04` | Every visualisation block enforces a **max point count per trace** and applies decimation before emitting the figure, reporting the decimation ratio in figure metadata. | M |
| `BLK-VIZ-05` | Colour palettes come from **active theme tokens**; a figure never hard-codes a colour that breaks under the alternate theme. | M |
| `BLK-VIZ-06` | Axis units and signal names propagate from input schema to figure labels without manual retyping. | S |

### 7.5 Layout and formatting blocks

| ID | Requirement | Pr. |
| --- | --- | --- |
| `BLK-LAY-01` | **Title block**: report title, subtitle and author fields, rendered at the top of the report. | M |
| `BLK-LAY-02` | **Document section block**: a named section with a declared heading level, contributing an entry to the report table of contents. | M |
| `BLK-LAY-03` | **Text block** with a restricted, **sanitised markdown subset** and interpolation of scalar values by explicit reference. | M |
| `BLK-LAY-04` | Document order is explicit and editable, independent of block positions on the canvas. | M |

### 7.6 Report block

| ID | Requirement | Pr. |
| --- | --- | --- |
| `BLK-REP-01` | **Standalone HTML export** embedding figure specs and data, openable without the platform. Detailed in §12. | M |
| `BLK-REP-02` | The report embeds a **provenance block**: recipe id + version, variable mapping, generated-module hash, platform version, generation timestamp. | M |

### 7.7 Python code blocks

| ID | Requirement | Pr. |
| --- | --- | --- |
| `BLK-CUS-01` | **Python block**: a user-authored function body receiving the mapped variables it declares and returning a declared output type. Inlined per `GEN-11`, executed **only** in the confined runner. | M |
| `BLK-CUS-02` | The editor provides syntax highlighting, the declared signature as a read-only preamble, the list of mapped variables in scope, and the **import allowlist** (`SEC-11`) visible to the author. | M |
| `BLK-CUS-03` | A Python block declares its **output schema** explicitly. The returned object is validated against it and rejected on mismatch, keeping graph validation static. | M |
| `BLK-CUS-04` | A figure produced by a Python block is accepted **only** as a figure specification validated against the same schema as a declarative figure. | M |

---

## 8. Variable mapping (Pillar 02)

Every input datum receives a name. The mapping is the contract between the graph and the
code, and the only namespace visible to a user code block.

> **PoC scope note (`mail.docx`):** the *mapping mechanism inside a dashboard* (below) is
> in scope. The separate **application-wide data dictionary** (internal-name ⇄ source-name
> correspondence, cross-report rename propagation) is **out of PoC scope** — it does not
> exist and does not apply with synthetic data.

| ID | Requirement | Pr. |
| --- | --- | --- |
| `MAP-01` | Every dataset entering the graph, and every intermediate result explicitly promoted by the user, receives a **unique variable name** chosen by the user. | M |
| `MAP-02` | A variable name is validated as a **Python identifier**: no reserved word, no leading digit, no collision with the compiler-reserved prefix, no collision with an allowlisted import alias. A rejected name is refused at edit time with the reason. | M |
| `MAP-03` | The mapping is displayed as a table in the editor: variable name, bound block output, dtype, unit, sample count. | M |
| `MAP-04` | Renaming a variable propagates to generated code and every configuration referencing it. It does **not** rewrite a user code block; instead, affected Python blocks are flagged as referencing an unknown name, and the run is refused until the author updates them. | M |
| `MAP-05` | A Python block declares the variables it consumes. Only those exist in its namespace at execution; an undeclared variable is not passed. | M |
| `MAP-06` | The mapping is persisted in the recipe and reproduced in the report provenance block. | M |

---

## 9. Execution model and code generation (Pillar 02)

### 9.1 Graph model and static validation

| ID | Requirement | Pr. |
| --- | --- | --- |
| `GRF-01` | The graph is **directed and acyclic**. Cycle detection runs on every edit and refuses the edit that would close a cycle, naming the blocks involved. | M |
| `GRF-02` | A link is accepted only if output port type is compatible with input port type. Compatibility is explicit; **no implicit conversion** between `Frame`, `Series`, `Scalar`. | M |
| `GRF-03` | Schemas propagate through the graph at edit time. A block whose configuration references a column absent from its resolved input schema is flagged immediately, before any run. | M |
| `GRF-04` | Static validation reports **every** error in one pass, attached to the offending block, rather than aborting on the first. | M |
| `GRF-05` | A graph containing at least one invalid block is never compiled and never executed. | M |
| `GRF-06` | Execution order is a deterministic topological order. Two runs of the same recipe on the same data produce the same order. | M |
| `GRF-07` | A Python block's output schema is taken from its declaration (`BLK-CUS-03`), never inferred from execution, so static validation is possible without running user code. | M |

### 9.2 Compilation contract

The compiler is a **pure function** from a validated recipe to a Python module. No side
effects, no I/O, and it never executes what it produces.

| ID | Requirement | Pr. |
| --- | --- | --- |
| `GEN-01` | The generated module follows the project Python standards: **PEP 8 with a 120-char line limit**, **PEP 484** annotations on every function signature, no boilerplate comment, no emoji. | M |
| `GEN-02` | Compilation is **deterministic and reproducible**: the same recipe yields byte-identical source. The source hash is recorded in the provenance block. | M |
| `GEN-03` | Each block compiles to **one module-level function** with an explicit signature and return type, no reliance on module globals. Block outputs are passed as arguments. | M |
| `GEN-04` | Generated identifiers derive from the block label through a slug function guaranteed to yield a valid, non-colliding Python identifier; collisions resolved by a deterministic suffix. Compiler identifiers use a **reserved prefix** the mapping refuses. | M |
| `GEN-05` | No user-provided string other than a declared Python block is ever interpolated into generated source. Configuration values are emitted through a **literal serialiser** that accepts only validated primitives. | M |
| `GEN-06` | Compiler-emitted code contains no `eval`, `exec`, `compile`, `__import__`, dynamic attribute access by name, or import inside a function body. | M |
| `GEN-07` | Imports are emitted at module level from a **fixed allowlist**, sorted deterministically, limited to what the graph uses. | M |
| `GEN-08` | The generated module is **syntax-checked and linted before execution**. A module failing that check due to compiler-emitted code is an engine defect: the run is refused and logged as such, never silently retried. | M |
| `GEN-09` | The generated module is **exportable to the user exactly as executed**, with a pinned dependency list and an entry point. | M |
| `GEN-10` | The generated module is readable by a Python engineer without platform-internal knowledge: the graph structure appears as the call structure of the entry point. | S |

### 9.3 Inlining of user code

The framing session retained inclusion of user code blocks **as written** in the generated
module. This preserves auditability and removes a serialisation boundary, but changes the
trust level of the whole artefact.

| ID | Requirement | Pr. |
| --- | --- | --- |
| `GEN-11` | A Python block is **inlined verbatim** into the generated module, inside a delimited region, as the body of a function whose signature is generated from the declared mapped variables and output type. Indentation is normalised; text otherwise unmodified. | M |
| `GEN-12` | User code is inlined in **statement position only**. Never into an expression, string literal, decorator, default argument, comprehension or format spec. | M |
| `GEN-13` | A generated module that inlines at least one Python block is **untrusted as a whole**. It is never imported, executed, evaluated or introspected by the application process. It is written to the run directory and executed **exclusively by the confined runner**. | M |
| `GEN-14` | Before inlining, the block source is parsed and statically analysed (`SEC-01..03`). A rejected block prevents generation of the entire module; a partially generated module is never written to disk. | M |
| `GEN-15` | Each inlined region is delimited by a stable marker carrying the block id, author and source hash — in both the executed module and the exported script — so a reviewer can separate compiler-emitted from user-authored code. | M |
| `GEN-16` | The exported script carries a header stating it contains user-authored regions that must be reviewed before being executed outside a confined environment. | M |

### 9.4 Defensive programming rules for generated code

These apply to compiler-emitted code and block implementations, **not** to inlined user
regions (which are subject to static analysis and confinement instead).

| ID | Requirement | Pr. |
| --- | --- | --- |
| `DEF-01` | Every generated function validates its **preconditions at entry** (expected columns present, expected dtypes, non-empty input where required). A violated precondition raises a typed, block-scoped exception carrying the block id. | M |
| `DEF-02` | Preconditions use **explicit raises**, never `assert` (removed under optimised interpretation). | M |
| `DEF-03` | **No bare `except`.** Exceptions are caught by narrow type at the block boundary, wrapped with block context and re-raised. | M |
| `DEF-04` | **No implicit type coercion.** Any dtype change is explicit in generated code and visible in block configuration. | M |
| `DEF-05` | **No in-place mutation** of an input Frame. Every transformation returns a new lazy frame. | M |
| `DEF-06` | Division, log, sqrt and comparable partial operations are generated with an explicit **domain guard** producing a declared value (null or configured default), never a silent infinity or unhandled exception. | M |
| `DEF-07` | Exponentiation is generated with an operand/exponent guard, so overflow is reported as a typed error rather than an infinity. | M |
| `DEF-08` | Every order-dependent operation emits an **explicit ordering**. | M |
| `DEF-09` | Every stochastic operation receives an explicit **seed** stored in the recipe. | M |
| `DEF-10` | Time columns are `float64`, value columns `float32` by default. Any deviation is explicit in block configuration. | M |
| `DEF-11` | A block failure is **contained**: it marks its own block failed and successors skipped, and never leaves a partial artefact visible. | M |
| `DEF-12` | Error messages returned to the user identify the block, the rule violated and the offending value, and contain **no filesystem path, platform stack frame or internal id**. | M |
| `DEF-13` | The value returned by an inlined user region crosses back into compiler-emitted code through a **validation function** checking declared type, schema and dtypes before any downstream block consumes it. | M |
| `DEF-14` | An exception raised inside an inlined user region is caught at the region boundary, attributed to its block, and reported with a user-facing traceback limited to the user region. | M |

---

## 10. Confined execution (Pillar 03)

### 10.1 Principles

1. User-supplied code is **hostile input**; it is never evaluated in the application process.
2. Isolation is **layered**; no single mechanism is trusted alone.
3. **Allowlists only** — a denylist of dangerous names, or a text scan, is insufficient.
4. **Least capability** — a block receives only the data it declares: no filesystem, no
   network, no environment, no other session's data.
5. **Honest posture** — where the architecture in force is not a security boundary, this is
   stated in the document, in the interface, and in the deployment constraints.

### 10.2 Threat model (summary)

Remote code execution · static-analysis bypass (aliasing, indirection, encoded literals,
dynamic attribute resolution) · escape by introspection (attribute chain, class hierarchy,
`__globals__`, frame objects) · import-based escape · data exfiltration (network, reading
another session's data/credentials) · persistence (writing where the platform later reads) ·
output injection (figure spec, table cell, text block, HTML report) · supply chain
(unpinned/compromised dependency). **Resource exhaustion by user code is a known threat the
PoC does not address** (see §3.2).

### 10.3 Architecture decision

Three architectures were compared. **Archi #1 (basic confinement)** = static verification
of the code, then execution outside the application process.

| ID | Decision |
| --- | --- |
| `DEC-01` | **Archi #1 is selected for the PoC.** Rationale: time-to-demonstration of the end-to-end chain and reuse of the existing AST evaluator — **not** security adequacy. |
| `DEC-02` | Archi #2 (hardened container) or Archi #3 (micro-VM) is the target for any deployment beyond the PoC host; the choice is settled after the PoC review. |

### 10.4 Archi #1 requirements

Archi #1 combines a **static AST allowlist analysis** of the user source with execution in
a child process outside the application process. Reference implementation of the allowlist
AST evaluator: [src/backend/api/computed.py](src/backend/api/computed.py) (`[R2]`).

| ID | Requirement | Pr. |
| --- | --- | --- |
| `SEC-01` | Static analysis operates on the **abstract syntax tree**, never on source text. Regex scanning of source is **not** acceptable (bypassed by aliasing/indirection/encoded literals; rejects legitimate code containing a watched substring). | M |
| `SEC-02` | The analysis applies an **allowlist of statement and expression node types**. Refused: imports outside the module allowlist; attribute access to dunder names (`__...__`); calls to `eval`, `exec`, `compile`, `__import__`, `globals`, `locals`, `vars`, `getattr`, `setattr`, `delattr`. | M |
| `SEC-03` | The analysis bounds the source: **max length, max node count, max nesting depth**. Exceeding a bound is a refusal before generation. | M |
| `SEC-04` | The refusal message names the **construct and its position** in the user source, so a legitimate author can correct it without guessing. | M |
| `SEC-05` | The generated module is executed in a **child process forked from the worker**, never in the application process or one of its threads. The parent never imports/evaluates the module. | M |
| `SEC-06` | The child becomes leader of its own **process group** and is terminated as a group on completion, cancellation or parent shutdown. | M |
| `SEC-07` | The child runs with a working directory inside a **per-run temporary directory** (removed when the run ends) and a **minimal environment** from which every secret, token and configuration path has been removed. | M |
| `SEC-08` | Where the host permits, the child additionally **drops privileges** to a dedicated unprivileged account and sets no-new-privileges. Where not permitted, the limitation is logged and displayed. | S |
| `SEC-09` | The child's stdout/stderr are captured and returned as **escaped diagnostic text** attributed to the block. | M |
| `SEC-10` | **Archi #1 is not a security boundary against a determined author.** It mitigates accident and careless code. The interface states this to the Python-block author; the deployment constraints of §10.5 apply while it is in force. | M |
| `SEC-11` | The Python block **import allowlist** is limited to the runner's computation packages: the data-frame library (Polars), the numerical library (NumPy), the figure library (Plotly), plus `math`, `statistics`, `datetime`. Submodules are allowlisted **explicitly**; an allowed top-level package does not authorise everything reachable from it. | M |

### 10.5 PoC deployment constraints

| ID | Requirement | Pr. |
| --- | --- | --- |
| `POC-01` | The PoC runs on a **dedicated host**, isolated from production, holding no production credential and no access to a production data store. | M |
| `POC-02` | The PoC uses **synthetic data only**. No confidential measurement is loaded on the PoC host. | M |
| `POC-03` | Access is restricted to a **closed list of named, authenticated users**. Anonymous access to the module is disabled. | M |
| `POC-04` | The Python-block capability is behind a **feature flag**, disabled by default, enabled only on the PoC host. | M |
| `POC-05` | Since the runner is not bounded in CPU/memory/duration, an operator can cancel any run and restart the service without loss of a persisted recipe. | M |

### 10.6 Output safety

| ID | Requirement | Pr. |
| --- | --- | --- |
| `SEC-12` | A figure crosses the boundary as a **validated specification object**. Any HTML/script payload it contains is **rejected**, not sanitised in place. | M |
| `SEC-13` | Text produced by a block is **rendered as text**. The interface never inserts block-produced content as raw markup. | M |
| `SEC-14` | The text-block markdown subset **excludes** raw HTML, scripts, inline event handlers and non-relative resource references. | M |
| `SEC-15` | Values produced by a block and injected into the report (table cells, axis labels, titles, captions) are **escaped at generation time**. | M |
| `SEC-16` | A generated HTML report is delivered as a **download or served from an origin distinct from the application origin**, free of platform cookies, so its content cannot reach an authenticated session. It is never rendered inside the application origin. | M |

---

## 11. Standalone HTML report (Pillar 04)

The primary deliverable and visible output of the PoC.

| ID | Requirement | Pr. |
| --- | --- | --- |
| `HTM-01` | The report is a **single HTML file** that opens with no network access: data, figure specs and rendering runtime are embedded. **No fetch at open time.** | M |
| `HTM-02` | Charts are **interactive offline**: zoom, pan, hover read-out, legend toggling, reset to initial view. | M |
| `HTM-03` | Tables are **interactive offline**: column sorting, value filtering, column show/hide, pagination above a configured row count. | M |
| `HTM-04` | The embedded rendering runtime comes from the **pinned, self-hosted vendored copy**. **No CDN** is referenced (offline + data-protection posture). | M |
| `HTM-05` | Document structure follows the formatting blocks: title, sections in declared order, text, figures, tables, plus a **table of contents** built from the section blocks. | M |
| `HTM-06` | The report embeds the provenance block of `BLK-REP-02`. | M |
| `HTM-07` | Data is **decimated before embedding** and the decimation ratio is stated next to the figure, so the file stays openable in a browser. | M |
| `HTM-08` | Generation is deterministic: same recipe + same data ⇒ identical file apart from the generation timestamp. | S |
| `HTM-09` | The report honours the platform theme tokens and **remains legible when printed in greyscale**. See clarification below. | S |
| `HTM-10` | The report is validated on the reference browsers, opened from a local filesystem with no network interface available. | M |
| `HTM-11` | The report carries **no platform cookie, no session identifier and no internal URL**. | M |

> **`HTM-09` clarification (`mail.docx`):** this is **not** about changing curve rendering.
> It is about **adapting the colour palette for black-and-white printing**: the palettes
> offered by the tool must be B&W-print compatible (sufficiently distinct contrast), **and**
> the user must be **warned** when a custom colour choice does not meet the usual contrast
> constraints.

---

## 12. Persistence

> **PoC clarification (`mail.docx`):** persistence for the PoC may be done by **serialising
> the blocks to JSON on disk**. Because there is no access-rights management in the tool yet,
> persisted data is **shared across all users**.

| ID | Requirement | Pr. |
| --- | --- | --- |
| `PER-01` | A dashboard is persisted as a **versioned recipe document** containing blocks, configurations, links, layout and variable mapping. | M |
| `PER-02` | The recipe format carries a **schema version**. An unknown/newer version is refused with a clear message rather than partially interpreted. | M |
| `PER-03` | A recipe can be reopened, modified and re-executed, producing the same document as long as its configuration is unchanged. | M |
| `PER-04` | Every create/modify/delete operation on a dashboard is logged with user and timestamp. | M |
| `PER-05` | Every run is logged with user, source hash of each Python block, generated-module hash, duration and termination cause. | M |

---

## 13. Cross-cutting validation rules

| ID | Requirement | Pr. |
| --- | --- | --- |
| `VAL-01` | Every configuration form is validated **client-side for feedback** and **server-side for enforcement**. Client validation is never authoritative. | M |
| `VAL-02` | Malformed, out-of-range or inconsistent configuration is refused at save time, with the message attached to the offending field. | M |
| `VAL-03` | Mandatory fields must be filled before a block is valid; an incomplete block marks the graph invalid and names the missing fields. | M |
| `VAL-04` | Deleting a block that has successors requires an **explicit confirmation naming them**, and is distinguished in the UI from removing a link. | M |
| `VAL-05` | Every error surfaced to the user states **what failed, in which block, and what action is expected**, without exposing internal implementation detail. | M |
| `VAL-06` | Every create/modify/delete operation is logged with user and timestamp; history is accessible to administrators. | M |

---

## 14. Non-functional requirements

| ID | Requirement | Pr. |
| --- | --- | --- |
| `NFR-01` | Canvas interaction (drag, link, pan, zoom) stays fluid at **60 fps** for a graph of at least **50 blocks**. | M |
| `NFR-02` | Static validation runs without a round trip for the checks the client can perform locally. | S |
| `NFR-03` | Compilation of a 50-block graph completes in **under 500 ms**; it is a pure text transformation and never blocks the editor. | S |
| `NFR-04` | Generation of a standalone HTML report of 10 figures and 5 tables completes in **under 15 s** on the reference host. | S |
| `NFR-05` | The module honours the platform **dual theme** through the existing design tokens, including inside figures and the exported report. | M |
| `NFR-06` | Every performance claim is supported by a **before/after benchmark** with correctness assertions on the results. | M |

---

## 15. Python engineering standards (MINT)

These standards apply to all backend code and to compiler-emitted code.

- **PEP 8**, formatted with **Black**, **max line length 120** (not 80).
- **PEP 484** type annotations are **mandatory** on every function and method. `mypy`
  static checking before commit is recommended.
- **PEP 20 (Zen of Python)** guides design: *explicit over implicit*, *simple over complex*,
  *readability counts*, *errors should never pass silently*.
- **Docstrings**: **Google Style**, written in **English**. Technical docs are generated
  from code on mature projects — keep that target.
- **Naming**: `snake_case` for variables/functions/modules, `PascalCase` for classes,
  `UPPERCASE` for constants, leading `_` for private members. No single-letter names outside
  short loops or formal math expressions.
- **Single Responsibility / DRY**: a function **must not exceed ~40 lines**; beyond that,
  decompose into explicitly named sub-functions.
- **Big data**: **Polars is the standard** for all tabular processing (Pandas only on proven
  third-party incompatibility). Prefer **lazy** `LazyFrame` for out-of-core/big-data or API
  consistency; otherwise a `DataFrame` is fine. **Loading files > 100 MB fully into memory
  is forbidden** without streaming/chunking (streaming mandatory > 200 MB). Profile with
  `py-spy` / `memory_profiler` **before** optimising.
- **Security & robustness**:
  - `eval()` and `exec()` are **forbidden**.
  - **No secrets** in source (API keys, passwords, tokens) — use environment variables or
    uncommitted `.env`.
  - Exceptions must be **typed**; a generic `except Exception` without re-raise is forbidden.
- **Defensive programming**: validate preconditions explicitly with `raise` (never `assert`
  for external/user data); return a **consistent type** (model absence with `Optional`, never
  implicit `None`); **fail fast**; wrap every external dependency call (file/API/DB) with
  explicit error handling.
- **Versioning / commits**: dedicated branch per feature/fix; **Conventional Commits**
  message style (e.g. `feat: add lazy MF4 loader`).

## 15.1 Performance rules

- **Measure before optimising** — profiling precedes any optimisation.
- Prefer `scan_parquet` over `read_parquet().lazy()` (true lazy scan; pushes down column and
  row-group pruning). Collect **as late as possible**, filter **before** collecting.
- **No Python loops over data.** Use vectorised NumPy/Polars/SciPy operations; use `np.where`
  or Polars `when/then/otherwise` for conditional transforms. Avoid nested loops (O(n²)+).
- In Polars, prefer **native expressions** over `.apply()` / `.map_elements()`.
- For KDE, use `KDEpy.FFTKDE` (linear-time, FFT-based); `n_points` a power of 2 (1024/2048/
  4096); bandwidth `ISJ` recommended for multimodal automotive signals. *(Post-PoC feature.)*

---

## 16. UX/UI guidelines

> **Front-end (`mail.docx`):** a standardised **React** design-system component library will
> be established internally at Renault later. **For now the tool is framework-agnostic and
> implemented in Vanilla JS.** For the PoC, base the UI on the **existing screens** plus the
> generic **Catppuccin** design-system guidance.

- **Design for real users** (engineers, not the general public): they handle large files and
  dozens of signals, repeat the same workflows hundreds of times, are comfortable with high
  information density, and **do not read documentation** → the interface must be
  self-explanatory.
- **Immediate feedback**: any action produces a visible response within **200 ms**. 200 ms–2 s:
  show a loading indicator (spinner/progress/skeleton). > 2 s: quantified progress
  (e.g. "Chargement 3/12 groupes"). > 10 s: explanatory message + progress state.
- **Error messages** are in the **user's language (French)**, actionable, and never expose a
  raw stack trace to the end user (prefer a simplified message with an option to view the full
  trace). A good message states **what happened, why, and what the user can do**.
- **Three-interaction rule**: any daily-use feature is reachable in **≤ 3 interactions** from
  the main screen (does not apply to advanced/rare features).
- **Keyboard shortcuts** are mandatory for frequent actions (standard set: `Ctrl+O`, `Ctrl+N`,
  `Ctrl+S`, `Ctrl+F`, `Ctrl+Z`, `Ctrl+Y`, scroll-to-zoom, H/B/G/D navigation).
- **Accessibility**: WCAG AA contrast (4.5:1 body text, 3:1 large titles); form fields and
  buttons keyboard-reachable.
- **Cross-tool consistency**: menu always on the **left** (collapsible, non-overlapping); the
  work area always **centre** and takes all available space; consistent drag & drop and
  shortcuts.
- **Colour palette**: **Catppuccin** — two themes, **Mocha** (dark, default) and **Latte**
  (light). Each colour is used for its **semantic** meaning (primary/secondary surface,
  accent, success, warning, error, primary/secondary text), never for aesthetics.
- **Typography**: **Fira Code** (monospace) is mandatory for numeric values, signal names and
  code blocks.
- **Information density**: high density is acceptable **if organised**; panels are resizable
  and their state (size/position/open/closed) is **persisted in the user layout** and restored.
- **Windows/panels**: confirmation dialogs are mandatory for destructive actions; long
  operations use non-blocking toasts rather than blocking modals.
- **Prototyping** (for reference, not PoC deliverable): Balsamiq for low-fidelity wireframes,
  Figma for high-fidelity; validate with at least one representative end user before dev.

---

## 17. Acceptance and test strategy

| ID | Requirement | Pr. |
| --- | --- | --- |
| `TST-01` | Each block type has unit tests covering nominal behaviour, empty input, single-row input, all-null input, non-uniform time base and schema mismatch. | M |
| `TST-02` | The compiler has **golden-file tests**: a fixed recipe produces a fixed module source; any change to output is an explicit, reviewed change. | M |
| `TST-03` | Every generated module in the test corpus passes a **syntax check and the project linting rules** in CI. | M |
| `TST-04` | The static analyser has a corpus of **legitimate code that must be accepted** and an **escape corpus that must be refused**. A false refusal is as severe as a false acceptance. | M |
| `TST-05` | The runner has an **escape suite** covering introspection, import, filesystem, network and malformed output payloads. Every case is contained or documented as an expected Archi #1 failure in the PoC test report. | M |
| `TST-06` | **Inlining injection tests**: a code block attempting to close the generated function, redefine a compiler-emitted symbol or alter module structure is detected before generation. | M |
| `TST-07` | HTML reports are validated by opening them on the reference browsers from a local filesystem, checking chart/table interactivity and the provenance block. | M |
| `TST-08` | Every feature slice is validated in a **real browser** before being considered complete. | M |

---

## 18. Delivery (context)

- A GitHub user is added as contributor on the **public repo**; a branch containing all PoC
  content is pushed and a **pull request** is opened.
- A Capgemini-internal mirror repository is created for the team.
- Key PoC milestones (from `mail.docx`): PoC kick-off (Capgemini), progress checkpoint, and
  final demonstration/restitution.

---

## 19. After the PoC (indicative, out of current scope)

| Step | Content |
| --- | --- |
| S1 | Confinement completion: runner resource limits (CPU, memory, duration, concurrency), then migration to Archi #2/#3 with container/micro-VM isolation, network namespace, import control. |
| S2 | Real measurement sources (MF4, BLF/CAN, computed variables, events) replacing the synthetic source behind the same port contract. |
| S3 | Complete the figure catalogue (bar, scatter, histogram, box plot) and numerical analysis blocks (FFT, KDE, filtering, smoothing). |
| S4 | Parameters and controls, result caching, incremental re-execution, multi-run comparison. |
| S5 | Remaining exports (PDF, XLSX, PPTX, CSV, Parquet), A4 print layout, sharing model, template gallery. |

---

## Appendix — Source documents

| Ref | Document |
| --- | --- |
| `[R1]` | Baltimore Bird documentation (Sphinx/MyST) — https://baltimorebird.readthedocs.io/ |
| `[R2]` | Allowlist AST evaluator, reference implementation — [src/backend/api/computed.py](src/backend/api/computed.py) |
| `[R3]` | Polars user guide (lazy API, expressions) — docs.pola.rs |
| `[R4]` | Plotly JSON chart schema — plotly.com |
| `[R5]` | OWASP Top 10 and CWE-94 (code injection) — owasp.org |
| `[R6]` | Renault Ampere — framing session, PoC Baltimore Bird (25/08/2026) — `Document/POC développement outil Renault pour lot B WP745.pdf` |
| `[R7]` | ORIOLE — legacy desktop report builder (internal functional reference) |
| — | Software Specification v0.2 — `Document/baltimore_bird_capge.pdf` |
| — | Client review notes — `Document/mail.docx` |
| — | MINT standards — `Document/Bonnes pratiques python…pdf`, `Document/Performance et optimisation…pdf`, `Document/UX_UI…pdf` |
