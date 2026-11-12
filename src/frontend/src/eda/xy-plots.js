// Baltimore Bird - Graphes X/Y: panneaux du dock lateral, rendu, liens avec l'axe du temps
//
// Un graphe X/Y est une autre vue de la MEME fenetre temporelle que les graphes de
// l'onglet: il trace les echantillons de ectx.globalView, montre les curseurs A/B sur la
// trajectoire et renvoie le survol vers les graphes temporels. Ses panneaux vivent dans
// tab.xyPlots, pas dans S.plots: tout le code des graphes temporels (regle, legendes,
// export, splitters) suppose un axe X = temps et n'a pas a connaitre ce type de panneau.

import { S } from '../core/state.js';
import { resizePlotCharts } from './bootstrap.js';
import { presetColorForSignal, themedPresetColor } from './color-presets.js';
import { API, ectx } from './context.js';
import { cursorTimeDecimals, moveCursorTo, placeCursorAt, removeCursor, touchCursor } from './cursors.js';
import { isSeriesSynth } from './overlay.js';
import { updateSignalActiveStates } from './plot-legend.js';
import { Y_AXIS_SIZE, themeChartColors } from './plot-ui.js';
import { isBoolSignalIndex, isEventSignalIndex } from './plots.js';
import { fetchViewData, requestRawSignals } from './render.js';
import {
    decimateXY, densityGrid, fitView, formatValue, indexAtTime, indexSpan, mergeBounds, nearestPoint, resampleOnto,
    windowIndexRange, xyBounds,
} from './xy-data.js';

// Donnees factices de l'instance uPlot: elle ne sert qu'aux axes, a la grille et a la
// selection. La trajectoire est dessinee par le hook draw (X non monotone: le mode
// standard d'uPlot exige des abscisses croissantes).
const DUMMY_DATA = [[0, 1], [null, null]];
// Points traites par serie pendant un glissement (pan de la regle, gouttieres): le rendu
// complet est refait au relachement.
const FAST_POINTS = 60000;
// Largeur du dock, partagee par tous les onglets et conservee d'une session a l'autre.
const DOCK_WIDTH_KEY = 'bb_xy_dock_width';
const DOCK_MIN_WIDTH = 260;
const X_AXIS_SIZE = 30;
const AXIS_LABEL_SIZE = 20;
// Part basse du panneau qui designe l'axe X pendant un depot de signal.
const DROP_X_ZONE = 0.72;
// Opacite de la trajectoire quand la plage entre curseurs est mise en avant.
const DIMMED_ALPHA = 0.28;
// Cote d'une cellule de la carte de densite, en pixels CSS.
const DENSITY_CELL_PX = 4;
// Rampes de la carte de densite, du moins dense au plus dense. Sequentielles en clarte dans
// le sens qui se detache du fond: vers le clair en theme sombre, vers le fonce en clair.
const DENSITY_RAMPS = {
    dark: [[59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]],
    light: [[198, 219, 239], [107, 174, 214], [33, 113, 181], [8, 48, 107]],
};

const SVG = 'viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" '
    + 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
const ICONS = {
    swap: `<svg ${SVG}><path d="M7 4 3 8l4 4"/><path d="M3 8h13"/><path d="m17 12 4 4-4 4"/><path d="M21 16H8"/></svg>`,
    fit: `<svg ${SVG}><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>`,
    points: `<svg ${SVG}><circle cx="5" cy="17" r="1.4"/><circle cx="10" cy="10" r="1.4"/>`
        + '<circle cx="15" cy="14" r="1.4"/><circle cx="19" cy="6" r="1.4"/></svg>',
    density: `<svg ${SVG}><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>`
        + '<rect x="9" y="9" width="6" height="6" fill="currentColor" stroke="none"/>'
        + '<rect x="15" y="9" width="6" height="6" fill="currentColor" fill-opacity="0.45" stroke="none"/></svg>',
};

function notify(message, kind = 'warning') {
    if (typeof window.showNotification === 'function') window.showNotification(message, kind);
}

function tabOf(tabId) {
    return S.tabs.find(t => t.id === tabId) || null;
}

function xyPlotsOf(tab) {
    if (!tab) return [];
    if (!tab.xyPlots) tab.xyPlots = [];
    return tab.xyPlots;
}

// Graphes X/Y de l'onglet affiche.
export function activeXYPlots() {
    return xyPlotsOf(tabOf(S.activeTabId));
}

// Signal tracable en X/Y: une serie numerique reelle du fichier actif.
function usableSignal(idx) {
    return typeof idx === 'number' && !isSeriesSynth(idx) && !!S.signalsInfo[idx]
        && !isBoolSignalIndex(idx) && !isEventSignalIndex(idx);
}

function signalLabel(idx, name) {
    const info = idx !== null ? S.signalsInfo[idx] : null;
    const unit = info && info.unit ? ` [${info.unit}]` : '';
    return (info ? info.name : name) + unit;
}

// Signal d'etat: sa valeur est tenue entre deux echantillons, pas interpolee.
function isHeldSignal(idx) {
    const info = S.signalsInfo[idx];
    return !!info && (info.unit === 'state' || info.is_categorical === true || info.isCategorical === true);
}

// plot.signals / plot.signalStyles: meme forme que les graphes temporels, pour les
// consommateurs generiques (palette de l'onglet, etat actif de la liste, theme).
function syncSignals(plot) {
    const signals = [];
    const styles = {};
    if (plot.x && plot.x.idx !== null) signals.push(plot.x.idx);
    plot.ys.forEach(y => {
        if (y.idx === null) return;
        if (!signals.includes(y.idx)) signals.push(y.idx);
        styles[y.idx] = y.style;
    });
    plot.signals = signals;
    plot.signalStyles = styles;
}

// =========================================================================
// Dock lateral et zones de depot d'un onglet
// =========================================================================
function applyDockWidth() {
    let width = NaN;
    try { width = parseFloat(localStorage.getItem(DOCK_WIDTH_KEY)); } catch (_) { /* stockage indisponible */ }
    if (Number.isFinite(width) && width >= DOCK_MIN_WIDTH) {
        document.documentElement.style.setProperty('--xy-dock-width', `${Math.round(width)}px`);
    }
}

function syncDock(tabId) {
    const dock = document.getElementById(`xyDock-${tabId}`);
    if (!dock) return;
    const empty = xyPlotsOf(tabOf(tabId)).length === 0;
    if (dock.hidden === empty) return;
    dock.hidden = empty;
    const splitter = dock.previousElementSibling;
    if (splitter && splitter.classList.contains('xy-dock-splitter')) splitter.hidden = empty;
    // Les graphes temporels gagnent ou perdent la largeur du dock.
    resizePlotCharts();
}

