---
type: Roadmap
title: Suite du Dashboard Builder
description: Ce qui a été volontairement reporté après le PoC, et dans quel ordre.
tags: [dashboard, poc, capgemini]
status: draft
generated:
  by: claude/sonnet-5
  at: 2026-09-15T00:00:00Z
---

# Suite du Dashboard Builder

Le PoC est mené avec Capgemini Engineering. Son périmètre est décrit dans
`docs/poc/functional-specification.md` et son état dans
[Dashboard Builder](/architecture/dashboard-builder.md).

## Reporté explicitement hors PoC

- **Limitation de ressources.** L'application de quotas CPU et mémoire par
  exécution est reportée. Le compensateur opérationnel minimum retenu est
  `POC-05` : annulation par l'opérateur et redémarrage du service sans perte de
  recette.
- **Garde d'exposant sur `ast.Pow`.** Une expression du type `9**9**9` passe la
  liste blanche et occupe le processus fils jusqu'au délai. Mitigation de déni
  de service à ajouter dans l'évaluateur. Voir
  [Variables calculées](/architecture/computed-variables.md).
- Données réelles dans les blocs, aujourd'hui synthétiques uniquement.
- Multi-run, blocs de statistiques, export PDF, XLSX et PPTX, galerie de
  modèles, évaluateur d'expressions de premier niveau.
- Architectures de confinement 2 et 3, la 1 étant celle qui est implémentée :
  liste blanche AST plus processus fils forké.

## Ordre proposé

La garde d'exposant d'abord : c'est la seule entrée de cette liste qui est un
défaut de sécurité ouvert et non une fonctionnalité absente. Ensuite les
données réelles, qui conditionnent l'intérêt de tout le reste et rejoignent
[la chaîne datalake](/roadmap/datalake-pipeline.md). Le confort d'export en
dernier.
