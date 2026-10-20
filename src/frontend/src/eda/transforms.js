// Baltimore Bird - Mutateurs rapides par signal: lissage, derivee, filtrage local
// Module extrait de app.js (refactoring): voir src/eda/ARCHITECTURE.md

import { S } from '../core/state.js';
import { ectx } from './context.js';
import {
    DEFAULT_PLOT_HEIGHT_PX, plotHeightPx, schedulePyramidBuild, sliceWindow, targetPointsForPlot, windowBounds,
} from './data-views.js';
import { materializeSelection, mergeIndexSets, pyramidSelect, scanSelect } from './minmax-pyramid.js';
import { plotHasSynth, renderOverlayFromCache } from './overlay.js';
import { autoEnableExtendedZones, updatePlotHeader } from './plot-legend.js';
import { buildBands, commitPlotRender, resolveSignalStyle } from './plot-ui.js';
import { assembleAlignedData, fetchAndRenderPlot } from './render.js';
import { screenSelect, stepFronts, stepFrontsLimit } from './screen-decimation.js';
import { probeNow, recordSelection } from './latency-probe.js';
import { derivative, savitzkyGolay } from './signal-math.js';

// Point selector of a complete cached signal: 'screen' (pixel error over the plot columns,
// screen-decimation.js, same selection with or without the pyramid, and as the server's first
// view) or 'pyramid' (index buckets ranked by structural error with an M4 scan until the
// pyramid is built, the previous behaviour, kept for side by side comparison in the browser).
export const DECIMATION_SELECTORS = ['screen', 'pyramid'];
let decimationSelector = 'screen';

export function getDecimationSelector() {
    return decimationSelector;
}

export function setDecimationSelector(name) {
    if (DECIMATION_SELECTORS.includes(name)) decimationSelector = name;
    return decimationSelector;
}

// Step signal (booleen, etat): rendu en escalier, decime par ses fronts.
export function isStepEntry(cached) {
    return cached.unit === 'bool' || Boolean(cached.stringMap);
}

// Raw indices of a window, or null when the window fits maxPts. The plot spans
// [viewMin, viewMax] over maxPts physical pixel columns (targetPointsForPlot).
function selectIndices(cached, startIdx, endIdx, viewMin, viewMax, maxPts, heightPx) {
    if (decimationSelector === 'pyramid') {
        return cached.pyramid
            ? pyramidSelect(cached.pyramid, cached.values, startIdx, endIdx, maxPts)
            : scanSelect(cached.values, startIdx, endIdx, maxPts);
    }
    if (endIdx - startIdx + 1 <= maxPts) return null;
    if (isStepEntry(cached)) {
        const fronts = stepFronts(cached.values, cached.changeIndex || null, startIdx, endIdx);
        if (fronts.length <= stepFrontsLimit(maxPts)) return fronts;
    }
    return screenSelect(cached.pyramid || null, cached.timestamps, cached.values, startIdx, endIdx, {
        budget: maxPts, cols: maxPts, heightPx, tMin: viewMin, tMax: viewMax,
    });
}

// =========================================================================
// Mutateurs rapides par signal: f(t) (brut), lissage Savitzky-Golay, derivee dx/dt.
// La transformation produit une entree de cache derivee de meme forme que l'originale
// (timestamps partages, valeurs recalculees, unite ajustee, pyramide propre), memoisee
// et invalidee quand la source change (arrivee du full-send) ou quand le mode change.
// =========================================================================
export const SIGNAL_TRANSFORMS = {
    savgol: {
        label: 'Lissage (Savitzky-Golay)',
        suffix: ' [lisse]',
        unit: (u) => u,
        compute: (ts, vs, params) => savitzkyGolay(vs, (params && params.window) || 75, 3),
    },
    ddt: {
        label: 'Derivee dx/dt',
        suffix: ' [dx/dt]',
        unit: (u) => (u ? `${u}/s` : '1/s'),
        compute: (ts, vs) => derivative(ts, vs),
    },
};

