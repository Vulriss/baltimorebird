---
type: Decision Record
title: Index ASAM ODS et cache Parquet plutôt qu'un entrepôt unique
description: Pourquoi l'index sémantique et les données sont séparés, et pourquoi la vue unitaire contourne les deux.
tags: [asam-ods, parquet, datalake, architecture]
status: draft
generated:
  by: claude/sonnet-5
  at: 2026-09-15T00:00:00Z
sources:
  - id: note-ods
    resource: "note interne : feuille de route architecture ASAM ODS + Polars + Rust"
    title: Feuille de route architecture de traitement
    author: human:Geo
    last_modified: NA
---

# Index ASAM ODS et cache Parquet plutôt qu'un entrepôt unique

Décision prospective. Elle engage la conception mais aucun code.

## Contexte

L'analyse de parc suppose de retrouver des essais par projet, véhicule et
calibration, puis de calculer sur des milliers de fichiers. Deux réponses
classiques existent : tout convertir en Parquet et indexer soi-même, ou stocker
les mesures dans un serveur ASAM ODS.

## Décision

Ni l'une ni l'autre entièrement. Le serveur ASAM ODS porte **l'index
sémantique** ; les valeurs vivent dans des fichiers Parquet sur un bucket de
cache, dont l'URI est liée dans l'entité `AoExternalReference`. La vue
temporelle unitaire ne passe par aucun des deux et lit le MF4 brut.

## Raison

Indexer soi-même revient à réinventer un vocabulaire d'essais que la norme
définit déjà, et à se couper des outils du secteur. Stocker les mesures dans
l'ODS place un serveur transactionnel sur le chemin d'un calcul analytique, ce
que Polars fait mieux directement sur Parquet, avec predicate pushdown.

Le contournement du cas A est le point qui rend la décision tenable : la
conversion est un cache, pas une source de vérité. Si le pipeline Parquet est
en panne, obsolète ou incomplet, la vue unitaire fonctionne toujours, et le
cache peut être reconstruit sans perte.

## Conséquence

- Le MF4 reste la source de vérité. Tout Parquet est jetable par construction.
- Il faut une politique d'invalidation du cache, qui n'est pas arrêtée.
- Le format Parquet doit être normé, sans quoi l'interopérabilité promise par
  l'ODS est perdue. Voir [Format Parquet ASAM Big ODS](/roadmap/parquet-asam-big-ods.md).
- Le choix du serveur ODS de référence reste ouvert, openMDM, Avalon et Peak
  étant les candidats.

Voir [Chaîne datalake](/roadmap/datalake-pipeline.md).
