---
type: Architecture
title: Pipeline de rendu des séries temporelles
description: Pyramide min-max, niveau de détail piloté par les pixels, format binaire partagé.
tags: [uplot, lod, performance]
status: stable
---

# Pipeline de rendu

Le tracé passe par une pyramide min-max à erreur structurelle cumulée. Le niveau
de détail est choisi d'après la largeur réelle du graphique en pixels, et non
d'après une constante : `targetPointsForPlot` vaut `ceil(cssWidth × dpr)`,
arrondi par paliers de 64 pixels.

La charge utile est binaire : en-tête, métadonnées JSON, horodatages en float64,
valeurs en float32. nginx la sert en gzip sur HTTP/2.

## Interactions du graphique

Les gestes sont implémentés en greffons uPlot dans `src/frontend/src/eda/plot-ui.js` :

- `axisDragPlugin` - translation de l'axe Y par glisser sur sa gouttière, jamais
  dans la zone de tracé. La fenêtre temporelle se déplace par glisser sur la règle
  de temps (voir plus bas).
- `wheelZoomYPlugin` - dilatation de l'axe Y à la molette, uniquement au survol
  de la gouttière Y, et désactivée sur les panneaux booléens et de commentaires.
- Dans la zone de tracé, un glisser au clic gauche sélectionne une plage à zoomer, 
  il existe 3 types d'interactions suivant la directions prise pendant le maintien
  du clic : zoom x, zoom y et zoom de zone d'intérét.

Les axes sont dessinés sur le canvas : il n'existe aucun élément DOM pour les
gouttières. Toute fonctionnalité qui voudrait les désigner ou les instrumenter
doit passer par des coordonnées, pas par un sélecteur.

## Règle de temps

Chaque onglet de layout porte une règle de temps unique, collée en haut de la zone
des graphes (`src/frontend/src/eda/time-ruler.js`). Les graphes n'affichent que leur
grille verticale : la graduation, le temps des curseurs et le delta sont portés une
seule fois par la règle, qui reste visible quand les graphes défilent.

La règle est une instance uPlot sans série. `rulerSyncPlugin`, greffé sur chaque
graphe, lui transmet à chaque dessin (hook `draw`) l'échelle X réelle du graphe et la
réaligne si sa zone de tracé a changé, plutôt que de suivre les écritures de
`globalView` ou de dépendre des seuls chemins qui déclenchent `setScale`/`setSize`. Même
largeur, même échelle et même `space` donnent les mêmes graduations : elles tombent
sur les lignes de grille. On s'y déplace par glisser ; Ctrl+clic pose un curseur.
L'export PNG la dessine en tête de l'image.

Les curseurs vivent dans `src/frontend/src/eda/cursors.js` : traits et valeurs dans
chaque graphe, temps et delta sur une même ligne de la règle, sous la graduation ; les
traits des curseurs remontent jusqu'aux ticks. Les temps A et B sont des pastilles qui
servent aussi de poignée, le delta est entre les deux, relié aux traits par un filet.
Les trois sont toujours affichés : `layoutRow` les garde dans l'ordre, au plus près de
leur position et sans chevauchement (les étiquettes qui se touchent forment un bloc
centré sur leurs positions), sans sortir de la règle ni passer sous ses boutons. La
règle a toujours ses deux lignes : poser un curseur ne redimensionne aucun graphe, et la
ligne vide rappelle le geste (Ctrl + clic).
Leurs temps et le delta prennent juste assez de décimales pour distinguer deux pixels
voisins (3 au minimum, 9 au plus). Le delta s'affiche avec un préfixe SI (`34 ms`, `18 µs`)
via `formatDuration` de `time-axis.js`, sur la règle comme dans la table de mesure ; les
temps A et B restent en secondes.

La pastille de delta est un bouton. Un clic (ou la touche L) verrouille l'écart : tout
déplacement d'un curseur passe par `moveCursorTo` dans `cursors.js`, qui entraîne alors
l'autre. C'est le seul point de passage des déplacements (trait, pastille, flèches) ; un
nouveau geste qui écrirait `S.cursor1` directement contournerait le verrou. Glisser la
pastille translate les deux curseurs. Le verrou (`S.cursorLock`) tombe dès qu'il manque
un curseur. Un curseur hors de la fenêtre garde sa pastille, calée contre le bord de la
piste du côté où il est sorti, en contour et sans trait : c'est sa position ramenée dans
la piste, et non sa position réelle, qui sert au placement de la pastille.

