---
okf_version: "0.2"
---

# Baltimore Bird — bundle de connaissances

Contexte destiné aux agents et aux humains qui travaillent sur ce dépôt.
Le code reste la source de vérité ; ce bundle explique les intentions, les
invariants et les procédures que le code ne dit pas.

## architecture

- [Pile technique](/architecture/stack.md) — ce qui tourne où, et comment le front est servi
- [Variables calculées](/architecture/computed-variables.md) — interpréteur AST sur liste blanche

## workflows

- [Construire et déployer](/workflows/build-and-deploy.md)

## decisions

- [AST sur liste blanche plutôt qu'eval](/decisions/0001-ast-allowlist-over-eval.md)

## policies

- [Conventions de code](/policies/code-conventions.md)
- [Invariants de sécurité](/policies/security-invariants.md)
