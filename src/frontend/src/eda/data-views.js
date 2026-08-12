// Baltimore Bird - Caches de vues (prefetch, persistant), fenetres temporelles, pyramides
// Module extrait de app.js (refactoring): voir src/eda/ARCHITECTURE.md

import { S } from '../core/state.js';
import { API, ectx } from './context.js';
import { buildMinMaxPyramid } from './minmax-pyramid.js';
import { plotHasSynth } from './overlay.js';
import { updateSignalsLoadedStatus } from './plots.js';
import { cacheServerSignals, fetchViewData, renderBoolPlot, renderPlotChart } from './render.js';
import { plotIsVisible } from './view-nav.js';

// =========================================================================
// Data Fetching & Rendering (with local filtering optimization)
// =========================================================================

/**
 * Check if all signals in a plot can be rendered from cache (no API call needed).
 */
// Cache de vues par plot: memorise les reponses serveur indexees par
// (plage, resolution, signaux) pour rejouer instantanement une vue deja visitee
// (zoom arriere, double-clic, historique) sans aller-retour reseau.
const MAX_VIEW_CACHE = 16;

// Resolution cible d'un plot, en points. Pilotee par la largeur reelle du plot en
// pixels (x devicePixelRatio): inutile de tracer plus de points que de pixels. La
// valeur est arrondie au bucket SUPERIEUR (jamais en dessous de la largeur reelle,
// pour qu'il y ait toujours >= 1 point par colonne et que la courbe couvre toute la
// vue), ce qui stabilise aussi la cle du cache lors des petits redimensionnements.
// Bornee [MIN, MAX] (le backend clampe aussi a 10000).
export const PX_BUCKET = 64;

const MIN_TARGET_POINTS = 300;

const MAX_TARGET_POINTS = 10000;

export function targetPointsForPlot(plot) {
    const body = plot.element && plot.element.querySelector('.plot-body');
    const cssWidth = (body && body.clientWidth) || 800;
    const dpr = window.devicePixelRatio || 1;
    const raw = Math.ceil(cssWidth * dpr);
    const bucketed = Math.ceil(raw / PX_BUCKET) * PX_BUCKET;
    return Math.min(MAX_TARGET_POINTS, Math.max(MIN_TARGET_POINTS, bucketed));
}

// Cle d'une vue: plage + signaux, SANS la resolution. La resolution (maxPts) peut
// deriver d'une frame a l'autre (mesures de largeur instables au layout/resize), ce
// qui fragmentait le cache et provoquait des re-fetch au zoom arriere. On la sort donc
// de la cle et on la memorise a cote (voir storeViewCache / rejeu conditionnel).
function viewKey(signalsStr) {
    const r = v => Math.round(v * 1000) / 1000;
    return `${r(ectx.globalView.min)}:${r(ectx.globalView.max)}:${signalsStr}`;
}

export function viewCacheKey(plot) {
    return viewKey(plot.signals.join(','));
}

// Requetes /view lancees au pickup (dragstart) d'un signal, pour masquer le cout de
// prechargement + reseau derriere le geste de drag. La cle reprend le format de
// viewKey afin qu'un plot frais (1 seul signal) la retrouve a la release.
export const prefetchCache = new Map();

const PREFETCH_TTL = 15000;

// Largeur ou un nouveau plot atterrira: les plots sont empiles verticalement, donc
// tous partagent la largeur du conteneur. Sert a choisir la resolution de la requete.
function estimatedMaxPtsForNewPlot() {
    const existingBody = document.querySelector('.plot-body');
    let cssWidth = existingBody && existingBody.clientWidth;
    if (!cssWidth) {
        const dz = document.getElementById(`dropZone-${S.activeTabId}`)
            || document.querySelector('.plots-container');
        cssWidth = (dz && dz.clientWidth) || 800;
    }
    const dpr = window.devicePixelRatio || 1;
    const raw = Math.ceil(cssWidth * dpr);
    const bucketed = Math.ceil(raw / PX_BUCKET) * PX_BUCKET;
    return Math.min(MAX_TARGET_POINTS, Math.max(MIN_TARGET_POINTS, bucketed));
}

