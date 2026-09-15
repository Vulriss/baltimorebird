---
type: Roadmap
title: Format Parquet ASAM Big ODS
description: Colonnes minimales de la sous-matrice de mesures, et la règle de préfixe pour les métadonnées maison.
tags: [parquet, asam-ods, format]
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

# Format Parquet ASAM Big ODS

Prospectif. Format cible des fichiers Parquet produits à la volée par le moteur
de conversion, pour être conformes à l'extension Big ODS d'ASAM à partir de la
version 6.1.

Chaque fichier structure une sous-matrice de mesures, `AoSubMatrix`, avec au
minimum ces colonnes.

| Colonne | Rôle | Type |
| --- | --- | --- |
| `name` | Nom textuel du canal ou du capteur, par exemple `Engine_Speed` | `String` / `Utf8` |
| `data` | Vecteur de l'ensemble des valeurs physiques | `List` de `Float` ou `Int` |
| `datatype` | Identifiant du type stocké dans le tableau, énumération ASAM ODS | `Int32` |
| `length` | Nombre d'échantillons du canal | `Int64` |

## Règle d'extension

Des colonnes de métadonnées maison peuvent être ajoutées librement, **à
condition que leur nom ne commence pas par le préfixe réservé `ao`**. Ce préfixe
appartient à la norme ; l'y empiéter casse silencieusement l'interopérabilité
avec les outils ODS tiers, sans erreur à l'écriture.

## Conséquence pour Polars

La forme est orientée canal, pas orientée échantillon : une ligne par canal,
avec ses valeurs en colonne `List`. Un `pl.scan_parquet` sur plusieurs milliers
de fichiers reste donc peu coûteux tant que le filtre porte sur `name`, puisque
le predicate pushdown élimine les canaux non demandés avant de matérialiser les
listes. Une requête qui commence par exploser la colonne `data` perd cet
avantage et doit être écrite autrement.

Voir [Chaîne datalake](/roadmap/datalake-pipeline.md).
