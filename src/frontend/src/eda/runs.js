// Baltimore Bird - Registre multi-fichiers: roster, comparaison, mode sequentiel, offsets
// Module extrait de app.js (refactoring): voir src/eda/ARCHITECTURE.md

import { S } from '../core/state.js';
import { API, ectx } from './context.js';
import { updateCursors } from './cursors.js';
import { canRenderFromCache } from './data-views.js';
import { sessionEventsCache } from './events-strip.js';
import { isSeriesSynth, plotHasSynth, renderOverlayFromCache, seriesDescriptor } from './overlay.js';
import { updatePlotHeader, updateSignalActiveStates } from './plot-legend.js';
import { removeSignalFromPlot } from './plots.js';
import { fetchAndRenderPlot } from './render.js';
import { changeSource } from './sessions.js';
import { renderSignalList, renderVirtualList } from './signal-list.js';
import { openUploadModal } from './upload.js';
import { applyGlobalViewLocal } from './view-nav.js';

// =========================================================================
// Multi-fichiers: roster des runs (tranche 1 - etat + lifecycle, mono-actif)
// =========================================================================
const GUEST_MAX_RUNS = 3;

function isGuestUser() {
    try { return !sessionStorage.getItem('auth_token'); } catch (_) { return true; }
}

// Enregistre (ou met a jour) un run uploade dans le roster de comparaison et le
// marque actif. Le premier run devient la reference temporelle.
// Palettes par fichier: Mocha (sombre) et son equivalent Latte (clair, plus contraste sur
// fond clair). L'index de palette est stable par run; la couleur est resolue selon le theme.
const RUN_COLORS = ['#94e2d5', '#fab387', '#a6e3a1', '#89b4fa', '#f5c2e7', '#f9e2af', '#cba6f7', '#eba0ac'];

const RUN_COLORS_LIGHT = ['#179299', '#fe640b', '#40a02b', '#1e66f5', '#ea76cb', '#df8e1d', '#8839ef', '#e64553'];

// Un identifiant de session sans le prefixe du <select>, pour que le mode mono et la
// comparaison designent le meme run.
function normalizeRunId(id) {
    const s = String(id || '');
    return s.startsWith('session_') ? s.slice('session_'.length) : s;
}

// Premiere teinte libre de la palette. L'ancienne attribution par hachage
// (hash % 8) donnait frequemment la MEME couleur a deux fichiers: avec 8 teintes,
// la probabilite de collision atteint ~33% des 3 fichiers et ~50% a 4 (paradoxe des
// anniversaires). L'allocation au premier emplacement libre garantit des couleurs
// distinctes tant qu'il y a moins de runs que de teintes.
function allocateRunColorIndex() {
    const used = new Set(
        (S.runs || []).map(r => r.colorIndex).filter(i => Number.isInteger(i))
    );
    for (let i = 0; i < RUN_COLORS.length; i++) {
        if (!used.has(i)) return i;
    }
    // Au-dela de 8 runs simultanes la repetition est inevitable: on reprend au debut.
    return (S.runs || []).length % RUN_COLORS.length;
}

// Repli pour un identifiant inconnu du roster (fichier pas encore enregistre):
// l'ancien hachage, qui a le merite d'etre stable sans etat.
function runColorIndexFor(id) {
    const run = (S.runs || []).find(r => r.sessionId === normalizeRunId(id));
    if (run && Number.isInteger(run.colorIndex)) return run.colorIndex;
    let hash = 0;
    const s = String(id);
    for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(hash) % RUN_COLORS.length;
}

// Resout une teinte de la palette selon le theme courant.
function runColorByIndex(index) {
    const light = document.documentElement.getAttribute('data-theme') === 'light';
    const palette = light ? RUN_COLORS_LIGHT : RUN_COLORS;
    return palette[((index % palette.length) + palette.length) % palette.length];
}

