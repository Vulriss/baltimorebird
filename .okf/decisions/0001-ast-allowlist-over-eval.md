---
type: Decision Record
title: Interpréteur AST sur liste blanche plutôt qu'eval filtré
description: Pourquoi le filtrage par blacklist a été abandonné pour les variables calculées.
tags: [securite, ast]
status: stable
generated:
  by: human:Geo
  at: 2026-09-10
---

# Interpréteur AST sur liste blanche plutôt qu'eval filtré

## Contexte

La première version des variables calculées reposait sur `eval` (portage oriole legacy), 
protégé par une regex en black list et des fonctions natives restreintes.

## Décision

Remplacement par une interprétation nœud par nœud d'un arbre syntaxique, sur une
liste blanche de types autorisés.

## Raison

Une black list est structurellement insuffisante : elle protège de ce qu'on a
pensé à interdire. Une liste blanche rend l'opération non autorisée inexprimable.
L'accès aux attributs, par exemple, n'est pas filtré : il est absent de la
grammaire acceptée.

## Conséquence

Tout ce qui produit une expression doit passer par cet évaluateur. Un supplément 
sécuritaire d'execution est en cours d'étude pour l'execution de code utilisateur
côté dashboard et big-data.
Voir [Variables calculées](/architecture/computed-variables.md).
