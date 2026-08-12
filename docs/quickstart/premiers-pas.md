# Premiers pas

## Accéder à l'outil

Baltimore Bird est une application web, accessible sans installation depuis
[baltimorebird.cloud](https://baltimorebird.cloud). Aucun logiciel client n'est requis :
seul un navigateur récent est nécessaire.

## Mode invité et mode compte

Deux façons d'utiliser l'outil sont disponibles :

- **Mode invité (anonyme)** : aucune inscription requise. Les fichiers chargés sont
  associés à une session temporaire (durée de vie d'une heure) et ne sont pas
  conservés au-delà. Ce mode est limité à la comparaison de 3 fichiers maximum et ne
  donne pas accès aux tableaux de bord, rapports, scripts ou conversions.
- **Compte utilisateur** : après inscription, les fichiers, tableaux de bord, scripts
  et rapports sont conservés dans un espace de stockage personnel, avec des quotas
  associés au compte.

Le mode invité convient à une exploration ponctuelle d'un fichier. Le mode compte est
recommandé pour un usage récurrent.

## Créer un compte

1. Ouvrir la fenêtre de connexion depuis le bouton de connexion en haut de
   l'interface.
2. Renseigner une adresse email, un mot de passe et un nom d'affichage.
3. Valider l'inscription.

Le tout premier compte créé sur une instance obtient automatiquement le rôle
administrateur. Les comptes suivants obtiennent le rôle utilisateur standard. Voir
{doc}`comptes-et-roles` pour le détail des droits associés à chaque rôle.

## Vue d'ensemble de l'interface

L'application est organisée en plusieurs espaces, accessibles depuis la navigation
principale :

| Espace | Rôle requis | Description |
|---|---|---|
| EDA | invité ou utilisateur | Exploration interactive des signaux |
| Dashboard | utilisateur | Éditeur de tableaux de bord par blocs |
| Reports | utilisateur | Consultation et export des analyses générées |
| Scripts | utilisateur | Éditeur Python avec exécution en bac à sable |
| Conversion | invité ou utilisateur | Conversion MF4 vers CSV |
| Concaténation | invité ou utilisateur | Fusion de plusieurs fichiers MF4 |
| Paramètres | utilisateur | Gestion du compte, du stockage et des préférences |

L'espace EDA est le point d'entrée le plus courant : c'est depuis là que les fichiers
sont chargés et explorés.
