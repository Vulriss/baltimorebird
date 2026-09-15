---
type: Policy
title: Invariants de sécurité
description: Ce qui ne doit être contourné sous aucun prétexte.
tags: [securite, csp]
status: stable
generated:
  by: human:Geo
  at: 2026-09-09
verified:
  by: human:Geo
  at: 2026-09-15
---

# Invariants de sécurité

Le code fourni par un utilisateur n'est jamais importé ni évalué par le processus
de l'application. Une expression passe par l'interpréteur AST sur liste blanche,
et rien d'autre. Voir [Variables calculées](/architecture/computed-variables.md).

Aucun gestionnaire d'événement en ligne. La politique de sécurité de contenu est
définie dans `src/backend/middleware/security.py` ; toute ressource externe doit y
être déclarée, sinon elle est silently blocked.

Les mots de passe sont hachés avec bcrypt. Les tentatives de connexion sont
limitées avec verrouillage. Les chemins de fichiers sont contrôlés contre la
traversée de répertoire. Les identifiants d'utilisateur dans les métriques sont
hachés avec un sel, jamais stockés en clair.

Les endpoints d'administration sont protégés par `admin_required`. Un nouvel
endpoint qui expose des données agrégées doit suivre la même règle.