function wireDockSplitter(splitter, dock) {
    splitter.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        e.preventDefault();
        const startX = e.clientX;
        const startWidth = dock.getBoundingClientRect().width;
        const maxWidth = Math.max(DOCK_MIN_WIDTH, dock.parentElement.getBoundingClientRect().width - 320);
        let width = startWidth;
        let raf = false;
        // Les panneaux X/Y sont masques pendant le glissement: chaque largeur intermediaire
        // les ferait redimensionner et redessiner, d'ou des saccades. Un seul rendu a la fin.
        dock.classList.add('is-resizing');
        splitter.classList.add('active');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';

        const onMove = ev => {
            width = Math.min(maxWidth, Math.max(DOCK_MIN_WIDTH, startWidth + (startX - ev.clientX)));
            if (raf) return;
            raf = true;
            requestAnimationFrame(() => {
                raf = false;
                document.documentElement.style.setProperty('--xy-dock-width', `${Math.round(width)}px`);
            });
        };
        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            splitter.classList.remove('active');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            try { localStorage.setItem(DOCK_WIDTH_KEY, String(Math.round(width))); } catch (_) { /* ignore */ }
            document.documentElement.style.setProperty('--xy-dock-width', `${Math.round(width)}px`);
            dock.classList.remove('is-resizing');
            activeXYPlots().forEach(fitToBody);
            resizePlotCharts();
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });
}

// Glisser abandonne (Echap, depot hors zone): aucun dragleave ne retire les marqueurs.
if (typeof document !== 'undefined') {
    document.addEventListener('dragend', () => {
        document.querySelectorAll('.xy-panel.drop-x, .xy-panel.drop-y, .xy-drop-zone.drop-target')
            .forEach(el => el.classList.remove('drop-x', 'drop-y', 'drop-target'));
    });
}

// Cale l'instance uPlot d'un panneau sur son corps et le redessine si sa taille a change.
function fitToBody(plot) {
    if (plot._dead || !plot.chart) return;
    const width = plot.body.clientWidth;
    const height = plot.body.clientHeight;
    if (width < 2 || height < 2) return;
    if (plot.chart.width !== width || plot.chart.height !== height) {
        plot.chart.setSize({ width, height });
        renderXY(plot);
    }
}

function draggedGroup() {
    if (S.draggedSignal === null || S.draggedPlotId) return [];
    return (S.draggedSignalGroup && S.draggedSignalGroup.length) ? S.draggedSignalGroup : [S.draggedSignal];
}

