// Baltimore Bird - Series overlay multi-fichiers (cle synthetique session+nom)
// Module extrait de app.js (refactoring): voir src/eda/ARCHITECTURE.md

import { S } from '../core/state.js';
import { resizePlotCharts } from './bootstrap.js';
import { API, ectx } from './context.js';
import { canRenderFromCache, targetPointsForPlot } from './data-views.js';
import { autoEnableExtendedZones, updatePlotHeader, updateSignalActiveStates } from './plot-legend.js';
import { buildSeriesConfig, commitPlotRender, resolveSignalStyle, themedSignalColor } from './plot-ui.js';
import { cacheServerSignals, fetchAndRenderPlot, fetchRawSignals, fetchViewData, fullDataInFlight } from './render.js';
import { effectiveRunOffset } from './runs.js';
import { windowedView } from './transforms.js';
import { plotIsVisible } from './view-nav.js';

// =========================================================================
// Overlay multi-fichiers: une serie tracee = (session, nom). On lui alloue une cle
// synthetique entiere stable, hors de la plage des index reels, afin de preserver le
// contrat "cle entiere" de tout le pipeline (cache, styles, viewCache). La cle est
// resolue via S.seriesMeta vers la session, le nom, la couleur de run et le libelle.
// =========================================================================
const SERIES_SYNTH_BASE = 100000000;

let seriesSynthCounter = SERIES_SYNTH_BASE;

const seriesSynthByKey = new Map();

function seriesMeta() {
    if (!S.seriesMeta) S.seriesMeta = new Map();
    return S.seriesMeta;
}

function seriesSynthFor(sessionId, name) {
    const k = sessionId + '\u0000' + name;
    let synth = seriesSynthByKey.get(k);
    if (synth == null) {
        synth = seriesSynthCounter++;
        seriesSynthByKey.set(k, synth);
    }
    const run = S.runs.find(r => r.sessionId === sessionId);
    seriesMeta().set(synth, {
        sessionId, name,
        color: run ? run.color : '#94e2d5',
        label: run ? run.filename : sessionId,
    });
    return synth;
}

export function isSeriesSynth(key) {
    const n = typeof key === 'number' ? key : Number(key);
    return Number.isFinite(n) && n >= SERIES_SYNTH_BASE;
}

export function plotHasSynth(plot) {
    return plot.signals.some(isSeriesSynth);
}

// Descripteur unifie d'une cle de serie: index reel du fichier actif, ou cle synthetique
// d'overlay. Fournit nom, couleur, session, index reel dans la session et libelle de run.
export function seriesDescriptor(key) {
    if (isSeriesSynth(key)) {
        const m = seriesMeta().get(Number(key));
        if (m) {
            const run = S.runs.find(r => r.sessionId === m.sessionId);
            const realIndex = run && run.nameToIndex ? run.nameToIndex.get(m.name) : undefined;
            return {
                synthetic: true, sessionId: m.sessionId, name: m.name,
                realIndex, color: m.color, runLabel: m.label,
            };
        }
    }
    const sig = S.signalsInfo[key];
    return {
        synthetic: false, sessionId: ectx.currentLazySessionId || null,
        name: sig ? sig.name : String(key),
        realIndex: typeof key === 'number' ? key : Number(key),
        color: sig ? sig.color : '#ffffff', runLabel: null,
    };
}

// Ajoute un signal (par nom) en overlay: une serie par run du roster qui le contient,
// coloree par fichier. Le trace reste exact (pas d'interpolation): chaque serie garde
// ses vrais echantillons, fusionnes en union-X au rendu.
export function addOverlaySeries(plot, name) {
    if (!plot.signalStyles) plot.signalStyles = {};
    let added = false;
    S.runs.forEach(run => {
        if (!run.compared) return;
        if (!run.nameToIndex || !run.nameToIndex.has(name)) return;
        const synth = seriesSynthFor(run.sessionId, name);
        if (plot.signals.includes(synth)) return;
        plot.signals.push(synth);
        plot.signalStyles[synth] = { color: run.color, width: 1.5, dash: '' };
        added = true;
    });
    if (!added) return;
    updatePlotHeader(plot);
    fetchAndRenderPlot(plot);
    updateSignalActiveStates();
    setTimeout(resizePlotCharts, 100);
}

