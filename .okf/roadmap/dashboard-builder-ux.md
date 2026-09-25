---
type: Roadmap
title: Dashboard Builder, ergonomie et chaîne d'exécution
description: Sujet de hackathon Capgemini. Frictions de l'éditeur relevées par audit du code, classées par sévérité, et découpées en tranches livrables.
tags: [dashboard, hackathon, capgemini, ux, frontend]
status: draft
generated:
  by: claude/sonnet-5
  at: 2026-09-25T00:00:00Z
verified:
  by: human:Geo
  at: 2026-09-25
---

# Dashboard Builder, ergonomie et chaîne d'exécution

Sujet de hackathon mené avec Capgemini. Le PoC a livré la chaîne recette,
compilation, exécution confinée et rapport (voir
[Dashboard Builder](/architecture/dashboard-builder.md)). Ce sujet porte sur
l'éditeur qui la pilote : micro-interactions, workflow, retour d'exécution et
finition visuelle. Il est distinct de
[la suite du Dashboard Builder](/roadmap/dashboard-builder-next.md), qui liste
des fonctionnalités reportées et un défaut de sécurité ouvert.

La référence reste `docs/poc/functional-specification.md`, sections 5, 6 et 16.
Les identifiants d'exigence cités ci-dessous en viennent.

## Où est le code

Tout l'éditeur tient dans `src/frontend/src/views/dashboard.js`, module
`DashboardEditor`, avec son gabarit `src/frontend/views/dashboard.html` et ses
styles `src/frontend/styles/views/_dashboard.scss`. Les routes API sont dans
`src/backend/api/scripts.py`, le compilateur dans
`src/backend/services/dashboard/compiler.py`.

L'éditeur n'est pas un blueprint builder : c'est un arbre ordonné de blocs, les
sections étant les seuls conteneurs. Chaque modification structurelle
(ajout, déplacement, suppression, changement de niveau de section) reconstruit
tout le canvas par `innerHTML` dans `renderCanvas`.

## Constats d'audit

Relevés par lecture du code au 2026-09-25 et test sur navigateur.

### Very no bueno

- **Aperçu de code par bloc divergent du code compilé.** Chaque entrée de
  `BLOCK_DEFINITIONS` porte un `generateCode` côté client qui émet une API
  fictive (`report.add(Section(...))`, `synthetic_source(df, ...)`). Le module
  réellement exécuté est produit par `compiler.py` et affiché dans le panneau de
  droite par `refreshLivePreview`. Montrer à l'utilisateur un Python qui n'est
  pas celui qui tourne contredit l'invariant d'auditabilité. Expected behavior :
  retirer l'aperçu par bloc et le remplacer par la synchronisation décrite plus
  bas.
- **Déplacer une section dans sa propre descendance crée un cycle.** Les zones
  de dépôt des enfants d'une section restent actives pendant qu'on la glisse,
  et `moveBlock` ne vérifie pas l'ascendance. La section devient son propre
  child, disparaît de la racine, et `flattenTree` comme `renderBlockList`
  récursent sans fin.
- **Pas d'annulation ni de rétablissement.** `EDT-05` est un Must. Aucun
  raccourci clavier n'est câblé, alors que la section 16 les rend obligatoires
  pour les actions fréquentes (`Ctrl+S`, `Ctrl+Z`, `Ctrl+Y`).
- **Exécution sans retour d'état ni annulation.** `POST /api/scripts/<id>/run`
  est synchrone. Le client écrit « Chargement des données » et « Génération du
  rapport » dans la console après la fin de l'exécution : ce n'est pas une
  vrai progression. Aucun état de bloc n'est affiché sur le canvas (`EDT-08`), et
  l'annulation par l'utilisateur (`LIF-01`, Must) n'existe pas.

### Middle no bueno

- **Glisser-déposer peu fiable selon les blocs.** Causes candidates, par ordre
  de probabilité : `handlePaletteDragStart` n'appelle pas
  `dataTransfer.setData`, sans quoi Firefox ne démarre pas le glisser depuis la
  palette ; seules les fines zones entre blocs acceptent le dépôt, pas le corps
  d'un bloc ; une section repliée n'offre aucune cible visible pour ses children.
