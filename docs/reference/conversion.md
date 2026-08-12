# Conversion

L'espace Conversion permet de convertir un fichier MF4 vers un format tabulaire (CSV),
avec ou sans DBC de décodage. Accessible en mode invité comme en mode compte.

## Étapes de conversion

1. Sélectionner le fichier MF4 à convertir.
2. Joindre optionnellement un fichier DBC pour décoder les trames CAN brutes en
   signaux nommés.
3. Choisir le format de sortie et, le cas échéant, les options CSV (séparateur,
   ré-échantillonnage sur une base de temps commune).
4. Lancer la conversion.

## Suivi de progression

La conversion s'exécute de manière asynchrone côté serveur. Une barre de progression
et un pourcentage indiquent l'avancement en temps réel. Trois états sont possibles à
l'issue du traitement : conversion terminée avec fichier téléchargeable, ou erreur
avec message explicite.

## Ré-échantillonnage

L'option de ré-échantillonnage permet d'aligner l'ensemble des signaux sur une base
de temps commune (raster fixe) avant export, ce qui est nécessaire pour obtenir un
CSV avec des lignes régulières plutôt qu'un enregistrement par changement de valeur.

## Téléchargement

Une fois la conversion terminée, le fichier résultat est téléchargeable directement
depuis l'interface, sous le nom de sortie indiqué avant le lancement de la
conversion.
