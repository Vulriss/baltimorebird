---
type: Roadmap
title: Décimation à budget partagé dans l'EDA
description: Sujet de hackathon Capgemini. Faire évoluer la pyramide min-max client vers une allocation globale du budget de points, mesurée en erreur de rasterisation.
tags: [rendu, lod, decimation, hackathon, capgemini, performance]
status: draft
generated:
  by: claude/sonnet-5
  at: 2026-09-25T00:00:00Z
verified:
  by: human:Geo
  at: 2026-09-25
---

# Décimation à budget partagé dans l'EDA

Sujet de hackathon mené avec Capgemini. Il transpose dans l'Interactive EDA la
méthode du papier « Budget-Constrained Rendering of Multi-Signal Time Series:
Content-Aligned Envelope Hierarchies with Screen-Space Allocation » (Geoffrey
Domergue, travail public en cours de rédaction).

## Ce qui existe

La décimation a deux étages, décrits en partie dans
[Pipeline de rendu](/architecture/rendering-pipeline.md).

- **Serveur.** `/view` décime par LTTB (`core.downsampling.lttb_downsample`,
  appelé depuis `data_management/sessions.py` et `data_management/datastore.py`)
  avant que le signal complet n'arrive. Ce chemin est hors périmètre ici.
- **Client.** `src/frontend/src/eda/minmax-pyramid.js` construit, après
  réception du signal complet, une pyramide par signal : buckets en index
  f4, argmin et argmax par bucket, erreur structurelle cumulée. La
  requête pose une couche uniforme puis raffine gloutonnement par tas max,
  chaque feuille émettant premier point, minimum, maximum et dernier point.
  L'enveloppe est exacte quelle que soit l'allocation.

Le budget est calculé par graphique : `targetPointsForPlot`
(`data-views.js`) vaut la largeur en pixels physiques, arrondie à 64, bornée
entre 300 et 10 000. Chaque signal d'un graphique reçoit ce budget, et les
signaux partageant un raster sont fusionnés par `mergeIndexSets`
(`transforms.js`). Un graphique reçoit donc environ W points par signal, soit le
quart du seuil M4 de 4W : l'EDA vit déjà dans le régime contraint que traite le
papier.

## Écarts avec le papier

1. **Pas de budget partagé.** Chaque signal est raffiné dans son propre tas. Le
   papier utilise un tas unique sur tous les panneaux visibles.
2. **Erreur non exprimée en pixels.** La priorité est l'erreur structurelle en
   unités de données, bornée par la taille de slot. Le papier ordonne par masse
   de pixels faux normalisée par l'encre du panneau, σ·ρ·cols / ink, seule
   grandeur comparable entre des signaux d'unités différentes.
3. **Frontières en index.** Le papier aligne les frontières sur un mélange de
   temps écoulé et de variation cumulée, avec α = 0,5. La pyramide actuelle
   découpe en tailles fixes, et le commentaire d'en-tête note déjà que, sur un
   raster non uniforme, bucket et colonne ne se correspondent pas.
4. **Pas de repli M4.** Au-delà de 4W points alloués à un panneau, le papier
   rend en M4 aligné sur les colonnes, ce qui supprime le résidu de
   rasterisation propre à toute hiérarchie précalculée.

## Tranches proposées

Chaque tranche est mesurée avant la suivante ; sans gain démontré, elle n'est
pas intégrée.

0. **Métrique.** Module de rasterisation par remplissage de colonnes et erreur
   normalisée (différence symétrique sur union), couvert par vitest, avec un bench
   qui rejoue des scènes de fichiers réels (anonymisés et normalisés pour le 
   hackaton). Sans ça, rien de la suite n'est mesurable.
1. **Masse écran.** Remplacer la priorité du tas par la masse normalisée, budget
   par graphique inchangé.
2. **Tas global.** Budget total égal à la somme des budgets actuels des
   graphiques visibles, redistribué par un tas unique. Le coût de rendu total
   est donc constant : seule la répartition change.
3. **Frontières alignées sur le contenu.** Conditionnée au résultat de la
   tranche 2. C'est la plus invasive : toute l'arithmétique `bucket × taille`
   de la pyramide suppose des buckets de taille fixe.
4. **Repli M4** au-delà de 4W points par panneau.

La tranche 3 est probablement sur-dimensionnée pour le hackathon : l'allocation 
globale seule porte l'essentiel du gain, et l'alignement
sur le contenu en ajoute une fraction.

## Points de conception ouverts

- **Graphique multi-traces.** Le papier suppose un signal par panneau. Dans
  l'EDA, un graphique superpose plusieurs traces : il faut décider si l'ink
  de normalisation est celle de la trace ou du panneau.
- **Canaux de transport.** Performance inférieure au partage uniforme dès 
  que la scène contient des CRC, compteurs cycliques ou tout autre artefact 
  de transport. Un utilisateur d'EDA en affiche : il faut un safegard, par
  exemple un plancher par graph ou une détection de ces canaux.
- **Worst pannel.** L'allocation globale peut dégrader le panneau le plus
  mauvais. Le rapporter dans le bench, pas seulement la moyenne.
- **Coût d'allocation.** Le tas global tourne à chaque déplacement de fenêtre.
  Profiler `pyramidView` avant, fixer la cible après mesure.

## Critères de fin

- Bench vitest rejouant au moins trois fichiers réels, erreur moyenne et pire
  panneau rapportés contre la pyramide actuelle.
- Enveloppe toujours exacte : tests existants de `minmax-pyramid.test.js` verts
  et étendus.
- Bascule entre ancien et nouvel allocateur pour comparaison en navigateur.
- Aucun changement serveur ; aucun invariant de sécurité touché.
