---
type: Overview
title: Baltimore Bird, vue d'ensemble
description: Ce qu'est le produit, pour qui, et ce qui est explicitement hors périmètre.
tags: [produit, perimetre]
status: stable
generated:
  by: claude/opus-5
  at: 2026-09-15
verified:
  by: human:Geo
  at: 2026-09-15
---
 
# Baltimore Bird
 
Plateforme web d'exploration et de restitution de données temporelles automobiles :
acquisitions MF4, bus CAN, mesures INCA. Backend Flask, frontend JavaScript vanilla
servi par Vite, application mono-page. Déployée sur baltimorebird.cloud.
 
L'ambition fonctionnelle est celle d'un AVL Concerto ou d'un ETAS MDA, dans un
navigateur, sans installation poste par poste.
 
## Pour qui
 
Ingénieurs d'essais et de mise au point qui doivent ouvrir une acquisition de
plusieurs gigaoctets, comparer des runs, calculer des grandeurs dérivées et
produire un rapport. Le public sait lire un signal ; il ne sait pas forcément
écrire du Python, d'où le poids donné à l'édition sans code.
 
## Ce que fait le produit aujourd'hui
 
- Exploration interactive de signaux numériques, catégoriels, booléens et
  d'événements INCA. Voir [Pipeline de rendu](/architecture/rendering-pipeline.md).
- Lecture MF4 par moteur Rust avec repli asammdf. Voir [Lecture MF4](/architecture/mf4-reading.md).
- Ingestion BLF/CAN et MAT. Voir [Ingestion CAN](/architecture/can-ingestion.md).
- Variables calculées par expression utilisateur. Voir [Variables calculées](/architecture/computed-variables.md).
- Comparaison multi-fichiers, mise en page sauvegardée, import de layouts MDA.
- Construction de rapports par blocs. Voir [Dashboard Builder](/architecture/dashboard-builder.md).
- Stockage par utilisateur avec quota, métriques d'usage et retours utilisateurs.
 
## Ce qui n'y est pas
 
- Aucun framework frontend. Voir [JavaScript vanilla plutôt qu'un framework](/decisions/0003-vanilla-js-no-framework.md).
- Aucune ingestion de données réelles dans les blocs Dashboard Builder : le PoC
  travaille sur des données synthétiques.
- Aucune analyse de masse sur parc d'essais. C'est le sujet de la
  [feuille de route datalake](/roadmap/datalake-pipeline.md).
- Aucun déploiement multi-worker. Voir [Worker gunicorn unique](/decisions/0002-single-gunicorn-worker.md).
 
## Positionnement interne
 
Le projet est développé hors ressources Renault et ne partage aucun code avec
ORIOLE, l'outil bureau PyQt5 dont il reprend l'intention. Il vise à devenir le
premier dépôt Renault réellement maintenu en open source, avec feuille de route
et communauté d'utilisateurs, par opposition aux dépôts publiés une fois puis
abandonnés.