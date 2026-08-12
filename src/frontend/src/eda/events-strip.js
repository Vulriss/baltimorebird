// Baltimore Bird - Bandeau des commentaires/events INCA (Ctrl+K)
// Module extrait de app.js (refactoring): voir src/eda/ARCHITECTURE.md

import { S } from '../core/state.js';
import { API, ectx } from './context.js';
import { cursorPlugin } from './cursors.js';
import { PLOT_PAD_BOTTOM, PLOT_PAD_RIGHT, PLOT_PAD_TOP, Y_AXIS_SIZE, axisDragPlugin, isLastPlot, themeChartColors, xAxisConfig, zoomToSelection } from './plot-ui.js';

// =========================================================================
// Strip commentaires (events Ctrl+K INCA)
// =========================================================================

// Points d'events par session (une seule requete /eda/events par fichier). Survit a la
// destruction des plots (changement de fichier) et se rejoue sans reseau.
export const sessionEventsCache = new Map();

async function fetchSessionEvents(sessionId) {
    if (!sessionId) return [];
    if (sessionEventsCache.has(sessionId)) return sessionEventsCache.get(sessionId);
    let events = [];
    try {
        const headers = {};
        const token = sessionStorage.getItem('auth_token');
        if (token) headers['Authorization'] = 'Bearer ' + token;
        const res = await fetch(`${API}/eda/events?session_id=${encodeURIComponent(sessionId)}`, { headers });
        if (res.ok) {
            const body = await res.json();
            if (Array.isArray(body.events)) events = body.events;
        }
    } catch (e) {
        events = [];
    }
    sessionEventsCache.set(sessionId, events);
    return events;
}

export function setCommentPlotSignal(plot, signalIndex) {
    plot.signals = [signalIndex];
    renderCommentPlot(plot);
}

function commentAccentColor() {
    const cs = getComputedStyle(document.documentElement);
    return (cs.getPropertyValue('--ctp-teal') || '#94e2d5').trim();
}

// Legende minimale du strip: nom du signal et nombre d'events (pas de valeur a afficher).
function renderCommentLegend(plot) {
    const legend = plot.element.querySelector('.plot-legend');
    if (!legend) return;
    const count = (plot.eventsData || []).length;
    const name = S.signalsInfo[plot.signals[0]]?.name || 'EventComment';
    legend.replaceChildren();
    const row = document.createElement('div');
    row.className = 'legend-row comment-legend-row';
    const dot = document.createElement('span');
    dot.className = 'legend-dot';
    dot.style.background = commentAccentColor();
    const label = document.createElement('span');
    label.className = 'legend-name';
    label.textContent = `${name} (${count})`;
    row.appendChild(dot);
    row.appendChild(label);
    legend.appendChild(row);
}

// Tooltip au survol: retrouve l'event le plus proche du curseur (en pixels) et affiche
// son commentaire. Aucun rendu de valeur, l'event n'en porte pas.
function commentTooltipPlugin(plot) {
    let tip;
    const HIT_PX = 10;
    return {
        hooks: {
            init: [(u) => {
                tip = document.createElement('div');
                tip.className = 'comment-tooltip';
                tip.style.display = 'none';
                u.over.appendChild(tip);
            }],
            setCursor: [(u) => {
                const events = plot.eventsData || [];
                const left = u.cursor.left;
                if (!tip) return;
                if (!events.length || left == null || left < 0) { tip.style.display = 'none'; return; }
                let best = -1;
                let bestDx = Infinity;
                for (let i = 0; i < events.length; i++) {
                    const px = u.valToPos(events[i].t, 'x');
                    const dx = Math.abs(px - left);
                    if (dx < bestDx) { bestDx = dx; best = i; }
                }
                if (best === -1 || bestDx > HIT_PX) { tip.style.display = 'none'; return; }
                const ev = events[best];
                tip.replaceChildren();
                const text = document.createElement('div');
                text.className = 'comment-tooltip-text';
                text.textContent = ev.text;
                tip.appendChild(text);
                if (ev.date || ev.time) {
                    const meta = document.createElement('div');
                    meta.className = 'comment-tooltip-meta';
                    meta.textContent = [ev.date, ev.time].filter(Boolean).join(' ');
                    tip.appendChild(meta);
                }
                const px = u.valToPos(ev.t, 'x');
                tip.style.left = `${px}px`;
                tip.style.display = 'block';
                // Bascule le tooltip du cote oppose s'il deborde du bord droit.
                const over = u.over.clientWidth || 0;
                tip.style.transform = (px + tip.offsetWidth + 12 > over)
                    ? 'translate(-100%, 0)' : 'translate(0, 0)';
            }],
        },
    };
}

function buildCommentPlotOptions(plot, series, width, height, showTimeAxis) {
    return {
        width,
        height,
        legend: { show: false },
        series,
        padding: [PLOT_PAD_TOP, PLOT_PAD_RIGHT, showTimeAxis ? null : PLOT_PAD_BOTTOM, null],
        scales: {
            x: { time: false, range: [ectx.globalView.min, ectx.globalView.max] },
            y: { range: [0, 2] },
        },
        axes: [
            xAxisConfig(showTimeAxis),
            {
                // Gouttiere Y vide (largeur alignee sur les autres panneaux), sans etiquette.
                stroke: () => themeChartColors().axis,
                grid: { show: false },
                ticks: { show: false },
                size: Y_AXIS_SIZE,
                splits: () => [1],
                values: () => [''],
            },
        ],
        cursor: { drag: { x: true, y: false, dist: 8 }, points: { show: false } },
        hooks: { setSelect: [zoomToSelection] },
        plugins: [cursorPlugin(), axisDragPlugin(), commentTooltipPlugin(plot)],
    };
}

// Rendu du strip commentaires: points seuls (aucune ligne) aux instants des events, sur
// une base unique. L'axe X reste cale sur globalView (zoom synchronise avec les autres
// panneaux); les events sont charges une fois puis rejoues au zoom sans reseau.
export async function renderCommentPlot(plot) {
    const chartDiv = plot.element.querySelector('.chart');
    const bodyDiv = plot.element.querySelector('.plot-body');
    if (!chartDiv || !bodyDiv) return;

    const events = await fetchSessionEvents(ectx.currentLazySessionId);
    plot.eventsData = events;
    renderCommentLegend(plot);

    if (plot.chart) plot.chart.destroy();

    const color = commentAccentColor();
    const xs = events.map(e => e.t);
    const ys = events.map(() => 1);
    const series = [
        {},
        {
            stroke: color,
            fill: color,
            paths: () => null,
            points: { show: true, size: 7, fill: color, stroke: color },
        },
    ];

    const width = bodyDiv.clientWidth || 800;
    const height = bodyDiv.clientHeight || 120;

    plot.chart = new uPlot(
        buildCommentPlotOptions(plot, series, width, height, isLastPlot(plot)),
        [xs, ys], chartDiv
    );
}

