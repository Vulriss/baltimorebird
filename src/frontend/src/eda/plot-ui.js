// Baltimore Bird - Fabrique d'options uPlot: series, axes, bandes, solo/lock/auto-Y
// Module extrait de app.js (refactoring): voir src/eda/ARCHITECTURE.md

import { S } from '../core/state.js';
import { boolZonesPlugin } from './bool-zones.js';
import { resizePlotCharts } from './bootstrap.js';
import { ectx } from './context.js';
import { cursorPlugin, isLegendSignalSelected } from './cursors.js';
import { targetPointsForPlot } from './data-views.js';
import { renderCommentPlot } from './events-strip.js';
import { plotHasSynth, renderOverlayFromCache } from './overlay.js';
import { autoEnableExtendedZones, updatePlotHeader } from './plot-legend.js';
import { colorWithOpacity } from './plots.js';
import { assembleAlignedData, renderBoolPlot } from './render.js';
import { effectiveCache, groupedWindowedViews, renderPlotFromCacheFiltered } from './transforms.js';
import { applyGlobalViewLocal, panPlotsScaleOnly, recordViewChange, refreshAllPlots } from './view-nav.js';

// =========================================================================
// uPlot Options Factory
// Source unique des options partagees par les trois chemins de rendu
// (cache complet, cache filtre, reponse serveur). Seules series/width/height
// et la borne Y varient d'un appel a l'autre.
// =========================================================================

// Zoom par selection: X ou Y adaptatif, bascule en boite 2D au-dela de 50 px
// sur l'axe secondaire, drag minimal de 8 px pour distinguer le clic de pose
// de curseur du zoom. setScale: false delegue entierement le zoom au hook
// setSelect (pas de double application par uPlot).
const PLOT_CURSOR_DRAG = { x: true, y: true, uni: 50, dist: 8, setScale: false };

