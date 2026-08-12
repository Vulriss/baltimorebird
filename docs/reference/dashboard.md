# Dashboard

L'espace Dashboard est un éditeur par blocs permettant de construire des modèles de
rapport réutilisables, combinant graphiques, textes et résultats de scripts. Il est
réservé aux comptes utilisateur.

## Palette de blocs

La palette de gauche liste les types de blocs disponibles, avec un champ de recherche
pour les filtrer. Un bloc est ajouté au canevas par glisser-déposer.

## Canevas d'édition

Le canevas central (`editionCanvas`) accueille les blocs déposés depuis la palette.
Un canevas vide affiche un message d'invite. La disposition des blocs est
entièrement libre : taille, position et empilement sont ajustables directement dans
le canevas.

## Panneau de mapping

Le panneau de mapping associe les blocs du tableau de bord à des signaux ou sources
de données concrètes. La recherche dans ce panneau permet de retrouver rapidement un
mapping existant parmi ceux déjà définis. Le compteur en tête de panneau indique le
nombre de mappings actifs.

## Panneau outline

Le panneau outline donne une vue structurée de la hiérarchie des blocs du tableau de
bord courant, utile pour naviguer dans un dashboard complexe sans faire défiler le
canevas.

## Intégration avec les scripts

Un tableau de bord peut inclure des blocs alimentés par le résultat d'un script
Python (voir {doc}`scripts`). Le statut d'exécution du script associé et le nom du
script actif sont affichés directement dans l'interface du dashboard, ainsi que la
console de sortie du script.

## Réduction et bascule d'affichage

Le panneau de dashboard peut être réduit ou étendu via le bouton de bascule dédié,
pour libérer de l'espace d'écran lors de l'édition du canevas.
