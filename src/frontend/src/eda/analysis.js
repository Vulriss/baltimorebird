// Baltimore Bird - Popover d'analyse KDE/FFT d'un signal
// Module extrait de app.js (refactoring): voir src/eda/ARCHITECTURE.md

import { S } from '../core/state.js';
import { ectx } from './context.js';
import { sliceWindow, windowBounds } from './data-views.js';
import { resolveSignalStyle } from './plot-ui.js';
import { colorWithOpacity } from './plots.js';
import { fftMagnitude, gaussianKde } from './signal-math.js';
import { effectiveCache } from './transforms.js';

// =========================================================================
// Panneau d'analyse KDE/FFT: domaine different du temps (valeur ou frequence),
// donc panneau flottant dedie plutot que le panneau temporel partage. Calcule sur le
// signal effectif (transformation active incluse), sur la plage choisie dans l'en-tete.
// =========================================================================
let analysisPopover = null;

// Plage analysee: tout le signal, la fenetre visible, ou l'intervalle entre les deux
// curseurs. Le choix est garde d'une ouverture a l'autre.
const ANALYSIS_SCOPES = [
    { id: 'full', label: 'Tout', title: 'Analyser tout le signal' },
    { id: 'visible', label: 'Visible', title: 'Analyser la fenêtre visible' },
    { id: 'cursors', label: 'Curseurs', title: 'Analyser l\'intervalle entre les deux curseurs' },
];
let analysisScope = 'visible';
// Delai sans mouvement apres lequel un redimensionnement en cours est applique au graphe.
const RESIZE_SETTLE_MS = 140;

function bothCursors() {
    return S.cursor1 !== null && S.cursor2 !== null;
}

// Plage de temps [min, max] d'une portee. Sans deux curseurs, la portee "curseurs"
// retombe sur la fenetre visible. Exportee pour les tests.
export function analysisRange(scope, timestamps) {
    if (scope === 'full' && timestamps.length) {
        return { min: timestamps[0], max: timestamps[timestamps.length - 1] };
    }
    if (scope === 'cursors' && bothCursors()) {
        return { min: Math.min(S.cursor1, S.cursor2), max: Math.max(S.cursor1, S.cursor2) };
    }
    return { min: ectx.globalView.min, max: ectx.globalView.max };
}

// Couleur du signal telle qu'elle est tracee (style choisi ou case de palette).
function signalColor(plot, sigIdx, cached) {
    return resolveSignalStyle(plot, sigIdx, cached.color).color || '#14b8a6';
}

// Taille du panneau d'analyse, persistee entre ouvertures et ajustable (poignee haut-gauche).
const analysisSize = { w: 560, h: 280 };

const ANALYSIS_MIN_W = 320;

const ANALYSIS_MIN_H = 180;

function closeAnalysisPopover() {
    if (!analysisPopover) return;
    if (analysisPopover._chart) analysisPopover._chart.destroy();
    analysisPopover.remove();
    analysisPopover = null;
}