export const SAVGOL_WINDOWS = [
    { value: 25, text: 'Leger' },
    { value: 75, text: 'Moyen' },
    { value: 151, text: 'Fort' },
];

// Etat de transformation d'un signal: { mode, window? } ou null (f(t) brut).
export function signalTransform(plot, sigIdx) {
    return plot.signalTransforms ? plot.signalTransforms[sigIdx] || null : null;
}

// Entree de cache effective d'un signal: la derivee memoisee si un mutateur est actif,
// sinon l'entree brute. Tous les chemins de rendu et de lecture de valeurs (fenetrage,
// legende, tableau de curseurs) passent par cet accesseur.
export function effectiveCache(plot, sigIdx) {
    const cached = plot.cachedData ? plot.cachedData[sigIdx] : null;
    const transform = signalTransform(plot, sigIdx);
    if (!cached || !transform || cached.unit === 'bool') return cached;

    const spec = SIGNAL_TRANSFORMS[transform.mode];
    if (!spec) return cached;

    if (!plot._derivedCache) plot._derivedCache = {};
    const memo = plot._derivedCache[sigIdx];
    if (memo && memo._mode === transform.mode && memo._window === transform.window
            && memo._source === cached.values) {
        return memo;
    }

    const derived = {
        ...cached,
        name: cached.name + spec.suffix,
        unit: spec.unit(cached.unit),
        values: spec.compute(cached.timestamps, cached.values, transform),
        stringMap: null,
        pyramid: null,
        _pyramidBuilt: false,
        _pyramidPending: false,
        _mode: transform.mode,
        _window: transform.window,
        _source: cached.values,
    };
    plot._derivedCache[sigIdx] = derived;
    schedulePyramidBuild(derived);
    return derived;
}

export function setSignalTransform(plotId, sigIdx, mode, windowSize) {
    const plot = S.plots.find(p => p.id === plotId);
    if (!plot) return;
    if (!plot.signalTransforms) plot.signalTransforms = {};

    if (mode) {
        const previous = plot.signalTransforms[sigIdx];
        plot.signalTransforms[sigIdx] = {
            mode,
            window: windowSize || (previous && previous.mode === mode ? previous.window : undefined) || 75,
        };
    } else {
        delete plot.signalTransforms[sigIdx];
    }
    if (plot._derivedCache) delete plot._derivedCache[sigIdx];

    updatePlotHeader(plot);
    fetchAndRenderPlot(plot);
    if (typeof window.bbTrack === 'function') window.bbTrack('signal_transform');
}

// Vue fenetree d'une entree de cache: bornes par recherche binaire, puis decimation par la
// pyramide min/max (enveloppe exacte, ~maxPts points emis) si la fenetre depasse la
// resolution cible, sinon vue subarray zero-copie (ou copie bornee pour les arrays JSON).
export function windowedView(cached, viewMin, viewMax, maxPts, heightPx = DEFAULT_PLOT_HEIGHT_PX) {
    const ts = cached.timestamps;
    if (!ts || ts.length === 0) return { timestamps: [], values: [] };
    const { startIdx, endIdx } = windowBounds(ts, viewMin, viewMax);

    // Selection bornee a maxPts meme sans pyramide (construite en idle apres le full-send):
    // sans elle, la fenetre entiere partait a uPlot, soit plusieurs millions de points sur
    // un fichier reel, et le trace n'apparaissait plus.
    const indices = selectIndices(cached, startIdx, endIdx, viewMin, viewMax, maxPts, heightPx);
    if (indices) return materializeSelection(ts, cached.values, indices);
    return {
        timestamps: sliceWindow(ts, startIdx, endIdx),
        values: sliceWindow(cached.values, startIdx, endIdx),
    };
}

// Meme heuristique que sameTimeBase, appliquee aux rasters bruts (fiable sur des grilles
// d'acquisition completes): longueur et trois echantillons temoins.
function sameRaster(a, b) {
    const n = a.length;
    if (b.length !== n || n === 0) return false;
    const mid = n >> 1;
    return a[0] === b[0] && a[n - 1] === b[n - 1] && a[mid] === b[mid];
}

