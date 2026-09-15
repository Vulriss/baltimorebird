---
type: Architecture
title: EDA lazy-session
description: Chargement par canal à la demande, budget mémoire, éviction, et pourquoi l'état vit dans le processus.
tags: [eda, memoire, sessions, mf4]
status: stable
---

# Sessions EDA paresseuses

Une acquisition MF4 pèse couramment plusieurs gigaoctets et porte des milliers
de canaux dont l'utilisateur en regarde cinq. `LazyEDAManager` et `LazySession`,
dans `data_management/sessions.py`, chargent donc **un canal à la fois, à la
demande**, et jamais le fichier entier. La lecture elle-même est déléguée au
moteur Rust, avec repli asammdf, décrit dans [Lecture MF4](/architecture/mf4-reading.md).

C'est l'invariant de la couche de données. Toute fonctionnalité qui aurait
besoin de parcourir tous les canaux d'un coup doit l'énoncer explicitement et
justifier son coût mémoire, parce que le défaut est l'inverse.

## Bornes

Les constantes vivent dans `config.py` :

- `LAZY_EDA_SESSION_TIMEOUT` : expiration d'une session inactive après huit heures.
- `LAZY_EDA_MEMORY_BUDGET_BYTES` : budget mémoire global des sessions, surchargeable
  par `BB_LAZY_EDA_MEMORY_BUDGET_BYTES`.
- `LAZY_EDA_EVICTION_GRACE` : délai de grâce avant qu'une session soit évincée.

Le thread de maintenance purge les sessions expirées, les fichiers temporaires
orphelins et les tâches de conversion anciennes (`data_management/maintenance.py`).

## Persistance de la description

Une session est décrite par un `SessionDescriptor` sérialisable
(`session_descriptor.py`) : sources, signaux calculés, confinement. Le
descripteur permet de reconstruire une session après redémarrage sans
reconstruire l'état mémoire. `confinement_violations` vérifie qu'un descripteur
ne pointe pas hors du répertoire de l'utilisateur ; c'est un contrôle de
sécurité, pas une validation de confort.

## Conséquence de déploiement

Cet état vit dans la mémoire du processus Flask. Il n'est ni partagé ni
répliqué. C'est ce qui impose un worker gunicorn unique en production, et c'est
aussi ce qui rend la limite mémoire de la sandbox relative et non absolue. Voir
[Worker gunicorn unique](/decisions/0002-single-gunicorn-worker.md).
