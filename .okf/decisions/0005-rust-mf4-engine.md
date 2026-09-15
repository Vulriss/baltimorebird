---
type: Decision Record
title: Moteur Rust de lecture MF4
description: Décision prise et implémentée, asammdf conservé en repli ; reste à trancher son extension à la conversion de masse.
tags: [rust, mf4, asammdf, maturin, pyo3]
status: stable
generated:
  by: claude/sonnet-5
  at: 2026-09-15T00:00:00Z
sources:
  - id: rust-mdf-parser
    resource: "depot rust-mdf-parser, rust_mdf_parser 0.5.1"
    title: rust_mdf_parser, parser MDF4 en Rust (projet Oriole)
    author: human:Vulriss
    last_modified: 2026-09-15T00:00:00Z
---

# Moteur Rust de lecture MF4

## Contexte

asammdf portait toute la lecture MF4. Sur les fichiers réels du parc, plusieurs
centaines de data groups et des milliers de canaux, le coût d'ouverture et
d'extraction rendait l'exploration interactive désagréable et la relecture par
requête impossible.

## Décision

Écrire `rust_mdf_parser`, un parser MDF4 en Rust lié par PyO3 et empaqueté par
Maturin, et le placer en chemin principal. Conserver asammdf en repli, et comme
décodeur de logs bus via DBC.

C'est fait, et en service. Voir
[Lecture MF4](/architecture/mf4-reading.md) pour le routage entre les deux.

## Raison

Trois propriétés, dans cet ordre d'importance.

**L'empreinte mémoire, pas seulement la vitesse.** Le fichier est mappé par
`memmap2` et jamais chargé ; les blocs non compressés sont rendus sans copie.
Cela autorise une relecture à froid par requête, ce qui est la condition pour
tenir plusieurs sessions concurrentes dans un worker unique. Voir
[Worker gunicorn unique](/decisions/0002-single-gunicorn-worker.md).

**L'immutabilité après ouverture.** `MdfFile` est `Sync` par construction, donc
partageable entre threads sans verrou. Le modèle de concurrence du backend
devient trivial au lieu d'être un sujet.

**La vitesse**, qui vient de `libdeflater` plutôt que flate2 quand la taille de
sortie est connue à l'avance, ce que les blocs DZ garantissent, et de la
décompression parallèle Rayon dans des tranches disjointes.

L'absence de panique est un choix explicite du parser : toute lecture est bornée,
tout fichier malformé produit une erreur typée. Une bibliothèque de lecture qui
panique fait tomber le worker, donc toutes les sessions avec lui.

## Conséquence

- **Dépendance optionnelle non déclarée.** `rust_mdf_parser` n'est pas dans
  `requirements.txt` et s'installe par Maturin. Une installation sans lui marche
  et devient lente en silence. C'est la conséquence la plus coûteuse de cette
  décision et elle est documentée dans
  [Lecture MF4](/architecture/mf4-reading.md).
- **Deux implémentations à garder d'accord.** La correspondance est aujourd'hui
  bit à bit sur les canaux numériques du fichier de référence. C'est une
  propriété à tester, pas à supposer.
- **Périmètre partiel assumé.** VLSD texte, `##LD` de MDF 4.2 et sortie de
  conversion texte ne sont pas couverts, avec erreurs typées à l'appui.

## Reste ouvert

L'extension du moteur à la conversion de masse MF4 vers Parquet normé, et à
l'extraction de métadonnées alimentant un index ASAM ODS, n'est pas faite. Elle
suppose d'ajouter l'écriture et l'abstraction de stockage objet au crate, qui ne
fait aujourd'hui que lire un fichier local mappé. Voir
[Chaîne datalake](/roadmap/datalake-pipeline.md) et
[Portabilité multi-cloud](/roadmap/multi-cloud-portability.md).