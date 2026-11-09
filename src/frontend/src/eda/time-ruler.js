// Baltimore Bird - Regle de temps de l'onglet: axe X unique, fixe en haut des graphes
//
// Les graphes n'affichent que leur grille verticale. Graduation, temps des curseurs et
// delta sont portes une seule fois par cette regle, collee en haut de la zone des graphes
// (position sticky) pour rester visible quand ils defilent, et qui sert aussi au
// deplacement de la fenetre par glisser.
//
// La regle est une instance uPlot sans serie. Sa piste est alignee sur la zone de trace
// des graphes (meme abscisse, meme largeur) et suit leur echelle X: meme largeur, meme
// echelle et meme espacement (time-axis.js) donnent les memes graduations, donc des
// graduations sur les lignes de grille. Elle se cale sur chaque dessin des graphes
// (rulerSyncPlugin) plutot que sur les ecritures de globalView, trop nombreuses, ce qui
// couvre aussi le pan leger (setScale seul) et les vues desynchronisees entre onglets.

import { S } from '../core/state.js';
import { ectx } from './context.js';
import { cursorTimeDecimals, placeCursorAt, removeCursor, touchCursor, updateCursors } from './cursors.js';
import { themeChartColors } from './plot-ui.js';
import { resizeAllChartsNow } from './plots.js';
import { formatDurationWithMinutes, timeAxisSpace, timeAxisValues } from './time-axis.js';
import { applyGlobalViewLocal, panPlotsScaleOnly, recordViewChange } from './view-nav.js';

// Hauteur de l'axe (instance uPlot), en bas de la regle.
const RULER_AXIS_HEIGHT = 30;
// Zone de trace minimale de l'instance uPlot, sous l'axe: l'axe occupe le reste.
const RULER_PLOT_HEIGHT = 2;
// Marge du canvas de part et d'autre de la piste: les etiquettes des graduations
// extremes, centrees sur leur trait, y debordent sans etre coupees. La zone de trace
// (donc l'echelle et les graduations) garde exactement la largeur de la piste.
const RULER_SIDE_PAD = 28;
// Ecart minimal (px) entre deux pastilles, et largeur estimee d'un caractere de pastille
// (police a chasse fixe 12px) plus son padding, repli quand le layout n'est pas mesurable.
const PILL_GAP = 6;
const PILL_CHAR_PX = 7.3;
const PILL_PAD_PX = 14;
// Marge (px) entre une pastille et le bord interieur de la regle.
const EDGE_MARGIN = 2;

const CURSOR_KEYS = [
    { which: 1, cls: 'ruler-cursor-a', get: () => S.cursor1 },
    { which: 2, cls: 'ruler-cursor-b', get: () => S.cursor2 },
];

// Monte la regle en tete de la zone des graphes d'un onglet.
export function mountTimeRuler(wrapper) {
    if (!wrapper || wrapper.querySelector(':scope > .time-ruler')) return;
    const el = document.createElement('div');
    el.className = 'time-ruler';
    el.setAttribute('aria-hidden', 'true');

    const track = document.createElement('div');
    track.className = 'time-ruler-track';
    const chartDiv = document.createElement('div');
    chartDiv.className = 'time-ruler-chart';
    track.appendChild(chartDiv);

    const delta = document.createElement('div');
    delta.className = 'ruler-delta';
    const deltaLine = document.createElement('div');
    deltaLine.className = 'ruler-delta-line';
    const deltaPill = document.createElement('div');
    deltaPill.className = 'ruler-delta-pill';
    track.append(delta, deltaLine, deltaPill);

    const ruler = {
        el, track, chartDiv, chart: null, left: null, width: 0, min: null, max: null,
        delta, deltaLine, deltaPill, cursors: [], hasLane: false,
    };
    CURSOR_KEYS.forEach(key => {
        const cursorEl = document.createElement('div');
        cursorEl.className = `ruler-cursor ${key.cls}`;
        const pill = document.createElement('div');
        pill.className = 'ruler-cursor-pill';
        cursorEl.appendChild(pill);
        track.appendChild(cursorEl);
        ruler.cursors.push({ ...key, el: cursorEl, pill });
        wireCursorDrag(ruler, key.which, pill);
    });

    el.appendChild(track);
    el._ruler = ruler;
    wrapper.prepend(el);
    track.addEventListener('mousedown', e => onTrackMouseDown(ruler, e));
}

