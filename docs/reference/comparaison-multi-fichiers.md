# Comparaison multi-fichiers

Le mode comparaison permet de superposer les signaux de plusieurs fichiers sur un
même graphique, pour analyser des essais différents côte à côte.

## Activer le mode comparaison

Le bouton **Comparer** bascule l'espace EDA en mode comparaison. Ce mode est
optionnel : l'exploration d'un fichier unique ne le requiert pas.

En mode invité (anonyme), la comparaison est limitée à 3 fichiers. Cette limite ne
s'applique pas aux comptes utilisateur.

## Ajouter et retirer des fichiers

Chaque fichier ajouté à la comparaison occupe un emplacement (`runSlots`) visible
dans la barre de comparaison, avec son propre nom d'affichage. Le retrait d'un
fichier de la comparaison n'affecte pas les autres : les vues et sélections des
fichiers restants sont conservées.

## Légende et curseur

En mode comparaison, la légende regroupe les signaux par fichier d'origine. Le
curseur affiche la valeur de chaque signal pour chaque fichier à la position
temporelle pointée, avec un décalage (offset) pris en compte lorsque les
enregistrements ne démarrent pas au même instant.

## Resynchronisation automatique

Lorsque des signaux de noms différents représentent la même grandeur d'un fichier à
l'autre (par exemple suite à un renommage entre deux versions d'un DBC), l'outil
propose une resynchronisation automatique pour les aligner sur le graphique.

## Alignement temporel

Un alignement automatique par corrélation croisée normalisée permet de recaler
temporellement deux enregistrements présentant un même profil de signal, utile
lorsque les essais n'ont pas démarré à un instant strictement identique.

## Variables calculées en comparaison

Une variable calculée définie en mode comparaison s'applique à l'ensemble des
fichiers comparés, chacun produisant sa propre courbe résultat.

## Réinitialisation du zoom

En mode comparaison, la réinitialisation du zoom ramène l'affichage à l'union des
plages temporelles de tous les fichiers comparés, et non à un seul fichier de
référence.
