---
type: Architecture
title: Lecture MF4, Rust engine et fallback asammdf
description: Deux backends de lecture, la règle de routage entre eux, et la falaise de performance quand le Rust est absent.
tags: [mf4, rust, asammdf, pyo3, performance]
status: stable
---

# Lecture MF4, moteur Rust et repli asammdf

Deux backends coexistent derrière une seule API, exposée par
`data_management/mf4_source.py` sous la forme d'un `Mf4Index` qui porte le champ
`backend`, valant `rust` ou `asammdf`.

Le moteur principal est `rust_mdf_parser`, bibliothèque Rust liée par PyO3 et
empaquetée par Maturin, développée dans le cadre du projet Oriole. asammdf reste
présent comme repli et comme décodeur de bus.

## Routage

`build_index` décide dans cet ordre :

1. Si `rust_mdf_parser` est importable, ouvrir le fichier avec Rust et filtrer
   les canaux dont le nom commence par `CAN_DataFrame`, `CAN_ErrorFrame` ou
   `CAN_RemoteFrame`. S'il reste des canaux, le fichier est physique, déjà
   décodé : index Rust direct.
2. S'il ne reste rien, le fichier est un log bus brut. Avec un DBC disponible,
   asammdf le décode une fois via `extract_bus_logging`, le résultat est écrit
   en cache sur disque, puis indexé par Rust.
3. Sans Rust importable, ou sans décodage possible, index asammdf complet.

L'étape 2 est le point intéressant : asammdf n'est pas un concurrent du moteur
Rust, c'est l'étape qui produit un fichier que le moteur Rust sait lire vite. Le
cache de fichiers décodés existe pour ne payer ce décodage qu'une fois.

## Empreinte mémoire

Le défaut est la **relecture à froid par requête** : le fichier est rouvert, la
colonne lue, rien n'est gardé. L'empreinte entre deux requêtes est quasi nulle,
ce qui est exactement ce qu'il faut sous huit threads partageant un processus.

`keep_handle` garde un handle chaud, qui coûte environ 16 Mo d'index mmap par
fichier. Un `MdfFile` est immuable après ouverture, donc `Sync` par
construction : il se partage entre threads sans verrou. Voir
[Sessions EDA](/architecture/eda-sessions.md).

## La falaise silencieuse

`rust_mdf_parser` **ne figure pas dans `requirements.txt`**. Il s'installe à part,
par `maturin develop --release`, ce qui suppose une chaîne Rust et, sous Windows,
les VS Build Tools. Une installation qui l'oublie fonctionne parfaitement, en
passant partout par le repli asammdf, et devient simplement des dizaines de fois
plus lente sans qu'aucune erreur ne le signale.

Sur un fichier de référence de 18 Mo, 921 data groups et 9287 canaux, les
mesures du projet donnent l'ouverture plus l'indexation à 8 ms contre 491 ms, et
l'extraction de tous les canaux uniques à 0,24 s contre 47,4 s, pour une
correspondance bit à bit sur les canaux numériques. Un diagnostic de lenteur
commence donc par vérifier le champ `backend` de l'index, pas par optimiser
autre chose.

## Périmètre du moteur Rust

Lu aujourd'hui : MDF 4.00 à 4.11 et au-delà, blocs DT, DV, DL, HL et DZ en
deflate avec transposition, groupes triés et non triés, canaux numériques vers
float64, canaux virtuels, maîtres, conversions CCBLOCK numériques y compris les
tables valeur vers texte avec formule par défaut.

Pas encore, avec erreurs typées explicites : canaux texte VLSD, stockage
colonne `##LD` de MDF 4.2, sortie de conversion texte. Une fonctionnalité qui en
dépend doit rester sur le chemin asammdf ou attendre.

Voir [Moteur Rust de lecture MF4](/decisions/0005-rust-mf4-engine.md).
