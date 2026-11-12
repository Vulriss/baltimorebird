# EDA (exploration interactive)

L'espace EDA est le module central de Baltimore Bird : il permet de charger un
fichier MF4, de sélectionner des signaux et de les explorer sous forme de graphiques
synchronisés.

## Formats acceptés

| Format | Ce qu'il faut fournir |
| --- | --- |
| `.mf4`, `.dat` | Le fichier seul. Un DBC optionnel décode les trames CAN brutes. |
| `.blf` | Le fichier et une base de communication `.dbc` ou `.arxml`, obligatoire. |
| `.mat` | Le fichier seul (export de simulation Simulink). |
| `.csv` | Le fichier seul. |

Les formats autres que MF4 sont convertis à l'import : le fichier conservé dans la
bibliothèque est toujours un MF4, et toutes les fonctions de l'espace EDA s'appliquent
ensuite sans distinction.

### Structure CSV attendue

Aucun réglage n'est demandé, la structure est détectée à la lecture.

- **Encodage** : UTF-8 (avec ou sans BOM), Windows-1252 ou Latin-1.
- **Séparateur** : virgule, point-virgule, tabulation ou barre verticale.
- **Première ligne** : les noms de colonnes. L'unité peut y être accolée entre
  crochets ou parenthèses, par exemple `Speed [km/h]`.
- **Deuxième ligne** : facultative, les unités, à condition qu'elle ne contienne
  aucune valeur numérique. C'est le format produit par l'export CSV de
  l'application, qui se relit donc tel quel.
- **Colonne de temps** : la première colonne, ou celle nommée `time`,
  `timestamps`, `t`, `temps` ou `datetime`. Les nombres sont des secondes, sauf
  unité contraire indiquée dans le nom ou la ligne d'unités (`ms`, `us`, `ns`,
  `min`, `h`). Les dates ISO-8601 (`2026-01-02T10:00:00`) sont acceptées.
- **Valeurs** : décimale point ou virgule, notation scientifique admise. Une
  cellule vide est un échantillon absent, pas un zéro. Les colonnes de texte sont
  ignorées et leur nombre est indiqué à la fin de l'import.
- **Taille** : 5 Go par fichier, soit le plafond de l'envoi HTTP, et 150 millions
  de valeurs au maximum.

Un fichier dont la structure n'est pas reconnue est refusé avec un message qui
précise ce qui a échoué : séparateur introuvable, colonne de temps inexploitable
ou absence de colonne numérique.

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
- Le bouton **Ajouter un curseur**, à droite de la règle de temps, permet de figer un
  curseur supplémentaire pour comparer deux instants précis.
- Avec deux curseurs, un clic sur l'écart affiché entre eux (ou la touche **L**) le
  verrouille, ce que signale le cadenas à droite de la valeur : déplacer un curseur entraîne l'autre. Glisser l'écart déplace les deux
  curseurs ensemble.
- Un double-clic sur le temps d'un curseur, ou sur l'écart, ouvre un champ pour saisir la
  valeur en secondes ; Entrée valide, Échap annule.
- L'affichage des étiquettes de curseur peut être activé ou désactivé
  (`cursorLabelsToggle`).
- L'affichage d'une info-bulle sur les zones booléennes peut être activé ou désactivé
  (`zoneTooltipToggle`).

## Zoom

- Molette de la souris : zoom centré sur le curseur.
- Cliquer-glisser horizontal : zoom sur une plage temporelle.
- **Ctrl+Z** / **Ctrl+Y** : annuler ou rétablir un niveau de zoom, sur un historique de
  20 étapes.
- Le bouton **Réinitialiser**, à droite de la règle de temps, ramène le graphique à l'échelle complète des données
  chargées.

## Graphes X/Y

Un graphe X/Y trace un signal en fonction d'un autre (couple en fonction du régime,
accélération latérale en fonction de la longitudinale). Il vit à côté des graphes
temporels du même onglet, dans un volet à droite, et montre toujours la même fenêtre de
temps qu'eux : zoomer ou déplacer la règle de temps filtre la trajectoire.

- **Créer.** Glisser deux signaux ou plus sur « + Graphe X/Y » : le premier porte l'axe X,
  les suivants sont tracés en Y. Un clic sur cette zone crée un panneau vide.
- **Compléter.** Glisser un signal sur un panneau : le haut l'ajoute en Y, le bas en fait
  l'axe X. Le bouton d'échange inverse X et Y quand il n'y a qu'une courbe.
- **Lire.** Le survol d'un point affiche son instant et ses valeurs, et marque cet instant
  sur les graphes temporels ; le survol d'un graphe temporel marque le point sur la
  trajectoire.
- **Curseurs.** A et B apparaissent comme des pastilles sur la trajectoire, la portion
  entre les deux est mise en avant, et une table donne X et Y à chaque curseur.
  Ctrl + clic sur la trajectoire pose un curseur ; une pastille se glisse le long de la
  courbe.
- **Densité.** Le bouton en grille remplace la courbe par une carte de chaleur : plus une
  zone est claire (foncée en thème clair), plus le signal y passe de temps.
- **Zoomer.** Glisser dans le graphe pour zoomer sur une bande ou une boîte, molette pour
  zoomer autour du pointeur, glisser une gouttière pour translater un axe, double-clic pour
  recadrer. « 1:1 » donne la même échelle aux deux axes.

Les signaux booléens et les commentaires ne se tracent pas en X/Y. Deux signaux de
cadences différentes sont appariés sur les instants du signal X. Les graphes X/Y sont
enregistrés avec la disposition ; ils ne figurent pas encore dans la capture PNG.

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

La fonction `interp1d(A, [x0, x1, …], [y0, y1, …])` interpole un signal dans une table
(cartographie, courbe de calibration) ; hors de la table, la valeur du bord est tenue.
« Table d'interpolation… », sous la formule, permet de coller deux colonnes depuis un
tableur et écrit l'appel dans la formule. La table fait partie de la formule : elle est
enregistrée et exportée avec la disposition. Elle est limitée à 500 points.

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

Le panneau KDE ou FFT porte la couleur du signal. Les boutons **Tout**, **Visible** et
**Curseurs** de son en-tête choisissent la plage analysée : tout le signal, la fenêtre
affichée, ou l'intervalle entre les deux curseurs (disponible quand ils sont posés tous
les deux). L'analyse se recalcule quand la fenêtre ou les curseurs bougent.

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
