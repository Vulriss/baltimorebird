# Scripts

L'espace Scripts fournit un éditeur Python permettant d'écrire des traitements
personnalisés sur les données chargées, exécutés côté serveur dans un environnement
isolé. Il est réservé aux comptes utilisateur.

## Éditeur et gestion des scripts

- La liste des scripts (`scriptsList`) affiche les scripts enregistrés dans l'espace
  personnel de l'utilisateur, avec un compteur en tête de liste.
- Le nom du script actif est affiché en permanence pendant l'édition.
- Le statut d'exécution (en cours, terminé, en erreur) est indiqué à côté du nom du
  script.

## Console de sortie

La console (`consoleContent`) affiche la sortie du script en cours d'exécution ou
la plus récente exécution, incluant les appels à `print` et les messages d'erreur le
cas échéant.

## Environnement d'exécution en bac à sable

Pour des raisons de sécurité, le code exécuté est soumis à des restrictions
strictes, validées avant exécution par une analyse de l'arbre syntaxique (AST) :

**Modules autorisés**

`numpy`, `pandas`, `statistics`, `math`, `decimal`, `fractions`, `collections`,
`itertools`, `functools`, `datetime`, `re`, `string`, `json`, `typing`.

**Fonctions natives autorisées**

Les types de base (`int`, `float`, `str`, `bool`, `list`, `dict`, `set`, `tuple`,
etc.), les fonctions d'itération courantes (`len`, `range`, `enumerate`, `zip`,
`map`, `filter`, `sorted`, `min`, `max`, `sum`), ainsi que les exceptions standard.

**Interdictions explicites**

- Les fonctions `eval`, `exec`, `compile`, `open`, `input`, `globals`, `locals`,
  `vars`, `dir`, `__import__` sont bloquées.
- L'accès aux attributs internes de type `__globals__`, `__code__`, `__class__`,
  `__subclasses__`, `__reduce__` et assimilés est interdit.
- Toute tentative d'accès à des mécanismes d'introspection permettant de contourner
  la sandbox est rejetée avant l'exécution.

L'exécution est en outre limitée en temps et en mémoire, et se déroule dans un
processus séparé du serveur principal.

## Bonnes pratiques

- Garder les scripts courts et ciblés sur un traitement précis plutôt qu'un pipeline
  complet : la limite de taille de code et le temps d'exécution imparti favorisent
  des scripts focalisés.
- Utiliser `print` pour tracer les étapes intermédiaires d'un calcul, la console
  affichant la sortie complète.
- En cas d'erreur de validation avant exécution, le message retourné indique
  précisément la construction interdite détectée dans le code.
