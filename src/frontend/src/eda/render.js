// Baltimore Bird - Recuperation des donnees serveur et rendu des panneaux (analog, bool)
// Module extrait de app.js (refactoring): voir src/eda/ARCHITECTURE.md

import { S } from '../core/state.js';
import { boolZonesPlugin } from './bool-zones.js';
import { API, ectx } from './context.js';
import { cursorPlugin, isLegendSignalSelected } from './cursors.js';
import { PX_BUCKET, cacheCoversView, canRenderFromCache, getPersistentView, prefetchCache, replayServerData, schedulePyramidBuild, storeViewCache, targetPointsForPlot, viewCacheKey } from './data-views.js';
import { renderCommentPlot } from './events-strip.js';
import { fetchViewGrouped, isSeriesSynth, plotHasSynth, renderOverlayChart, renderOverlayFromCache, scheduleFullDataOverlay, seriesDescriptor } from './overlay.js';
import { autoEnableExtendedZones } from './plot-legend.js';
import { PLOT_PAD_BOTTOM, PLOT_PAD_RIGHT, PLOT_PAD_TOP, Y_AXIS_SIZE, axisDragPlugin, buildBands, buildSeriesConfig, commitPlotRender, isLastPlot, pathRenderer, resolveSignalStyle, themeChartColors, xAxisConfig, zoomToSelection } from './plot-ui.js';
import { colorWithOpacity } from './plots.js';
import { SIGNAL_TRANSFORMS, renderPlotFromCacheFiltered, signalTransform, windowedView } from './transforms.js';
import { plotIsVisible } from './view-nav.js';

// --- Full send : rapatriement pleine résolution côté client ---
// Après le premier rendu (vue décimée via /view), on rapatrie en tâche de fond les signaux
// affichés en pleine résolution (binaire). Une fois en cache avec isComplete, tout le pan/zoom
// est rendu localement par canRenderFromCache -> renderPlotFromCacheFiltered, sans réseau.
export const fullDataInFlight = new Set();

// Decode l'enveloppe binaire commune a /raw et /view:
// [uint32 LE longueur d'entete][entete JSON UTF-8][par signal: float64 ts + float32 vals].
// Retourne l'entete tel quel, chaque signal recevant ses typed arrays a la place de 'n'.
function decodeSignalsPayload(buf) {
    const headerLen = new DataView(buf).getUint32(0, true);
    const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, headerLen)));
    let off = 4 + headerLen;
    for (const sig of header.signals) {
        const n = sig.n;
        // slice() recopie sur un buffer aligne (requis par Float64Array/Float32Array).
        sig.timestamps = new Float64Array(buf.slice(off, off + n * 8)); off += n * 8;
        sig.values = new Float32Array(buf.slice(off, off + n * 4)); off += n * 4;
        delete sig.n;
    }
    return header;
}

// GET d'une vue serveur, binaire ou JSON selon le Content-Type de la reponse (le mode
// demo sans session repond en JSON, les sessions lazy en binaire via format=bin).
// Retourne null sur erreur HTTP, a la charge de l'appelant.
export async function fetchViewData(url, headers) {
    const res = await fetch(url, { headers });
    if (!res.ok) return null;
    const type = res.headers.get('Content-Type') || '';
    if (type.includes('application/octet-stream')) {
        return decodeSignalsPayload(await res.arrayBuffer());
    }
    return res.json();
}

