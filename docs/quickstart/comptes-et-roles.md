# Comptes et rôles

## Rôles disponibles

| Rôle | Attribution | Accès |
|---|---|---|
| Invité (anonyme) | Par défaut, sans compte | EDA en lecture, comparaison limitée à 3 fichiers, conversion, concaténation |
| Utilisateur | Compte standard | EDA complet, Dashboard, Scripts, Reports, stockage personnel avec quotas |
| Administrateur | Premier compte créé sur l'instance, ou promotion manuelle | Accès utilisateur complet, plus gestion des comptes, bannière système et consultation des métriques d'usage |

## Stockage et quotas

Chaque compte utilisateur dispose d'un espace de stockage personnel où sont conservés
les fichiers MF4 importés, les fichiers DBC associés, les dispositions
sauvegardées, les mappings et les analyses. Les compteurs d'utilisation sont visibles
dans l'espace **Paramètres** du compte.

Les quotas exacts (volume et nombre de fichiers) dépendent de la configuration de
l'instance et peuvent être communiqués par l'administrateur.

## Fonctionnalités réservées aux administrateurs

Depuis l'espace **Paramètres**, un compte administrateur a accès à :

- la gestion des comptes utilisateurs (changement de rôle, désactivation) ;
- la configuration d'une bannière d'information affichée à l'ensemble des
  utilisateurs, avec sévérité, plage de dates et caractère masquable ;
- un tableau de bord de métriques d'usage : utilisateurs actifs du jour, sessions
  actives, latence moyenne, répartition par endpoint et synthèse hebdomadaire.

## Modifier son mot de passe

Depuis **Paramètres**, renseigner le mot de passe actuel puis le nouveau mot de passe
(saisi deux fois pour confirmation). Le changement prend effet immédiatement, sans
déconnexion des autres sessions actives.
