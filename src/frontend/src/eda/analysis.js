// Baltimore Bird - Popover d'analyse KDE/FFT d'un signal
// Module extrait de app.js (refactoring): voir src/eda/ARCHITECTURE.md

import { S } from '../core/state.js';
import { ectx } from './context.js';
import { sliceWindow, windowBounds } from './data-views.js';
import { themedSignalColor } from './plot-ui.js';
import { fftMagnitude, gaussianKde } from './signal-math.js';
import { effectiveCache } from './transforms.js';

// =========================================================================
// Panneau d'analyse KDE/FFT: domaine different du temps (valeur ou frequence),
// donc panneau flottant dedie plutot que le panneau temporel partage. Calcule sur
// la fenetre visible du signal effectif (transformation active incluse).
// =========================================================================
let analysisPopover = null;

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

function computeAnalysis(kind, cached) {
    const { startIdx, endIdx } = windowBounds(cached.timestamps, ectx.globalView.min, ectx.globalView.max);
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
    const strokeColor = themedSignalColor(cached.color) || '#14b8a6';
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
                { stroke: strokeColor, width: 1.5, fill: 'rgba(20, 184, 166, 0.12)' },
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
        series: [{}, { stroke: strokeColor, width: 1.5, fill: 'rgba(20, 184, 166, 0.12)' }],
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
    const result = computeAnalysis(kind, cached);
    if (!result) {
        notify(kind === 'kde'
            ? 'KDE impossible (signal constant sur la fenetre).'
            : 'FFT impossible (fenetre trop courte).', 'warning');
        return;
    }

    const pop = document.createElement('div');
    pop.className = 'analysis-popover';

    const header = document.createElement('div');
    header.className = 'analysis-popover-header';
    const title = document.createElement('span');
    title.className = 'analysis-popover-title';
    title.textContent = result.title;
    header.appendChild(title);

    const range = document.createElement('span');
    range.className = 'analysis-popover-range';
    range.textContent = `[${ectx.globalView.min.toFixed(1)} s, ${ectx.globalView.max.toFixed(1)} s]`;
    header.appendChild(range);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'analysis-popover-btn';
    closeBtn.textContent = '\u00d7';
    closeBtn.title = 'Fermer';
    closeBtn.addEventListener('click', closeAnalysisPopover);
    header.appendChild(closeBtn);
    pop.appendChild(header);

    const body = document.createElement('div');
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

    // Poignee de redimensionnement au coin haut-gauche (le panneau est ancre en bas-droite):
    // tirer vers le haut-gauche agrandit. La taille est memorisee pour les ouvertures suivantes.
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
        const onMove = (ev) => {
            analysisSize.w = Math.max(ANALYSIS_MIN_W, Math.round(startW + (startX - ev.clientX)));
            analysisSize.h = Math.max(ANALYSIS_MIN_H, Math.round(startH + (startY - ev.clientY)));
            if (pop._chart) pop._chart.setSize({ width: analysisSize.w, height: analysisSize.h });
        };
        const onUp = () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    });

    if (typeof window.bbTrack === 'function') window.bbTrack(`analysis_${kind}`);
}

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAnalysisPopover();
});

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

    const result = computeAnalysis(kind, cached);
    if (!result) return;  // fenetre inexploitable (trop courte, constante): garder l'etat precedent

    pop._chart.setData(result.data);
    pop._rangeEl.textContent = `[${ectx.globalView.min.toFixed(1)} s, ${ectx.globalView.max.toFixed(1)} s]`;
    pop._readoutEl.textContent = '—';
    if (pop._statsEl && result.statsText) pop._statsEl.textContent = result.statsText;
    pop._readout = result.readout;
}

export function notify(message, kind) {
    if (typeof window.showNotification === 'function') window.showNotification(message, kind);
}