// Detruit l'instance uPlot de la regle d'un onglet dont le contenu va etre retire ou
// remplace, comme les graphes eux-memes.
export function destroyTimeRuler(wrapper) {
    const el = wrapper && wrapper.querySelector(':scope > .time-ruler');
    if (!el) return;
    if (el._ruler.chart) el._ruler.chart.destroy();
    el.remove();
}

// Regle d'un graphe, retrouvee par le DOM: le premier dessin peut tomber pendant la
// construction d'un graphe, avant que plot.chart soit assigne.
function rulerOf(u) {
    const wrapper = u.root && u.root.closest('.plots-wrapper');
    const el = wrapper && wrapper.querySelector(':scope > .time-ruler');
    return el ? el._ruler : null;
}

function activeRuler() {
    const wrapper = document.getElementById(`plotsWrapper-${S.activeTabId}`);
    const el = wrapper && wrapper.querySelector(':scope > .time-ruler');
    return el ? el._ruler : null;
}

// Plugin des graphes: a chaque dessin d'un graphe, la regle reprend son echelle X et se
// realigne sur sa zone de trace. La geometrie est toujours mesuree, jamais deduite d'un
// cache propre au graphe: la regle est partagee, et un cache local laisserait passer
// une regle desalignee par ailleurs tant que ce graphe-ci ne change pas. alignTo
// n'ecrit dans le DOM que si la position ou la largeur differe.
// Un ResizeObserver sur la zone de trace couvre les changements de taille constates
// apres le dessin: il est rappele apres le layout et avant l'affichage, donc sans
// frame de retard. Un graphe masque (largeur nulle) est ignore.
export function rulerSyncPlugin() {
    let observer = null;
    const align = u => {
        const ruler = rulerOf(u);
        if (ruler) alignTo(ruler, u);
    };
    return {
        hooks: {
            init: u => {
                if (typeof ResizeObserver === 'undefined') return;
                observer = new ResizeObserver(() => align(u));
                observer.observe(u.over);
            },
            draw: u => {
                const ruler = rulerOf(u);
                if (!ruler) return;
                syncScale(ruler, u.scales.x);
                alignTo(ruler, u);
            },
            destroy: () => {
                if (observer) observer.disconnect();
                observer = null;
            },
        },
    };
}

function syncScale(ruler, scale) {
    if (!ruler || !Number.isFinite(scale.min) || !Number.isFinite(scale.max)) return;
    if (ruler.min === scale.min && ruler.max === scale.max) return;
    ruler.min = scale.min;
    ruler.max = scale.max;
    if (ruler.chart) ruler.chart.setScale('x', { min: scale.min, max: scale.max });
}

// Aligne la piste de la regle sur la zone de trace du graphe. Retourne false si le
// graphe n'est pas mesurable.
function alignTo(ruler, u) {
    if (!ruler || !u.over || !u.over.isConnected) return false;
    const over = u.over.getBoundingClientRect();
    // Graphe masque (mode graphe seul, onglet inactif): rien a quoi s'aligner.
    if (over.width < 1) return false;
    // left d'un enfant positionne: compte depuis l'interieur de la bordure de la regle.
    const left = Math.round(over.left - ruler.el.getBoundingClientRect().left - ruler.el.clientLeft);
    const width = Math.round(over.width);
    if (left !== ruler.left) {
        ruler.left = left;
        ruler.track.style.left = `${left}px`;
    }
    if (width !== ruler.width) {
        ruler.width = width;
        ruler.track.style.width = `${width}px`;
    }
    syncScale(ruler, u.scales.x);
    const chartWidth = width + 2 * RULER_SIDE_PAD;
    if (!ruler.chart) createChart(ruler, chartWidth);
    else if (ruler.chart.width !== chartWidth) ruler.chart.setSize({ width: chartWidth, height: RULER_AXIS_HEIGHT });
    ruler.el.classList.add('is-ready');
    return true;
}

function createChart(ruler, chartWidth) {
    const axisColor = () => themeChartColors().axis;
    ruler.chartDiv.style.left = `${-RULER_SIDE_PAD}px`;
    ruler.chart = new uPlot({
        width: chartWidth,
        height: RULER_AXIS_HEIGHT,
        padding: [0, RULER_SIDE_PAD, 0, RULER_SIDE_PAD],
        legend: { show: false },
        cursor: { show: false },
        series: [{}],
        scales: { x: { time: false, auto: false, range: (u, min, max) => [min, max] } },
        axes: [{
            scale: 'x',
            side: 0,
            size: RULER_AXIS_HEIGHT - RULER_PLOT_HEIGHT,
            space: timeAxisSpace,
            values: timeAxisValues,
            stroke: axisColor,
            grid: { show: false },
            ticks: { stroke: axisColor, width: 1, size: 5 },
        }],
        hooks: { draw: [() => layoutCursors(ruler)] },
    }, [[]], ruler.chartDiv);
    if (ruler.min !== null) ruler.chart.setScale('x', { min: ruler.min, max: ruler.max });
}

