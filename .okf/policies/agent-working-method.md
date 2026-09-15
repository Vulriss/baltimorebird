---
type: Policy
title: Méthode de travail attendue
description: Ce qu'on annonce avant de coder, ce qu'on vérifie après, et ce qui vaut un revert.
tags: [methode, revue, qualite]
status: stable
generated:
  by: human:Geo
  at: 2026-09-15T15:09:00Z
---

# Méthode de travail attendue

S'applique aux contributeurs humains comme aux agents. Un agent qui ignore cette
page produit du code qui sera rejeté, pas du code qui sera corrigé.

## Avant de coder

Énoncer brièvement : les exigences touchées et leur référence de spécification,
le plan d'implémentation, les critères d'acceptation, la liste des modules
impactés. Quatre lignes suffisent. Le but est de rendre le désaccord possible
avant l'écriture, pas après.

Sur le Dashboard Builder, lire `docs/poc/functional-specification.md` d'abord.
C'est la spécification qui fait foi, pas l'intuition de conception.

## Pendant

Éditions chirurgicales plutôt que réécritures larges. Le code amont fait
autorité : on ne le reformate pas au passage, on ne le renomme pas parce qu'un
autre nom plairait davantage. Une tranche fonctionnelle est validée avant d'être
intégrée à la suivante.

## Après

Vérifier le résultat contre les critères annoncés. Proposer les tests unitaires
de ce qui a été ajouté. Expliquer les choix de conception, y compris ceux qui
ont été écartés.

Passer l'analyse statique sur chaque fichier modifié et corriger ce qu'elle
remonte sur le code neuf, sans attendre qu'on le demande. Après toute
modification de dépendances (`requirements.txt`, `package.json`), passer une
analyse de vulnérabilités et traiter ce qui est trouvé avant de continuer. Le
dépôt est branché sur Codacy et contraint à ESLint 8.57 par ce biais.

## Performance

Aucune optimisation n'est intégrée sans mesure avant et après, accompagnée
d'assertions de correction. Une optimisation qui ne prouve pas son gain est
retirée, même si elle est élégante. Un cas réel du projet : `return_inverse`
mesuré plus lent que la ligne de base, revenu à `searchsorted`.

## Signalement de défaut

Un rapport de bug utile porte les logs console et réseau exacts et la preuve
visuelle. La réponse attendue est une correction de cause racine. Un
contournement qui masque le symptôme est refusé, et le sur-dimensionnement se
signale au lieu de se subir.

Voir [Conventions de code](/policies/code-conventions.md) et
[Invariants de sécurité](/policies/security-invariants.md).