// Adapte une couleur par defaut au theme courant. La teinte attribuee par le serveur
// (hsl(H, 70%, 55%)) reste l'identite du signal; saturation et luminosite sont une
// decision d'affichage: eclairci sur fond sombre, assombri sur fond clair pour le
// contraste. Les couleurs choisies par l'utilisateur (hex des overrides) passent
// inchangees - un choix explicite n'est jamais corrige.
export function themedSignalColor(color) {
    if (typeof color !== 'string') return color;
    const match = color.match(/^hsl\(\s*([\d.]+)\s*,/);
    if (!match) return color;
    const hue = match[1];
    const light = document.documentElement.getAttribute('data-theme') === 'light';
    return light ? `hsl(${hue}, 65%, 38%)` : `hsl(${hue}, 70%, 60%)`;
}

export function resolveSignalStyle(plot, sigIdx, fallbackColor) {
    return plot.signalStyles?.[sigIdx]
        || { color: themedSignalColor(fallbackColor), width: 1.5, dash: '' };
}

// Constructeurs de chemins uPlot, instancies a la demande puis memorises
// (uPlot est garanti charge a l'appel, pas forcement a l'evaluation du module).
// 'none' renvoie un constructeur nul (aucune ligne, points seuls).
export const PATH_MODES = ['none', 'linear', 'spline', 'stepped'];

const _pathBuilders = {};

export function pathRenderer(mode) {
    if (mode === 'none') return () => null;
    if (!_pathBuilders[mode]) {
        _pathBuilders[mode] =
            mode === 'spline' ? uPlot.paths.spline() :
            mode === 'stepped' ? uPlot.paths.stepped({ align: 1 }) :
            uPlot.paths.linear();
    }
    return _pathBuilders[mode];
}

// Mode de trace effectif: la valeur explicite du signal sinon le defaut lie au
// type (escalier par defaut).
export function effectivePathMode(style, unit) {
    return style.path || 'stepped';
}

// Modes de remplissage par bande, jusqu'a la courbe voisine du panneau:
// 'above' remplit vers la courbe precedente (au-dessus dans la legende),
// 'below' vers la suivante. Materialise par l'option top-level bands.
export const FILL_MODES = ['none', 'above', 'below'];

export function effectiveFillMode(style) {
    return style.fill || 'none';
}

// Entree de serie uPlot pour un signal. selected epaissit le trait pour la mise
// en exergue. Les booleens conservent leur aire remplie (zones). _fillMode est
// lu par buildPlotOptions pour construire les bandes inter-courbes.
export function buildSeriesConfig(name, unit, style, selected = false) {
    const isBool = unit === 'bool';
    const mode = effectivePathMode(style, unit);
    return {
        label: name,
        stroke: style.color,
        width: selected ? style.width * 2 + 0.5 : style.width,
        dash: style.dash ? style.dash.split(',').map(Number) : undefined,
        fill: isBool ? colorWithOpacity(style.color, 0.4) : undefined,
        paths: pathRenderer(mode),
        // Sans ligne, on montre les points pour que le signal reste visible.
        points: mode === 'none' ? { show: true } : undefined,
        _fillMode: effectiveFillMode(style),
        _mode: mode,
    };
}

// En mode adaptatif, l'axe non reduit occupe toute la dimension du plot: on en
// deduit quels axes ont reellement ete bornes par la selection.
function selectionAxes(u) {
    const sel = u.select;
    return {
        x: sel.width > 1 && sel.width < u.over.offsetWidth - 2,
        y: sel.height > 1 && sel.height < u.over.offsetHeight - 2,
    };
}

// Applique le zoom de la selection.
// - X seul: nouvelle fenetre temporelle globale (rechargement), Y re-auto-cadre
//   sur tous les panneaux concernes.
// - Y seul: borne Y locale au panneau, application immediate sans serveur.
// - Boite (X+Y): X recharge et Y prend les bornes tirees pour ce panneau.
export function zoomToSelection(u) {
    const { x: zoomX, y: zoomY } = selectionAxes(u);
    const sel = u.select;
    const plot = S.plots.find(p => p.chart === u);
    const clearSelect = () => u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);

    if (!zoomX && !zoomY) {
        clearSelect();
        return;
    }

    if (zoomY && plot) {
        const yA = u.posToVal(sel.top, 'y');
        const yB = u.posToVal(sel.top + sel.height, 'y');
        plot.yRange = { min: Math.min(yA, yB), max: Math.max(yA, yB) };
    }

    if (zoomX) {
        const xA = u.posToVal(sel.left, 'x');
        const xB = u.posToVal(sel.left + sel.width, 'x');
        const min = Math.min(xA, xB);
        const max = Math.max(xA, xB);
        if (max - min <= 0.01) {
            clearSelect();
            return;
        }
        // Auto-cadrage Y a la nouvelle fenetre pour tous les panneaux, sauf
        // celui dont Y vient d'etre borne explicitement par un drag en boite,
        // et ceux dont l'echelle Y est verrouillee.
        S.plots.forEach(p => {
            if (zoomY && p === plot) return;
            if (p.yLocked) return;
            p.yRange = null;
        });
        recordViewChange();
        ectx.globalView = { min, max };
        clearSelect();
        refreshAllPlots();
        return;
    }

    // Zoom Y seul: application immediate sur l'echelle, sans rebuild ni serveur.
    clearSelect();
    if (plot) u.setScale('y', { min: plot.yRange.min, max: plot.yRange.max });
}

// Moyenne d'une serie (valeurs non nulles), pour ordonner les courbes.
function seriesMean(values) {
    let sum = 0;
    let count = 0;
    for (const v of values) {
        if (v != null && Number.isFinite(v)) {
            sum += v;
            count++;
        }
    }
    return count ? sum / count : 0;
}

const FILL_OPACITY = 0.2;

const fillToScaleMin = (u) => u.scales.y.min;

const fillToScaleMax = (u) => u.scales.y.max;

