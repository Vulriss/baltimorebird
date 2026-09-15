---
type: Runbook
title: Tester
description: Les tests sont des fichiers isolés, pas une suite unique ; voici lesquels et quand.
tags: [tests, pytest, vitest, smoke]
status: stable
generated:
  by: claude/sonnet-5
  at: 2026-09-15T00:00:00Z
---

# Tester

Il n'y a **pas** de `pytest.ini` ni de `pyproject.toml` à la racine. Lancer
`pytest` depuis le dépôt ne collecte rien d'utile. Les tests se lancent fichier
par fichier, depuis `src/backend`.

```bash
cd src/backend
python -m pytest api/test_computed_formula.py
python -m pytest api/test_zone_stats.py
python -m pytest data_management/test_session_restore.py
python -m pytest services/test_storage_ingest.py
python -m pytest services/dashboard/test_dashboard.py
python -m pytest services/dashboard/test_formatting.py
```

Les fichiers préfixés `smoke_test_` dans `services/` (`smoke_test_blf_ingest.py`,
`smoke_test_mat_ingest.py`) demandent des fichiers de mesure et ne tournent pas
en intégration continue.

## Frontend

```bash
cd src/frontend
bun run test          # vitest run, environnement jsdom, config dans vitest.config.js
bun run test:watch
```

## Bout en bout

```bash
pip install -r tests/requirements-dev.txt
python tests/smoke_test.py [--base-url http://localhost:5000]
```

Exerce l'authentification, les envois de fichiers, les sessions EDA paresseuses
et le contrôle d'accès de `/api/view`. À passer avant tout déploiement.

## Bundle de connaissances

```bash
python3 scripts/okf_validate.py .okf --strict
```

Voir [Maintenir le bundle OKF](/workflows/okf-bundle.md).
