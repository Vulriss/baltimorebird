---
type: Architecture
title: Dashboard Builder
description: Recette par blocs, compilation en Python lisible, exécution confinée hors processus, rapport HTML.
tags: [dashboard, sandbox, compilation, rapports]
status: stable
---

# Dashboard Builder

Le module compile un graphe composé par l'utilisateur, appelé recette (blocs,
liens typés, mapping de variables), en un module Python, puis exécute ce module
**hors du processus Flask**, avant de rendre un rapport HTML autonome. Le code
vit sous `services/dashboard/` et les routes sous `/api/scripts/*`.

## Deux invariants

**Auditabilité.** Le Python généré est toujours montré à l'utilisateur. Aucune
étape d'exécution cachée. `compiler.py` produit un en-tête de module portant un
`provenance_hash` de la recette, et `validate_generated_module_source` vérifie
que le module émis respecte les conventions du dépôt, longueur de ligne comprise.

**Confinement.** Le Python écrit par l'utilisateur dans un bloc Python est une
entrée hostile par construction. Il est validé statiquement contre une liste
blanche, puis exécuté dans un processus fils. Il n'est jamais importé ni évalué
par l'application. Voir [Invariants de sécurité](/policies/security-invariants.md).

## Chaîne

1. `blocks.py` : catalogue des blocs, leurs champs, le code qu'ils émettent.
2. `compiler.py` : `validate_recipe` puis `compile_recipe`, aplatissement des
   blocs, collecte des helpers, émission d'une fonction par bloc et d'un
   séquenceur.
3. `services/sandbox.py` : validation AST, puis exécution dans un
   `multiprocessing` avec `RLIMIT_AS` et délai. La limite mémoire est
   **relative à la VSZ héritée au fork**, pas absolue ; voir la note dans le
   code et [Sessions EDA](/architecture/eda-sessions.md).
4. `report.py` : rendu HTML autonome.
5. `security_corpus.py` : corpus d'échappement, exécuté comme un test.

## Périmètre du PoC

Les blocs de données sont **synthétiques uniquement** (`synthetic.py`). Aucune
ingestion MF4 ou CAN réelle dans un dashboard à ce stade. La levée de cette
limite est décrite dans [Suite du Dashboard Builder](/roadmap/dashboard-builder-next.md).

La spécification fonctionnelle de référence est `docs/poc/functional-specification.md`.
Elle fait foi pour ce sous-système : on la lit avant de toucher à
`services/dashboard/` ou aux routes `/api/scripts/*`.