export async function fetchRawSignals(indices, sessionId = ectx.currentLazySessionId) {
    if (!sessionId || indices.length === 0) return null;
    let url = `${API}/raw?session_id=${encodeURIComponent(sessionId)}&signals=${indices.join(',')}`;
    const headers = {};
    const token = sessionStorage.getItem('auth_token');
    if (token) headers['Authorization'] = 'Bearer ' + token;

    const res = await fetch(url, { headers });
    if (!res.ok) return null;
    const header = decodeSignalsPayload(await res.arrayBuffer());

    for (const sig of header.signals) {
        const values = sig.values;
        let mn = Infinity, mx = -Infinity;
        for (let i = 0; i < values.length; i++) { const v = values[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
        sig.is_complete = true;
        sig.from_raw = true;
        sig.string_map = sig.string_map || null;
        sig.is_categorical = sig.is_categorical || false;
        sig.stats = { min: mn === Infinity ? 0 : mn, max: mx === -Infinity ? 0 : mx };
    }
    return header;
}

// Diffère le full send jusqu'à l'inactivité du navigateur: le premier paint (vue décimée) et sa
// requête /view passent en priorité; le GET pleine résolution démarre une fois l'affichage rendu.
function scheduleFullData(plot) {
    const run = () => ensureFullData(plot);
    if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(run, { timeout: 1500 });
    } else {
        setTimeout(run, 200);
    }
}

async function ensureFullData(plot) {
    if (!ectx.currentLazySessionId || !plot || plot.signals.length === 0) return;
    if (plotHasSynth(plot)) return; // overlay: full-send dedie groupe par run
    const need = plot.signals.filter(i => {
        const c = plot.cachedData[i];
        const complete = c && c.isComplete && c.fullTimeRange;
        return !complete && !fullDataInFlight.has(i);
    });
    if (need.length === 0) return;

    need.forEach(i => fullDataInFlight.add(i));
    try {
        const data = await fetchRawSignals(need);
        if (data && data.signals && data.signals.length) {
            cacheServerSignals(plot, data);
            // Le full-send est differe (idle + reseau): l'onglet a pu changer entre-temps.
            if (plotIsVisible(plot) && canRenderFromCache(plot, ectx.globalView.min, ectx.globalView.max)) {
                if (plot.isBoolPlot) renderBoolPlot(plot);
                else renderPlotFromCacheFiltered(plot);
            }
        }
    } catch (e) {
        console.error('Full send error:', e);
    } finally {
        need.forEach(i => fullDataInFlight.delete(i));
    }
}

export async function fetchAndRenderPlot(plot) {
    if (plot.signals.length === 0) return;

    // Strip commentaires: rendu dedie (points d'events), aucun fetch /view.
    if (plot.isCommentPlot) { renderCommentPlot(plot); return; }

    // Overlay multi-fichiers: chemin dedie (fetch groupe par run, rendu union-X). Les
    // optimisations mono-session (viewCache, prefetch, full-res) sont volontairement
    // contournees pour ce premier passage; le plot refetch a chaque changement de vue.
    if (plotHasSynth(plot)) {
        // Cache complet (apres full-send): rejeu local immediat, aucun reseau.
        if (canRenderFromCache(plot, ectx.globalView.min, ectx.globalView.max)) {
            renderOverlayFromCache(plot);
            return;
        }
        // Sinon: rendu decime immediat groupe par run, puis full-send differe en idle.
        const maxPtsOverlay = targetPointsForPlot(plot);
        const overlayData = await fetchViewGrouped(plot, maxPtsOverlay);
        if (overlayData.signals.length) renderPlotChart(plot, overlayData);
        scheduleFullDataOverlay(plot);
        return;
    }

    // 1) Signaux complets deja en cache: rendu client immediat.
    if (canRenderFromCache(plot, ectx.globalView.min, ectx.globalView.max)) {
        if (plot.isBoolPlot) renderBoolPlot(plot);
        else renderPlotFromCacheFiltered(plot);
        return;
    }

    // 2) Vue deja visitee (meme plage/resolution/signaux): rejeu sans reseau.
    const maxPts = targetPointsForPlot(plot);
    const vKey = viewCacheKey(plot);
    const cachedView = plot.viewCache?.get(vKey);
    // Rejeu si la resolution en cache couvre le besoin courant (tolerance d'un bucket,
    // pour absorber la derive de mesure de largeur). Sinon on refetch a la bonne resolution.
    if (cachedView && cachedView.maxPts >= maxPts - PX_BUCKET) {
        storeViewCache(plot, vKey, cachedView.data, cachedView.maxPts);
        replayServerData(plot, cachedView.data);
        const statServer = document.getElementById('statServer');
        if (statServer) statServer.textContent = 'cache';
        scheduleFullData(plot);
        return;
    }

    // 2bis) Cache persistant inter-plots (survit au changement de fichier): un plot
    //       reconstruit apres bascule 1 -> 2 -> 1 rejoue la vue sans reseau. Meme tolerance
    //       de resolution que le cache par-plot.
    const persisted = getPersistentView(ectx.currentLazySessionId, vKey);
    if (persisted && persisted.maxPts >= maxPts - PX_BUCKET) {
        storeViewCache(plot, vKey, persisted.data, persisted.maxPts);
        replayServerData(plot, persisted.data);
        const statServer = document.getElementById('statServer');
        if (statServer) statServer.textContent = 'cache-fichier';
        scheduleFullData(plot);
        return;
    }

    // 2ter) Requete deja lancee au pickup (drag): un plot frais (1 signal) la retrouve
    //       ici et attend simplement la fin de la requete deja en vol -> ressenti instantane.
    const prefetched = prefetchCache.get(vKey);
    if (prefetched) {
        prefetchCache.delete(vKey);
        const data = await prefetched.promise;
        if (data && data.signals) {
            storeViewCache(plot, vKey, data, prefetched.maxPts);
            replayServerData(plot, data);
            const statServer = document.getElementById('statServer');
            if (statServer) statServer.textContent = 'prefetch';
            scheduleFullData(plot);
            return;
        }
    }

    // 3) Zoom avant dans une sous-fenetre: affichage grossier immediat depuis le
    //    cache courant, puis raffinement par le serveur ci-dessous.
    if (!plot.isBoolPlot && cacheCoversView(plot, ectx.globalView.min, ectx.globalView.max)) {
        renderPlotFromCacheFiltered(plot);
    }

    const signalIndices = plot.signals.join(',');
    let url = `${API}/view?signals=${signalIndices}&start=${ectx.globalView.min}&end=${ectx.globalView.max}&max_points=${maxPts}`;

    const headers = {};
    if (ectx.currentLazySessionId) {
        url += `&session_id=${encodeURIComponent(ectx.currentLazySessionId)}&format=bin`;
        const token = sessionStorage.getItem('auth_token');
        if (token) {
            headers['Authorization'] = 'Bearer ' + token;
        }
    }

    const startTime = performance.now();

    try {
        const data = await fetchViewData(url, headers);
        if (!data || !data.signals) return;

        const fetchTime = performance.now() - startTime;
        const statServer = document.getElementById('statServer');
        if (statServer) {
            statServer.textContent = `${fetchTime.toFixed(0)}ms`;
        }

        storeViewCache(plot, vKey, data, maxPts);
        replayServerData(plot, data);
        scheduleFullData(plot);

    } catch (e) {
        console.error('Fetch error:', e);
    }
}

// Met en cache les signaux d'une reponse serveur sur le plot (extrait de
// renderPlotChart pour etre partage avec le rendu booleen).
// Plage d'acquisition attendue pour une cle de serie, garde-fou de completude.
function expectedAcquisitionRange(key) {
    if (isSeriesSynth(key)) {
        const d = seriesDescriptor(key);
        const run = d.sessionId ? S.runs.find(r => r.sessionId === d.sessionId) : null;
        return run && Number.isFinite(run.tMin) && Number.isFinite(run.tMax)
            ? { min: run.tMin, max: run.tMax } : null;
    }
    return ectx.acquisitionView ? { min: ectx.acquisitionView.min, max: ectx.acquisitionView.max } : null;
}

export function cacheServerSignals(plot, data) {
    if (!data.signals) return;
    data.signals.forEach(sig => {
        const existingCache = plot.cachedData[sig.index];
        const newTimeRange = {
            min: sig.timestamps[0],
            max: sig.timestamps[sig.timestamps.length - 1]
        };

        if (existingCache?.isComplete && existingCache?.fullTimeRange) {
            const existingCovers = existingCache.fullTimeRange.min <= newTimeRange.min &&
                                   existingCache.fullTimeRange.max >= newTimeRange.max;
            if (existingCovers) {
                return;
            }
        }

        plot.cachedData[sig.index] = {
            name: sig.name,
            color: sig.color,
            unit: sig.unit,
            timestamps: sig.timestamps,
            values: sig.values,
            stats: sig.stats,
            isComplete: (() => {
                if (!sig.is_complete) return false;
                if (sig.from_raw) return true;
                const acq = expectedAcquisitionRange(sig.index);
                const span = acq ? acq.max - acq.min : 0;
                return !acq || (newTimeRange.min <= acq.min + span * 0.01
                    && newTimeRange.max >= acq.max - span * 0.01);
            })(),
            timeRange: newTimeRange,
            stringMap: sig.string_map || null,
            isCategorical: sig.is_categorical || false
        };
        const entry = plot.cachedData[sig.index];
        entry.fullTimeRange = entry.isComplete ? newTimeRange : null;

        applyUnitConversion(plot, sig.index);
        schedulePyramidBuild(plot.cachedData[sig.index]);
    });
}

// Convertit en place les valeurs (et l'unité) du cache d'un signal vers l'unité du graphe,
// si une conversion a été déterminée à l'ajout. Sans effet sinon.
function applyUnitConversion(plot, signalIndex) {
    const conv = plot.unitConversions?.[signalIndex];
    if (!conv) return;
    const entry = plot.cachedData[signalIndex];
    if (!entry) return;
    entry.values = convertValues(entry.values, conv);
    entry.unit = conv.targetUnit;
}

// Applique la conversion affine à un tableau de valeurs (nouveau tableau, gaps préservés).
function convertValues(values, conv) {
    const { factor, offset } = conv;
    // Typed array (full-send): conversion sans changement de type, pour preserver le chemin
    // subarray zero-copie et la pyramide min/max. Les valeurs y sont finies (le serveur
    // interpole les NaN avant envoi). Array JS (donnees decimees de /view): trous possibles.
    if (typeof values.subarray === 'function') {
        const out = new values.constructor(values.length);
        for (let i = 0; i < values.length; i++) out[i] = values[i] * factor + offset;
        return out;
    }
    return Array.from(values, v =>
        (v === null || v === undefined || Number.isNaN(v)) ? v : v * factor + offset
    );
}

// Vrai si tous les signaux partagent la meme grille temporelle (meme longueur et memes
// bornes/milieu). Permet de garder le chemin rapide (X partage) quand c'est le cas.
function sameTimeBase(sigList) {
    const a = sigList[0].timestamps;
    const n = a.length;
    for (let k = 1; k < sigList.length; k++) {
        const b = sigList[k].timestamps;
        if (b.length !== n) return false;
        if (n === 0) continue;
        const mid = n >> 1;
        if (a[0] !== b[0] || a[n - 1] !== b[n - 1] || a[mid] !== b[mid]) return false;
    }
    return true;
}

// Assemble les donnees uPlot pour des signaux pouvant avoir des bases de temps differentes
// (ex. raster natif et variante _100ms). Grille commune: chemin rapide a X partage. Sinon:
// union triee des timestamps, remplissage null hors des echantillons reels de chaque signal,
// et spanGaps pour relier chaque courbe a travers les positions etrangeres. uPlot etant en
// mode 1 (X unique), c'est la seule facon d'aligner correctement des grilles distinctes.
export function assembleAlignedData(sigList) {
    const series = [{}];
    if (sigList.length === 0) return { uplotData: [[]], series };

    if (sigList.length === 1 || sameTimeBase(sigList)) {
        const uplotData = [sigList[0].timestamps];
        sigList.forEach(s => {
            uplotData.push(s.values);
            series.push(buildSeriesConfig(s.name, s.unit, s.style, s.selected));
        });
        return { uplotData, series };
    }

    const tsSet = new Set();
    sigList.forEach(s => { const t = s.timestamps; for (let i = 0; i < t.length; i++) tsSet.add(t[i]); });
    const x = Float64Array.from(tsSet);
    x.sort();
    const pos = new Map();
    for (let i = 0; i < x.length; i++) pos.set(x[i], i);

    const uplotData = [Array.from(x)];
    sigList.forEach(s => {
        const y = new Array(x.length).fill(null);
        const t = s.timestamps;
        const v = s.values;
        for (let i = 0; i < t.length; i++) {
            const p = pos.get(t[i]);
            if (p !== undefined) y[p] = v[i];
        }
        const sc = buildSeriesConfig(s.name, s.unit, s.style, s.selected);
        sc.spanGaps = true;
        uplotData.push(y);
        series.push(sc);
    });
    return { uplotData, series };
}

export function renderPlotChart(plot, data) {
    if (!data.signals || data.signals.length === 0) return;

    cacheServerSignals(plot, data);

    // Cache alimente ci-dessus: si l'onglet a change pendant la requete, on s'arrete
    // la. Le rendu sera rejoue depuis le cache au retour sur l'onglet.
    if (!plotIsVisible(plot)) return;

    // Overlay multi-fichiers: assemblage union-X (bases de temps differentes par run).
    if (plotHasSynth(plot)) {
        renderOverlayChart(plot, data);
        return;
    }

    const sigList = data.signals.map(sig => {
        const style = resolveSignalStyle(plot, sig.index, sig.color);
        const conv = plot.unitConversions?.[sig.index];
        let name = sig.name;
        let unit = conv ? conv.targetUnit : sig.unit;
        let values = conv ? convertValues(sig.values, conv) : sig.values;

        // Mutateur actif: transformation des series decimees du serveur, pour une
        // bascule immediatement visible (approximation transitoire jusqu'au full-send).
        const transform = signalTransform(plot, sig.index);
        const spec = transform && unit !== 'bool' ? SIGNAL_TRANSFORMS[transform.mode] : null;
        if (spec) {
            values = spec.compute(sig.timestamps, values, transform);
            unit = spec.unit(unit);
            name += spec.suffix;
        }
        return { name, unit, style, timestamps: sig.timestamps, values };
    });

    const { uplotData, series } = assembleAlignedData(sigList);

    const bands = buildBands(series, uplotData);
    commitPlotRender(plot, series, uplotData, bands);

    autoEnableExtendedZones(plot);
}

// Options uPlot du plot booleen: chaque signal sur sa propre lane discrete
// (valeurs decalees de lane*2), echelle Y fixe, axe Y etiquete par signal.
function buildBoolPlotOptions(series, width, height, laneCount, baselines, showTimeAxis = true) {
    return {
        width,
        height,
        legend: { show: false },
        series,
        padding: [PLOT_PAD_TOP, PLOT_PAD_RIGHT, showTimeAxis ? null : PLOT_PAD_BOTTOM, null],
        scales: {
            // Fonction (et non tableau fige a la creation): uPlot re-evalue la plage X a
            // chaque redraw, donc le setScale('x') du pan est suivi en direct. Avec un
            // tableau statique, le strip booleen restait fige pendant le glissement et ne
            // sautait qu'au relachement (rebuild) -> navigation a l'aveugle.
            x: { time: false, range: () => [ectx.globalView.min, ectx.globalView.max] },
            y: { range: [-0.2, laneCount * 2 - 0.8] },
        },
        axes: [
            xAxisConfig(showTimeAxis),
            {
                // Gouttiere Y vide (meme largeur que les autres panneaux pour
                // l'alignement X), sans etiquettes; la grille marque les lanes.
                stroke: () => themeChartColors().axis,
                grid: { stroke: () => themeChartColors().grid, width: 1 },
                ticks: { show: false },
                size: Y_AXIS_SIZE,
                splits: () => baselines,
                values: () => baselines.map(() => ''),
            },
        ],
        cursor: { drag: { x: true, y: false, dist: 8 }, points: { show: false } },
        hooks: { setSelect: [zoomToSelection] },
        plugins: [boolZonesPlugin(), cursorPlugin(), axisDragPlugin()],
    };
}

// Rendu du plot booleen dedie facon timeseries-discrete: lanes empilees, trace
// en escalier, remplissage en dessous jusqu'a la base de chaque lane. Le premier
// signal est en haut. plot.laneOffsets sert au positionnement des curseurs.
export function renderBoolPlot(plot) {
    if (plot.signals.length === 0) return;

    const chartDiv = plot.element.querySelector('.chart');
    const bodyDiv = plot.element.querySelector('.plot-body');

    if (plot.chart) plot.chart.destroy();

    const n = plot.signals.length;
    const laneOffsets = {};

    // Chaque booleen a sa propre grille de timestamps (ajout separe => decimation
    // independante), donc on NE PARTAGE PAS l'axe X du premier signal. Filtrage borne a
    // la vue PAR SIGNAL, en gardant un point au-dela de chaque bord (sinon l'escalier est
    // coupe aux bords ou disparait dans un palier sans front).
    const perSignal = [];
    const maxPts = targetPointsForPlot(plot);
    plot.signals.forEach((sigIdx, k) => {
        const cached = plot.cachedData[sigIdx];
        if (!cached || !cached.timestamps || cached.timestamps.length === 0) return;

        const view = windowedView(cached, ectx.globalView.min, ectx.globalView.max, maxPts);

        const lane = n - 1 - k;          // premier signal en haut
        const base = lane * 2;
        laneOffsets[sigIdx] = base;

        const t = [];
        const v = [];
        for (let i = 0; i < view.timestamps.length; i++) {
            t.push(view.timestamps[i]);
            const val = view.values[i];
            v.push(val == null ? null : val + base);
        }
        perSignal.push({ sigIdx, base, t, v, cached });
    });

    if (perSignal.length === 0) return;

    // Union triee des timestamps de tous les booleens; Y aligne avec trous (null) hors
    // echantillons, spanGaps reliant l'escalier de chaque signal a travers les positions
    // des autres. Exact (vrais echantillons), identique au cas des grilles coincidentes.
    const tsSet = new Set();
    perSignal.forEach(s => { for (let i = 0; i < s.t.length; i++) tsSet.add(s.t[i]); });
    const x = Float64Array.from(tsSet);
    x.sort();
    const pos = new Map();
    for (let i = 0; i < x.length; i++) pos.set(x[i], i);

    const uplotData = [Array.from(x)];
    const series = [{}];

    perSignal.forEach(s => {
        const y = new Array(x.length).fill(null);
        for (let i = 0; i < s.t.length; i++) {
            const p = pos.get(s.t[i]);
            if (p !== undefined) y[p] = s.v[i];
        }
        const style = resolveSignalStyle(plot, s.sigIdx, s.cached.color);
        const selected = isLegendSignalSelected(plot.id, s.sigIdx);
        uplotData.push(y);
        series.push({
            label: s.cached.name,
            stroke: style.color,
            width: selected ? style.width * 2 + 0.5 : style.width,
            paths: pathRenderer('stepped'),
            fill: colorWithOpacity(style.color, selected ? 0.5 : 0.3),
            fillTo: s.base,
            points: { show: false },
            spanGaps: true,
        });
    });

    // Bases des lanes (du bas vers le haut) pour les separateurs de grille Y.
    const baselines = [];
    for (let lane = 0; lane < n; lane++) {
        baselines.push(lane * 2);
    }

    plot.laneOffsets = laneOffsets;

    const width = bodyDiv.clientWidth || 800;
    const height = bodyDiv.clientHeight || 180;

    plot.chart = new uPlot(
        buildBoolPlotOptions(series, width, height, n, baselines, isLastPlot(plot)),
        uplotData, chartDiv
    );

    autoEnableExtendedZones(plot);
}