// Construit les remplissages facon "bandes de temperature": chaque courbe en
// mode 'below' se remplit vers le bas jusqu'a la courbe la plus proche situee
// en dessous (par valeur), 'above' vers le haut jusqu'a la plus proche au-dessus.
// La voisine est choisie par valeur moyenne (pas par ordre de liste), comme dans
// l'exemple High/Low. Sans voisine dans la direction, on remplit jusqu'au bord
// du graphe (bas ou haut). La couleur reprend celle de la courbe. Effet de bord
// assume: le remplissage "jusqu'au bord" est pose directement sur la serie.
export function buildBands(series, data) {
    const means = series.map((s, i) => (i === 0 ? null : seriesMean(data[i])));
    const bands = [];

    for (let i = 1; i < series.length; i++) {
        const mode = series[i]._fillMode;
        if (mode !== 'above' && mode !== 'below') continue;

        const down = mode === 'below';

        // Courbe voisine la plus proche dans la direction du remplissage.
        let neighbor = null;
        let bestMean = null;
        for (let j = 1; j < series.length; j++) {
            if (j === i) continue;
            const mj = means[j];
            const inDir = down ? mj < means[i] : mj > means[i];
            if (inDir && (bestMean === null || (down ? mj > bestMean : mj < bestMean))) {
                bestMean = mj;
                neighbor = j;
            }
        }

        const fill = colorWithOpacity(series[i].stroke, FILL_OPACITY);

        if (neighbor !== null) {
            // uPlot exige series[0] = bord superieur.
            const upper = down ? i : neighbor;
            const lower = down ? neighbor : i;
            bands.push({ series: [upper, lower], fill });
        } else {
            // Pas de voisine dans cette direction: remplissage jusqu'au bord.
            series[i].fill = fill;
            series[i].fillTo = down ? fillToScaleMin : fillToScaleMax;
        }
    }

    return bands;
}

// Largeur commune de la gouttiere de l'axe Y a TOUS les panneaux (normaux et
// booleen). Indispensable pour que les zones de trace demarrent au meme pixel
// et donc que les axes X restent alignes verticalement entre panneaux.
export const Y_AXIS_SIZE = 50;

// Padding droit fixe et identique sur TOUS les panneaux. Sans cela, le panneau
// du bas (axe temporel visible) reserve a droite la place de la derniere
// etiquette, tandis que ceux du haut (axe X masque) n'en reservent pas: leurs
// zones de trace n'auraient pas la meme longueur.
// Padding interne uPlot [haut, droite, bas, gauche]. Valeurs serrees pour maximiser la
// zone de trace (u-under): haut, droite et bas reduits a 4px (le bas garde l'auto sur le
// dernier panneau, qui porte l'axe temps). Gauche laisse en auto (gouttiere Y_AXIS_SIZE).
export const PLOT_PAD_TOP = 4;

export const PLOT_PAD_RIGHT = 4;

export const PLOT_PAD_BOTTOM = 4;

// Vrai si le panneau est le dernier (le plus bas) de l'onglet courant.
// Axe temporel et bandeau de legende sont portes par le dernier / le premier
// panneau. En mode solo, un seul panneau est visible: c'est lui qui doit porter
// les deux, sinon un panneau du milieu se retrouverait sans axe des temps.
export function isLastPlot(plot) {
    const solo = soloPlot();
    if (solo) return solo.id === plot.id;
    return S.plots.length > 0 && S.plots[S.plots.length - 1].id === plot.id;
}

export function isFirstPlot(plot) {
    const solo = soloPlot();
    if (solo) return solo.id === plot.id;
    return S.plots.length > 0 && S.plots[0].id === plot.id;
}

// Re-rendu d'un panneau depuis le cache courant (sans appel serveur) pour
// reappliquer la visibilite de l'axe temporel quand il devient (ou cesse d'etre)
// le dernier. La vue ne change pas, donc le cache courant suffit, meme si les
// signaux sont incomplets (on ne passe pas par canRenderFromCache).
export function rerenderPlotFromCache(plot) {
    if (!plot || plot.signals.length === 0) return;
    if (plot.isCommentPlot) { renderCommentPlot(plot); return; }
    if (!plot.cachedData[plot.signals[0]]) return;
    if (plot.isBoolPlot) renderBoolPlot(plot);
    else renderPlotFromCacheFiltered(plot);
}

// Couleurs des graphes lues depuis les tokens CSS du theme courant. Passees en
// fonctions a uPlot (reevaluees au redraw) pour suivre la bascule clair/sombre.
export function themeChartColors() {
    const cs = getComputedStyle(document.documentElement);
    return {
        axis: (cs.getPropertyValue('--chart-axis') || '#b6b6b6').trim(),
        grid: (cs.getPropertyValue('--chart-grid') || '#2d2d5a').trim(),
    };
}