// Couleur de run resolue selon le theme. Source unique: run-list.js l'appelle aussi,
// pour que roster, pastilles et series tracees restent d'accord.
export function runColorFor(id) {
    return runColorByIndex(runColorIndexFor(id));
}

window.runColorFor = runColorFor;

// Change la couleur d'un run et repercute partout: roster, styles de series deja
// posees dans les graphes, et re-rendu.
function setRunColorIndex(sessionId, index) {
    const sid = normalizeRunId(sessionId);
    const run = (S.runs || []).find(r => r.sessionId === sid);
    if (!run || !Number.isInteger(index) || index < 0 || index >= RUN_COLORS.length) return false;

    // Echange si la teinte est deja prise: deux runs ne doivent jamais partager une
    // couleur, et l'utilisateur recupere ainsi celle qu'il vient de liberer.
    const holder = (S.runs || []).find(r => r !== run && r.colorIndex === index);
    if (holder) holder.colorIndex = run.colorIndex;
    run.colorIndex = index;

    (S.runs || []).forEach(r => { r.color = runColorFor(r.sessionId); });

    // Les series overlay portent une copie de la couleur dans signalStyles: meme
    // parcours que la re-resolution au changement de theme.
    (S.plots || []).forEach(plot => {
        (plot.signals || []).forEach(key => {
            if (typeof isSeriesSynth === 'function' && isSeriesSynth(key) && plot.signalStyles?.[key]) {
                const d = seriesDescriptor(key);
                if (d && d.sessionId) plot.signalStyles[key].color = runColorFor(d.sessionId);
            }
        });
    });

    if (typeof window.refreshRunList === 'function') window.refreshRunList();
    applyGlobalViewLocal();
    return true;
}

window.setRunColorIndex = setRunColorIndex;

// Palette resolue selon le theme + index occupes: le selecteur peut ainsi marquer
// les teintes deja prises par un autre fichier.
window.getRunPalette = () => {
    const light = document.documentElement.getAttribute('data-theme') === 'light';
    const palette = light ? RUN_COLORS_LIGHT : RUN_COLORS;
    return palette.map((hex, i) => {
        const owner = (S.runs || []).find(r => r.colorIndex === i);
        return { index: i, color: hex, takenBy: owner ? owner.filename : null };
    });
};

export function registerRun(sessionId, filename, ephemeral, signals) {
    if (!sessionId) return;
    let run = S.runs.find(r => r.sessionId === sessionId);
    if (!run) {
        // Index attribue AVANT la construction: allocateRunColorIndex inspecte les
        // runs deja enregistres pour prendre une teinte encore libre.
        const colorIndex = allocateRunColorIndex();
        run = {
            sessionId, filename: filename || sessionId, ephemeral: !!ephemeral,
            ref: S.runs.length === 0, colorIndex, color: null, compared: false,
            nameToIndex: null, signals: null, nSignals: null, duration: null, offset: 0,
        };
        run.color = runColorByIndex(colorIndex);
        S.runs.push(run);
        if (typeof window.bbTrack === 'function') window.bbTrack('file_upload');
    } else {
        if (filename) run.filename = filename;
        if (ephemeral !== undefined) run.ephemeral = !!ephemeral;
    }
    if (Array.isArray(signals)) {
        run.nameToIndex = new Map(signals.map(s => [s.name, s.index]));
        run.signals = signals;
        run.nSignals = signals.length;
    }
    S.activeRunId = sessionId;
}

// Couverture d'un nom de signal: nombre de runs du roster qui le contiennent, sur le total.
export function signalRunCoverage(name) {
    const compared = S.runs.filter(r => r.compared);
    let count = 0;
    for (const r of compared) if (r.nameToIndex && r.nameToIndex.has(name)) count++;
    return { count, total: compared.length };
}

