# Première analyse

Ce guide décrit le chemin le plus court entre l'ouverture de l'outil et un premier
graphique de signal.

## 1. Charger un fichier

Depuis l'espace EDA :

1. Cliquer sur le bouton d'import (**Importer** en mode invité, ou le bouton d'upload
   authentifié si connecté).
2. Sélectionner un fichier `.mf4`. Un DBC optionnel peut être joint pour décoder les
   trames CAN brutes.
3. Le chargement s'effectue côté serveur : seuls les métadonnées et la liste des
   canaux sont transférés au navigateur dans un premier temps, ce qui permet
   d'ouvrir des fichiers volumineux rapidement.

Un serveur de démonstration expose déjà deux sources d'exemple (un enregistrement
OBD2 réel et un jeu de données synthétique), utilisables sans import pour se
familiariser avec l'interface.

## 2. Explorer les signaux

Une fois le fichier chargé, la barre latérale gauche affiche la liste des signaux
disponibles.

- Utiliser le champ de recherche pour filtrer par nom de signal.
- Cliquer sur un signal pour l'ajouter au graphique actif.
- Un clic avec **Shift** ou **Ctrl** enfoncé permet de sélectionner plusieurs signaux
  et de les ajouter en un seul chargement.
- Glisser-déposer un signal dans la légende permet de le réordonner.

## 3. Lire le graphique

- **Molette** : zoom autour du curseur.
- **Cliquer-glisser** : sélection d'une plage temporelle à zoomer.
- **Ctrl+Z / Ctrl+Y** : annuler ou rétablir un niveau de zoom (historique de 20
  étapes).
- Le curseur affiche la valeur de chaque signal visible à la position pointée ; les
  étiquettes se réorganisent automatiquement pour éviter les chevauchements.
- Les zones booléennes (signaux à deux états) sont mises en évidence par un
  surlignage de fond plutôt qu'une simple courbe.

## 4. Ajouter un onglet

Le bouton **+** dans la barre d'onglets crée un nouvel espace de visualisation
indépendant, utile pour organiser plusieurs vues d'un même fichier (par exemple,
signaux moteur dans un onglet, signaux châssis dans un autre).

## 5. Sauvegarder et partager

- **Sauvegarder la disposition** conserve l'agencement des graphiques et des signaux
  pour une réutilisation ultérieure.
- **Partager la vue** génère un lien contenant l'état de la vue encodé dans l'URL,
  permettant de le transmettre sans nécessiter de compte partagé.
- **Exporter en PNG** capture le graphique actif tel qu'affiché.

## Et ensuite

- Pour comparer plusieurs fichiers entre eux, voir
  {doc}`../reference/comparaison-multi-fichiers`.
- Pour construire une analyse réutilisable avec mise en page fixe, voir
  {doc}`../reference/dashboard`.
- Pour automatiser un traitement sur les données chargées, voir
  {doc}`../reference/scripts`.