// Configuration de l'axe X. L'axe temporel n'est affiche que sur le panneau du
// bas: les autres ne gardent que la grille verticale (sans graduations ni
// gouttiere) pour ne pas dupliquer les etiquettes et gagner de la hauteur.
export function xAxisConfig(showTimeAxis) {
    if (showTimeAxis) {
        return { stroke: () => themeChartColors().axis, grid: { stroke: () => themeChartColors().grid, width: 1 }, size: 40 };
    }
    return {
        grid: { stroke: () => themeChartColors().grid, width: 1 },
        ticks: { show: false },
        gap: 0,
        size: 0,
        values: (u, splits) => splits.map(() => ''),
    };
}

// Options uPlot communes a tous les panneaux. axes et drag sont recrees a
// chaque appel: uPlot ecrit des proprietes calculees dessus, les partager
// entre instances creerait des effets de bord. yRange null => Y auto-cadre.
// bands est calcule par buildBands (a besoin des donnees pour ordonner).
// Signature visuelle d'un rendu: si elle est inchangee entre deux rendus du meme
// plot, l'instance uPlot peut etre reutilisee (setData) au lieu d'etre recreee.
function renderSignature(plot, series) {
    const cols = series.slice(1).map(s =>
        [s.label, s.stroke, s.width, s.dash ? s.dash.join('.') : '',
         s.fill || '', s._fillMode || '', s._mode || '', s.points ? 'p' : '',
         s.spanGaps ? 'g' : ''].join('~')
    );
    // X et Y suivent tous deux une fonction range (globalView / plot.yRange), donc
    // absents de la signature: un changement de fenetre ou de borne Y se traduit par
    // un simple setData, pas une reconstruction. Seule la structure visuelle compte.
    // spanGaps fait partie de la structure: une serie alignee par union-X (trous null a
    // combler) ne peut pas etre rejouee via setData sur un chart construit sans spanGaps.
    return `${isLastPlot(plot)}#${plot.signals.join(',')}#${cols.join('|')}`;
}

// Applique series/donnees au graphe. Tant que la structure visuelle est inchangee
// (zoom/pan X, grossier->fin), on REUTILISE l'instance uPlot via setData: le DOM,
// l'overlay des curseurs et les handlers persistent -> transition sans accroc.
// X suit globalView (fonction range); un changement de signaux/style/borne-Y change
// la signature et declenche une reconstruction.
export function commitPlotRender(plot, series, uplotData, bands) {
    const sig = renderSignature(plot, series);

    if (plot.chart && plot._renderSig === sig) {
        // Reutilisation: setData declenche un redraw qui re-evalue les fonctions range
        // X (globalView) et Y (plot.yRange) -> fenetre et cadrage Y suivis sans rebuild.
        plot.chart.setData(uplotData);
        return;
    }

    if (plot.chart) plot.chart.destroy();
    const bodyDiv = plot.element.querySelector('.plot-body');
    const chartDiv = plot.element.querySelector('.chart');
    const width = bodyDiv.clientWidth || 800;
    const height = bodyDiv.clientHeight || 180;
    plot.chart = new uPlot(
        buildPlotOptions(series, width, height, plot, bands && bands.length ? bands : null, isLastPlot(plot)),
        uplotData, chartDiv
    );
    plot._renderSig = sig;
}

// Boutons icone de la barre overlay. SVG inline plutot qu'emoji: les emoji sont
// rendus en couleur et differemment selon l'OS/la police, ce qui jurerait avec les
// glyphes monochromes voisins. `currentColor` fait suivre au trace la couleur du
// bouton, donc le theme clair/sombre et les etats survol/actif, gratuitement.
// Traces issus du jeu Feather (MIT), viewBox 24 pour un trace net a 11px.
const PLOT_ICONS = {
    lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    unlock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>',
    maximize: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
    minimize: '<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>',
};

export function plotIconSvg(name) {
    return '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor"'
        + ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
        + PLOT_ICONS[name] + '</svg>';
}

// Id du panneau actuellement survole, cible du raccourci Shift+Y.


