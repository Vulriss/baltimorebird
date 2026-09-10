---
okf_version: "0.2"
---

# Baltimore Bird — bundle de connaissances

Contexte destiné aux agents et aux humains qui travaillent sur ce dépôt.
Le code reste la source de vérité ; ce bundle explique les intentions, les
invariants et les procédures que le code ne dit pas.

## architecture

- [Pile technique](/architecture/stack.md) — ce qui tourne où, et comment le front est servi
- [Pipeline de rendu](/architecture/rendering-pipeline.md) — pyramide min-max, LOD, format binaire
- [Ingestion BLF et CAN](/architecture/blf-ingest.md) — ARXML, DBC, résolution par bus
- [Variables calculées](/architecture/computed-variables.md) — interpréteur AST sur liste blanche
- [Métriques](/architecture/metrics.md) — collecte, agrégation, endpoints

## workflows

- [Construire et déployer](/workflows/build-and-deploy.md)
- [Valider une modification](/workflows/validate-changes.md)
- [Ajouter une fonctionnalité front](/workflows/add-frontend-feature.md)

## decisions

- [AST sur liste blanche plutôt qu'eval](/decisions/0001-ast-allowlist-over-eval.md)
- [cantools plutôt que canmatrix](/decisions/0002-cantools-over-canmatrix.md)
- [maxPts hors de la clé de cache](/decisions/0003-maxpts-out-of-cache-key.md)

## policies

- [Conventions de code](/policies/code-conventions.md)
- [Invariants de sécurité](/policies/security-invariants.md)