// =========================================================================
// Curseurs sur la regle: pastille de temps, trait vers les graphes, delta
// =========================================================================

// Repositionne les curseurs de la regle de l'onglet affiche (appele par updateCursors).
export function updateRulerCursors() {
    const ruler = activeRuler();
    if (ruler && ruler.chart) layoutCursors(ruler);
}

// Largeur rendue d'une pastille, estimee hors layout (rendu en arriere-plan, tests).
function pillWidth(el, text) {
    return el.offsetWidth || text.length * PILL_CHAR_PX + PILL_PAD_PX;
}

function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(v, hi));
}

// Ligne des curseurs, sous la graduation: elle n'existe qu'avec au moins un curseur.
// La hauteur ne change donc qu'a la pose du premier ou au retrait du dernier, jamais
// pendant un glissement; les graphes sont alors redimensionnes.
function setCursorLane(ruler, on) {
    if (ruler.hasLane === on) return;
    ruler.hasLane = on;
    ruler.el.classList.toggle('has-cursor', on);
    if (ruler.el.isConnected) requestAnimationFrame(resizeAllChartsNow);
}

function layoutCursors(ruler) {
    const u = ruler.chart;
    const decimals = cursorTimeDecimals(u);
    const shown = [];

    ruler.cursors.forEach(c => {
        const t = c.get();
        if (t === null || !Number.isFinite(t)) {
            c.el.style.display = 'none';
            return;
        }
        const x = u.valToPos(t, 'x');
        const text = `${t.toFixed(decimals)}s`;
        if (c.pill.textContent !== text) c.pill.textContent = text;
        c.el.style.display = 'block';
        c.el.style.transform = `translate3d(${x}px, 0, 0)`;
        shown.push({ el: c.pill, anchor: x, center: x, w: pillWidth(c.pill, text) });
    });
    setCursorLane(ruler, shown.length > 0);

    // Elements de la ligne, dans l'ordre: pastille de gauche, delta, pastille de droite.
    shown.sort((a, b) => a.anchor - b.anchor);
    const row = [...shown];
    if (shown.length === 2) {
        const [l, r] = shown;
        const text = `Δ ${formatDurationWithMinutes(Math.abs(S.cursor2 - S.cursor1), decimals)}`;
        const pill = ruler.deltaPill;
        if (pill.textContent !== text) pill.textContent = text;
        pill.style.display = 'block';
        row.splice(1, 0, { el: pill, anchor: 0, center: (l.anchor + r.anchor) / 2, w: pillWidth(pill, text) });
        showDeltaSpan(ruler, l.anchor, r.anchor);
    } else {
        ruler.delta.style.display = 'none';
        ruler.deltaLine.style.display = 'none';
        ruler.deltaPill.style.display = 'none';
    }

    // Bornes en coordonnees de piste: l'interieur de la regle, qui deborde de la piste
    // a gauche (gouttiere Y) et a droite (colonne des legendes).
    const minX = -ruler.left + EDGE_MARGIN;
    const maxX = ruler.el.clientWidth - ruler.left - EDGE_MARGIN;
    layoutRow(row, minX, maxX);
    // Les pastilles de curseur sont placees par rapport a leur trait, le delta dans la piste.
    row.forEach(item => { item.el.style.transform = `translateX(${item.start - item.anchor}px)`; });
}

// Disposition d'une ligne d'etiquettes ordonnees (gauche -> droite), chacune centree au
// plus pres de sa position ideale, sans chevauchement et dans [minX, maxX]. Les
// etiquettes qui se chevauchent fusionnent en un bloc, place de facon a minimiser leur
// ecart a leurs positions ideales (moyenne des departs souhaites); on repete jusqu'a ce
// qu'aucun bloc n'en touche un autre. Exportee pour les tests.
export function layoutRow(items, minX, maxX) {
    let blocks = items.map(item => ({ items: [item], width: item.w, wanted: item.center - item.w / 2 }));
    const startOf = b => clamp(b.wanted, minX, Math.max(minX, maxX - b.width));
    let merged = true;
    while (merged) {
        merged = false;
        for (let i = 0; i + 1 < blocks.length; i++) {
            const a = blocks[i];
            const b = blocks[i + 1];
            if (startOf(a) + a.width + PILL_GAP <= startOf(b)) continue;
            // Depart souhaite du bloc fusionne: moyenne des departs souhaites de chaque
            // etiquette, ramenes au debut du bloc.
            const offset = a.width + PILL_GAP;
            const wanted = (a.wanted * a.items.length + (b.wanted - offset) * b.items.length)
                / (a.items.length + b.items.length);
            blocks.splice(i, 2, { items: [...a.items, ...b.items], width: offset + b.width, wanted });
            merged = true;
            break;
        }
    }
    blocks.forEach(b => {
        let x = startOf(b);
        b.items.forEach(item => {
            item.start = x;
            x += item.w + PILL_GAP;
        });
    });
}