// Rafraichit l'icone/le titre du bouton verrou d'un panneau.
function updateYLockButton(plot) {
    const btn = plot?.element?.querySelector('.plot-lock');
    if (!btn) return;
    const locked = !!plot.yLocked;
    btn.innerHTML = plotIconSvg(locked ? 'lock' : 'unlock');
    btn.classList.toggle('is-on', locked);
    btn.title = locked
        ? 'Echelle Y verrouillee — cliquer pour liberer'
        : 'Verrouiller l\'echelle Y (elle ne se recadrera plus au zoom/pan)';
}

// Verrou de l'echelle Y. Sans lui, tout zoom X relache les bornes Y de tous les
// panneaux (cf. zoomX) et l'echelle se recadre: impossible de comparer une
// amplitude d'un bout a l'autre de l'acquisition. Verrouiller = figer la plage Y
// courante; les points de relachement automatique la respectent ensuite.
export function toggleYLock(plot) {
    if (!plot || plot.isBoolPlot || plot.isCommentPlot) return false;
    if (plot.yLocked) {
        plot.yLocked = false;
        plot.yRange = null; // retour au cadrage auto
        if (plot.chart && plot.chart.data) plot.chart.setData(plot.chart.data);
    } else {
        const sc = plot.chart?.scales?.y;
        if (!sc || !Number.isFinite(sc.min) || !Number.isFinite(sc.max)) return false;
        plot.yRange = { min: sc.min, max: sc.max };
        plot.yLocked = true;
    }
    updateYLockButton(plot);
    return true;
}

// Rafraichit l'icone/le titre du bouton solo d'un panneau.
function updateSoloButton(plot) {
    const btn = plot?.element?.querySelector('.plot-solo-btn');
    if (!btn) return;
    const solo = !!plot._solo;
    btn.innerHTML = plotIconSvg(solo ? 'minimize' : 'maximize');
    btn.classList.toggle('is-on', solo);
    btn.title = solo ? 'Revenir a tous les panneaux' : 'Agrandir ce panneau seul';
}

// Le panneau seul affiche, s'il y en a un.
export function soloPlot() {
    return S.plots.find(p => p._solo) || null;
}

// Sortie du mode solo (etat + classes), sans re-rendu: les appelants decident
// des panneaux a reconstruire.
export function exitSolo(tabId) {
    const wrapper = document.getElementById(`plotsWrapper-${tabId}`);
    if (wrapper) wrapper.classList.remove('has-solo');
    S.plots.forEach(p => {
        p._solo = false;
        p.element.classList.remove('plot-solo', 'plot-hidden-by-solo');
        updateSoloButton(p);
    });
}

// Affiche un seul panneau sur toute la hauteur (re-clic = retour). Les autres sont
// masques en CSS: S.plots n'est pas touche, donc l'ordre, les hauteurs reglees au
// splitter et les caches sont intacts au retour.
export function toggleSoloPlot(plot) {
    if (!plot) return false;
    const wrapper = document.getElementById(`plotsWrapper-${plot.tabId}`);
    const entering = !plot._solo;
    const prevFirst = S.plots[0];
    const prevLast = S.plots[S.plots.length - 1];

    S.plots.forEach(p => {
        p._solo = false;
        p.element.classList.remove('plot-solo', 'plot-hidden-by-solo');
    });
    if (entering) {
        plot._solo = true;
        S.plots.forEach(p => {
            p.element.classList.add(p === plot ? 'plot-solo' : 'plot-hidden-by-solo');
        });
    }
    if (wrapper) wrapper.classList.toggle('has-solo', entering);

    // Le bandeau de legende (premier panneau) et l'axe temporel (dernier) suivent
    // le panneau seul affiche: isFirstPlot/isLastPlot tiennent compte du solo, il
    // suffit de reconstruire les panneaux dont le statut a pu changer.
    S.plots.forEach(p => updateSoloButton(p));
    const touched = new Set([plot, prevFirst, prevLast].filter(Boolean));
    touched.forEach(p => updatePlotHeader(p));
    touched.forEach(p => { if (!p.element.classList.contains('plot-hidden-by-solo')) rerenderPlotFromCache(p); });

    setTimeout(resizePlotCharts, 60);
    return true;
}