// Entre en mode comparaison (seul point de bascule vers le roster). Amorce l'ensemble
// de comparaison avec tous les fichiers uploades; l'utilisateur elague ensuite via le
// bouton du chip. Sans effet sous deux fichiers.
function enterComparison() {
    if (S.runs.length < 2) return;
    S.runs.forEach(run => { run.compared = true; });
    S.comparing = true;
    if (typeof window.refreshRunList === 'function') window.refreshRunList();
    if (typeof renderVirtualList === 'function') renderVirtualList(true);
    updateDurationStat();
    if (typeof window.bbTrack === 'function') window.bbTrack('compare_enter');
}

// Quitte le mode comparaison: retour au selecteur mono. Les series overlay deja tracees
// restent en place (donnees valides liees a leur session); seuls les futurs drags
// reviennent au mono sur le fichier actif.
export function exitComparison() {
    S.comparing = false;
    S.runs.forEach(run => { run.compared = false; });
    if (typeof window.refreshRunList === 'function') window.refreshRunList();
    if (typeof renderVirtualList === 'function') renderVirtualList(true);
    updateDurationStat();
}

// Ouvre le modal d'upload en respectant la limite invite.
export function requestUpload() {
    if (isGuestUser() && S.runs.length >= GUEST_MAX_RUNS) {
        if (typeof showNotification === 'function') {
            showNotification(
                `Limite de ${GUEST_MAX_RUNS} fichiers uploades pour un invite. `
                + 'Connectez-vous pour en charger davantage.',
                'warning'
            );
        }
        return;
    }
    if (typeof openUploadModal === 'function') openUploadModal();
}

// Active un run du roster (le charge comme source courante via le pont select).
function activateRun(sessionId) {
    if (!sessionId || sessionId === S.activeRunId) return;
    const run = S.runs.find(r => r.sessionId === sessionId);
    const selector = document.getElementById('sourceSelector');
    if (!selector) return;

    // Pont select: garantit l'option (loadSources a pu la vider), avec marqueur ephemere.
    const val = 'session_' + sessionId;
    let opt = selector.querySelector(`option[value="${val}"]`);
    if (!opt) {
        opt = document.createElement('option');
        opt.value = val;
        selector.appendChild(opt);
    }
    opt.textContent = (run ? run.filename : sessionId) + (run && run.ephemeral ? ' (temporaire)' : '');

    // Bascule entre runs deja charges: on ne change QUE la liste de signaux (source de
    // drag) vers le fichier choisi, sans detruire les graphes ni reinitialiser la vue.
    // Cela permet d'acceder aux signaux propres a chaque fichier (couverture 1/N) tout
    // en conservant les overlays en cours.
    if (run && Array.isArray(run.signals)) {
        S.activeRunId = sessionId;
        ectx.currentLazySessionId = sessionId;
        ectx.currentSource = val;
        selector.value = val;
        S.signalsInfo = run.signals;
        window.signalsInfo = S.signalsInfo;

        const statSig = document.getElementById('statSignals');
        if (statSig && run.nSignals != null) statSig.textContent = run.nSignals;
        const statDur = document.getElementById('statDuration');
        if (statDur && run.duration != null) statDur.textContent = run.duration.toFixed(0) + 's';

        renderSignalList();
        updateSignalActiveStates();
        if (typeof window.refreshRunList === 'function') window.refreshRunList();
        return;
    }

    // Repli (signaux non encore en cache): chemin complet de chargement de source.
    selector.value = val;
    changeSource();
}

// Retire un fichier de l'ensemble de comparaison sans le desinscrire: la session serveur
// et l'option du selecteur sont conservees (le fichier reste choisissable en mono). Seules
// ses series overlay sont retirees des graphes. Sous deux fichiers compares, la comparaison
// perd son sens: on repasse en mono, le fichier restant devient reference temporelle.
function removeFromComparison(sessionId) {
    const run = S.runs.find(r => r.sessionId === sessionId);
    if (!run || !run.compared) return;
    run.compared = false;

    S.plots.slice().forEach(p => {
        const orphan = p.signals.filter(k => isSeriesSynth(k) && seriesDescriptor(k).sessionId === sessionId);
        orphan.forEach(k => removeSignalFromPlot(p.id, k));
    });

    if (run.ref) {
        run.ref = false;
        const nextRef = S.runs.find(r => r.compared);
        if (nextRef) nextRef.ref = true;
    }

    if (S.runs.filter(r => r.compared).length < 2) {
        exitComparison();
        return;
    }
    if (typeof window.refreshRunList === 'function') window.refreshRunList();
    if (typeof renderVirtualList === 'function') renderVirtualList(true);
    updateDurationStat();
}

