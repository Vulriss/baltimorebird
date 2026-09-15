---
type: Decision Record
title: Worker gunicorn unique en production
description: Pourquoi la production tourne sur un seul worker, et ce que cela interdit.
tags: [deploiement, gunicorn, etat]
status: stable
generated:
  by: claude/sonnet-5
  at: 2026-09-15T00:00:00Z
---

# Worker gunicorn unique en production

## Contexte

Les sessions EDA paresseuses et les tâches de conversion maintiennent leur état
dans la mémoire du processus Flask. Rien n'est externalisé vers Redis ou vers
une base.

## Décision

La production tourne avec `-w 1 --threads 8`. Un seul worker, la concurrence
passe par les threads.

## Raison

Deux workers ne partageraient pas cet état. Une requête arrivée sur le worker B
ne trouverait pas la session ouverte par le worker A, de façon intermittente et
donc difficile à diagnostiquer. Le choix n'est pas une limite de performance
acceptée par paresse : c'est la conséquence directe du modèle mémoire décrit
dans [Sessions EDA](/architecture/eda-sessions.md).

## Conséquence

Monter en charge se fait verticalement, ou en externalisant d'abord l'état. Tant
que ce n'est pas fait, toute proposition d'ajouter des workers est à refuser.

L'accès aux handles de lecture est protégé par un `threading.RLock` par session,
puisque huit threads partagent le même processus. Le handle Rust est l'exception :
immuable après ouverture, il se partage sans verrou. Voir
[Lecture MF4](/architecture/mf4-reading.md).