// Recadre Y sur les donnees visibles: on relache la borne Y explicite (yRange
// null => la fonction de range du chart retombe sur autoYRange) puis on force
// uPlot a reevaluer ses echelles. setData(data) reinitialise les scales par
// defaut en 1.6.x: X est reevalue via sa propre fonction de range (globalView),
// donc la fenetre temporelle est preservee.
export function autoScaleY(plot) {
    if (!plot || plot.isBoolPlot || plot.isCommentPlot) return false;
    // Auto-Y et verrou sont deux actions opposees: cadrer automatiquement libere
    // le verrou, sinon on garderait un bouton "verrouille" sur une echelle qui
    // se recadre a chaque zoom.
    if (plot.yLocked) {
        plot.yLocked = false;
        updateYLockButton(plot);
    }
    plot.yRange = null;
    const u = plot.chart;
    if (!u || !u.data) return false;
    u.setData(u.data);
    return true;
}

// Cadrage Y automatique (yRange null) reproduisant un padding de 10%, robuste aux
// cas degeneres (donnees vides, min==max).
function autoYRange(dataMin, dataMax) {
    if (dataMin == null || dataMax == null || !isFinite(dataMin) || !isFinite(dataMax)) {
        return [0, 1];
    }
    if (dataMin === dataMax) {
        const p = Math.abs(dataMin) * 0.1 || 1;
        return [dataMin - p, dataMax + p];
    }
    const pad = (dataMax - dataMin) * 0.1;
    return [dataMin - pad, dataMax + pad];
}

// Pan des axes facon demo uPlot "Draggable y scales": glisser sur la gouttiere de
// l'axe X (sous la zone de trace) translate la fenetre temporelle globale (partagee
// par tous les panneaux); glisser sur la gouttiere de l'axe Y (a gauche) translate
// l'echelle Y du panneau. La zone de trace conserve le zoom par selection.
export function axisDragPlugin() {
    return {
        hooks: {
            ready: u => {
                const plot = S.plots.find(p => p.chart === u);
                if (!plot) return;
                let drag = null;
                let rafPending = false;

                const onMove = e => {
                    if (!drag) return;
                    if (drag.axis === 'x') {
                        const shift = -(e.clientX - drag.startX) * drag.uppX;
                        if (!drag.moved && shift !== 0) {
                            recordViewChange();
                            drag.moved = true;
                        }
                        ectx.globalView = { min: drag.xMin + shift, max: drag.xMax + shift };
                        if (!rafPending) {
                            rafPending = true;
                            requestAnimationFrame(() => { rafPending = false; panPlotsScaleOnly(); });
                        }
                    } else {
                        const shift = (e.clientY - drag.startY) * drag.uppY;
                        plot.yRange = { min: drag.yMin + shift, max: drag.yMax + shift };
                        u.setScale('y', { min: plot.yRange.min, max: plot.yRange.max });
                    }
                };

                const onUp = () => {
                    const needsResolve = !!(drag && drag.axis === 'x' && drag.moved);
                    drag = null;
                    document.body.style.cursor = '';
                    window.removeEventListener('mousemove', onMove);
                    window.removeEventListener('mouseup', onUp);
                    // Fin du pan X: rendu propre (re-decimation pleine qualite, cadrage Y,
                    // strips) a la vue finale, apres les setScale legers du glissement.
                    if (needsResolve) applyGlobalViewLocal();
                };

                u.root.addEventListener('mousedown', e => {
                    if (e.button !== 0) return;
                    const r = u.over.getBoundingClientRect();
                    const onX = e.clientY > r.bottom && e.clientX >= r.left && e.clientX <= r.right;
                    const onY = e.clientX < r.left && e.clientY >= r.top && e.clientY <= r.bottom;
                    if (!onX && !onY) return;            // zone de trace: zoom-selection inchange
                    if (onY && plot.isBoolPlot) return;  // Y fixe (lanes) sur les panneaux booleens

                    e.preventDefault();
                    drag = {
                        axis: onX ? 'x' : 'y', moved: false,
                        startX: e.clientX, startY: e.clientY,
                        xMin: ectx.globalView.min, xMax: ectx.globalView.max,
                        yMin: u.scales.y.min, yMax: u.scales.y.max,
                        uppX: (ectx.globalView.max - ectx.globalView.min) / r.width,
                        uppY: (u.scales.y.max - u.scales.y.min) / r.height,
                    };
                    document.body.style.cursor = 'grabbing';
                    window.addEventListener('mousemove', onMove);
                    window.addEventListener('mouseup', onUp);
                });
            },
        },
    };
}