// Branche le dock, la zone "+ Graphe X/Y" et le survol des graphes temporels d'un onglet.
// Appele par createTab une fois le contenu de l'onglet insere.
export function mountXYDock(tabId) {
    applyDockWidth();
    const dock = document.getElementById(`xyDock-${tabId}`);
    const zone = document.getElementById(`xyDropZone-${tabId}`);
    const wrapper = document.getElementById(`plotsWrapper-${tabId}`);
    if (!dock || !zone) return;

    const splitter = dock.previousElementSibling;
    if (splitter && splitter.classList.contains('xy-dock-splitter')) wireDockSplitter(splitter, dock);

    zone.addEventListener('dragover', e => {
        if (!draggedGroup().length) return;
        e.preventDefault();
        zone.classList.add('drop-target');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('drop-target'));
    zone.addEventListener('drop', e => {
        e.preventDefault();
        zone.classList.remove('drop-target');
        const group = draggedGroup();
        if (group.length) createXYFromSignals(tabId, group);
    });
    // Sans glisser: un panneau vide, qui indique ou deposer X et Y.
    zone.addEventListener('click', () => createXYPlot(tabId));

    if (wrapper) wireTimeHover(wrapper);
}

// Survol d'un graphe temporel: le point correspondant est montre sur les trajectoires.
// uPlot tient deja la position du pointeur (cursor.left): aucune lecture de layout ici.
function wireTimeHover(wrapper) {
    let raf = false;
    let pending = null;
    wrapper.addEventListener('mousemove', e => {
        if (activeXYPlots().length === 0) return;
        const over = e.target && e.target.closest ? e.target.closest('.u-over') : null;
        const plot = over ? S.plots.find(p => p.chart && p.chart.over === over) : null;
        const left = plot ? plot.chart.cursor.left : -1;
        pending = (plot && left >= 0) ? plot.chart.posToVal(left, 'x') : null;
        if (raf) return;
        raf = true;
        requestAnimationFrame(() => {
            raf = false;
            if (pending === null) clearProbe();
            else setProbe(pending, null);
        });
    });
    wrapper.addEventListener('mouseleave', () => {
        pending = null;
        clearProbe();
    });
}

// =========================================================================
// Creation, suppression
// =========================================================================
function iconButton(className, label, html, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `xy-tool ${className}`;
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.innerHTML = html;
    btn.addEventListener('click', onClick);
    return btn;
}

export function createXYPlot(tabId, spec = null) {
    const tab = tabOf(tabId);
    const dock = document.getElementById(`xyDock-${tabId}`);
    if (!tab || !dock) return null;
    if (tab.xyIdCounter === undefined) tab.xyIdCounter = 0;
    const id = `xy-${tabId}-${tab.xyIdCounter++}`;

    const element = document.createElement('div');
    element.className = 'xy-panel';
    element.id = id;

    const header = document.createElement('div');
    header.className = 'xy-header';
    const series = document.createElement('div');
    series.className = 'xy-series';
    const tools = document.createElement('div');
    tools.className = 'xy-tools';
    header.append(series, tools);

    const readout = document.createElement('div');
    readout.className = 'xy-readout';
    readout.hidden = true;

    const body = document.createElement('div');
    body.className = 'xy-body';
    const chartDiv = document.createElement('div');
    chartDiv.className = 'xy-chart';
    const message = document.createElement('div');
    message.className = 'xy-message';
    const status = document.createElement('div');
    status.className = 'xy-status';
    const tooltip = document.createElement('div');
    tooltip.className = 'xy-tooltip';
    tooltip.hidden = true;
    const dropOverlay = document.createElement('div');
    dropOverlay.className = 'xy-drop-overlay';
    dropOverlay.innerHTML = '<div class="xy-drop-y">Tracer en Y</div><div class="xy-drop-x">Axe X</div>';
    body.append(chartDiv, message, status, tooltip, dropOverlay);

    element.append(header, readout, body);
    dock.appendChild(element);

    const plot = {
        id,
        tabId,
        kind: 'xy',
        element,
        body,
        chartDiv,
        chart: null,
        // Signal de l'axe X et series Y: { name, idx } (idx null: absent du fichier courant,
        // conserve pour le prochain fichier), plus le style pour les Y.
        x: null,
        ys: [],
        signals: [],
        signalStyles: {},
        cachedData: {},
        // Y reechantillonnes sur la grille de X, par index de signal.
        paired: new Map(),
        // Fenetre posee par l'utilisateur (zoom, pan), ou null: cadrage automatique sur les
        // points de la fenetre temporelle.
        range: null,
        view: null,
        equal: false,
        mode: 'line',
        // Carte de densite a la place de la trajectoire.
        density: false,
        heat: null,
        drawn: [],
        window: { i0: 0, i1: -1 },
    };

    tools.append(
        iconButton('xy-swap', 'Échanger les axes X et Y', ICONS.swap, () => swapAxes(plot)),
        iconButton('xy-equal', 'Même échelle sur les deux axes', '<span>1:1</span>', () => {
            plot.equal = !plot.equal;
            plot.range = null;
            updateHeader(plot);
            renderXY(plot);
        }),
        iconButton('xy-mode', 'Afficher les points sans les relier', ICONS.points, () => {
            plot.mode = plot.mode === 'line' ? 'points' : 'line';
            updateHeader(plot);
            renderXY(plot);
        }),
        iconButton('xy-density', 'Afficher la densité de points (carte de chaleur)', ICONS.density, () => {
            plot.density = !plot.density;
            updateHeader(plot);
            renderXY(plot);
        }),
        iconButton('xy-fit', 'Recadrer sur les données (double-clic)', ICONS.fit, () => {
            plot.range = null;
            renderXY(plot);
        }),
        iconButton('xy-delete', 'Supprimer ce graphe X/Y', '✕', () => deleteXYPlot(plot)),
    );

    wirePanelDrop(plot);
    if (typeof ResizeObserver === 'function') {
        let raf = false;
        plot.resizeObserver = new ResizeObserver(() => {
            if (raf) return;
            raf = true;
            requestAnimationFrame(() => {
                raf = false;
                // Dock en cours de redimensionnement: le rendu attend le relachement.
                if (dock.classList.contains('is-resizing')) return;
                fitToBody(plot);
            });
        });
        plot.resizeObserver.observe(body);
    }

    xyPlotsOf(tab).push(plot);
    if (spec) applySpec(plot, spec);
    syncDock(tabId);
    updateHeader(plot);
    renderXY(plot);
    return plot;
}

// Nouveau graphe depuis un groupe de signaux deposes: le premier porte l'axe X, les
// suivants sont traces en Y.
export function createXYFromSignals(tabId, group) {
    const usable = group.filter(usableSignal);
    if (usable.length === 0) {
        notify('Les signaux booléens et les commentaires ne se tracent pas en X/Y');
        return null;
    }
    const plot = createXYPlot(tabId);
    if (!plot) return null;
    setXSignal(plot, usable[0]);
    addYSignals(plot, usable.slice(1));
    return plot;
}

function destroyXYPlot(plot) {
    plot._dead = true;
    if (plot.resizeObserver) plot.resizeObserver.disconnect();
    if (plot.chart) plot.chart.destroy();
    plot.chart = null;
    plot.element.remove();
}

function deleteXYPlot(plot) {
    const tab = tabOf(plot.tabId);
    destroyXYPlot(plot);
    if (tab) tab.xyPlots = xyPlotsOf(tab).filter(p => p !== plot);
    syncDock(plot.tabId);
    updateSignalActiveStates();
}

// Detruit les graphes X/Y d'un onglet (fermeture, application d'un layout).
export function destroyXYPlots(tab) {
    if (!tab || !tab.xyPlots) return;
    tab.xyPlots.forEach(destroyXYPlot);
    tab.xyPlots = [];
    syncDock(tab.id);
}

// Changement de fichier ou effacement: les index de signaux ne valent que pour un fichier.
export function clearAllXYPlots() {
    S.tabs.forEach(destroyXYPlots);
    clearProbe();
}

// =========================================================================
// Affectation des signaux
// =========================================================================
function allTabPlots(plot) {
    const tab = tabOf(plot.tabId);
    return [...((tab && tab.plots) || []), ...xyPlotsOf(tab)];
}

function newStyle(plot, idx) {
    return { color: presetColorForSignal(allTabPlots(plot), plot, idx), width: 1.5, dash: '' };
}

function afterSignalChange(plot) {
    plot._failed = false;
    plot.range = null;
    syncSignals(plot);
    plot.paired.clear();
    updateHeader(plot);
    renderXY(plot);
    updateSignalActiveStates();
}

function setXSignal(plot, idx) {
    if (!usableSignal(idx)) return;
    plot.ys = plot.ys.filter(y => y.idx !== idx);
    plot.x = { name: S.signalsInfo[idx].name, idx };
    afterSignalChange(plot);
}

function addYSignals(plot, indices) {
    let added = false;
    indices.filter(usableSignal).forEach(idx => {
        if ((plot.x && plot.x.idx === idx) || plot.ys.some(y => y.idx === idx)) return;
        // Le style se lit sur plot.signals/signalStyles: a jour avant chaque attribution,
        // pour que deux signaux deposes ensemble ne recoivent pas la meme couleur.
        syncSignals(plot);
        plot.ys.push({ name: S.signalsInfo[idx].name, idx, style: newStyle(plot, idx) });
        added = true;
    });
    if (added) afterSignalChange(plot);
}

function removeY(plot, y) {
    plot.ys = plot.ys.filter(item => item !== y);
    afterSignalChange(plot);
}

function swapAxes(plot) {
    if (!plot.x || plot.ys.length !== 1) return;
    const oldX = plot.x;
    const oldY = plot.ys[0];
    plot.x = { name: oldY.name, idx: oldY.idx };
    plot.ys = [{
        name: oldX.name,
        idx: oldX.idx,
        // La couleur suit la courbe, pas le signal: il n'y a toujours qu'une trajectoire.
        style: oldY.style,
    }];
    afterSignalChange(plot);
}

function wirePanelDrop(plot) {
    const el = plot.element;
    const clear = () => el.classList.remove('drop-x', 'drop-y');
    el.addEventListener('dragover', e => {
        if (!draggedGroup().length) return;
        e.preventDefault();
        const rect = plot.body.getBoundingClientRect();
        const onX = (e.clientY - rect.top) > rect.height * DROP_X_ZONE;
        el.classList.toggle('drop-x', onX);
        el.classList.toggle('drop-y', !onX);
    });
    el.addEventListener('dragleave', e => {
        if (!el.contains(e.relatedTarget)) clear();
    });
    el.addEventListener('drop', e => {
        e.preventDefault();
        const onX = el.classList.contains('drop-x');
        clear();
        const usable = draggedGroup().filter(usableSignal);
        if (usable.length === 0) {
            notify('Les signaux booléens et les commentaires ne se tracent pas en X/Y');
            return;
        }
        if (onX) {
            setXSignal(plot, usable[0]);
            addYSignals(plot, usable.slice(1));
        } else {
            addYSignals(plot, usable);
        }
    });
}

// =========================================================================
// En-tete (series, outils) et table de mesure
// =========================================================================
function chip(label, color, title, onRemove) {
    const el = document.createElement('span');
    el.className = 'xy-chip';
    el.title = title;
    if (color) {
        const dot = document.createElement('span');
        dot.className = 'xy-chip-dot';
        dot.style.background = color;
        el.appendChild(dot);
    }
    const text = document.createElement('span');
    text.className = 'xy-chip-name';
    text.textContent = label;
    el.appendChild(text);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'xy-chip-remove';
    remove.setAttribute('aria-label', `Retirer ${label}`);
    remove.textContent = '×';
    remove.addEventListener('click', onRemove);
    el.appendChild(remove);
    return el;
}

function axisTag(text) {
    const tag = document.createElement('span');
    tag.className = 'xy-axis-tag';
    tag.textContent = text;
    return tag;
}

function updateHeader(plot) {
    const series = plot.element.querySelector('.xy-series');
    series.textContent = '';
    // Une ligne par axe: l'etiquette de l'axe ne se retrouve jamais separee de ses signaux.
    const axisRow = tag => {
        const row = document.createElement('div');
        row.className = 'xy-axis-row';
        row.appendChild(axisTag(tag));
        series.appendChild(row);
        return row;
    };
    const emptyHint = () => {
        const hint = document.createElement('span');
        hint.className = 'xy-chip-empty';
        hint.textContent = 'déposez un signal';
        return hint;
    };

    const yRow = axisRow('Y');
    if (plot.ys.length === 0) yRow.appendChild(emptyHint());
    plot.ys.forEach(y => {
        const el = chip(signalLabel(y.idx, y.name), y.style.color,
            y.idx === null ? 'Signal absent de ce fichier' : y.name, () => removeY(plot, y));
        el.classList.toggle('is-missing', y.idx === null);
        yRow.appendChild(el);
    });
    const xRow = axisRow('X');
    if (plot.x) {
        const el = chip(signalLabel(plot.x.idx, plot.x.name), null,
            plot.x.idx === null ? 'Signal absent de ce fichier' : plot.x.name, () => {
                plot.x = null;
                afterSignalChange(plot);
            });
        el.classList.toggle('is-missing', plot.x.idx === null);
        xRow.appendChild(el);
    } else {
        xRow.appendChild(emptyHint());
    }

    const swap = plot.element.querySelector('.xy-swap');
    swap.disabled = !(plot.x && plot.ys.length === 1);
    const equal = plot.element.querySelector('.xy-equal');
    equal.classList.toggle('is-on', plot.equal);
    equal.setAttribute('aria-pressed', plot.equal ? 'true' : 'false');
    const mode = plot.element.querySelector('.xy-mode');
    mode.classList.toggle('is-on', plot.mode === 'points');
    mode.setAttribute('aria-pressed', plot.mode === 'points' ? 'true' : 'false');
    const density = plot.element.querySelector('.xy-density');
    density.classList.toggle('is-on', plot.density);
    density.setAttribute('aria-pressed', plot.density ? 'true' : 'false');
    buildReadout(plot);
}

function buildReadout(plot) {
    const readout = plot.element.querySelector('.xy-readout');
    readout.textContent = '';
    const cell = (text, className) => {
        const el = document.createElement('span');
        el.className = className;
        el.textContent = text;
        readout.appendChild(el);
        return el;
    };
    cell('', 'xy-ro-head');
    cell('A', 'xy-ro-head xy-ro-a');
    cell('B', 'xy-ro-head xy-ro-b');
    cell('Δ', 'xy-ro-head');
    const rows = [];
    const addRow = (idx, name, color) => {
        const label = cell(name, 'xy-ro-name');
        if (color) label.style.color = color;
        rows.push({ idx, a: cell('-', 'xy-ro-val'), b: cell('-', 'xy-ro-val'), d: cell('-', 'xy-ro-val') });
    };
    if (plot.x && plot.x.idx !== null) addRow(plot.x.idx, signalLabel(plot.x.idx, plot.x.name), null);
    plot.ys.forEach(y => {
        if (y.idx !== null) addRow(y.idx, signalLabel(y.idx, y.name), y.style.color);
    });
    plot.readoutRows = rows;
}

function writeText(el, text) {
    if (el.textContent !== text) el.textContent = text;
}

// =========================================================================
// Donnees: series completes, empruntees aux graphes temporels ou rapatriees
// =========================================================================
function toTyped(arr, Ctor) {
    return arr instanceof Ctor ? arr : Ctor.from(arr, v => (v === null || v === undefined ? NaN : v));
}

function normalizeEntry(src) {
    return { timestamps: toTyped(src.timestamps, Float64Array), values: toTyped(src.values, Float32Array) };
}

// Serie complete deja presente dans un graphe de n'importe quel onglet. Une entree
// convertie vers l'unite de son graphe (unitConversions) ne porte plus les valeurs du
// fichier: elle n'est pas reutilisee.
function borrowEntry(idx, self) {
    for (const tab of S.tabs) {
        for (const p of [...(tab.plots || []), ...(tab.xyPlots || [])]) {
            if (p === self) continue;
            const c = p.cachedData ? p.cachedData[idx] : null;
            if (!c || !c.timestamps || !c.values) continue;
            if (p.kind !== 'xy' && !(c.isComplete && c.fullTimeRange)) continue;
            if (p.unitConversions && p.unitConversions[idx]) continue;
            return c;
        }
    }
    return null;
}

async function fetchSeries(indices, sessionId) {
    if (sessionId) return requestRawSignals(indices);
    // Source de demonstration (sans session): pas de route pleine resolution, la vue
    // decimee de toute l'acquisition tient lieu de serie.
    const acq = ectx.acquisitionView;
    const url = `${API}/view?signals=${indices.join(',')}&start=${acq.min}&end=${acq.max}&max_points=10000`;
    return fetchViewData(url, {});
}

// Vrai si toutes les series du graphe sont disponibles. Sinon lance leur chargement, qui
// relancera le rendu.
function ensureData(plot) {
    const missing = [];
    plot.signals.forEach(idx => {
        if (plot.cachedData[idx]) return;
        const borrowed = borrowEntry(idx, plot);
        if (borrowed) plot.cachedData[idx] = normalizeEntry(borrowed);
        else missing.push(idx);
    });
    if (missing.length === 0) return true;
    if (plot._loading || plot._failed) return false;

    plot._loading = true;
    const sessionId = ectx.currentLazySessionId;
    fetchSeries(missing, sessionId).catch(() => null).then(data => {
        plot._loading = false;
        if (plot._dead || sessionId !== ectx.currentLazySessionId) return;
        const signals = (data && data.signals) || [];
        signals.forEach(sig => {
            if (sig.timestamps && sig.values) plot.cachedData[sig.index] = normalizeEntry(sig);
        });
        if (missing.some(idx => !plot.cachedData[idx])) plot._failed = true;
        renderXY(plot);
    });
    return false;
}

// Oublie les donnees d'un signal dont le contenu a change (variable calculee modifiee).
export function invalidateXYSignal(idx) {
    S.tabs.forEach(tab => xyPlotsOf(tab).forEach(plot => {
        if (!plot.signals.includes(idx)) return;
        delete plot.cachedData[idx];
        plot.paired.clear();
        plot._failed = false;
        if (plot.tabId === S.activeTabId) renderXY(plot);
    }));
}

function pairedValues(plot, y) {
    const xEntry = plot.cachedData[plot.x.idx];
    const yEntry = plot.cachedData[y.idx];
    const memo = plot.paired.get(y.idx);
    if (memo && memo.ts === xEntry.timestamps && memo.src === yEntry.values) return memo.values;
    const values = resampleOnto(xEntry.timestamps, yEntry.timestamps, yEntry.values, isHeldSignal(y.idx));
    plot.paired.set(y.idx, { ts: xEntry.timestamps, src: yEntry.values, values });
    return values;
}

// =========================================================================
// Rendu
// =========================================================================
function blockingMessage(plot) {
    if (!plot.x && plot.ys.length === 0) return 'Déposez un signal pour l\'axe X, puis un signal à tracer en Y';
    if (!plot.x) return 'Déposez le signal de l\'axe X (bas du panneau)';
    if (plot.ys.length === 0) return 'Déposez un signal à tracer en Y';
    if (plot.x.idx === null) return `Signal X absent de ce fichier : ${plot.x.name}`;
    if (plot.ys.every(y => y.idx === null)) return 'Signaux Y absents de ce fichier';
    return null;
}

function setMessage(plot, text) {
    const el = plot.element.querySelector('.xy-message');
    writeText(el, text || '');
    plot.element.classList.toggle('has-message', !!text);
}

function chartSignature(plot) {
    const ys = plot.ys.filter(y => y.idx !== null);
    return `${plot.x.idx}|${ys.map(y => y.idx).join(',')}`;
}

function axisOptions(label, size) {
    return {
        stroke: () => themeChartColors().axis,
        grid: { stroke: () => themeChartColors().grid, width: 1 },
        ticks: { stroke: () => themeChartColors().grid, width: 1 },
        size,
        label,
        labelSize: AXIS_LABEL_SIZE,
    };
}

function buildChart(plot) {
    if (plot.chart) plot.chart.destroy();
    const ys = plot.ys.filter(y => y.idx !== null);
    const yLabel = ys.length === 1
        ? signalLabel(ys[0].idx, ys[0].name)
        : [...new Set(ys.map(y => (S.signalsInfo[y.idx] && S.signalsInfo[y.idx].unit) || ''))].filter(Boolean).join(', ');
    const options = {
        width: plot.body.clientWidth || 400,
        height: plot.body.clientHeight || 300,
        legend: { show: false },
        padding: [8, 10, 0, 0],
        series: [{}, { points: { show: false }, stroke: 'transparent' }],
        scales: {
            x: { time: false, range: () => [plot.view.x.min, plot.view.x.max] },
            y: { range: () => [plot.view.y.min, plot.view.y.max] },
        },
        axes: [
            axisOptions(signalLabel(plot.x.idx, plot.x.name), X_AXIS_SIZE),
            axisOptions(yLabel, Y_AXIS_SIZE),
        ],
        cursor: { drag: { x: true, y: true, uni: 50, dist: 8, setScale: false }, points: { show: false } },
        hooks: {
            init: [u => wireChart(plot, u)],
            setSelect: [u => zoomToSelection(plot, u)],
            draw: [u => {
                paintBase(plot, u);
                paintOverlay(plot);
                positionCursorDots(plot);
            }],
        },
    };
    plot.view = plot.view || fitView(null);
    plot.chart = new uPlot(options, DUMMY_DATA, plot.chartDiv);
    plot._signature = chartSignature(plot);
}

// Rend un graphe X/Y sur la fenetre temporelle courante. fast: echantillonnage allege,
// pour les rendus par frame d'un glissement.
export function renderXY(plot, { fast = false } = {}) {
    // Onglet masque (donnees arrivees entre-temps): le rendu est refait a son affichage.
    if (plot._dead || plot.tabId !== S.activeTabId) return;
    const blocking = blockingMessage(plot);
    if (blocking) {
        setMessage(plot, blocking);
        return;
    }
    if (!ensureData(plot)) {
        setMessage(plot, plot._failed ? 'Données indisponibles pour ce graphe' : 'Chargement…');
        return;
    }
    setMessage(plot, null);

    if (!plot.chart || plot._signature !== chartSignature(plot)) buildChart(plot);
    const u = plot.chart;
    const xEntry = plot.cachedData[plot.x.idx];
    const xs = xEntry.values;
    const { i0, i1 } = windowIndexRange(xEntry.timestamps, ectx.globalView.min, ectx.globalView.max);
    const count = Math.max(0, i1 - i0 + 1);
    const stride = fast ? Math.max(1, Math.ceil(count / FAST_POINTS)) : 1;
    const series = plot.ys.filter(y => y.idx !== null).map(y => ({ y, values: pairedValues(plot, y) }));
    const width = u.bbox.width;
    const height = u.bbox.height;

    if (plot.range) {
        plot.view = plot.range;
    } else {
        const bounds = mergeBounds(series.map(s => xyBounds(xs, s.values, i0, i1, stride)));
        // Fenetre sans point: on garde le cadrage precedent plutot qu'un saut vers [0, 1].
        if (bounds || !plot.view) plot.view = fitView(bounds, { equal: plot.equal, width, height });
    }

    plot.window = { i0, i1 };
    plot.drawn = series.map(s => {
        const result = decimateXY(xs, s.values, i0, i1, plot.view, Math.max(1, width), Math.max(1, height), { stride });
        return { y: s.y, values: s.values, indices: result.indices, stride: result.stride };
    });

    // Densite: tous les echantillons de la fenetre comptent, pas les seuls points traces.
    plot.heat = null;
    if (plot.density) {
        const dpr = window.devicePixelRatio || 1;
        const cols = Math.max(1, Math.round(width / (DENSITY_CELL_PX * dpr)));
        const rows = Math.max(1, Math.round(height / (DENSITY_CELL_PX * dpr)));
        const counts = new Uint32Array(cols * rows);
        let max = 0;
        // Les series s'additionnent dans la meme grille.
        series.forEach(s => {
            max = Math.max(max, densityGrid(xs, s.values, i0, i1, plot.view, cols, rows, { stride, counts }).max);
        });
        plot.heat = { counts, max, cols, rows };
    }

    const approx = !fast && !plot.density && plot.drawn.some(d => d.stride > 1);
    writeText(plot.element.querySelector('.xy-status'), approx
        ? `Tracé allégé : 1 point sur ${Math.max(...plot.drawn.map(d => d.stride))}` : '');

    // setData relance le calcul des echelles (fonctions range ci-dessus) et le dessin.
    u.setData(DUMMY_DATA);
    updateReadout(plot);
}

// Rend les graphes X/Y de l'onglet affiche (changement de fenetre temporelle).
export function renderXYPlots(options) {
    activeXYPlots().forEach(plot => renderXY(plot, options));
}

// Reset du zoom: les fenetres posees a la main repartent en cadrage automatique.
export function resetXYRanges() {
    activeXYPlots().forEach(plot => { plot.range = null; });
}

function pxMapper(plot, u, scale) {
    const w = u.bbox.width * scale;
    const h = u.bbox.height * scale;
    const kx = w / (plot.view.x.max - plot.view.x.min);
    const ky = h / (plot.view.y.max - plot.view.y.min);
    const x0 = plot.view.x.min;
    const y0 = plot.view.y.min;
    return { toX: x => (x - x0) * kx, toY: y => h - (y - y0) * ky };
}

// Trace les points indices[k0..k1) d'une serie: polyligne (une rupture leve le crayon) ou
// points seuls. Coordonnees en pixels physiques, origine (ox, oy).
function traceSeries(ctx, plot, drawn, k0, k1, map, ox, oy, lineWidth) {
    const xs = plot.cachedData[plot.x.idx].values;
    const ys = drawn.values;
    const indices = drawn.indices;
    if (plot.mode === 'points') {
        const size = Math.max(2, lineWidth * 1.6);
        for (let k = k0; k < k1; k++) {
            const i = indices[k];
            if (i < 0) continue;
            ctx.fillRect(ox + map.toX(xs[i]) - size / 2, oy + map.toY(ys[i]) - size / 2, size, size);
        }
        return;
    }
    ctx.beginPath();
    let pen = false;
    for (let k = k0; k < k1; k++) {
        const i = indices[k];
        if (i < 0) {
            pen = false;
            continue;
        }
        const px = ox + map.toX(xs[i]);
        const py = oy + map.toY(ys[i]);
        if (pen) ctx.lineTo(px, py);
        else ctx.moveTo(px, py);
        pen = true;
    }
    ctx.lineWidth = lineWidth;
    ctx.lineJoin = 'bevel';
    ctx.stroke();
}

function bothCursorsSet() {
    return S.cursor1 !== null && S.cursor2 !== null;
}

// Table de couleurs de la densite pour le theme courant: 256 entrees RGBA, l'indice 0
// (cellule vide) transparent.
const densityLuts = {};

function densityLut() {
    const theme = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    if (densityLuts[theme]) return densityLuts[theme];
    const ramp = DENSITY_RAMPS[theme];
    const lut = new Uint8ClampedArray(256 * 4);
    for (let k = 1; k < 256; k++) {
        const t = ((k - 1) / 254) * (ramp.length - 1);
        const a = Math.min(ramp.length - 2, Math.floor(t));
        const f = t - a;
        for (let c = 0; c < 3; c++) lut[k * 4 + c] = ramp[a][c] + (ramp[a + 1][c] - ramp[a][c]) * f;
        lut[k * 4 + 3] = 255;
    }
    densityLuts[theme] = lut;
    return lut;
}

// Carte de densite: une cellule par case de la grille, couleur selon le logarithme du
// nombre d'echantillons (une echelle lineaire ecraserait tout sous le pic).
function paintDensity(plot, u) {
    const { counts, max, cols, rows } = plot.heat;
    if (!max) return;
    if (!plot.heatCanvas) plot.heatCanvas = document.createElement('canvas');
    const canvas = plot.heatCanvas;
    if (canvas.width !== cols || canvas.height !== rows) {
        canvas.width = cols;
        canvas.height = rows;
    }
    const hctx = canvas.getContext('2d');
    const image = hctx.createImageData(cols, rows);
    const lut = densityLut();
    const scale = 254 / Math.log(1 + max);
    const data = image.data;
    for (let i = 0; i < counts.length; i++) {
        const count = counts[i];
        if (!count) continue;
        const k = (1 + Math.round(Math.log(1 + count) * scale)) * 4;
        const o = i * 4;
        data[o] = lut[k];
        data[o + 1] = lut[k + 1];
        data[o + 2] = lut[k + 2];
        data[o + 3] = lut[k + 3];
    }
    hctx.putImageData(image, 0, 0);
    const ctx = u.ctx;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(canvas, u.bbox.left, u.bbox.top, u.bbox.width, u.bbox.height);
    ctx.restore();
}

function paintBase(plot, u) {
    if (!plot.view || !plot.x || !plot.cachedData[plot.x.idx]) return;
    const ctx = u.ctx;
    const dpr = window.devicePixelRatio || 1;
    const map = pxMapper(plot, u, 1);
    if (plot.density && plot.heat) {
        // La carte remplace la trajectoire; la plage entre curseurs reste tracee par-dessus.
        plot._dimmed = bothCursorsSet();
        paintDensity(plot, u);
        return;
    }
    plot._dimmed = bothCursorsSet();
    ctx.save();
    ctx.beginPath();
    ctx.rect(u.bbox.left, u.bbox.top, u.bbox.width, u.bbox.height);
    ctx.clip();
    ctx.globalAlpha = plot._dimmed ? DIMMED_ALPHA : 1;
    plot.drawn.forEach(d => {
        ctx.strokeStyle = d.y.style.color;
        ctx.fillStyle = d.y.style.color;
        traceSeries(ctx, plot, d, 0, d.indices.length, map, u.bbox.left, u.bbox.top, d.y.style.width * dpr);
    });
    ctx.restore();
}

// Plage entre les deux curseurs, sur un canvas a part: elle suit un glissement de curseur
// sans redessiner la trajectoire complete.
function paintOverlay(plot) {
    const u = plot.chart;
    const canvas = plot.overlay;
    if (!u || !canvas || !plot.view) return;
    if (canvas.width !== u.bbox.width || canvas.height !== u.bbox.height) {
        canvas.width = u.bbox.width;
        canvas.height = u.bbox.height;
    }
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!bothCursorsSet() || !plot.x || !plot.cachedData[plot.x.idx]) return;

    const ts = plot.cachedData[plot.x.idx].timestamps;
    const { i0, i1 } = plot.window;
    const a = Math.max(i0, windowIndexRange(ts, Math.min(S.cursor1, S.cursor2), Infinity).i0);
    const b = Math.min(i1, windowIndexRange(ts, -Infinity, Math.max(S.cursor1, S.cursor2)).i1);
    if (b < a) return;
    const dpr = window.devicePixelRatio || 1;
    const map = pxMapper(plot, u, 1);
    plot.drawn.forEach(d => {
        const { k0, k1 } = indexSpan(d.indices, a, b);
        ctx.strokeStyle = d.y.style.color;
        ctx.fillStyle = d.y.style.color;
        // Sur la carte de densite, un trait fin: il ne doit pas la recouvrir.
        const extra = plot.density ? 0 : 1;
        traceSeries(ctx, plot, d, k0, k1, map, 0, 0, (d.y.style.width + extra) * dpr);
    });
}

