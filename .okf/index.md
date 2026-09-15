---
okf_version: "0.2"
---

# Baltimore Bird — bundle de connaissances

Contexte destiné aux agents et aux humains qui travaillent sur ce dépôt.
Le code reste la source de vérité ; ce bundle explique les intentions, les
invariants et les procédures que le code ne dit pas.

Commencer par [Vue d'ensemble](/overview.md), puis
[Méthode de travail attendue](/policies/agent-working-method.md) avant toute
contribution. Les concepts sous `roadmap/` sont prospectifs et portent
`status: draft` : ils décrivent une intention, pas du code existant.

## vue d'ensemble

- [Vue d'ensemble](/overview.md) - ce qu'est le produit, pour qui, et ce qui est hors périmètre

## architecture

- [Pile technique](/architecture/stack.md) - ce qui tourne où, et comment le front est servi
- [Organisation du backend](/architecture/backend-layout.md) - carte des modules Python et où atterrit une logique
- [Pipeline de rendu](/architecture/rendering-pipeline.md) - pyramide min-max, LOD, binary format
- [Sessions EDA paresseuses](/architecture/eda-sessions.md) - chargement par canal, budget mémoire, éviction
- [Lecture MF4](/architecture/mf4-reading.md) - moteur Rust, repli asammdf, routage et falaise de performance
- [Ingestion CAN et BLF](/architecture/can-ingestion.md) - cantools, assainissement ARXML, résolution par bus
- [Variables calculées](/architecture/computed-variables.md) - interpréteur AST sur liste blanche
- [Dashboard Builder](/architecture/dashboard-builder.md) - recette, compilation, exécution confinée, rapport

## workflows

- [Monter l'environnement local](/workflows/local-development.md)
- [Construire et déployer](/workflows/build-and-deploy.md)
- [Tester](/workflows/testing.md)
- [Maintenir le bundle OKF](/workflows/okf-bundle.md)

## decisions

- [AST sur liste blanche plutôt qu'eval](/decisions/0001-ast-allowlist-over-eval.md)
- [Worker gunicorn unique en production](/decisions/0002-single-gunicorn-worker.md)
- [JavaScript vanilla plutôt qu'un framework](/decisions/0003-vanilla-js-no-framework.md)
- [Index ASAM ODS et cache Parquet](/decisions/0004-ods-index-parquet-cache.md) - prospectif
- [Moteur Rust de lecture MF4](/decisions/0005-rust-mf4-engine.md)

## policies

- [Conventions de code](/policies/code-conventions.md)
- [Invariants de sécurité](/policies/security-invariants.md)
- [Méthode de travail attendue](/policies/agent-working-method.md)

## roadmap

- [Chaîne datalake, ASAM ODS et Polars](/roadmap/datalake-pipeline.md) - analyse de masse sur parc d'essais
- [Format Parquet ASAM Big ODS](/roadmap/parquet-asam-big-ods.md) - colonnes minimales de la sous-matrice
- [Portabilité multi-cloud](/roadmap/multi-cloud-portability.md) - object_store, fsspec, OIDC, Terraform
- [Mode hors ligne](/roadmap/offline-first.md) - bundle local et question CORS
- [Suite du Dashboard Builder](/roadmap/dashboard-builder-next.md) - ce qui est reporté après le PoC
