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

## Modification d'une variable déjà tracée

Le serveur remplace les données sous le même index. Côté client,
`submitCreateVariable` appelle `invalidateSignalCaches` (`eda/data-views.js`), qui
oublie le signal dans `cachedData`, les dérivés, les vues par plot, les vues
persistantes de la session et le prefetch, puis redessine les plots concernés. Sans
cette purge, `cacheServerSignals` conserve le cache complet et l'ancien calcul reste
affiché.

## Persistance dans les layouts

Depuis `LAYOUT_VERSION = 2`, chaque entrée de `computed_variables` porte le `mapping`
explicite lettre vers signal, exposé par `/api/eda/list-signals` et `/api/info`. C'est
lui qui fait foi à la restauration : `source_signals` n'est qu'une liste de noms dont
l'ordre ne correspond pas forcément aux lettres triées de la formule. Les layouts v1,
sans `mapping`, retombent sur l'association positionnelle historique.

`applyLayout` recrée les variables par passes successives (`layout-computed.js`), ce qui
respecte les dépendances entre variables calculées. Une variable non recréée (source
absente, formule refusée, nom déjà pris par un signal brut) est signalée à l'utilisateur
et sa définition est gardée dans `S.unresolvedComputedVars`, puis ré-exportée telle
quelle : un aller-retour A vers B vers A ne la perd pas. Chaque signal de plot peut
porter un `transform` optionnel (`{mode, window}`) qui persiste son mutateur rapide.

L'export LXF (utilisateur non connecté) porte les mêmes données dans des processing
instructions XML, hors schéma ASAM : `baltimorebird-layout` dans le prologue pour les
variables calculées, `baltimorebird-signal` dans chaque `LineCurve` pour le mutateur et
le style que LXF ne sait pas représenter. Un lecteur LXF tiers les ignore.

`validate_layout_content` (`api/layouts.py`) contrôle types et tailles de ces champs,
pour l'API layouts comme pour le stockage utilisateur où les layouts sont réellement
enregistrés.

Voir [AST sur liste blanche plutôt qu'eval](/decisions/0001-ast-allowlist-over-eval.md)
et [Invariants de sécurité](/policies/security-invariants.md).
