# Business Context — Baltimore Bird Dashboard Builder


> This document gives GitHub Copilot and developers the **business background** behind the
> Baltimore Bird Dashboard Builder PoC: why it exists, who uses it, and the constraints that
> shape it. Functional requirements are in `functional-specification.md`; development standards
> are in `Document/coding-standards.md`.

---

## 1. The domain: automotive measurement post-processing

Renault's MINT team performs **post-processing of vehicle measurement data**. Large data files
(*big data*) coming out of the vehicle **ECUs** are converted into a **data lake**, on which
**business/engineering statistical analyses** are run.

These analyses serve **dashboarding** over the data: spotting problematic events, checking that
vehicle settings conform to the specification, detecting deviations, and confirming whether a
development is "on trajectory". The analyses are declined across every vehicle perimeter —
energy management, thermal management, battery management, and every system worked on during
vehicle development and calibration.

### The legacy workflow (ORIOLE)

-  **dedicated data engineers write the analyses by hand** (all the charts, aggregations
  and numerical methods are hand-written code).
- These are produced with **ORIOLE**, an internal **desktop report builder** made by
  **Renault–Nissan** (inner-source, internal Git). It is a "make" tool mixing open-source
  libraries and proprietary in-house libraries.
- ORIOLE is the **functional reference** Baltimore Bird is expected to replace in a web form.

---

## 2. The vision: a web tool on the data lake, with semi-no-code analysis

The team is porting the capability to a **web version** of the tool, connected to an internal
**data lake** that holds measurement files from many services (not only MINT: driver assistance,
vehicle delivery, etc.). The goal is to exploit this data **directly in the cloud**, instead of
repatriating files locally onto workstations or PCs for post-processing.

To democratise access to data, the team is shifting toward **no-code for analysts**:

- Simplify the creation of dashboarding so **non-expert users** can explore data themselves.
- A previous **Blueprint** (node-graph) approach existed but was **abandoned**: even a single
  box-plot required many blocks, and dense reports (dozens of blocks with aggregations and
  computations) became unreadable ("apocalyptic"). It was not adequate for non-expert users.
- The chosen direction is a **semi-no-code** system: analyses are built from **predefined
  high-level blocks** (choose inputs, X, Y, etc.), while **expert users keep the ability to
  write plain Python** inside the analysis for finer control beyond the predefined blocks.

### What the PoC must demonstrate

The PoC builds exactly this system: **generate code from predefined blocks + an editing zone**,
producing procedurally, via no-code, a report similar to what analysts write by hand today.

- The final generated file **takes data as input and returns HTML reports**.
- The **execution of that generated code runs in a sandbox** — it is simpler to sandbox at the
  level of the **whole generated file** than per snippet (a syntactic check of the embedded code
  can still be done). This is the key security concern (see §4).


---

## 3. Technical landscape

| Layer | Technology |
| --- | --- |
| Web backend (Baltimore Bird) | **Python** |
| Web frontend | **Vanilla HTML / JS** + **SCSS** for the interface |
| Desktop application (ORIOLE) | Full **Python** |
| Data handling | **Polars** (the library for all data management/reading) |
| Charting | **Plotly**, Seaborn, Matplotlib — keep all these possibilities for users to build reports as they wish |



### Widgets / analysis priorities

Analysts "code whatever they want", so practically **all Plotly chart types** are used, but
there is a **priority order** by frequency of use:

- **Frequently used (priority):** line plots, bar charts, 2D histograms.
- **PoC focus — standard basics:** scatter plot, line plot, box plot.
- **Numerical analysis blocks that go with them:** FFT, KDE, filtering, smoothing.
- Some figure types are rarely/never used and are **not prioritised / not scoped** for now.
- Historical Blueprint blocks (column inputs, scatter/line/bar/funnel/timeline plots, 1D/2D
  distributions, stacked plots, math/logic functions, transformations) can seed the priority
  backlog.

> The generated code must be **robust to big-data analyses**: algorithmic-complexity concerns
> matter, and the domain rules already done by hand must be effectively **hard-coded** into the
> block implementations underneath.

---

## 4. Security concern: sandboxing user Python

Letting users write **custom Python** raises significant security stakes. When the generated
Python is executed, custom code blocks must be **encapsulated in a sandbox** so that nobody can
put non-analysis code into these blocks.

Concretely, the client wants to:

- **Limit the available fields and functions.**
- Ideally have the **spawned notebooks/workers and the input files live in dedicated
  environments**, so no one can escape that space to reach **other people's data** or resources
  they should not control.

This is the core technical subject. (In `functional-specification.md` this maps to Pillar 03
"Confined execution", Archi #1 with an AST allowlist + child-process execution.)

---


## 6. Client clarifications on the specification 

The review notes refine what is expected and, importantly, what must **not** be built for the
PoC. (These are also reflected as scope notes in `functional-specification.md`.)

- **Print & contrast (`HTM-09`).** Not about changing curve rendering, but about **adapting the
  colour palette for black-and-white printing**. Offered palettes must be B&W-compatible
  (sufficiently distinct contrast), and the tool must **warn the user** if a custom choice breaks
  the usual contrast constraints.

  for the PoC, base the UI on **existing screens** + the generic **Catppuccin** design-system
  guidance.
- **Application roles.** The whole roles chapter is **informative** in the specification. Roles
  are **not implemented today and must not be implemented for the PoC.**
- **Variable mapping.** A future feature will maintain a **data dictionary** (mapping an internal
  parameter name to its possible names across different input sources); renaming an internal name
  would rename it across all reports using it and warn about invalidated code blocks. Since this
  feature does not exist and the PoC uses **synthetic data only**, it **does not apply**.
- **Documentation.** Developer documentation is in **English**; user documentation is in
  **French**. Sphinx docs are hosted online (https://baltimorebird.readthedocs.io/). The user doc
  already describes the PoC features at a high level (no update required). Technical
  documentation is generated from code on mature projects — keep that target even if it is not
  generated today.
- **Persistence.** The specification describes JSON persistence. For the PoC, persistence can be
  done by **serialising blocks to JSON on disk**; data is **shared across all users** as long as
  there is no access-rights management in the tool.


---

