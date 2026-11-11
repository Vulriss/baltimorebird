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
import { resetView } from './bootstrap.js';
import {
    addCursorFromButton, cursorTimeDecimals, isCursorLockActive, moveCursorTo, placeCursorAt, removeCursor,
    setCursorPair, toggleCursorLock, touchCursor,
} from './cursors.js';
import { themeChartColors } from './plot-ui.js';
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
// Largeur du cadenas de la pastille de delta et de son ecart au texte (repli hors layout).
const LOCK_ICON_PX = 16;
// Deplacement (px) a partir duquel un appui sur le delta est un glisser, pas un clic.
const DRAG_THRESHOLD_PX = 3;
// Marge (px) entre une pastille et le bord interieur de la regle.
const EDGE_MARGIN = 2;

const SVG_ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
    + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
const ICON_LOCK = `<svg ${SVG_ATTRS}><path class="ruler-lock-shackle" d="M8 11V7a4 4 0 0 1 8 0v4"/>`
    + '<rect x="5" y="11" width="14" height="10" rx="2"/></svg>';
const ICON_ADD_CURSOR = `<svg ${SVG_ATTRS}><line x1="9" y1="4" x2="9" y2="20"/><line x1="6" y1="4" x2="12" y2="4"/>`
    + '<line x1="6" y1="20" x2="12" y2="20"/><line x1="17" y1="9" x2="17" y2="15"/>'
    + '<line x1="14" y1="12" x2="20" y2="12"/></svg>';
const ICON_RESET_ZOOM = `<svg ${SVG_ATTRS}><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16" y2="16"/>`
    + '<path d="M8.5 12.5a3 3 0 1 0 .4-3.4"/><polyline points="8.5 7.5 8.5 9.5 10.5 9.5"/></svg>';

const CURSOR_KEYS = [
    { which: 1, cls: 'ruler-cursor-a', get: () => S.cursor1 },
    { which: 2, cls: 'ruler-cursor-b', get: () => S.cursor2 },
];

// Monte la regle en tete de la zone des graphes d'un onglet.
export function mountTimeRuler(wrapper) {
    if (!wrapper || wrapper.querySelector(':scope > .time-ruler')) return;
    const el = document.createElement('div');
    el.className = 'time-ruler';
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', 'Règle de temps');

    const track = document.createElement('div');
    track.className = 'time-ruler-track';
    const chartDiv = document.createElement('div');
    chartDiv.className = 'time-ruler-chart';
    chartDiv.setAttribute('aria-hidden', 'true');
    track.appendChild(chartDiv);

    const delta = document.createElement('div');
    delta.className = 'ruler-delta';
    const deltaLine = document.createElement('div');
    deltaLine.className = 'ruler-delta-line';
    // Le delta est un controle: clic = verrou de l'ecart, glisser = translation de la paire.
    const deltaPill = document.createElement('button');
    deltaPill.type = 'button';
    deltaPill.className = 'ruler-delta-pill';
    deltaPill.title = 'Verrouiller l\'écart (L) - glisser pour déplacer les deux curseurs';
    deltaPill.setAttribute('aria-pressed', 'false');
    const deltaText = document.createElement('span');
    deltaText.className = 'ruler-delta-text';
    deltaPill.appendChild(deltaText);
    // Cadenas a droite de la valeur: elle reste ce qu'on lit en premier.
    deltaPill.insertAdjacentHTML('beforeend', ICON_LOCK);
    track.append(delta, deltaLine, deltaPill);

    const ruler = {
        el, track, chartDiv, chart: null, left: null, width: 0, innerWidth: 0, toolsWidth: 0, min: null,
        max: null, tools: null,
        delta, deltaLine, deltaPill, deltaText, cursors: [], hasLane: false, locked: false,
    };
    CURSOR_KEYS.forEach(key => {
        const cursorEl = document.createElement('div');
        cursorEl.className = `ruler-cursor ${key.cls}`;
        const pill = document.createElement('div');
        pill.className = 'ruler-cursor-pill';
        cursorEl.appendChild(pill);
        track.appendChild(cursorEl);
        ruler.cursors.push({ ...key, el: cursorEl, pill });
        wireCursorDrag(ruler, key.which, cursorEl, pill);
    });
    wireDeltaPill(ruler);

    // Ligne des curseurs vide: elle dit comment en poser un.
    const hint = document.createElement('div');
    hint.className = 'ruler-lane-hint';
    hint.textContent = 'Ctrl + clic pour poser un curseur';
    track.appendChild(hint);

    // Actions qui portent sur l'axe du temps, a sa droite au-dessus de la colonne des
    // legendes, sur les deux lignes de la regle.
    const tools = document.createElement('div');
    tools.className = 'time-ruler-tools';
    tools.append(
        toolButton('add-cursor', 'Ajouter un curseur (Ctrl + clic gauche)', ICON_ADD_CURSOR, addCursorFromButton),
        toolButton('reset-zoom', 'Réinitialiser le zoom (plage complète, bornes Y libérées)', ICON_RESET_ZOOM,
            resetView),
    );

    ruler.tools = tools;
    el.append(track, tools);
    el._ruler = ruler;
    wrapper.prepend(el);
    track.addEventListener('mousedown', e => onTrackMouseDown(ruler, e));
}

