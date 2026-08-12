# EDA (exploration interactive)

L'espace EDA est le module central de Baltimore Bird : il permet de charger un
fichier MF4, de sélectionner des signaux et de les explorer sous forme de graphiques
synchronisés.

## Barre latérale

Deux onglets composent la barre latérale gauche :

- **Fichiers** : liste les sources chargées dans la session courante. Le sélecteur de
  source permet de basculer entre plusieurs fichiers ouverts sans les recharger.
- **Signaux** : liste les canaux disponibles pour la source active, avec un champ de
  recherche pour filtrer par nom.

La largeur de cette barre latérale est ajustable par glissement du séparateur
vertical, et la préférence est conservée entre les sessions.

## Sélection et ajout de signaux

- Clic simple : ajoute le signal au graphique actif.
- **Shift** + clic : sélectionne une plage continue de signaux dans la liste.
- **Ctrl** + clic : ajoute ou retire un signal individuel à une sélection existante.
- Les signaux sélectionnés sont chargés en un seul appel réseau groupé, plutôt qu'un
  appel par signal.

## Onglets et disposition

Chaque onglet (`+` dans la barre d'onglets) représente une disposition de graphiques
indépendante. Les onglets sont réordonnables par glisser-déposer.

## Curseur et lecture des valeurs

- Le curseur suit la position de la souris sur le graphique et affiche la valeur
  interpolée ou exacte de chaque signal visible.
- Le bouton **Ajouter un curseur** permet de figer un curseur supplémentaire pour
  comparer deux instants précis.
- L'affichage des étiquettes de curseur peut être activé ou désactivé
  (`cursorLabelsToggle`).
- L'affichage d'une info-bulle sur les zones booléennes peut être activé ou désactivé
  (`zoneTooltipToggle`).

## Zoom

- Molette de la souris : zoom centré sur le curseur.
- Cliquer-glisser horizontal : zoom sur une plage temporelle.
- **Ctrl+Z** / **Ctrl+Y** : annuler ou rétablir un niveau de zoom, sur un historique de
  20 étapes.
- Le bouton **Réinitialiser** ramène le graphique à l'échelle complète des données
  chargées.

## Signaux booléens et catégoriels

Les signaux à deux états sont affichés sous forme de surlignage de zone plutôt que de
courbe classique, ce qui facilite l'identification visuelle des périodes actives. Les
signaux catégoriels (énumérations) affichent leur libellé texte plutôt qu'une valeur
numérique brute lorsque cette information est disponible dans le fichier ou le DBC.

## Variables calculées

Le bouton **Créer une variable** ouvre un éditeur permettant de définir un nouveau
signal à partir d'une formule appliquée à un ou plusieurs signaux existants. La
variable calculée se comporte ensuite comme un signal natif : elle peut être tracée,
comparée entre fichiers et exportée.

Pour modifier une variable calculée existante, effectuer un double-clic sur son
entrée dans la liste des signaux.

## Import de dispositions MDA

Une disposition exportée depuis ETAS MDA (fichier `.xdx`) peut être importée
directement via le bouton d'import MDA, afin de reprendre une mise en page existante
sans la reconstruire manuellement.

## Sauvegarde, partage et export

- **Sauvegarder la disposition** : conserve l'agencement courant (onglets, graphiques,
  signaux sélectionnés) pour une réutilisation ultérieure. Réservé aux comptes
  utilisateur.
- **Charger une disposition** : recharge une disposition précédemment sauvegardée.
- **Partager la vue** : génère un lien contenant l'état de la vue encodé en base64
  dans le fragment d'URL, exploitable sans compte partagé.
- **Exporter en PNG** : capture le graphique actif dans son état affiché.

## Outils d'analyse par signal

Depuis le menu contextuel d'un signal dans la légende :

- **Filtrage Savitzky-Golay** : lissage du signal, avec préréglages Léger, Moyen et
  Fort.
- **Dérivée (dx/dt)** : calcul de la dérivée du signal, avec gestion des pas de temps
  non uniformes.
- **Analyse KDE** : estimation de densité par noyau de la distribution des valeurs.
- **Analyse FFT** : transformée de Fourier rapide pour l'analyse fréquentielle.

Ces popovers se rafraîchissent automatiquement lorsque la vue (zoom, plage
temporelle) change.

## Annotations d'événements

Lorsqu'un fichier MF4 contient des événements INCA (annotations Ctrl+K), ceux-ci sont
affichés sous forme de bande au-dessus du graphique, avec une info-bulle au survol
donnant le détail de chaque annotation.

## Indicateurs de session

En bas de l'interface, trois indicateurs renseignent sur la source active : durée
totale de l'enregistrement, temps de traitement côté serveur et nombre de signaux
disponibles.
