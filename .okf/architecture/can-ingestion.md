---
type: Architecture
title: Ingestion CAN et BLF
description: Décodage BLF via cantools, assainissement ARXML, résolution de trame par bus.
tags: [can, blf, arxml, dbc, cantools]
status: stable
---

# Ingestion CAN et BLF

`services/blf_ingest.py` transforme un enregistrement BLF plus une base de
description (DBC ou ARXML) en signaux exploitables par la couche EDA. Le
décodage s'appuie sur cantools. canmatrix a été évalué puis écarté.

## Deux pièges qui ne se devinent pas

**ARXML et SECURED-I-PDU.** Un élément `SECURED-I-PDU` sans `PAYLOAD-REF`
déclenche une assertion cantools inconditionnelle : le fichier entier devient
illisible. L'ARXML est donc assaini avec lxml avant d'être remis à cantools, en
neutralisant ces éléments. Ce n'est pas un contournement esthétique, c'est la
seule façon d'ouvrir les fichiers réels du parc.

**Une trame n'est pas identifiée par son seul identifiant.** Sur les bases
rencontrées, des dizaines d'identifiants de trame existent simultanément sur
plusieurs bus, avec des définitions différentes. Une table de correspondance
plate indexée par `frame_id` est donc fausse par construction. La résolution se
fait par couple bus et identifiant.

## Forme du flux

Deux phases : un balayage qui recense ce que le fichier contient, puis une
extraction qui ne décode que ce qui a été demandé. La même discipline que pour
les sessions MF4, pour la même raison. Voir [Sessions EDA](/architecture/eda-sessions.md).

`services/smoke_test_blf_ingest.py` couvre la chaîne bout en bout. Voir
[Tests](/workflows/testing.md).
