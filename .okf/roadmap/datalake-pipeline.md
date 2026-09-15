---
type: Roadmap
title: Chaîne datalake, ASAM ODS et Polars
description: Flux cible pour l'analyse de masse sur parc d'essais, et la bifurcation qui évite d'avoir à choisir entre finesse et échelle.
tags: [datalake, asam-ods, polars, rust, parquet]
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

# Chaîne datalake, ASAM ODS et Polars

Prospectif. Rien de ce qui suit n'est implémenté. Le sujet est l'analyse de
masse sur un parc d'essais, que Baltimore Bird ne sait pas faire aujourd'hui :
il ouvre un fichier, pas dix mille.

## Le dilemme, et la façon de ne pas le trancher

Une vue temporelle unitaire veut la précision de l'échantillon brut. Une analyse
de parc veut des colonnes agrégeables sur des milliers de fichiers. Les deux
besoins tirent le format de stockage dans des directions opposées.

La réponse retenue est de **ne pas unifier**, mais d'isoler les deux cas d'usage
derrière une même recherche.[^note-ods]

```
[1. RECHERCHE ET FILTRE]
L'utilisateur cherche des essais dans le datalake (projet, vehicule, calibration)
       |
       +--> CAS A : vue temporelle fine unitaire
       |            contournement du datalake Parquet, lecture directe du MF4 brut
       |
       +--> CAS B : analyse globale de masse
                    declenchement du flux ODS/Parquet (etape 2)
                                  |
                                  v
[2. CONVERSION A LA VOLEE ET INDEXATION ASAM ODS]
 pour chaque MF4 selectionne :
 a. extraction des metadonnees par le moteur Rust
 b. POST HTTP (JSON ou Protobuf) vers l'API REST d'un serveur ASAM ODS
    (openMDM, Avalon, Peak) pour creer l'index semantique projet > vehicule > mesure
 c. conversion Rust : MF4 -> Parquet norme ASAM Big ODS
 d. depot du Parquet sur un bucket de cache (GCS, S3, Azure Blob) et liaison de
    son URI dans l'entite AoExternalReference de l'ODS
                                  |
                                  v
[3. TRAITEMENT ANALYTIQUE INSTANTANE]
 l'application interroge l'ODS et recupere la liste des URI Parquet
                                  |
                                  v
 pl.scan_parquet(["gs://...", "gs://..."])
                                  |
                                  v
 pipeline LazyFrame (filtres, agregations, predicate pushdown) puis .collect()
```

## Ce qui existe déjà

Le moteur Rust de l'étape 2 n'est pas à créer : `rust_mdf_parser` lit déjà les
MF4 en production, et expose les métadonnées par canal dont l'index ODS a
besoin. Voir [Moteur Rust de lecture MF4](/decisions/0005-rust-mf4-engine.md).

Ce qui manque au crate est l'écriture : il lit un fichier local mappé, il ne
produit pas de Parquet et ne parle à aucun stockage objet. L'étape 2 est donc
une extension d'un composant éprouvé, pas un chantier neuf, ce qui change
l'estimation et le risque.

## Pourquoi passer par un serveur ASAM ODS

L'ODS n'est pas un entrepôt de mesures, c'est l'index sémantique. Il porte la
hiérarchie projet, véhicule, mesure, et il est déjà le vocabulaire commun des
outils d'essais du secteur. Le Parquet reste dans un bucket ; l'ODS ne connaît
que son URI, via `AoExternalReference`.

Cela découple la question « quels essais me concernent » de la question « comment
lire vite ». Le cas A court-circuite entièrement l'ODS et le cache Parquet, ce
qui garantit qu'une régression du pipeline de masse ne peut pas dégrader la vue
unitaire.

Voir [Index ODS et cache Parquet](/decisions/0004-ods-index-parquet-cache.md) pour
la décision, [Format Parquet ASAM Big ODS](/roadmap/parquet-asam-big-ods.md) pour
le format de fichier, et [Portabilité multi-cloud](/roadmap/multi-cloud-portability.md)
pour l'abstraction de stockage.

## Points ouverts

- Quel serveur ODS de référence pour le déploiement interne Renault, et à quel
  coût de licence pour la version open source.
- Politique d'invalidation du cache Parquet quand le MF4 source change.
- Articulation avec l'add-on INCA qui alimente déjà le datalake.
- Chiffrement des MF4 stockés : décision reportée au déploiement interne, le
  modèle de menace et la classification Renault restant à trancher.

[^note-ods]: Feuille de route architecture de traitement
