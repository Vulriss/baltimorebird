# Paramètres

L'espace Paramètres regroupe la gestion du compte et, pour les administrateurs, les
outils de supervision de l'instance. Il nécessite un compte connecté.

## Compte

- Modification du mot de passe (mot de passe actuel requis, nouveau mot de passe
  saisi deux fois pour confirmation).
- Consultation des compteurs d'utilisation de l'espace personnel : nombre de
  fichiers MF4, de fichiers DBC, de dispositions et de mappings enregistrés.

## Bannière système (administrateurs)

Un administrateur peut configurer une bannière affichée à l'ensemble des
utilisateurs de l'instance :

- **Message** : texte affiché, avec compteur de caractères restants.
- **Sévérité** : niveau visuel de la bannière (information, avertissement, etc.).
- **Plage de dates** : date et heure de début et de fin d'affichage.
- **Masquable** : autorise ou non l'utilisateur à fermer la bannière manuellement.

Un aperçu de la bannière est affiché avant enregistrement.

## Métriques d'usage (administrateurs)

Le tableau de bord de métriques affiche :

- le nombre d'utilisateurs actifs et de requêtes du jour ;
- le nombre de sessions actives et la latence moyenne des requêtes ;
- une répartition de l'usage par endpoint ;
- une synthèse hebdomadaire et un détail par jour.

Ces métriques sont calculées côté serveur à partir de snapshots quotidiens et ne sont
visibles que par les comptes administrateur.
