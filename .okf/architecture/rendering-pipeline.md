---
type: Architecture
title: Pipeline de rendu des séries temporelles
description: Pyramide min-max, niveau de détail piloté par les pixels, format binaire partagé.
tags: [uplot, lod, performance]
status: stable
---

# Pipeline de rendu

Le tracé passe par une pyramide min-max construite en idle après le full-send.
Le niveau de détail est choisi d'après la largeur réelle du graphique en pixels,
et non d'après une constante : `targetPointsForPlot` vaut `ceil(cssWidth × dpr)`,
arrondi par paliers de 64 pixels. C'est le budget de points de chaque trace.

## Sélection des points

`src/frontend/src/eda/screen-decimation.js` choisit les points à tracer une fois
la pyramide prête. Les feuilles sont les colonnes de pixels de la fenêtre, avec un
arbre binaire équilibré au-dessus. Chaque nœud s'émet en M4 (premier point,
minimum, maximum, dernier point), ce qui garde l'enveloppe exacte quelle que soit
la sélection. Un nœud est noté par son erreur en pixels : sur ses colonnes, la
différence symétrique entre les lignes couvertes par ses échantillons et celles
couvertes par sa polyligne M4. Le tas raffine d'abord la plus forte erreur par
point ajouté, et ne coupe jamais un nœud d'erreur nulle : un palier reste à deux
points quelle que soit sa durée. Les extrema par colonne sont des requêtes de
plage sur la pyramide, donc le coût suit la largeur du graphique et non le nombre
d'échantillons.

Sans pyramide (elle se construit en idle après le full-send), les extrema par
colonne viennent d'un balayage de la fenêtre, avec exactement le même résultat :
la sélection ne change pas quand la pyramide arrive. À valeurs égales, l'indice le
plus ancien gagne, quel que soit le chemin.

L'ancien sélecteur (`pyramidSelect`, buckets en index classés par erreur
structurelle, balayage M4 sans pyramide) reste disponible pour comparer en
navigateur : `setDecimationSelector('pyramid')` dans la console, `'screen'` pour
revenir.

## Même sélection côté serveur

`/view` décime avec la même méthode (`src/backend/core/screen_decimation.py`,
compilé par Numba) : le premier affichage d'un signal est déjà celui que le client
calcule ensuite sur la pleine résolution. Conditions de cette identité :

- même fenêtre (un échantillon de part et d'autre, comme `windowBounds`), mêmes
  colonnes (`max_points`) et même hauteur (paramètre `height` de `/view`) ;
- classement sur les valeurs en float32, celles que reçoit le client ;
- même arbre, même tas, mêmes opérations dans le même ordre ;
- les signaux d'un même raster reçoivent l'union de leurs sélections, comme dans
  `groupedWindowedViews` ;
- les signaux en escalier (booléens, états) sont réduits à leurs fronts des deux
  côtés (`state_change_points`, `stepFronts`), avec repli sur la sélection écran
  au-delà de `max(2 × max_points, 4000)` fronts.

Quand la vue serveur affichée a exactement les paramètres du rendu suivant, le
client ne redessine pas à l'arrivée du full-send (`serverViewIsExact` dans
`render.js`) : le chargement ne produit plus aucun changement visible. Au drop,
la hauteur du futur graphique est estimée ; si elle tombe à côté, le full-send
redessine à la vraie hauteur. Toute modification de la méthode doit être faite
des deux côtés : `tests/fixtures/screen_decimation_parity.json` est vérifié par
vitest et par pytest.

Mesuré sur trois fichiers réels (114 scènes de 12 traces, budget inchangé) :
erreur de rasterisation médiane de 11,3 % à 2,0 %, aucune trace dégradée, même
nombre de points émis. Coût médian 4,9 ms par scène de 12 traces contre 0,4 ms,
28 ms au pire (12 traces de 8,6 millions d'échantillons, fenêtre entière).
Détail dans [la feuille de route](/roadmap/budget-constrained-decimation.md).

La charge utile est binaire : en-tête, métadonnées JSON, horodatages en float64,
valeurs en float32. nginx la sert en gzip sur HTTP/2. Un signal dont les
horodatages sont identiques à ceux d'un signal précédent de la même réponse porte
`ts_ref` et n'envoie que ses valeurs ; sur `/raw`, `have_ts` déclare les bases de
temps que le client détient déjà, et un signal qui en partage une porte
`timestamps_from`. Le client réutilise alors la même instance de `Float64Array`.

## Discipline réseau

Mesurée avec le harnais de latence (profil 4G : 10 Mbit/s, 100 ms d'aller-retour) :

- une seule requête de vue par panneau : la même vue n'est pas redemandée, une
  nouvelle annule la précédente, et une réponse arrivée après un changement de
  vue n'est jamais dessinée ;
- seuls les signaux non complets sont demandés, par lots de 50 au plus (plafond
  serveur) ;
- le full-send passe par une file unique, un signal à la fois, et cède la liaison
  à toute vue (`fetchViewData` abandonne le transfert en cours, repris au calme).

Groupe de 12 signaux en 4G : première image 700 → 353 ms, image finale après
cinq actions rapprochées 1,9 s → 0,25 s, pleine résolution 57 → 22 Mo. Limite
connue : un transfert abandonné repart de zéro, ce qui retarde la pleine
résolution des premiers panneaux quand les dépôts s'enchaînent.

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