// =========================================================================
// Curseurs A/B et sonde de survol
// =========================================================================
function dotPool(plot, key, className) {
    if (!plot.dots) plot.dots = {};
    if (!plot.dots[key]) plot.dots[key] = { className, items: [] };
    return plot.dots[key];
}

// Place un point par serie a l'echantillon `index`, ou les masque (index < 0).
function placeDots(plot, key, className, index, text) {
    const u = plot.chart;
    const pool = dotPool(plot, key, className);
    let used = 0;
    if (u && index >= 0 && plot.view) {
        const dpr = window.devicePixelRatio || 1;
        const map = pxMapper(plot, u, 1 / dpr);
        const xs = plot.cachedData[plot.x.idx].values;
        plot.drawn.forEach(d => {
            const x = xs[index];
            const y = d.values[index];
            if (x !== x || y !== y) return;
            let dot = pool.items[used];
            if (!dot) {
                dot = document.createElement('div');
                dot.className = className;
                if (pool.onCreate) pool.onCreate(dot);
                u.over.appendChild(dot);
                pool.items[used] = dot;
            }
            dot.style.display = 'block';
            dot.style.setProperty('--sig-color', d.y.style.color);
            if (text !== undefined) writeText(dot, text);
            dot.style.transform = `translate3d(${map.toX(x)}px, ${map.toY(y)}px, 0) translate(-50%, -50%)`;
            dot._series = d;
            used++;
        });
    }
    for (let k = used; k < pool.items.length; k++) pool.items[k].style.display = 'none';
}