// Bouton d'action de la regle: meme losange que les boutons de la toolbar (.toolbar-btn).
// L'icone rejoue une courte animation a chaque clic (classe retiree en fin d'animation),
// seul retour visible d'une action sans etat.
function toolButton(action, title, icon, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toolbar-btn ruler-tool';
    btn.dataset.action = action;
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.innerHTML = `<span class="toolbar-btn-icon">${icon}</span>`;
    btn.addEventListener('click', () => {
        onClick();
        btn.classList.remove('is-fired');
        // Lecture de layout voulue: sans elle, retirer puis remettre la classe ne relance rien.
        void btn.offsetWidth;
        btn.classList.add('is-fired');
    });
    btn.addEventListener('animationend', () => btn.classList.remove('is-fired'));
    return btn;
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
    // Largeur interieure memorisee ici (chemin de dessin): layoutCursors n'a ainsi aucune
    // lecture de layout a faire pendant le glissement d'un curseur.
    ruler.innerWidth = ruler.el.clientWidth;
    ruler.toolsWidth = ruler.tools ? ruler.tools.offsetWidth : 0;
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

// Largeur rendue d'une pastille. Mesuree une fois par gabarit de texte (chiffres
// neutralises: la police est a chasse fixe) puis relue en cache: mesurer a chaque frame,
// juste apres avoir ecrit le texte, forcait un layout synchrone de la page pendant le
// glissement. Estimee hors layout (rendu en arriere-plan, pastille masquee, tests).
const pillWidths = new Map();
window.addEventListener('resize', () => pillWidths.clear());

function pillWidth(el, text, extra = 0) {
    const key = `${extra}:${text.replace(/\d/g, '0')}`;
    const cached = pillWidths.get(key);
    if (cached) return cached;
    const measured = el.offsetWidth;
    if (measured) pillWidths.set(key, measured);
    return measured || text.length * PILL_CHAR_PX + PILL_PAD_PX + extra;
}

function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(v, hi));
}

// Ligne des curseurs, sous la graduation. Elle est toujours la (la regle garde sa
// hauteur, les graphes ne sont jamais redimensionnes par la pose d'un curseur): la classe
// ne fait que remplacer l'indication de la ligne vide par les pastilles.
function setCursorLane(ruler, on) {
    if (ruler.hasLane === on) return;
    ruler.hasLane = on;
    ruler.el.classList.toggle('has-cursor', on);
}

function layoutCursors(ruler) {
    const u = ruler.chart;
    const decimals = cursorTimeDecimals(u);
    const shown = [];
    // Piste mesuree: un curseur hors de la fenetre garde sa pastille, calee contre le bord
    // de la piste du cote ou il est sorti, mais perd son trait, qui sinon se dessinerait
    // sur la gouttiere ou la colonne des legendes.
    const inTrack = x => !(ruler.width > 0) || (x >= 0 && x <= ruler.width);
    const toTrack = x => (ruler.width > 0 ? clamp(x, 0, ruler.width) : x);

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
        c.el.classList.toggle('is-offscreen', !inTrack(x));
        c.el.style.transform = `translate3d(${x}px, 0, 0)`;
        // Hors fenetre, la pastille vise l'interieur du bord de la piste: centree sur la
        // position reelle du curseur, elle partait flotter au-dessus des legendes.
        const w = pillWidth(c.pill, text);
        const center = inTrack(x) ? x : clamp(x, w / 2, Math.max(w / 2, ruler.width - w / 2));
        shown.push({ el: c.pill, anchor: x, center, w });
    });
    setCursorLane(ruler, shown.length > 0);
    const locked = isCursorLockActive();
    if (ruler.locked !== locked) {
        ruler.locked = locked;
        ruler.el.classList.toggle('is-locked', locked);
        ruler.deltaPill.classList.toggle('is-locked', locked);
        ruler.deltaPill.setAttribute('aria-pressed', locked ? 'true' : 'false');
    }

    // Elements de la ligne, dans l'ordre: pastille de gauche, delta, pastille de droite.
    shown.sort((a, b) => a.anchor - b.anchor);
    const row = [...shown];
    if (shown.length === 2) {
        const [l, r] = shown;
        const text = `Δ ${formatDurationWithMinutes(Math.abs(S.cursor2 - S.cursor1), decimals)}`;
        const pill = ruler.deltaPill;
        if (ruler.deltaText.textContent !== text) ruler.deltaText.textContent = text;
        pill.style.display = 'inline-flex';
        const x1 = toTrack(l.anchor);
        const x2 = toTrack(r.anchor);
        row.splice(1, 0, { el: pill, anchor: 0, center: (x1 + x2) / 2, w: pillWidth(pill, text, LOCK_ICON_PX) });
        showDeltaSpan(ruler, x1, x2);
    } else {
        ruler.delta.style.display = 'none';
        ruler.deltaLine.style.display = 'none';
        ruler.deltaPill.style.display = 'none';
    }

    // Bornes en coordonnees de piste: l'interieur de la regle, qui deborde de la piste
    // a gauche (gouttiere Y) et a droite (colonne des legendes), jusqu'aux boutons.
    const minX = -ruler.left + EDGE_MARGIN;
    const maxX = (ruler.innerWidth || ruler.el.clientWidth) - ruler.toolsWidth - ruler.left - EDGE_MARGIN;
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
// traits sous le delta. Les deux elements ont la largeur de la piste et sont reduits par
// scaleX a la fraction couverte: une largeur ecrite a chaque frame imposait layout et
// peinture, alors qu'une transformation ne coute qu'une composition, dans la meme frame
// que les traits.
// Ne jamais etirer un element de 1px a la place: sa largeur est d'abord calee sur les
// pixels physiques (1px CSS = 1 pixel a 125 %, 2 a 150 %), et l'etirement multiplie cette
// erreur - plage trop courte de 20 % a 125 %, trop longue de 33 % a 150 %. Reduite depuis
// la largeur de la piste, l'erreur reste sous le pixel physique a toute echelle.
function showDeltaSpan(ruler, x1, x2) {
    // Piste pas encore mesuree: pas de fraction calculable, rien a afficher.
    if (!(ruler.width > 0)) {
        ruler.delta.style.display = 'none';
        ruler.deltaLine.style.display = 'none';
        return;
    }
    const transform = `translate3d(${x1}px, 0, 0) scaleX(${Math.max(x2 - x1, 0) / ruler.width})`;
    ruler.delta.style.display = 'block';
    ruler.delta.style.transform = transform;
    ruler.deltaLine.style.display = 'block';
    ruler.deltaLine.style.transform = transform;
}

