---
type: Architecture
title: Variables calculées
description: Interpréteur AST sur liste blanche, sans eval ni accès aux attributs.
tags: [securite, ast, expressions]
status: stable
generated:
  by: agent
  at: 2026-09-09
---

# Variables calculées

`SafeExpressionEvaluator`, dans `computed.py`, interprète l'expression nœud par
nœud sur une liste blanche de types AST. Les opérations non autorisées ne sont
pas filtrées : elles sont impossibles à exprimer. L'accès aux attributs est
structurellement absent de la liste, donc inatteignable.

C'est l'invariant à ne jamais contourner. Toute fonctionnalité qui produit une
expression, y compris une suggestion générée par un modèle, doit la faire passer
par cet évaluateur et l'afficher à l'utilisateur avant application. Le générateur
propose du texte ; il n'est jamais un chemin d'exécution.

Voir [AST sur liste blanche plutôt qu'eval](/decisions/0001-ast-allowlist-over-eval.md)
et [Invariants de sécurité](/policies/security-invariants.md).
