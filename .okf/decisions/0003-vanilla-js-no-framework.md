---
type: Decision Record
title: JavaScript vanilla vs framework
description: Choix délibéré, ses conséquences sur le chargement des vues, et la condition de sa révision.
tags: [frontend, javascript, vite]
status: stable
generated:
  by: human:Geo
  at: 2026-09-15T15:25:00Z
---

# JavaScript vanilla plutôt qu'un framework

## Contexte

L'interface est une application mono-page avec une vue d'exploration très dense
et plusieurs vues secondaires. Le choix par défaut de l'industrie serait React.

## Décision

JavaScript vanilla, modules ES, bundle produit par Vite. Aucun framework.

## Raison

Le coût d'un framework est ici réel: le render des timeseriesest fait
au canvas par uPlot, avec des greffons qui manipulent des coordonnées et non des
éléments du DOM. Un framework n'apporterait rien à la partie coûteuse et
imposerait sa discipline à tout le reste. Renault prévoit par ailleurs un
design system React à plus long terme, ce qui rendrait un choix de framework
fait aujourd'hui doublement transitoire.

## Conséquence

`main.js` importe les modules dans un **ordre préservé**, documenté par des
commentaires dans le fichier, plutôt que de s'appuyer sur un routeur.

Les vues sont des fragments HTML chargés à la demande par `core/view-loader.js`
et injectés par `innerHTML`. Un sélecteur qui vise un élément de vue ne peut
donc pas être résolu au chargement du document : la vue arrive plus tard, par
mutation du DOM. C'est la source d'erreur numéro un pour un contributeur
nouveau.

Le code historique de `core/` est en IIFE exposées sur `window`, déclarées dans
`.eslintrc.json`. La cohabitation avec les modules ES de `eda/` est assumée, pas
accidentelle.

## Révision

Cette décision se réexamine si le design system React de la MINT (ie Renault)
 devient une contrainte de conformité plutôt qu'une intention.
