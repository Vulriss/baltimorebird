---
type: Runbook
title: Maintenir le bundle OKF
description: Ce que le validateur exige, et la seule règle qui fait vraiment tomber l'intégration continue.
tags: [okf, documentation, ci]
status: stable
---

# Maintenir le bundle OKF

Ce répertoire `.okf/` est un bundle Open Knowledge Format v0.2. Il est validé en
intégration continue par `.github/workflows/okf.yml`, qui lance
`scripts/okf_validate.py .okf --strict`. Le validateur n'a aucune dépendance.

## Point d'entrée

Aucun outil ne découvre `.okf/` tout seul. `AGENTS.md`, à la racine, est le
fichier que les agents lisent par convention, et il renvoie vers
[l'index racine](/index.md). Claude Code, lui, ne lit que `CLAUDE.md` : le
`CLAUDE.md` du dépôt tient donc en une ligne, `@AGENTS.md`, qui importe le
fichier commun sans le dupliquer.

Conséquence : `AGENTS.md` ne doit contenir que ce qu'un agent doit savoir avant
d'ouvrir quoi que ce soit. Tout le reste appartient au bundle. Un `AGENTS.md`
qui grossit redevient le `CLAUDE.md` qu'on a retiré.

## Ce qui fait échouer la validation

En mode `--strict`, tout avertissement devient une erreur. Concrètement :

1. Chaque fichier `.md` non réservé porte un frontmatter YAML analysable, avec
   un `type` non vide, plus `title` et `description`.
2. Seul l'`index.md` racine porte un frontmatter, et il déclare `okf_version`.
   Un `index.md` de sous-répertoire ou un `log.md` qui porte un frontmatter est
   une erreur dure.
3. Aucun lien interne cassé.
4. Aucun concept orphelin : tout concept doit être cité par au moins un autre
   document.

## Le piège des liens

Le validateur ne reconnaît comme lien interne qu'une seule forme : un libellé
entre crochets, suivi entre parenthèses d'un chemin qui **commence par une barre
oblique**, interprétée comme la racine du bundle. C'est aussi la forme
recommandée par la spécification, parce qu'elle survit au déplacement d'un
document. Une forme relative n'est ni vérifiée ni comptée.

Corollaire : **ne jamais écrire un chemin de code source sous forme de lien**.
Un lien vers `src/backend/config.py` écrit avec une barre oblique initiale serait
compté comme un lien interne cassé, puisque le validateur le chercherait dans le
bundle. Les chemins de code s'écrivent entre accents graves, jamais en lien.

Même prudence pour un exemple de lien dans la documentation du bundle : le
validateur lit le fichier entier, blocs de code compris, et ne fait pas la
différence entre un lien et l'illustration d'un lien.

Corollaire du point 4 : un concept nouveau doit être ajouté à l'index racine
dans le même commit, sinon il est orphelin et la chaîne casse.

## Frontmatter attendu

```yaml
---
type: Architecture          # requis, valeur libre
title: ...                  # requis en pratique
description: ...            # requis en pratique
tags: [a, b]
status: stable              # draft | stable | deprecated
generated:
  by: human:Vulriss         # ou <producteur>/<version> pour un agent
  at: 2026-09-15T00:00:00Z
---
```

`status: draft` est le bon marqueur pour un concept prospectif qui n'a pas de
code derrière lui. Tout `/roadmap/` est dans cet état.