- **Pas de synchronisation entre blocs et code généré.** Sélectionner un bloc ne
  fait pas défiler le panneau de code, et l'inverse non plus. Le compilateur
  émet déjà une fonction par bloc, nommée d'après son identifiant et documentée
  par « Run block 'id' », donc la correspondance existe.
- **Validation non rattachée aux blocs.** `validateRecipeDraft` produit des
  chaînes « Bloc id: ... », sans ancrage sur le bloc ni sur le champ
  (`EDT-03`, `EDT-04`). L'aperçu ne montre que la première erreur serveur.
- **Éditeurs de code détruits à chaque rendu structurel.** `renderCanvas`
  appelle `CodeEditor.destroyAll` puis recrée tous les éditeurs : l'historique
  d'annulation interne d'un bloc Python est perdu dès qu'un autre bloc bouge.
- **Couleurs codées en dur.** Les couleurs de blocs sont des hexadécimaux dans
  `BLOCK_DEFINITIONS`, injectés en style en ligne, et plusieurs n'appartiennent
  pas au theme global (`#8b5cf6`, `#64748b`, `#22c55e`, `#06b6d4`, `#f59e0b`).

### Pequino no bueno

- `setupDragAndDrop` réattache les écouteurs de la palette à chaque rendu : les
  gestionnaires s'accumulent.
- `scrollToBlock` ne déplie une section que si elle est elle-même la cible, pas
  ses ancêtres : naviguer depuis le plan vers une section imbriquée dans une
  section repliée échoue.
- Pas de copier, coller ni dupliquer (`EDT-06`, Should).

## Tranches proposées

Chaque tranche est livrable seule et validée en navigateur avant la suivante.

1. **Fiabilité de l'édition.** Cycle de section, glisser-déposer, listeners,
   dépliage des ancêtres. Aucune dépendance.
2. **Un seul code montré.** Retrait de l'aperçu par bloc, synchronisation
   bidirectionnelle bloc et panneau de code, surlignage de la plage du bloc
   sélectionné. La correspondance bloc vers lignes doit venir du compilateur,
   renvoyée par `compile-preview`, et non d'une analyse du texte côté client.
   C'est un changement de contrat de route.
3. **Historique et raccourcis.** Pile d'annulation sur les opérations de
   recette, raccourcis de la section 16, dupliquer. Préalable utile : rendre le
   rendu incrémental, ou au minimum préserver les éditeurs de code non touchés.
4. **Validation sur le bloc.** Erreurs par champ et par bloc, liste de
   problèmes navigable, toutes les erreurs de `compile-preview` et pas la
   première seulement.
5. **Chaîne d'exécution observable.** États de bloc sur le canvas, progression
   réelle, annulation. Voir la contrainte ci-dessous.
6. **Polish.** Couleurs avec le theme token standard, contraste AA, micro-retours
   sous 200 ms (section 16).

## Contrainte sur la tranche 5

Une exécution asynchrone avec progression et annulation suppose un travail
suivi entre plusieurs requêtes. En prod, ce suivi vit en mémoire du worker
gunicorn unique, comme les sessions EDA (prod externe Renault) : c'est compatible avec
[le worker unique](/decisions/0002-single-gunicorn-worker.md), mais tout état
de travail doit survivre à un redémarrage sans corrompre la recette (`POC-05`,
`LIF-03`). Le processus fils confiné reste le seul lieu d'exécution du code
utilisateur ; voir [Invariants de sécurité](/policies/security-invariants.md).

## Critères de livraison

- Chaque tranche livrée passe le build Vite, ESLint et un scénario manuel écrit
  dans un navigateur de référence.
- Aucun sélecteur de vue résolu au chargement, aucun gestionnaire en ligne.
- Tranche 2 : le code visible dans l'éditeur est, octet pour octet, celui que le
  runner exécute.
- Tranche 3 : toute opération de la section 6 est annulable, y compris
  suppression d'un bloc et déplacement entre sections.