function computeAnalysis(kind, cached, range) {
    const { startIdx, endIdx } = windowBounds(cached.timestamps, range.min, range.max);
    const ts = sliceWindow(cached.timestamps, startIdx, endIdx);
    const vs = sliceWindow(cached.values, startIdx, endIdx);

    // Axes denses: police 10px et bandeaux de libelle reduits (uPlot reserve 30px de
    // labelSize par defaut des qu'un axe est libelle - l'essentiel de l'espace perdu).
    const axisStyle = {
        stroke: '#7f849c',
        grid: { stroke: 'rgba(127, 132, 156, 0.15)' },
        font: '10px Inter, sans-serif',
        labelFont: '10px Inter, sans-serif',
        labelSize: 12,
    };
    // Trait et aire a la couleur du signal, lue au dessin: elle suit un changement de style
    // ou de theme sans reconstruire le graphe.
    const strokeColor = () => (analysisPopover ? analysisPopover._color : '#14b8a6');
    const fillColor = () => colorWithOpacity(strokeColor(), 0.14);
    const fmt = (v) => v.toFixed(Math.abs(v) >= 100 ? 1 : 2);

    if (kind === 'kde') {
        const kde = gaussianKde(vs);
        if (!kde) return null;
        const { stats } = kde;
        const unit = cached.unit || '';
        return {
            title: `KDE - ${cached.name}`,
            data: [Array.from(kde.x), Array.from(kde.density), Array.from(kde.cdf)],
            series: [
                {},
                { stroke: strokeColor, width: 1.5, fill: fillColor },
                // Densite cumulee sur echelle secondaire: tout percentile se lit
                // directement au curseur ou sur l'axe de droite.
                { stroke: '#7f849c', width: 1, dash: [4, 3], scale: 'p' },
            ],
            scales: { x: { time: false }, p: { range: [0, 1] } },
            axes: [
                { ...axisStyle, label: unit ? `valeur (${unit})` : 'valeur', size: 26 },
                { ...axisStyle, label: 'densite', size: 34 },
                { ...axisStyle, label: 'cumul', size: 30, scale: 'p', side: 1, grid: { show: false } },
            ],
            readout: (u, idx) => `${fmt(u.data[0][idx])}${unit ? ' ' + unit : ''}`
                + `  ·  densite ${u.data[1][idx].toFixed(4)}`
                + `  ·  cumul ${(u.data[2][idx] * 100).toFixed(1)}%`,
            statsText: `moy ${fmt(stats.mean)}  ·  med ${fmt(stats.median)}`
                + `  ·  p5 ${fmt(stats.p5)}  ·  p95 ${fmt(stats.p95)}`
                + (unit ? ` ${unit}` : ''),
        };
    }
    const spec = fftMagnitude(ts, vs);
    if (!spec) return null;
    return {
        title: `FFT - ${cached.name}`,
        data: [Array.from(spec.freq), Array.from(spec.magnitude)],
        series: [{}, { stroke: strokeColor, width: 1.5, fill: fillColor }],
        scales: { x: { time: false } },
        axes: [
            { ...axisStyle, label: 'frequence (Hz)', size: 26 },
            { ...axisStyle, label: cached.unit ? `amplitude (${cached.unit})` : 'amplitude', size: 34 },
        ],
        readout: (u, idx) => `${u.data[0][idx].toFixed(2)} Hz  ·  ${fmt(u.data[1][idx])}`
            + (cached.unit ? ` ${cached.unit}` : ''),
    };
}