Pendant un glissement de curseur, la règle ne lit rien dans le layout et n'écrit que des
transformations : la plage et le filet ont la largeur de la piste et sont réduits par
`scaleX` à la fraction couverte, la largeur des pastilles est mesurée une fois par gabarit
de texte puis relue en cache. Écrire une largeur ou lire `offsetWidth` dans ce chemin
réintroduit un layout synchrone par frame.

Ne pas étirer un élément de 1px à la place : sa largeur est calée sur les pixels
physiques avant l'étirement (1 pixel à 125 %, 2 à 150 %), et la plage ne tombe plus sur
les curseurs dès que l'affichage Windows n'est pas à 100 %. Toute modification de ce
rendu se vérifie par capture à 100 %, 125 % et 150 %
(`chrome --headless --force-device-scale-factor=1.25 --screenshot`), jsdom ne voyant
aucune géométrie.

Les actions qui portent sur l'axe du temps (ajouter un curseur, réinitialiser le zoom)
sont des boutons de la règle, à droite de la graduation, sur ses deux lignes. Il y en a
un jeu par onglet, donc pas d'`id` : on les désigne par `.ruler-tool[data-action]`.
Ils réutilisent le composant `.toolbar-btn` (losange) de la barre d'outils, comme les
actions de la rangée des onglets (`.toolbar-btn--inline`) : un bouton d'action de l'EDA
ne redéfinit pas son propre style.

La table de mesure A / B / Δ des légendes (`updateCursorReadout`) résout ses cellules
une fois par table (`readoutCellsOf`, un `WeakMap` indexé par l'élément table) et
tient à jour la longueur du plus long texte de chaque colonne à l'écriture. Ni la mise
à jour ni la synchronisation des colonnes ne relisent le DOM pendant un glissement. Cela
repose sur le fait que `plot-legend.js` reconstruit la table entière à chaque rendu ; un
changement du nombre de lignes en place invalide l'entrée.

## Hauteur des panneaux

Le splitter entre deux panneaux écrit des poids flex (`flexWeight` dans `plots.js`,
`1.47 1 0px`), jamais une hauteur en pixels, et convertit au début du glissement tous les
panneaux à hauteur libre de l'onglet. Une hauteur figée (`0 0 Npx`) ne suit plus la zone
des graphes : dès que celle-ci perd de la hauteur (barre d'outils dépliée, fenêtre
réduite, arrondi d'`offsetHeight` à 125 %), elle déborde et un ascenseur apparaît. Seuls
les strips booléen et commentaires gardent une hauteur fixe. Un poids de 1 vaut la hauteur
moyenne, ce qui en fait le ratio enregistré tel quel dans un layout.

## Bords de la fenêtre

Toute vue inclut l'échantillon qui précède la fenêtre et celui qui la suit : `windowBounds`
côté client, `LazyEDAManager.get_view` et `MultiSourceDataStore.get_view` côté serveur.
Le cadrage Y automatique porte sur l'enveloppe de la trace effectivement dessinée, bords
compris (`src/frontend/src/eda/trace-envelope.js`), et non sur les seuls échantillons
visibles : en escalier la valeur tenue au bord gauche, en linéaire les valeurs interpolées
aux deux bords.

## Libellés de l'axe temporel

`src/frontend/src/eda/time-axis.js` fournit `space` et `values` à l'axe de la règle
de temps. En mode absolu, les graduations portent exactement les décimales du pas.
Au-delà de 7 chiffres significatifs, si le décalage en économise au moins 4, elles
passent en écarts relatifs à préfixe SI commun (`+500 µs`) et l'ancre absolue s'affiche
une fois, dans l'élément `.x-axis-offset` à gauche de la règle. `space` est partagé avec
les axes masqués des graphes (`xAxisConfig`) pour garder les grilles alignées sur la
règle et entre panneaux.