// Vues fenetrees des signaux d'un panneau, avec decimation CONJOINTE par groupe de raster:
// les signaux partageant une grille de temps recoivent l'union de leurs selections
// pyramidales, materialisee pour chacun sur un axe X partage (meme instance). Ainsi le
// chemin sameTimeBase reste stable (aucun null a combler, pas de bascule d'alignement entre
// frames) et l'enveloppe de chaque signal reste exacte. Retourne Map sigIdx -> vue.
export function groupedWindowedViews(plot, viewMin, viewMax, maxPts) {
    const entries = [];
    for (const sigIdx of plot.signals) {
        const cached = effectiveCache(plot, sigIdx);
        if (cached && cached.timestamps && cached.timestamps.length) entries.push({ sigIdx, cached });
    }

    // Les signaux en escalier restent seuls: leurs fronts ne se fusionnent pas avec une
    // selection par erreur pixel (meme regle cote serveur).
    const groups = [];
    for (const e of entries) {
        const g = !isStepEntry(e.cached) && groups.find(
            grp => !isStepEntry(grp[0].cached) && sameRaster(grp[0].cached.timestamps, e.cached.timestamps),
        );
        if (g) g.push(e);
        else groups.push([e]);
    }

    const heightPx = plotHeightPx(plot);
    const views = new Map();
    for (const group of groups) {
        if (group.length === 1) {
            const e = group[0];
            views.set(e.sigIdx, windowedView(e.cached, viewMin, viewMax, maxPts, heightPx));
            continue;
        }

        const ref = group[0].cached;
        const { startIdx, endIdx } = windowBounds(ref.timestamps, viewMin, viewMax);
        const nVisible = endIdx - startIdx + 1;

        if (nVisible <= maxPts) {
            for (const e of group) {
                views.set(e.sigIdx, {
                    timestamps: sliceWindow(e.cached.timestamps, startIdx, endIdx),
                    values: sliceWindow(e.cached.values, startIdx, endIdx),
                });
            }
            continue;
        }

        // Selection par signal (indices bruts croissants), fusionnee pour le groupe. Le serveur
        // applique la meme union a sa premiere vue (core/screen_decimation.py).
        const merged = mergeIndexSets(group.map(
            e => selectIndices(e.cached, startIdx, endIdx, viewMin, viewMax, maxPts, heightPx),
        ));
        const ts = new Float64Array(merged.length);
        for (let i = 0; i < merged.length; i++) ts[i] = ref.timestamps[merged[i]];
        for (const e of group) {
            const vs = new Float32Array(merged.length);
            const src = e.cached.values;
            for (let i = 0; i < merged.length; i++) vs[i] = src[merged[i]];
            views.set(e.sigIdx, { timestamps: ts, values: vs });
        }
    }
    return views;
}

/**
 * Render plot using local filtering (no API call).
 */
export function renderPlotFromCacheFiltered(plot) {
    if (plot.signals.length === 0) return;
    if (plotHasSynth(plot)) { renderOverlayFromCache(plot); return; }

    const sigList = [];
    plot.displayedViewParams = null;
    const selectStart = probeNow();
    const views = groupedWindowedViews(plot, ectx.globalView.min, ectx.globalView.max, targetPointsForPlot(plot));
    recordSelection(selectStart);
    for (const sigIdx of plot.signals) {
        const cached = effectiveCache(plot, sigIdx);
        if (!cached) continue;
        const filtered = views.get(sigIdx);
        if (!filtered || !filtered.timestamps.length) continue;
        sigList.push({
            name: cached.name,
            unit: cached.unit,
            style: resolveSignalStyle(plot, sigIdx, cached.color),
            timestamps: filtered.timestamps,
            values: filtered.values,
        });
    }
    if (sigList.length === 0) return;

    const { uplotData, series } = assembleAlignedData(sigList);

    const bands = buildBands(series, uplotData);
    commitPlotRender(plot, series, uplotData, bands);

    autoEnableExtendedZones(plot);
}