export function openAnalysisPopover(plotId, sigIdx, kind) {
    closeAnalysisPopover();
    const plot = S.plots.find(p => p.id === plotId);
    const cached = plot ? effectiveCache(plot, sigIdx) : null;
    if (!cached || !cached.timestamps || !cached.timestamps.length) {
        notify('Aucune donnee en cache pour ce signal.', 'warning');
        return;
    }
    if (analysisScope === 'cursors' && !bothCursors()) analysisScope = 'visible';
    const result = computeAnalysis(kind, cached, analysisRange(analysisScope, cached.timestamps));
    if (!result) {
        notify(kind === 'kde'
            ? 'KDE impossible (signal constant sur la plage).'
            : 'FFT impossible (plage trop courte).', 'warning');
        return;
    }

    const pop = document.createElement('div');
    pop.className = 'analysis-popover';
    pop._color = signalColor(plot, sigIdx, cached);

    const header = document.createElement('div');
    header.className = 'analysis-popover-header';
    const title = document.createElement('span');
    title.className = 'analysis-popover-title';
    title.textContent = result.title;
    header.appendChild(title);

    const range = document.createElement('span');
    range.className = 'analysis-popover-range';
    header.appendChild(range);

    // Portee de l'analyse: tout le signal, la fenetre visible ou l'intervalle des curseurs.
    const scopes = document.createElement('div');
    scopes.className = 'analysis-popover-scopes';
    scopes.setAttribute('role', 'group');
    scopes.setAttribute('aria-label', 'Plage analysée');
    ANALYSIS_SCOPES.forEach(scope => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'analysis-popover-scope';
        btn.dataset.scope = scope.id;
        btn.textContent = scope.label;
        btn.title = scope.title;
        btn.addEventListener('click', () => {
            if (analysisScope === scope.id) return;
            analysisScope = scope.id;
            refreshAnalysisPopover();
        });
        scopes.appendChild(btn);
    });
    header.appendChild(scopes);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'analysis-popover-btn';
    closeBtn.textContent = '\u00d7';
    closeBtn.title = 'Fermer';
    closeBtn.addEventListener('click', closeAnalysisPopover);
    header.appendChild(closeBtn);
    pop.appendChild(header);

    const body = document.createElement('div');
    body.className = 'analysis-popover-body';
    body.style.width = `${analysisSize.w}px`;
    body.style.height = `${analysisSize.h}px`;
    pop.appendChild(body);

    const readoutLine = document.createElement('div');
    readoutLine.className = 'analysis-popover-readout';
    readoutLine.textContent = '—';
    pop.appendChild(readoutLine);

    if (result.statsText) {
        const statsLine = document.createElement('div');
        statsLine.className = 'analysis-popover-stats';
        statsLine.textContent = result.statsText;
        pop.appendChild(statsLine);
        pop._statsEl = statsLine;
    }

    document.body.appendChild(pop);
    analysisPopover = pop;
    pop._context = { plotId, sigIdx, kind };
    pop._rangeEl = range;
    pop._readoutEl = readoutLine;
    pop._scopesEl = scopes;

    pop._chart = new uPlot({
        width: analysisSize.w,
        height: analysisSize.h,
        legend: { show: false },
        cursor: { y: false, points: { size: 6 } },
        scales: result.scales,
        series: result.series,
        axes: result.axes,
        hooks: {
            setCursor: [(u) => {
                const idx = u.cursor.idx;
                readoutLine.textContent = idx == null ? '—' : pop._readout(u, idx);
            }],
        },
    }, result.data, body);
    pop._readout = result.readout;
    updateAnalysisHeader(pop, cached);

    // Poignee de redimensionnement au coin haut-gauche (le panneau est ancre en bas-droite):
    // tirer vers le haut-gauche agrandit. La taille est memorisee pour les ouvertures suivantes.
    // Pendant le glissement, le graphe deja dessine est seulement etire par une
    // transformation (une composition par frame); il n'est redessine a sa vraie taille que
    // lorsque le pointeur marque une pause ou au relachement. Un setSize par evenement
    // souris reallouait le canvas et redessinait plusieurs fois par frame: les saccades.
    const grip = document.createElement('div');
    grip.className = 'analysis-popover-resize';
    grip.title = 'Redimensionner';
    pop.appendChild(grip);
    grip.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const startX = e.clientX;
        const startY = e.clientY;
        const startW = analysisSize.w;
        const startH = analysisSize.h;
        const root = pop._chart.root;
        let raf = null;
        let settle = null;
        pop.classList.add('is-resizing');
        document.body.style.userSelect = 'none';

        const commit = () => {
            settle = null;
            if (!pop._chart) return;
            root.style.transform = '';
            if (pop._chart.width !== analysisSize.w || pop._chart.height !== analysisSize.h) {
                pop._chart.setSize({ width: analysisSize.w, height: analysisSize.h });
            }
        };
        const onMove = (ev) => {
            analysisSize.w = Math.max(ANALYSIS_MIN_W, Math.round(startW + (startX - ev.clientX)));
            analysisSize.h = Math.max(ANALYSIS_MIN_H, Math.round(startH + (startY - ev.clientY)));
            if (raf !== null) return;
            raf = requestAnimationFrame(() => {
                raf = null;
                if (!pop._chart) return;
                body.style.width = `${analysisSize.w}px`;
                body.style.height = `${analysisSize.h}px`;
                root.style.transform = `scale(${analysisSize.w / pop._chart.width}, ${analysisSize.h / pop._chart.height})`;
                clearTimeout(settle);
                settle = setTimeout(commit, RESIZE_SETTLE_MS);
            });
        };
        const onUp = () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            if (raf !== null) cancelAnimationFrame(raf);
            clearTimeout(settle);
            body.style.width = `${analysisSize.w}px`;
            body.style.height = `${analysisSize.h}px`;
            pop.classList.remove('is-resizing');
            document.body.style.userSelect = '';
            commit();
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    });

    if (typeof window.bbTrack === 'function') window.bbTrack(`analysis_${kind}`);
}

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAnalysisPopover();
});