// Zoom Y a la molette / pincement trackpad, uniquement au survol de la gouttiere de l'axe Y (a gauche de la zone de trace) 
export function wheelZoomYPlugin() {
    return {
        hooks: {
            ready: u => {
                const plot = S.plots.find(p => p.chart === u);
                if (!plot) return;
                if (plot.isBoolPlot || plot.isCommentPlot) return;

                u.root.addEventListener('wheel', e => {
                    const r = u.over.getBoundingClientRect();
                    const onY = e.clientX < r.left && e.clientY >= r.top && e.clientY <= r.bottom;
                    if (!onY) return;

                    e.preventDefault();

                    const scale = u.scales.y;
                    if (!Number.isFinite(scale.min) || !Number.isFinite(scale.max)) return;

                    const cursorY = e.clientY - r.top;
                    const pivot = u.posToVal(cursorY, 'y');

                    const factor = Math.exp(e.deltaY * 0.001);
                    const newMin = pivot - (pivot - scale.min) * factor;
                    const newMax = pivot + (scale.max - pivot) * factor;

                    plot.yRange = { min: newMin, max: newMax };
                    u.setScale('y', { min: newMin, max: newMax });
                }, { passive: false });
            },
        },
    };
}

function buildPlotOptions(series, width, height, plot, bands = null, showTimeAxis = true) {
    return {
        width,
        height,
        legend: { show: false },
        series,
        bands: bands && bands.length ? bands : undefined,
        padding: [PLOT_PAD_TOP, PLOT_PAD_RIGHT, showTimeAxis ? null : PLOT_PAD_BOTTOM, null],
        scales: {
            x: { time: false, range: () => [ectx.globalView.min, ectx.globalView.max] },
            // Borne Y lue en direct sur plot.yRange: bornee si zoom Y, auto sinon.
            y: { range: (u, dataMin, dataMax) => plot.yRange
                ? [plot.yRange.min, plot.yRange.max]
                : autoYRange(dataMin, dataMax) },
        },
        axes: [
            xAxisConfig(showTimeAxis),
            { stroke: () => themeChartColors().axis, grid: { stroke: () => themeChartColors().grid, width: 1 }, size: Y_AXIS_SIZE },
        ],
        cursor: { drag: { ...PLOT_CURSOR_DRAG }, points: { show: false } },
        hooks: { setSelect: [zoomToSelection] },
        plugins: [boolZonesPlugin(), cursorPlugin(), axisDragPlugin(), wheelZoomYPlugin()],
    };
}

export function renderPlotFromCache(plot) {
    if (plot.signals.length === 0) return;
    // Un panneau booleen a son propre rendu en lanes empilees (renderBoolPlot). Sans
    // ce garde-fou, un re-rendu declenche par la selection en legende ou un changement
    // de style repasse par le chemin lineaire generique et applatit les lanes: tous les
    // booleens retombent sur la meme base. Aligne sur rerenderPlotFromCache.
    if (plot.isBoolPlot) { renderBoolPlot(plot); return; }
    if (plot.isCommentPlot) { renderCommentPlot(plot); return; }
    if (plotHasSynth(plot)) { renderOverlayFromCache(plot); return; }

    const sigList = [];
    const views = groupedWindowedViews(plot, ectx.globalView.min, ectx.globalView.max, targetPointsForPlot(plot));
    plot.signals.forEach(sigIdx => {
        const sigData = effectiveCache(plot, sigIdx);
        if (!sigData || !sigData.timestamps) return;
        const view = views.get(sigIdx);
        if (!view || !view.timestamps.length) return;
        sigList.push({
            name: sigData.name,
            unit: sigData.unit,
            style: resolveSignalStyle(plot, sigIdx, sigData.color),
            timestamps: view.timestamps,
            values: view.values,
            selected: isLegendSignalSelected(plot.id, sigIdx),
        });
    });
    if (sigList.length === 0) return;

    const { uplotData, series } = assembleAlignedData(sigList);

    const bands = buildBands(series, uplotData);
    commitPlotRender(plot, series, uplotData, bands);

    autoEnableExtendedZones(plot);
}