export function prefetchSignalView(signalIndices) {
    const indices = (Array.isArray(signalIndices) ? signalIndices : [signalIndices])
        .filter(i => i != null && S.signalsInfo[i]);
    if (!indices.length) return;

    const key = viewKey(indices.join(','));
    if (prefetchCache.has(key)) return;

    const maxPts = estimatedMaxPtsForNewPlot();
    let url = `${API}/view?signals=${indices.join(',')}&start=${ectx.globalView.min}&end=${ectx.globalView.max}`
        + `&max_points=${maxPts}`;
    const headers = {};
    if (ectx.currentLazySessionId) {
        url += `&session_id=${encodeURIComponent(ectx.currentLazySessionId)}&format=bin`;
        const token = sessionStorage.getItem('auth_token');
        if (token) headers['Authorization'] = 'Bearer ' + token;
    }

    const promise = fetchViewData(url, headers).catch(() => null);
    prefetchCache.set(key, { promise, maxPts });
    setTimeout(() => prefetchCache.delete(key), PREFETCH_TTL);
}

export function storeViewCache(plot, key, data, maxPts) {
    if (!plot.viewCache) plot.viewCache = new Map();
    plot.viewCache.delete(key);
    plot.viewCache.set(key, { data, maxPts });
    while (plot.viewCache.size > MAX_VIEW_CACHE) {
        plot.viewCache.delete(plot.viewCache.keys().next().value);
    }
    // Write-through vers le cache persistant: seules les vues mono-session y vont
    // (l'overlay a son propre chemin et contourne viewCache).
    if (!plotHasSynth(plot)) storePersistentView(ectx.currentLazySessionId, key, data, maxPts);
}

// Cache de vues persistant, partage entre plots et survivant a leur destruction. Au
// changement de fichier, applyLayout detruit puis reconstruit les plots (donc perd leur
// viewCache); ce cache module-level permet un aller-retour 1 -> 2 -> 1 sans refetch. La
// cle prefixe viewKey par le sessionId: les index de signaux sont stables au sein d'une
// session (memes noms -> memes index a la reconstruction), et le prefixe isole les
// sessions entre elles. Eviction LRU globale bornee.
const persistentViewCache = new Map();

const MAX_PERSISTENT_VIEW_CACHE = 64;

function persistentViewKey(sessionId, vKey) {
    return `${sessionId}::${vKey}`;
}

export function getPersistentView(sessionId, vKey) {
    if (!sessionId) return null;
    const key = persistentViewKey(sessionId, vKey);
    const hit = persistentViewCache.get(key);
    if (!hit) return null;
    persistentViewCache.delete(key);
    persistentViewCache.set(key, hit);
    return hit;
}

function storePersistentView(sessionId, vKey, data, maxPts) {
    if (!sessionId) return;
    const key = persistentViewKey(sessionId, vKey);
    persistentViewCache.delete(key);
    persistentViewCache.set(key, { data, maxPts });
    while (persistentViewCache.size > MAX_PERSISTENT_VIEW_CACHE) {
        persistentViewCache.delete(persistentViewCache.keys().next().value);
    }
}

// Rejoue une reponse serveur (en cache) via le chemin de rendu normal, sans reseau.
export function replayServerData(plot, data) {
    // Point de rendu commun a tous les chemins post-fetch: la mise en cache est faite
    // par les appelants/renderPlotChart, on peut donc sauter le trace si l'onglet a
    // change pendant la requete.
    if (!plotIsVisible(plot)) {
        if (plot.isBoolPlot) cacheServerSignals(plot, data);
        if (data.signals_status) updateSignalsLoadedStatus(data.signals_status);
        return;
    }
    if (plot.isBoolPlot) {
        cacheServerSignals(plot, data);
        renderBoolPlot(plot);
    } else {
        renderPlotChart(plot, data);
    }
    if (data.signals_status) updateSignalsLoadedStatus(data.signals_status);
}

