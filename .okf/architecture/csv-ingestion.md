---
type: Architecture
title: Ingestion CSV
description: Normalisation d'un CSV d'acquisition en MF4, détection du dialecte, axe de temps et garde-fous.
tags: [csv, ingestion, mf4, pandas]
status: stable
generated:
  by: agent:copilot
  at: 2026-10-26T00:00:00Z
---

# Ingestion CSV

`services/csv_ingest.py` transforme un CSV d'acquisition en MF4 physique. Comme
pour le `.mat` et le BLF, le MF4 produit devient l'unique artefact de la
session: la chaîne d'analyse paresseuse, la pyramide min-max, les voies
calculées et le stockage ne connaissent qu'un format.

## Pourquoi convertir plutôt que lire le CSV à la volée

Un lecteur CSV dédié aurait imposé son propre chemin de décimation, son propre
cache et sa propre gestion de la mémoire, en doublon de ce qui existe pour le
MF4. La conversion coûte une passe de lecture à l'import et rend le reste
gratuit, y compris la réouverture depuis la bibliothèque, qui retombe sur un
MF4 ordinaire. Voir [Sessions EDA](/architecture/eda-sessions.md).

## Ce que le format accepte

Rien n'est demandé à l'utilisateur: le dialecte est détecté sur les 64 premiers
kilo-octets du fichier.

- **Encodage**: UTF-8 avec ou sans BOM, puis Windows-1252, puis Latin-1.
- **Séparateur**: virgule, point-virgule, tabulation ou barre verticale. Est
  retenu celui qui découpe l'entête et les premières lignes en un nombre
  constant de colonnes.
- **Entête**: première ligne non vide. Une unité peut y être accolée sous la
  forme `Speed [km/h]` ou `Speed (km/h)`.
- **Ligne d'unités**: une deuxième ligne sans aucune valeur numérique est lue
  comme une ligne d'unités. C'est exactement ce qu'écrit l'export MF4 vers CSV
  de l'application, donc l'aller-retour conserve noms et unités.
- **Colonne de temps**: la première colonne, sauf si une autre porte un nom
  d'axe temporel (`time`, `timestamps`, `t`, `temps`, `zeit`, `datetime`...).
  Les valeurs numériques sont des secondes, sauf unité contraire lue dans le nom
  ou la ligne d'unités (`ms`, `us`, `ns`, `min`, `h`). Les instants ISO-8601
  sont acceptés: ils deviennent des secondes depuis le premier échantillon et
  l'instant absolu part dans l'entête MF4.
- **Valeurs**: décimale point ou virgule, détectée sur le fichier, notation
  scientifique admise. Une colonne entièrement non numérique est écartée et
  signalée, pas fatale.

## Deux points qui ne se devinent pas

**Un trou n'est pas un zéro.** Une cellule vide est un échantillon absent. La
colonne concernée part donc dans son propre groupe de canaux, avec le master
réduit aux instants qu'elle couvre réellement. Interpoler aurait fabriqué de la
mesure qui n'existe pas.

**Un axe désordonné est réordonné, pas refusé.** La pyramide de rendu suppose un
master trié. Le tri est stable et le rapport d'ingestion le signale à
l'utilisateur.

## La taille des groupes de canaux décide du confort de l'EDA

MDF4 entrelace les enregistrements d'un groupe: les échantillons des canaux d'un
même groupe sont stockés par ligne, pas par colonne. Lire **un** canal d'un
groupe qui en porte cinq mille impose donc de parcourir tout le bloc du groupe,
alors que la session paresseuse ne lit jamais qu'un canal à la fois. Un
convertisseur naïf regroupe tous les canaux qui partagent un master, et produit
exactement ce cas.

Mesuré sur une acquisition réelle de 992 Mo, 5465 colonnes et 21 161 lignes,
moteur Rust, par `get_column`:

| Plafond de canaux par groupe | Groupes | Lecture unitaire médiane | Taille |
| --- | --- | --- | --- |
| aucun | 920 | 160 ms | 783 Mo |
| 256 | 937 | 7 ms | 786 Mo |
| 64 | 990 | 3 ms | 795 Mo |
| 16 | 1203 | moins de 1 ms | 829 Mo |

`MAX_GROUP_CHANNELS` vaut donc 64: cinquante fois plus rapide à la lecture pour
1,5 % de fichier en plus. C'est le réglage qui rend un fichier à plusieurs
milliers de canaux utilisable, pas la vitesse de l'import.

## Pourquoi polars et pas pandas

Mesuré sur le même fichier: 47,7 s et 3627 Mo de pic avec pandas, 16,3 s et
2431 Mo avec polars, pour un MF4 identique canal par canal. L'écart ne vient pas
d'une différence de qualité générale mais de la forme du fichier: sur 5465
colonnes, l'inférence de type par blocs de pandas déclenche un `DtypeWarning`
sur près de neuf cents colonnes et coûte 25 s à elle seule. Polars reçoit un
schéma Float64 explicite avec `ignore_errors`: une colonne de texte revient
entièrement nulle et sera écartée plus loin, sans qu'une seule chaîne ne soit
matérialisée.

Une réserve, vérifiée et non supposée: le lecteur CSV de polars ne décode que
l'UTF-8 et **abîme silencieusement** un nom accentué dans un fichier
Windows-1252, sans lever d'erreur. L'entête et la ligne d'unités sont donc lues
par nos soins avec l'encodage détecté, puis injectées via `new_columns`; seul le
corps est laissé à polars, où une valeur numérique est ASCII par construction.

## Garde-fous

Le worker gunicorn est unique et porte toutes les sessions EDA: voir
[Worker gunicorn unique](/decisions/0002-single-gunicorn-worker.md). Un import
qui déborde doit échouer avec un message, pas emporter le processus. Deux bornes
y veillent, et elles ne disent pas la même chose.

La première, 5 Go de fichier source, est alignée sur `MAX_CONTENT_LENGTH`:
un fichier plus gros est déjà refusé par Flask, une valeur plus basse ne
protégerait de rien et refuserait des mesures légitimes du parc.

La seconde, 150 millions de valeurs, est celle qui borne réellement la mémoire,
et elle ne se déduit pas de la taille du fichier: un fichier d'entiers courts
porte plusieurs fois plus de valeurs par octet qu'un fichier de flottants
formatés. Elle est appliquée **avant** l'allocation, en dérivant un nombre
maximal de lignes du nombre de colonnes de l'entête, parce qu'un plafond
vérifié après lecture ne protège de rien.

Le contenu du fichier est analysé comme de la donnée et jamais évalué. Voir
[Invariants de sécurité](/policies/security-invariants.md).

## Vérification

`services/smoke_test_csv_ingest.py` fabrique ses fichiers et couvre les deux
dialectes, les deux formes d'axe temporel, les trous, le désordre, le plafond de
canaux par groupe et le refus d'un fichier malformé. Voir
[Tests](/workflows/testing.md).
