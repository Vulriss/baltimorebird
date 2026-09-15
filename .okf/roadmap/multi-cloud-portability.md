---
type: Roadmap
title: Portabilité multi-cloud
description: Abstraction du stockage, conteneurisation, absence de clés d'API, et stratégie de distribution.
tags: [cloud, gcs, s3, azure, oidc, terraform, maturin]
status: draft
generated:
  by: claude/sonnet-5
  at: 2026-09-15T00:00:00Z
sources:
  - id: note-ods
    resource: "note interne : feuille de route architecture ASAM ODS + Polars + Rust"
    title: Feuille de route architecture de traitement
    author: human:Vulriss
    last_modified: unknown
---

# Portabilité multi-cloud

Prospectif. Contrainte de conception de la bibliothèque de traitement : elle doit
s'exécuter sur GCP, AWS ou Azure sans dépendre d'une infrastructure
propriétaire, sinon la version open source n'est utilisable que par Renault.

## Abstraction du stockage

Côté Rust, la crate `object_store` d'Apache Arrow, qui lit et écrit nativement
sur S3, GCS et Azure Blob. `rust_mdf_parser` en est aujourd'hui dépourvu : il
s'appuie sur `memmap2`, donc sur un fichier local. Introduire `object_store`
signifie rendre la source de lecture abstraite dans un crate qui suppose
partout un mmap, ce qui n'est pas un ajout de dépendance mais une refonte de
sa couche d'entrée. Côté Python, `fsspec`, que Polars consomme
nativement, pour manipuler les URI `gs://`, `s3://` et `abfss://` de façon
transparente.

La règle qui en découle : **aucun code métier ne construit un chemin spécifique
à un fournisseur**. Un chemin est une URI, et c'est la bibliothèque qui décide
quoi en faire.

## Conteneurisation

Le moteur d'exécution est encapsulé dans une image Docker. Les environnements
serverless de chaque cloud, Cloud Run, Fargate, Container Apps, exécutent le
binaire Rust précompilé via Maturin et PyO3, sans conflit de dépendances
système.

## Zéro clé d'API

Aucun fichier de clés, ni JSON de compte de service, ni chaîne de connexion,
dans le code métier. L'authentification passe par OIDC et les rôles IAM de la
machine hôte : `fsspec` et `object_store` détectent l'environnement et
consomment des jetons éphémères.

C'est un invariant de sécurité, au même titre que ceux de
[la page dédiée](/policies/security-invariants.md) : une clé statique dans une
image Docker publiée est une fuite, pas une commodité.

## Distribution

1. Publication des wheels Python précompilées sur PyPI, via GitHub Actions
   couplées à Maturin.
2. Templates Terraform basiques pour que la communauté déploie l'infrastructure
   standardisée, serveur ODS, stockage et workers, en quelques minutes.

Voir [Chaîne datalake](/roadmap/datalake-pipeline.md) et
[Moteur Rust de lecture MF4](/decisions/0005-rust-mf4-engine.md).