// Echantillon de l'axe X a l'instant d'un curseur, -1 s'il est hors de la fenetre affichee.
function cursorIndex(plot, time) {
    if (time === null || !plot.x || !plot.cachedData[plot.x.idx]) return -1;
    if (time < ectx.globalView.min || time > ectx.globalView.max) return -1;
    const index = indexAtTime(plot.cachedData[plot.x.idx].timestamps, time);
    return (index >= plot.window.i0 && index <= plot.window.i1) ? index : -1;
}

function positionCursorDots(plot) {
    if (!plot.chart || plot.element.classList.contains('has-message')) return;
    placeDots(plot, 'c1', 'xy-cursor-dot cursor-1', cursorIndex(plot, S.cursor1), 'A');
    placeDots(plot, 'c2', 'xy-cursor-dot cursor-2', cursorIndex(plot, S.cursor2), 'B');
}

function updateReadout(plot) {
    const readout = plot.element.querySelector('.xy-readout');
    const active = S.cursor1 !== null || S.cursor2 !== null;
    const show = active && !!plot.x && plot.x.idx !== null && !!plot.cachedData[plot.x.idx];
    if (readout.hidden === show) readout.hidden = !show;
    if (!show) return;
    const ts = plot.cachedData[plot.x.idx].timestamps;
    const ia = S.cursor1 !== null ? indexAtTime(ts, S.cursor1) : -1;
    const ib = S.cursor2 !== null ? indexAtTime(ts, S.cursor2) : -1;
    (plot.readoutRows || []).forEach(row => {
        const values = row.idx === plot.x.idx
            ? plot.cachedData[plot.x.idx].values
            : (plot.paired.get(row.idx) || {}).values;
        const va = values && ia >= 0 ? values[ia] : NaN;
        const vb = values && ib >= 0 ? values[ib] : NaN;
        writeText(row.a, formatValue(va));
        writeText(row.b, formatValue(vb));
        writeText(row.d, formatValue(vb - va));
    });
}