window.requestUpload = () => requestUpload();

window.activateRun = (id) => activateRun(id);

window.enterComparison = () => enterComparison();

window.exitComparison = () => exitComparison();

window.removeFromComparison = (id) => removeFromComparison(id);

// Suppression complete d'un fichier uploade: session serveur supprimee, option du selecteur
// retiree, run retire du registre (libere un slot invite). Distinct de removeFromComparison
// qui ne fait que le sortir de l'overlay. Si c'etait le fichier actif, bascule sur un autre
// fichier uploade, sinon sur une source demo.
async function deleteRun(sessionId) {
    const idx = S.runs.findIndex(r => r.sessionId === sessionId);
    if (idx === -1) return;
    const wasRef = S.runs[idx].ref;
    const wasActive = S.activeRunId === sessionId || ectx.currentLazySessionId === sessionId;

    try {
        const token = sessionStorage.getItem('auth_token');
        const opts = { method: 'DELETE' };
        if (token) opts.headers = { Authorization: 'Bearer ' + token };
        await fetch(`${API}/eda/session/${sessionId}`, opts);
    } catch (e) { /* best effort: une session ephemere expire de toute facon */ }

    // Retire les series de ce run de tous les graphes (evite des orphelines pointant vers
    // une session supprimee); les autres runs restent traces.
    S.plots.slice().forEach(p => {
        const orphan = p.signals.filter(k => isSeriesSynth(k) && seriesDescriptor(k).sessionId === sessionId);
        orphan.forEach(k => removeSignalFromPlot(p.id, k));
    });

    const selector = document.getElementById('sourceSelector');
    selector?.querySelector(`option[value="session_${sessionId}"]`)?.remove();

    S.runs.splice(idx, 1);
    sessionEventsCache.delete(sessionId);
    if (wasRef && S.runs.length) {
        (S.runs.find(r => r.compared) || S.runs[0]).ref = true;
    }
    if (S.comparing && S.runs.filter(r => r.compared).length < 2) exitComparison();

    if (wasActive) {
        // Bascule sur un autre fichier uploade si possible, sinon sur une source demo.
        const nextRun = S.runs[0];
        if (nextRun && selector) {
            selector.value = `session_${nextRun.sessionId}`;
            changeSource();
        } else if (selector) {
            const demoOpt = Array.from(selector.options)
                .find(o => o.value && !o.value.startsWith('session_') && !o.disabled);
            if (demoOpt) { selector.value = demoOpt.value; changeSource(); }
        }
    }
    if (typeof window.refreshRunList === 'function') window.refreshRunList();
}

window.deleteRun = (id) => deleteRun(id);

window.isGuestUser = () => isGuestUser();

window.getRuns = () => S.runs;

window.GUEST_MAX_RUNS = GUEST_MAX_RUNS;

// =========================================================================
// Mode multi-fichiers: 'compare' (superposition, offsets manuels) ou 'sequential'
// (fichiers mis bout a bout sur l'axe temps, offsets chaines automatiquement).
// =========================================================================
function sequentialRunOffsets() {
    const offsets = new Map();
    let chainEnd = null;
    for (const run of S.runs) {
        if (!run.compared) continue;
        const tMin = Number.isFinite(run.tMin) ? run.tMin : 0;
        const tMax = Number.isFinite(run.tMax) ? run.tMax : tMin;
        if (chainEnd === null) {
            offsets.set(run.sessionId, 0);
            chainEnd = tMax;
        } else {
            offsets.set(run.sessionId, chainEnd - tMin);
            chainEnd += tMax - tMin;
        }
    }
    return { offsets, chainEnd };
}