// Fetch /view groupe par session: chaque run interroge sa propre session avec ses index
// reels, puis on remappe l'index de reponse vers la cle de serie (synthetique) du plot.
export async function fetchViewGrouped(plot, maxPts) {
    const groups = new Map();
    for (const key of plot.signals) {
        const d = seriesDescriptor(key);
        if (d.realIndex == null) continue;
        const sid = d.sessionId || '';
        if (!groups.has(sid)) groups.set(sid, []);
        groups.get(sid).push({ key, realIndex: d.realIndex });
    }

    const token = sessionStorage.getItem('auth_token');
    const merged = [];
    for (const [sid, items] of groups) {
        const realIdx = items.map(it => it.realIndex);
        // Fenetre brute decalee par l'offset du run (affichage a t+offset).
        const run = sid ? S.runs.find(r => r.sessionId === sid) : null;
        const off = effectiveRunOffset(run);
        const start = ectx.globalView.min - off;
        const end = ectx.globalView.max - off;
        let url = `${API}/view?signals=${realIdx.join(',')}&start=${start}`
            + `&end=${end}&max_points=${maxPts}`;
        const headers = {};
        if (sid) {
            url += `&session_id=${encodeURIComponent(sid)}&format=bin`;
            if (token) headers['Authorization'] = 'Bearer ' + token;
        }
        try {
            const data = await fetchViewData(url, headers);
            if (data && data.signals) {
                const byReal = new Map(items.map(it => [it.realIndex, it.key]));
                data.signals.forEach(s => { if (byReal.has(s.index)) s.index = byReal.get(s.index); });
                merged.push(...data.signals);
            }
        } catch (e) {
            console.error('Overlay view fetch error:', e);
        }
    }
    return { signals: merged };
}

// Rendu overlay: axe X = union triee des timestamps de toutes les series (decalage
// d'offset par run applique ici, Δt=0 tant que l'offset n'est pas branche), Y aligne
// avec trous (null) hors des echantillons reels de chaque serie. spanGaps relie les
// vrais points de chaque serie a travers les positions des autres runs.
export function renderOverlayChart(plot, data) {
    const sigs = (data.signals || []).filter(s => s.timestamps && s.timestamps.length);
    if (!sigs.length) return;

    const shiftFor = (sig) => {
        if (sig.preShifted) return 0;
        const d = seriesDescriptor(sig.index);
        if (!d.sessionId) return 0;
        const run = S.runs.find(r => r.sessionId === d.sessionId);
        return effectiveRunOffset(run);
    };

    const tsSet = new Set();
    sigs.forEach(s => {
        const d = shiftFor(s);
        const t = s.timestamps;
        for (let i = 0; i < t.length; i++) tsSet.add(t[i] + d);
    });
    const x = Float64Array.from(tsSet);
    x.sort();
    const pos = new Map();
    for (let i = 0; i < x.length; i++) pos.set(x[i], i);

    const uplotData = [Array.from(x)];
    const series = [{}];
    sigs.forEach(sig => {
        const d = shiftFor(sig);
        const y = new Array(x.length).fill(null);
        const t = sig.timestamps;
        const v = sig.values;
        for (let i = 0; i < t.length; i++) {
            const p = pos.get(t[i] + d);
            if (p !== undefined) y[p] = v[i];
        }
        const style = resolveSignalStyle(plot, sig.index, sig.color);
        const desc = seriesDescriptor(sig.index);
        const label = desc.runLabel ? `${sig.name} · ${desc.runLabel}` : sig.name;
        const sc = buildSeriesConfig(label, sig.unit, style);
        sc.spanGaps = true;
        uplotData.push(y);
        series.push(sc);
    });

    commitPlotRender(plot, series, uplotData, null);
    autoEnableExtendedZones(plot);
}