// Glisser la pastille deplace le curseur; Ctrl+clic le retire, comme sur son trait. Son
// survol epaissit les traits du curseur dans les graphes, comme le survol d'un trait.
function wireCursorDrag(ruler, which, cursorEl, pill) {
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
        cursorEl.classList.add('is-dragging');
        document.body.style.cursor = 'ew-resize';
        document.body.style.userSelect = 'none';

        const onMove = ev => {
            clientX = ev.clientX;
            if (raf !== null) return;
            raf = requestAnimationFrame(() => {
                raf = null;
                const x = Math.max(0, Math.min(clientX - rect.left, rect.width));
                moveCursorTo(which, ruler.chart.posToVal(x, 'x'));
            });
        };
        const onUp = ev => {
            if (raf !== null) cancelAnimationFrame(raf);
            dragging = false;
            cursorEl.classList.remove('is-dragging');
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

// Pastille de delta: un clic (ou Entree/Espace au clavier) bascule le verrou de l'ecart,
// un glisser translate les deux curseurs ensemble, verrou actif ou non. La paire reste
// dans la fenetre affichee quand elle y tenait au depart.
function wireDeltaPill(ruler) {
    const pill = ruler.deltaPill;
    let dragged = false;

    pill.addEventListener('click', () => {
        // Le clic qui termine un glisser ne bascule pas le verrou.
        if (dragged) {
            dragged = false;
            return;
        }
        toggleCursorLock();
    });

    pill.addEventListener('mousedown', e => {
        if (e.button !== 0 || !ruler.chart) return;
        e.stopPropagation();
        e.preventDefault();
        dragged = false;
        const start = { c1: S.cursor1, c2: S.cursor2 };
        if (start.c1 === null || start.c2 === null) return;
        const unitsPerPx = ruler.chart.posToVal(1, 'x') - ruler.chart.posToVal(0, 'x');
        const view = ectx.globalView;
        const minShift = view.min - Math.min(start.c1, start.c2);
        const maxShift = view.max - Math.max(start.c1, start.c2);
        let clientX = e.clientX;
        let raf = null;

        const onMove = ev => {
            clientX = ev.clientX;
            if (!dragged) {
                if (Math.abs(clientX - e.clientX) < DRAG_THRESHOLD_PX) return;
                dragged = true;
                pill.classList.add('is-dragging');
                document.body.style.cursor = 'grabbing';
                document.body.style.userSelect = 'none';
            }
            if (raf !== null) return;
            raf = requestAnimationFrame(() => {
                raf = null;
                let shift = (clientX - e.clientX) * unitsPerPx;
                if (minShift <= maxShift) shift = clamp(shift, minShift, maxShift);
                setCursorPair(start.c1 + shift, start.c2 + shift);
            });
        };
        const onUp = () => {
            if (raf !== null) cancelAnimationFrame(raf);
            pill.classList.remove('is-dragging');
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
