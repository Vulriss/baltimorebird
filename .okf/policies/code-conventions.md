---
type: Policy
title: Conventions de code
description: Règles de style et de langue appliquées dans tout le dépôt.
tags: [conventions, style]
status: stable
generated:
  by: human:Geo
  at: 2026-09-09
verified:
  by: human:Geo
  at: 2026-09-15
---

# Conventions de code

## Python

PEP 8 avec des lignes de 120 caractères, annotations de type PEP 484, docstrings
de style Google en anglais, journalisation plutôt qu'affichage direct. Les
principes SOLID s'appliquent, PEP 20 sert d'arbitre en cas de doute.

## JavaScript

ESLint 8.57 avec `ecmaVersion: 2021` : pas de champ de classe privé, pas de
syntaxe ES2022. Indentation de quatre espaces, guillemets simples.

## SCSS

Système de modules `@use`. Les couleurs viennent des jetons Catppuccin de
`abstracts/_variables.scss`, jamais de valeurs littérales. Pas de dégradé.

## Langue

Tout en anglais pour la documentation produite et les docstrings.

## Interdits

No boilerplate comment. Pas de séparateurs décoratifs en blocs.
Et pas d'emoji flingués.