// Appele par updateCursors (cursors.js) a chaque changement de curseur, glissement compris.
export function updateXYCursors() {
    activeXYPlots().forEach(plot => {
        updateReadout(plot);
        if (!plot.chart || plot.element.classList.contains('has-message')) return;
        // Passage avec/sans plage: l'attenuation de la trajectoire change, a redessiner.
        if (plot._dimmed !== bothCursorsSet()) {
            plot.chart.redraw(false);
            return;
        }
        paintOverlay(plot);
        positionCursorDots(plot);
    });
}

function probeLine(chart) {
    if (!chart._xyProbe || !chart._xyProbe.isConnected) {
        const line = document.createElement('div');
        line.className = 'xy-probe-line';
        chart.over.appendChild(line);
        chart._xyProbe = line;
    }
    return chart._xyProbe;
}

// Montre l'instant t sur toutes les trajectoires de l'onglet. source: graphe X/Y survole
// (le trait de rappel est alors pose sur les graphes temporels), ou null si le survol
// vient d'un graphe temporel.
function setProbe(time, source) {
    activeXYPlots().forEach(plot => {
        if (!plot.chart || plot.element.classList.contains('has-message')) return;
        placeDots(plot, 'hover', 'xy-hover-dot', cursorIndex(plot, time));
    });
    if (!source) return;
    S.plots.forEach(p => {
        if (!p.chart || !p.chart.over) return;
        const line = probeLine(p.chart);
        line.style.display = 'block';
        line.style.transform = `translate3d(${p.chart.valToPos(time, 'x')}px, 0, 0)`;
    });
}