// Plage entre les curseurs, teintee sur toute la hauteur, et filet qui relie les deux
// traits sous le delta.
function showDeltaSpan(ruler, x1, x2) {
    ruler.delta.style.display = 'block';
    ruler.delta.style.transform = `translate3d(${x1}px, 0, 0)`;
    ruler.delta.style.width = `${x2 - x1}px`;
    ruler.deltaLine.style.display = 'block';
    ruler.deltaLine.style.transform = `translate3d(${x1}px, 0, 0)`;
    ruler.deltaLine.style.width = `${x2 - x1}px`;
}

// Glisser la pastille deplace le curseur; Ctrl+clic le retire, comme sur son trait. Son
// survol epaissit les traits du curseur dans les graphes, comme le survol d'un trait.
function wireCursorDrag(ruler, which, pill) {
    const hoverClass = `is-cursor-${which}-hovered`;
    let dragging = false;
    pill.addEventListener('mouseenter', () => document.body.classList.add(hoverClass));
    pill.addEventListener('mouseleave', () => {
        if (!dragging) document.body.classList.remove(hoverClass);
    });

    pill.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        e.stopPropagation();
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) {
            removeCursor(which);
            return;
        }
        touchCursor(which);
        const rect = ruler.track.getBoundingClientRect();
        let clientX = e.clientX;
        let raf = null;
        dragging = true;
        document.body.style.cursor = 'ew-resize';
        document.body.style.userSelect = 'none';

        const onMove = ev => {
            clientX = ev.clientX;
            if (raf !== null) return;
            raf = requestAnimationFrame(() => {
                raf = null;
                const x = Math.max(0, Math.min(clientX - rect.left, rect.width));
                const time = ruler.chart.posToVal(x, 'x');
                if (which === 1) S.cursor1 = time;
                else S.cursor2 = time;
                updateCursors();
            });
        };
        const onUp = ev => {
            if (raf !== null) cancelAnimationFrame(raf);
            dragging = false;
            if (!pill.contains(ev.target)) document.body.classList.remove(hoverClass);
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    });
}

// =========================================================================
// Deplacement de la fenetre par glisser sur la regle; Ctrl+clic pose un curseur
// =========================================================================
function onTrackMouseDown(ruler, e) {
    if (e.button !== 0 || !ruler.chart) return;
    e.preventDefault();
    const rect = ruler.track.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) {
        placeCursorAt(ruler.chart.posToVal(e.clientX - rect.left, 'x'));
        return;
    }

    const start = { ...ectx.globalView };
    const unitsPerPx = (start.max - start.min) / rect.width;
    let moved = false;
    let raf = false;
    ruler.el.classList.add('is-panning');
    document.body.style.cursor = 'grabbing';

    const onMove = ev => {
        const shift = -(ev.clientX - e.clientX) * unitsPerPx;
        if (!moved && shift !== 0) {
            recordViewChange();
            moved = true;
        }
        ectx.globalView = { min: start.min + shift, max: start.max + shift };
        if (raf) return;
        raf = true;
        requestAnimationFrame(() => { raf = false; panPlotsScaleOnly(); });
    };
    const onUp = () => {
        ruler.el.classList.remove('is-panning');
        document.body.style.cursor = '';
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        // Fin du glissement: rendu propre (re-decimation, cadrage Y, strips) a la vue
        // finale, apres les setScale legers du glissement.
        if (moved) applyGlobalViewLocal();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
}

// =========================================================================
// Export PNG: canvas de la regle et elements de curseurs a rasteriser
// =========================================================================
export function rulerForExport(wrapper) {
    const el = wrapper && wrapper.querySelector(':scope > .time-ruler.is-ready');
    const ruler = el ? el._ruler : null;
    if (!ruler || !ruler.chart) return null;
    return { el, canvas: ruler.chart.ctx.canvas, track: ruler.track, height: ruler.track.offsetHeight };
}