// Rendu overlay depuis le cache (zoom/rejeu sans reseau): reconstruit la reponse a
// partir des echantillons reels mis en cache par serie, bornes a la vue, puis union-X.
export function renderOverlayFromCache(plot) {
    const sigs = [];
    const maxPts = targetPointsForPlot(plot);
    for (const key of plot.signals) {
        const cached = plot.cachedData[key];
        if (!cached || !cached.timestamps || !cached.timestamps.length) continue;
        // Fenetre brute decalee: la serie est affichee a t+offset, donc on borne ses
        // echantillons bruts a [vue.min - offset, vue.max - offset].
        let off = 0;
        if (isSeriesSynth(key)) {
            const d = seriesDescriptor(key);
            const run = d.sessionId ? S.runs.find(r => r.sessionId === d.sessionId) : null;
            off = effectiveRunOffset(run);
        }
        const f = windowedView(cached, ectx.globalView.min - off, ectx.globalView.max - off, maxPts);
        if (!f.timestamps.length) continue;
        sigs.push({
            index: key, name: cached.name, unit: cached.unit, color: cached.color,
            timestamps: f.timestamps, values: f.values, _offset: off,
            _order: isSeriesSynth(key)
                ? S.runs.findIndex(r => r.sessionId === seriesDescriptor(key).sessionId)
                : 0,
        });
    }
    if (!sigs.length) return;

    // Mode sequentiel: une seule serie continue par nom de signal - les fenetres de
    // chaque run, deja bornees a leur portion de chaine, sont decalees puis concatenees
    // dans l'ordre des runs (timestamps globalement croissants par construction).
    if (S.runsMode === 'sequential') {
        const byName = new Map();
        for (const sig of sigs) {
            if (!byName.has(sig.name)) byName.set(sig.name, []);
            byName.get(sig.name).push(sig);
        }
        const merged = [];
        for (const [name, parts] of byName) {
            parts.sort((a, b) => a._order - b._order);
            const total = parts.reduce((acc, p) => acc + p.timestamps.length, 0);
            const ts = new Float64Array(total);
            const vs = new Float32Array(total);
            let at = 0;
            for (const part of parts) {
                for (let i = 0; i < part.timestamps.length; i++) {
                    ts[at] = part.timestamps[i] + part._offset;
                    vs[at] = part.values[i];
                    at++;
                }
            }
            merged.push({
                index: parts[0].index, name, unit: parts[0].unit,
                color: themedSignalColor(parts[0].color),
                timestamps: ts, values: vs, preShifted: true,
            });
        }
        renderOverlayChart(plot, { signals: merged });
        return;
    }
    renderOverlayChart(plot, { signals: sigs });
}

// Full-send overlay differe: recupere la pleine resolution de chaque serie via /raw,
// groupee par run, remappee vers les cles synthetiques. Une fois en cache (complet),
// les changements de vue se rejouent localement sans rappeler /view.
export function scheduleFullDataOverlay(plot) {
    const run = () => ensureFullDataOverlay(plot);
    if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(run, { timeout: 1500 });
    } else {
        setTimeout(run, 200);
    }
}

async function ensureFullDataOverlay(plot) {
    if (!plot || !plotHasSynth(plot)) return;
    const need = plot.signals.filter(k => {
        const c = plot.cachedData[k];
        const complete = c && c.isComplete && c.fullTimeRange;
        return !complete && !fullDataInFlight.has(k);
    });
    if (need.length === 0) return;

    need.forEach(k => fullDataInFlight.add(k));
    try {
        const groups = new Map();
        for (const k of need) {
            const d = seriesDescriptor(k);
            if (!d.sessionId || d.realIndex == null) continue;
            if (!groups.has(d.sessionId)) groups.set(d.sessionId, []);
            groups.get(d.sessionId).push({ key: k, realIndex: d.realIndex });
        }

        const merged = [];
        for (const [sid, items] of groups) {
            const raw = await fetchRawSignals(items.map(it => it.realIndex), sid);
            if (raw && raw.signals) {
                const byReal = new Map(items.map(it => [it.realIndex, it.key]));
                raw.signals.forEach(s => { if (byReal.has(s.index)) s.index = byReal.get(s.index); });
                merged.push(...raw.signals);
            }
        }

        if (merged.length) {
            cacheServerSignals(plot, { signals: merged });
            // Full-send differe: l'onglet a pu changer pendant l'attente reseau.
            if (plotIsVisible(plot) && canRenderFromCache(plot, ectx.globalView.min, ectx.globalView.max)) {
                renderOverlayFromCache(plot);
            }
        }
    } catch (e) {
        console.error('Overlay full data error:', e);
    } finally {
        need.forEach(k => fullDataInFlight.delete(k));
    }
}