export function effectiveRunOffset(run) {
    if (!run) return 0;
    if (S.runsMode === 'sequential') {
        return sequentialRunOffsets().offsets.get(run.sessionId) || 0;
    }
    return run.offset || 0;
}

// Plage temporelle couvrant l'union des runs compares, decalages temporels inclus. En
// comparaison, le reset zoom et la duree totale vont du premier point de data au dernier,
// tous fichiers confondus. Retourne null hors comparaison ou si les bornes sont inconnues.
export function comparedAcquisitionRange() {
    if (!S.comparing) return null;
    const runs = S.runs.filter(r => r.compared && Number.isFinite(r.tMin) && Number.isFinite(r.tMax));
    if (runs.length < 2) return null;
    let min = Infinity;
    let max = -Infinity;
    for (const run of runs) {
        const off = effectiveRunOffset(run);
        min = Math.min(min, run.tMin + off);
        max = Math.max(max, run.tMax + off);
    }
    return (Number.isFinite(min) && Number.isFinite(max) && max > min) ? { min, max } : null;
}

// Met a jour le stat de duree: union des runs compares (decalages inclus) en comparaison,
// sinon duree du fichier actif.
function updateDurationStat() {
    const el = document.getElementById('statDuration');
    if (!el) return;
    const range = comparedAcquisitionRange();
    if (range) {
        el.textContent = (range.max - range.min).toFixed(0) + 's';
        return;
    }
    const run = S.runs.find(r => r.sessionId === ectx.currentLazySessionId);
    if (run && run.duration != null) el.textContent = run.duration.toFixed(0) + 's';
}

function setRunsMode(mode) {
    if (S.runsMode === mode) return;
    S.runsMode = mode;

    const first = S.runs.find(r => r.compared);
    if (mode === 'sequential' && first) {
        const start = Number.isFinite(first.tMin) ? first.tMin : 0;
        const { chainEnd } = sequentialRunOffsets();
        ectx.globalView = { min: start, max: chainEnd !== null ? chainEnd : start + 1 };
    }
    applyGlobalViewLocal();
    S.plots.forEach(p => { if (plotHasSynth(p)) updatePlotHeader(p); });
    updateCursors();
    if (typeof window.refreshRunList === 'function') window.refreshRunList();
    if (typeof window.bbTrack === 'function') window.bbTrack('runs_mode');
}

window.setRunsMode = (mode) => setRunsMode(mode);

window.getRunsMode = () => S.runsMode || 'compare';

// Decalage temporel par run (offset manuel). Applique au rendu via shiftFor; re-rend
// les graphes overlay contenant ce run. Le run de reference reste a 0.
export function setRunOffset(sessionId, dt) {
    const run = S.runs.find(r => r.sessionId === sessionId);
    if (!run || run.ref) return;
    run.offset = Number.isFinite(dt) ? dt : 0;
    S.plots.forEach(p => {
        if (!plotHasSynth(p)) return;
        const concerns = p.signals.some(k => isSeriesSynth(k) && seriesDescriptor(k).sessionId === sessionId);
        if (!concerns) return;
        if (canRenderFromCache(p, ectx.globalView.min, ectx.globalView.max)) renderOverlayFromCache(p);
        else fetchAndRenderPlot(p);
    });
    updateDurationStat();
}

window.setRunOffset = (sid, dt) => setRunOffset(sid, dt);

window.getRunOffset = (sid) => {
    const r = S.runs.find(x => x.sessionId === sid);
    return r ? (r.offset || 0) : 0;
};

window.isRefRun = (sid) => {
    const r = S.runs.find(x => x.sessionId === sid);
    return !!(r && r.ref);
};