// Vrai si le cache courant couvre la fenetre demandee (meme non "complet"):
// permet un rendu grossier immediat lors d'un zoom avant, en attendant le serveur.
export function cacheCoversView(plot, viewMin, viewMax) {
    const TOLERANCE = 0.5;
    if (plot.signals.length === 0) return false;
    for (const sigIdx of plot.signals) {
        const c = plot.cachedData[sigIdx];
        if (!c || !c.timestamps || c.timestamps.length === 0) return false;
        if (c.timestamps[0] > viewMin + TOLERANCE ||
            c.timestamps[c.timestamps.length - 1] < viewMax - TOLERANCE) return false;
    }
    return true;
}

export function canRenderFromCache(plot, viewMin, viewMax) {
    for (const sigIdx of plot.signals) {
        const cached = plot.cachedData[sigIdx];
        if (!cached) return false;
        if (!cached.isComplete) return false;
        if (!cached.fullTimeRange) return false;
        // isComplete => le cache contient TOUTE la serie. Aucune donnee n'existe au-dela
        // de fullTimeRange : une vue plus large (dezoom) n'a rien a recuperer cote serveur
        // et se rend donc en local (windowedView borne proprement aux donnees presentes).
    }
    return true;
}

// Premier indice i tel que ts[i] >= t (equivalent searchsorted side='left').
function lowerBoundTs(ts, t) {
    let lo = 0, hi = ts.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (ts[mid] < t) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

// Premier indice i tel que ts[i] > t (equivalent searchsorted side='right').
function upperBoundTs(ts, t) {
    let lo = 0, hi = ts.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (ts[mid] <= t) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

// Bornes inclusives [startIdx, endIdx] de la fenetre [viewMin, viewMax] sur des timestamps
// tries. On etend d'un point de chaque cote: indispensable pour le rendu escalier de donnees
// eparses (un palier sans front dans la vue serait sinon vide), et sans effet visible pour
// les signaux denses (le point hors-vue est clippe). Recherche binaire O(log n): ce chemin
// tourne a chaque frame de pan (applyGlobalViewLocal), les balayages lineaires historiques
// coutaient O(n) par frame et par signal sur les caches pleine resolution.
export function windowBounds(ts, viewMin, viewMax) {
    const n = ts.length;
    const lo = lowerBoundTs(ts, viewMin);
    const hi = upperBoundTs(ts, viewMax) - 1;

    let startIdx = lo > 0 ? lo - 1 : 0;
    let endIdx = hi < n - 1 ? hi + 1 : n - 1;
    if (startIdx > endIdx) {
        startIdx = Math.max(0, Math.min(lo, n - 1));
        endIdx = startIdx;
    }
    return { startIdx, endIdx };
}

// Vue [start, endInclusive] sans copie pour les typed arrays du full-send (subarray),
// copie bornee a la fenetre pour les arrays JSON decimes de /view (quelques milliers
// de points, cout negligeable).
export function sliceWindow(arr, start, endInclusive) {
    return arr.subarray ? arr.subarray(start, endInclusive + 1) : arr.slice(start, endInclusive + 1);
}

// Construit la pyramide min/max d'une entree de cache complete, en idle pour ne pas disputer
// le main thread au premier rendu. Tant qu'elle n'est pas prete, windowedView replie sur la
// vue subarray brute. buildMinMaxPyramid retourne null pour les signaux courts ou non types:
// le flag _pyramidBuilt evite alors de replanifier indefiniment.
export function schedulePyramidBuild(entry) {
    if (!entry || !entry.isComplete || entry._pyramidBuilt || entry._pyramidPending) return;
    if (!entry.values || typeof entry.values.subarray !== 'function') return;
    entry._pyramidPending = true;
    const run = () => {
        entry._pyramidPending = false;
        entry._pyramidBuilt = true;
        entry.pyramid = buildMinMaxPyramid(entry.values);
    };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 3000 });
    else setTimeout(run, 250);
}

