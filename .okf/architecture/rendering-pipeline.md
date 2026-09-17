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

- `axisDragPlugin` - déplacement de la fenêtre par glisser sur les gouttières
  d'axes, jamais dans la zone de tracé.
- `wheelZoomYPlugin` - dilatation de l'axe Y à la molette, uniquement au survol
  de la gouttière Y, et désactivée sur les panneaux booléens et de commentaires.
- Dans la zone de tracé, un glisser au clic gauche sélectionne une plage à zoomer, 
  il existe 3 types d'interactions suivant la directions prise pendant le maintien
  du clic : zoom x, zoom y et zoom de zone d'intérét.

Les axes sont dessinés sur le canvas : il n'existe aucun élément DOM pour les
gouttières. Toute fonctionnalité qui voudrait les désigner ou les instrumenter
doit passer par des coordonnées, pas par un sélecteur.

Les curseurs vivent dans `src/frontend/src/eda/cursors.js`. Leurs temps et le delta
prennent juste assez de décimales pour distinguer deux pixels voisins (3 au minimum, 9 au plus).
Le delta s'affiche avec un préfixe SI (`34 ms`, `18 µs`) via `formatDuration` de `time-axis.js`,
sur le plot comme dans la table de mesure ; les temps A et B restent en secondes.

## Bords de la fenêtre

Toute vue inclut l'échantillon qui précède la fenêtre et celui qui la suit : `windowBounds`
côté client, `LazyEDAManager.get_view` et `MultiSourceDataStore.get_view` côté serveur.
Le cadrage Y automatique porte sur l'enveloppe de la trace effectivement dessinée, bords
compris (`src/frontend/src/eda/trace-envelope.js`), et non sur les seuls échantillons
visibles : en escalier la valeur tenue au bord gauche, en linéaire les valeurs interpolées
aux deux bords.

## Libellés de l'axe temporel

`src/frontend/src/eda/time-axis.js` fournit `space` et `values` à `xAxisConfig`.
En mode absolu, les graduations portent exactement les décimales du pas. Au-delà de
7 chiffres significatifs, si le décalage en économise au moins 4, elles passent en
écarts relatifs à préfixe SI commun (`+500 µs`) et l'ancre absolue s'affiche une fois,
dans l'élément `.x-axis-offset` au coin bas-gauche de la zone de tracé. `space` est
partagé avec les axes masqués pour garder les grilles alignées entre panneaux.