// Plage affichee et etat des boutons de portee. "Curseurs" n'est disponible qu'avec deux
// curseurs poses; un cache encore partiel (serie complete pas arrivee) est signale.
function updateAnalysisHeader(pop, cached) {
    const range = analysisRange(analysisScope, cached.timestamps);
    const partial = analysisScope === 'full' && !cached.isComplete ? ' (données partielles)' : '';
    pop._rangeEl.textContent = `[${range.min.toFixed(1)} s, ${range.max.toFixed(1)} s]${partial}`;
    pop._scopesEl.querySelectorAll('.analysis-popover-scope').forEach(btn => {
        const active = btn.dataset.scope === analysisScope;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
        if (btn.dataset.scope === 'cursors') btn.disabled = !bothCursors();
    });
}

// Les curseurs ont bouge (cursors.js): la portee "curseurs" se recalcule, et son bouton
// suit la presence des deux curseurs quelle que soit la portee en cours.
export function analysisCursorsChanged() {
    const pop = analysisPopover;
    if (!pop) return;
    if (analysisScope === 'cursors') {
        // Un curseur retire: retour immediat a la fenetre visible, bouton et plage compris.
        if (!bothCursors()) {
            analysisScope = 'visible';
            refreshAnalysisPopover();
            return;
        }
        scheduleAnalysisRefresh();
        return;
    }
    const btn = pop._scopesEl.querySelector('[data-scope="cursors"]');
    if (btn && btn.disabled === bothCursors()) btn.disabled = !bothCursors();
}

// Recalcul automatique de l'analyse quand la fenetre visible change: debounce sur la
// stabilisation de la vue (la KDE coute 10-30 ms, un recalcul par frame de pan
// produirait du jank), puis mise a jour en place - donnees, plage affichee, synthese
// et formateur de lecture - sans reconstruire le popover ni perdre le curseur.
let analysisRefreshTimer = null;

export function scheduleAnalysisRefresh() {
    if (!analysisPopover) return;
    clearTimeout(analysisRefreshTimer);
    analysisRefreshTimer = setTimeout(refreshAnalysisPopover, 200);
}

function refreshAnalysisPopover() {
    const pop = analysisPopover;
    if (!pop || !pop._context || !pop._chart) return;

    const { plotId, sigIdx, kind } = pop._context;
    const plot = S.plots.find(p => p.id === plotId);
    const cached = plot && plot.signals.includes(sigIdx) ? effectiveCache(plot, sigIdx) : null;
    if (!cached || !cached.timestamps || !cached.timestamps.length) {
        closeAnalysisPopover();
        return;
    }

    pop._color = signalColor(plot, sigIdx, cached);
    const result = computeAnalysis(kind, cached, analysisRange(analysisScope, cached.timestamps));
    updateAnalysisHeader(pop, cached);
    if (!result) {
        // Plage inexploitable (trop courte, constante): l'etat precedent reste affiche.
        pop._rangeEl.textContent += ' - plage inexploitable';
        return;
    }

    pop._chart.setData(result.data);
    pop._readoutEl.textContent = '—';
    if (pop._statsEl && result.statsText) pop._statsEl.textContent = result.statsText;
    pop._readout = result.readout;
}

export function notify(message, kind) {
    if (typeof window.showNotification === 'function') window.showNotification(message, kind);
}