function clearProbe() {
    activeXYPlots().forEach(plot => {
        if (plot.dots && plot.dots.hover) plot.dots.hover.items.forEach(dot => { dot.style.display = 'none'; });
        const tooltip = plot.element.querySelector('.xy-tooltip');
        if (tooltip && !tooltip.hidden) tooltip.hidden = true;
    });
    S.plots.forEach(p => {
        if (p.chart && p.chart._xyProbe) p.chart._xyProbe.style.display = 'none';
    });
}

// Point trace le plus proche d'une position (px CSS dans la zone de trace), toutes series
// confondues, ou restreint a une serie.
function hitTest(plot, x, y, maxDist, only = null) {
    const u = plot.chart;
    const dpr = window.devicePixelRatio || 1;
    const map = pxMapper(plot, u, 1 / dpr);
    const xs = plot.cachedData[plot.x.idx].values;
    let best = null;
    plot.drawn.forEach(d => {
        if (only && d !== only) return;
        const hit = nearestPoint(xs, d.values, d.indices, map.toX, map.toY, x, y, best ? best.dist : maxDist);
        if (hit) best = { ...hit, series: d };
    });
    return best;
}

function showTooltip(plot, hit) {
    const tooltip = plot.element.querySelector('.xy-tooltip');
    const xEntry = plot.cachedData[plot.x.idx];
    const time = xEntry.timestamps[hit.index];
    const lines = [
        `t = ${time.toFixed(cursorTimeDecimals())} s`,
        `X = ${formatValue(xEntry.values[hit.index])}`,
        `Y = ${formatValue(hit.series.values[hit.index])}`,
    ];
    writeText(tooltip, lines.join('\n'));
    tooltip.hidden = false;
    const u = plot.chart;
    const dpr = window.devicePixelRatio || 1;
    const map = pxMapper(plot, u, 1 / dpr);
    const px = u.bbox.left / dpr + map.toX(xEntry.values[hit.index]);
    const py = u.bbox.top / dpr + map.toY(hit.series.values[hit.index]);
    // A droite du point, a gauche s'il est dans la moitie droite du panneau.
    const flip = px > (u.bbox.left + u.bbox.width / 2) / dpr;
    tooltip.style.transform = `translate3d(${px}px, ${py}px, 0) translate(${flip ? 'calc(-100% - 12px)' : '12px'}, -50%)`;
}

