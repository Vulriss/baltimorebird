---
type: Runbook
title: Construire et déployer
description: Full sequence.
tags: [build, deploiement, vite, systemd]
status: stable
---

# Construire et déployer

```bash
cd src/frontend
npm install          # seulement si les dépendances ont changé
npm run build        # écrit dans src/frontend/dist/
sudo systemctl restart baltimorebird
sudo systemctl restart nginx # si des modifs ont étés apportés à la conf ou autre
```

Note, le serveur de prod ext utilise aujourd'hui bun au lieu de npm, l'utilisation
de l'un ou l'autre est complètement transparente.

Pour itérer sans reconstruire à chaque fois, `npm run dev` sert le front sur le
port 5173 avec un proxy `/api` vers le backend.

## Carefull

Modifier un fichier de `src/frontend/src/` ; nginx sert `dist/`. Sans `npm run build`,
rien n'a changé, et aucune erreur ne l'indique.

Corollaire : une erreur de compilation SCSS ou JavaScript interrompt le build. Si
une variable SCSS manque, la feuille entière échoue et le bundle produit peut
être incomplet. Lire la sortie du build avant de conclure quoi que ce soit.