function wireChart(plot, u) {
    const over = u.over;
    plot.dots = {};
    plot.overlay = document.createElement('canvas');
    plot.overlay.className = 'xy-overlay';
    over.appendChild(plot.overlay);

    // Glisser un point de curseur le long de la trajectoire: il prend l'instant du point
    // trace le plus proche du pointeur, par moveCursorTo (le verrou de l'ecart suit).
    const wireCursorDot = which => dot => {
        dot.addEventListener('mousedown', e => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            if (e.ctrlKey || e.metaKey) {
                removeCursor(which);
                return;
            }
            touchCursor(which);
            const rect = over.getBoundingClientRect();
            const series = dot._series;
            let raf = false;
            let last = e;
            dot.classList.add('is-dragging');
            document.body.style.userSelect = 'none';
            const onMove = ev => {
                last = ev;
                if (raf) return;
                raf = true;
                requestAnimationFrame(() => {
                    raf = false;
                    const hit = hitTest(plot, last.clientX - rect.left, last.clientY - rect.top, Infinity, series);
                    if (hit) moveCursorTo(which, plot.cachedData[plot.x.idx].timestamps[hit.index]);
                });
            };
            const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                dot.classList.remove('is-dragging');
                document.body.style.userSelect = '';
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    };
    dotPool(plot, 'c1', 'xy-cursor-dot cursor-1').onCreate = wireCursorDot(1);
    dotPool(plot, 'c2', 'xy-cursor-dot cursor-2').onCreate = wireCursorDot(2);

    let hoverRaf = false;
    over.addEventListener('mousemove', () => {
        if (hoverRaf) return;
        hoverRaf = true;
        requestAnimationFrame(() => {
            hoverRaf = false;
            if (plot._dead || !plot.view || u.cursor.left < 0) return;
            const hit = hitTest(plot, u.cursor.left, u.cursor.top, 24);
            if (!hit) {
                clearProbe();
                return;
            }
            setProbe(plot.cachedData[plot.x.idx].timestamps[hit.index], plot);
            showTooltip(plot, hit);
        });
    });
    over.addEventListener('mouseleave', clearProbe);

    // Ctrl + clic: pose un curseur a l'instant du point, comme sur la regle de temps.
    over.addEventListener('click', e => {
        if (!(e.ctrlKey || e.metaKey) || u.cursor.left < 0) return;
        const hit = hitTest(plot, u.cursor.left, u.cursor.top, 24);
        if (hit) placeCursorAt(plot.cachedData[plot.x.idx].timestamps[hit.index]);
    });

    over.addEventListener('dblclick', () => {
        plot.range = null;
        renderXY(plot);
    });

    wireZoomAndPan(plot, u);
}

function keepEqual(plot, u, range) {
    if (!plot.equal) return range;
    return fitView({ xMin: range.x.min, xMax: range.x.max, yMin: range.y.min, yMax: range.y.max },
        { pad: 0, equal: true, width: u.bbox.width, height: u.bbox.height });
}

// Zoom par selection, comme sur les graphes temporels: une bande etroite ne borne qu'un
// axe, une boite borne les deux.
function zoomToSelection(plot, u) {
    const sel = u.select;
    const dpr = window.devicePixelRatio || 1;
    const zoomX = sel.width > 1 && sel.width < u.bbox.width / dpr - 2;
    const zoomY = sel.height > 1 && sel.height < u.bbox.height / dpr - 2;
    if (!zoomX && !zoomY) return;
    const range = { x: { ...plot.view.x }, y: { ...plot.view.y } };
    if (zoomX) {
        const a = u.posToVal(sel.left, 'x');
        const b = u.posToVal(sel.left + sel.width, 'x');
        range.x = { min: Math.min(a, b), max: Math.max(a, b) };
    }
    if (zoomY) {
        const a = u.posToVal(sel.top, 'y');
        const b = u.posToVal(sel.top + sel.height, 'y');
        range.y = { min: Math.min(a, b), max: Math.max(a, b) };
    }
    u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
    if (!(range.x.max > range.x.min) || !(range.y.max > range.y.min)) return;
    plot.range = keepEqual(plot, u, range);
    renderXY(plot);
}

// Molette: zoom autour du pointeur (les deux axes dans la zone de trace, un seul sur sa
// gouttiere). Glisser une gouttiere: translation de cet axe.
function wireZoomAndPan(plot, u) {
    let raf = false;
    const schedule = fast => {
        if (raf) return;
        raf = true;
        requestAnimationFrame(() => {
            raf = false;
            renderXY(plot, { fast });
        });
    };
    // Zone du pointeur: 'plot', 'x' (gouttiere du bas), 'y' (gouttiere de gauche) ou null.
    const zoneAt = (e, rect) => {
        const inX = e.clientX >= rect.left && e.clientX <= rect.right;
        const inY = e.clientY >= rect.top && e.clientY <= rect.bottom;
        if (inX && inY) return 'plot';
        if (inX && e.clientY > rect.bottom) return 'x';
        if (inY && e.clientX < rect.left) return 'y';
        return null;
    };

    u.root.addEventListener('wheel', e => {
        if (!plot.view) return;
        const rect = u.over.getBoundingClientRect();
        const zone = zoneAt(e, rect);
        if (!zone) return;
        e.preventDefault();
        const factor = Math.exp(e.deltaY * 0.0015);
        const range = { x: { ...plot.view.x }, y: { ...plot.view.y } };
        const both = zone === 'plot' || plot.equal;
        if (both || zone === 'x') {
            const pivot = zone === 'y' ? (range.x.min + range.x.max) / 2 : u.posToVal(e.clientX - rect.left, 'x');
            range.x = { min: pivot - (pivot - range.x.min) * factor, max: pivot + (range.x.max - pivot) * factor };
        }
        if (both || zone === 'y') {
            const pivot = zone === 'x' ? (range.y.min + range.y.max) / 2 : u.posToVal(e.clientY - rect.top, 'y');
            range.y = { min: pivot - (pivot - range.y.min) * factor, max: pivot + (range.y.max - pivot) * factor };
        }
        plot.range = range;
        schedule(false);
    }, { passive: false });

    u.root.addEventListener('mousedown', e => {
        if (e.button !== 0 || !plot.view) return;
        const rect = u.over.getBoundingClientRect();
        const zone = zoneAt(e, rect);
        if (zone !== 'x' && zone !== 'y') return;
        e.preventDefault();
        const start = { x: e.clientX, y: e.clientY, view: { x: { ...plot.view.x }, y: { ...plot.view.y } } };
        const perPxX = (start.view.x.max - start.view.x.min) / rect.width;
        const perPxY = (start.view.y.max - start.view.y.min) / rect.height;
        document.body.style.cursor = 'grabbing';
        const onMove = ev => {
            const range = { x: { ...start.view.x }, y: { ...start.view.y } };
            if (zone === 'x') {
                const shift = (start.x - ev.clientX) * perPxX;
                range.x = { min: start.view.x.min + shift, max: start.view.x.max + shift };
            } else {
                const shift = (ev.clientY - start.y) * perPxY;
                range.y = { min: start.view.y.min + shift, max: start.view.y.max + shift };
            }
            plot.range = range;
            schedule(true);
        };
        const onUp = () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            document.body.style.cursor = '';
            renderXY(plot);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    });
}

// =========================================================================
// Layout: enregistrement et restauration
// =========================================================================
// Entrees de layout des graphes X/Y d'un onglet, rangees dans le tableau `plots` de
// l'onglet. `signals` reste vide: une version anterieure de l'application, qui ne connait
// pas `kind`, ignore alors l'entree au lieu de la tracer contre le temps.
export function exportXYPlots(tab) {
    return xyPlotsOf(tab).map(plot => ({
        kind: 'xy',
        flex: 1,
        signals: [],
        x: plot.x ? plot.x.name : null,
        ys: plot.ys.map(y => ({
            name: y.name,
            style: { color: y.style.color, width: y.style.width, dash: y.style.dash || '' },
        })),
        equal: plot.equal,
        mode: plot.mode,
        density: plot.density,
    }));
}

function applySpec(plot, spec) {
    const nameToIndex = new Map(S.signalsInfo.map(sig => [sig.name, sig.index]));
    const resolve = name => {
        const idx = nameToIndex.get(name);
        return idx !== undefined && usableSignal(idx) ? idx : null;
    };
    const light = document.documentElement.getAttribute('data-theme') === 'light';
    plot.x = typeof spec.x === 'string' ? { name: spec.x, idx: resolve(spec.x) } : null;
    plot.ys = (Array.isArray(spec.ys) ? spec.ys : [])
        .filter(y => y && typeof y.name === 'string' && y.name !== spec.x)
        .map(y => ({
            name: y.name,
            idx: resolve(y.name),
            style: {
                color: themedPresetColor((y.style && y.style.color) || '#89b4fa', light),
                width: (y.style && y.style.width) || 1.5,
                dash: '',
            },
        }));
    plot.equal = spec.equal === true;
    plot.mode = spec.mode === 'points' ? 'points' : 'line';
    plot.density = spec.density === true;
    syncSignals(plot);
}

// Recree un graphe X/Y depuis une entree de layout (onglet actif).
export function restoreXYPlot(tabId, spec) {
    const plot = createXYPlot(tabId, spec);
    if (plot) updateSignalActiveStates();
    return plot;
}
