// Baltimore Bird - Liste de signaux virtualisee: rendu, filtrage, selection, drag
// Module extrait de app.js (refactoring): voir src/eda/ARCHITECTURE.md

import { S } from '../core/state.js';
import { openComputedVariableForEdit } from './computed-vars.js';
import { ectx } from './context.js';
import { prefetchSignalView } from './data-views.js';
import { isSeriesSynth, seriesDescriptor } from './overlay.js';
import { themedSignalColor } from './plot-ui.js';
import { isBoolSignalIndex } from './plots.js';
import { ensureSignalPreloaded } from './preload.js';
import { signalRunCoverage } from './runs.js';

// =========================================================================
// Liste de signaux virtualisee
// =========================================================================
// La liste peut contenir des milliers de signaux. Tout monter dans le DOM
// (~30k+ noeuds) rend le rendu initial lent et chaque reflow (resize, etc.)
// tres couteux. On ne monte donc que la fenetre visible (+ marge): un conteneur
// "sizer" porte la hauteur totale et positionne en absolu les items visibles.
const SIGNAL_LIST_PAD = 10;

// marge interne (px), reprise du SCSS .signal-list
const SIGNAL_ITEM_SLOT = 31;

// pas vertical par item (hauteur + espacement)
const SIGNAL_ITEM_HEIGHT = 28;

// hauteur d'un item
const SIGNAL_LIST_BUFFER = 6;

// items rendus hors-ecran de part et d'autre
let filteredSignalIndices = [];

// Selection multiple dans la liste des signaux. Les plages Shift s'etendent sur l'ordre
// FILTRE courant (celui que l'utilisateur voit), depuis l'ancre du dernier clic simple.
const selectedSignals = new Set();

let selectionAnchor = null;

function clearSignalSelection() {
    if (!selectedSignals.size) return;
    selectedSignals.clear();
    selectionAnchor = null;
    renderVirtualList(true);
}

// Semantique explorateur de fichiers: clic = selection simple, Ctrl = bascule,
// Shift = plage depuis l'ancre (cumulable avec Ctrl). Un mousedown simple sur un item
// deja selectionne conserve le groupe, pour pouvoir le saisir au drag.
function updateSignalSelection(idx, e) {
    if (e.shiftKey && selectionAnchor !== null) {
        const anchorPos = filteredSignalIndices.indexOf(selectionAnchor);
        const pos = filteredSignalIndices.indexOf(idx);
        if (anchorPos !== -1 && pos !== -1) {
            if (!e.ctrlKey && !e.metaKey) selectedSignals.clear();
            const [a, b] = anchorPos <= pos ? [anchorPos, pos] : [pos, anchorPos];
            for (let i = a; i <= b; i++) selectedSignals.add(filteredSignalIndices[i]);
        }
    } else if (e.ctrlKey || e.metaKey) {
        if (selectedSignals.has(idx)) selectedSignals.delete(idx);
        else selectedSignals.add(idx);
        selectionAnchor = idx;
    } else {
        if (!selectedSignals.has(idx)) {
            selectedSignals.clear();
            selectedSignals.add(idx);
        }
        selectionAnchor = idx;
    }
    renderVirtualList(true);
}

// Couleurs des signaux actuellement traces (pour l'etat actif dans la liste).
export function signalActiveColorMap() {
    const map = new Map();
    S.plots.forEach(plot => {
        plot.signals.forEach(sigIdx => {
            const customColor = plot.signalStyles?.[sigIdx]?.color;
            const cachedColor = plot.cachedData?.[sigIdx]?.color;
            const defaultColor = S.signalsInfo[sigIdx]?.color;
            map.set(sigIdx, customColor || themedSignalColor(cachedColor || defaultColor));
            // Overlay: relie la serie synthetique du run actif a son item de liste (index reel),
            // pour que la liste reflete l'etat actif meme en mode comparaison.
            if (isSeriesSynth(sigIdx)) {
                const d = seriesDescriptor(sigIdx);
                if (d.sessionId === S.activeRunId && d.realIndex != null) {
                    map.set(d.realIndex, customColor || themedSignalColor(cachedColor || d.color));
                }
            }
        });
    });
    return map;
}

// Construit l'element DOM d'un item (sans ecouteurs: ils sont delegues au
// conteneur, car les items sont crees/detruits au defilement).
function createSignalItemEl(sig, colorMap) {
    const item = document.createElement('div');
    item.className = 'signal-item';
    item.dataset.index = sig.index;
    item.id = `signal-item-${sig.index}`;

    const isLoaded = sig.loaded !== false;
    // Draggable meme non charge: le prechargement demarre au mousedown et le /view du
    // depot charge cote serveur; bloquer le drag faisait attendre tout le round-trip.
    item.draggable = true;
    if (!isLoaded) item.classList.add('not-loaded');
    if (selectedSignals.has(sig.index)) item.classList.add('selected');

    if (sig.computed === true) {
        item.classList.add('computed');
        item.dataset.formula = sig.formula || '';
        item.dataset.description = sig.description || '';
        item.dataset.sourceSignals = JSON.stringify(sig.source_signals || []);
        item.title = `Variable calculée: ${sig.formula}\nDouble-clic pour éditer`;
    }

    const dot = document.createElement('div');
    dot.className = 'signal-dot';
    if (!isLoaded) dot.classList.add('lazy-indicator');

    const nameSpan = document.createElement('span');
    nameSpan.className = 'signal-name';
    nameSpan.textContent = sig.name;

    const unitSpan = document.createElement('span');
    unitSpan.className = 'signal-unit';
    unitSpan.textContent = sig.unit;

    const loader = document.createElement('div');
    loader.className = 'signal-loader';
    loader.style.display = 'none';

    item.appendChild(dot);
    item.appendChild(nameSpan);
    item.appendChild(unitSpan);
    if (S.comparing) {
        const cov = signalRunCoverage(sig.name);
        const covSpan = document.createElement('span');
        covSpan.className = 'signal-coverage' + (cov.count < cov.total ? ' partial' : '');
        covSpan.textContent = `${cov.count}/${cov.total}`;
        covSpan.title = cov.count < cov.total
            ? `Present dans ${cov.count} fichier(s) sur ${cov.total}`
            : `Present dans les ${cov.total} fichiers`;
        item.appendChild(covSpan);
    }
    item.appendChild(loader);

    if (colorMap && colorMap.has(sig.index)) {
        item.classList.add('active');
        const color = colorMap.get(sig.index);
        dot.style.setProperty('--signal-color', color);
        item.style.setProperty('--signal-color', color);
    }

    return item;
}

// Calcule la liste filtree selon la recherche courante.
export function computeFilteredSignals() {
    const input = document.getElementById('search');
    const query = (input?.value || '').toLowerCase().trim();
    if (!query) {
        filteredSignalIndices = S.signalsInfo.map(s => s.index);
        return;
    }
    const terms = query.split(/[\*\s]+/).filter(t => t.length > 0);
    filteredSignalIndices = S.signalsInfo
        .filter(s => terms.every(t => (s.name || '').toLowerCase().includes(t)))
        // Variables calculees en tete des resultats (tri stable: le reste garde son ordre).
        .sort((a, b) => (b.computed === true) - (a.computed === true))
        .map(s => s.index);
}

// Rend la fenetre d'items visibles. force=true reconstruit meme sans changement
// de plage (etat actif/charge modifie, filtre, etc.).
export function renderVirtualList(force = false) {
    const container = document.getElementById('signalList');
    if (!container || !container._vlist) return;

    const sizer = container._vlist.sizer;
    const total = filteredSignalIndices.length;
    const totalHeight = SIGNAL_LIST_PAD * 2 + total * SIGNAL_ITEM_SLOT;
    sizer.style.height = totalHeight + 'px';

    const viewH = container.clientHeight || 400;
    const maxScroll = Math.max(0, totalHeight - viewH);
    if (container.scrollTop > maxScroll) container.scrollTop = maxScroll;
    const scrollTop = container.scrollTop;
    let first = Math.floor((scrollTop - SIGNAL_LIST_PAD) / SIGNAL_ITEM_SLOT) - SIGNAL_LIST_BUFFER;
    let last = Math.ceil((scrollTop + viewH - SIGNAL_LIST_PAD) / SIGNAL_ITEM_SLOT) + SIGNAL_LIST_BUFFER;
    first = Math.max(0, first);
    last = Math.min(total - 1, last);

    if (!force && container._vlist.first === first && container._vlist.last === last) return;
    container._vlist.first = first;
    container._vlist.last = last;

    const colorMap = signalActiveColorMap();
    const frag = document.createDocumentFragment();
    for (let i = first; i <= last; i++) {
        const sig = S.signalsInfo[filteredSignalIndices[i]];
        if (!sig) continue;
        const item = createSignalItemEl(sig, colorMap);
        item.style.position = 'absolute';
        item.style.top = (SIGNAL_LIST_PAD + i * SIGNAL_ITEM_SLOT) + 'px';
        item.style.left = SIGNAL_LIST_PAD + 'px';
        item.style.right = SIGNAL_LIST_PAD + 'px';
        item.style.height = SIGNAL_ITEM_HEIGHT + 'px';
        item.style.marginBottom = '0';
        item.style.boxSizing = 'border-box';
        frag.appendChild(item);
    }
    sizer.replaceChildren(frag);
}

// Ecouteurs delegues sur le conteneur (les items sont recycles au scroll).
function setupSignalListEvents(container) {
    let scrollRaf = null;
    container.addEventListener('scroll', () => {
        if (scrollRaf === null) {
            scrollRaf = requestAnimationFrame(() => { scrollRaf = null; renderVirtualList(); });
        }
    });

    // Conflit double-clic / liste virtuelle: la selection au premier clic re-rend la liste
    // et remplace le noeud DOM, si bien que le dblclick natif ne se declenche jamais (il
    // exige deux clics sur le meme element). On detecte donc le double-clic par index de
    // signal (donnee stable), on ouvre l'edition d'une variable calculee, et on neutralise
    // le drag natif associe (voir le handler dragstart plus bas).
    const DBLCLICK_MS = 350;
    let lastSignalDownTs = 0;
    let lastSignalDownIdx = null;
    let suppressNextDrag = false;

    container.addEventListener('mousedown', e => {
        const item = e.target.closest('.signal-item');
        if (!item) { clearSignalSelection(); return; }

        const idx = parseInt(item.dataset.index);
        const sig = S.signalsInfo[idx];
        if (!sig) { e.preventDefault(); return; }

        const nowTs = Date.now();
        const isDouble = idx === lastSignalDownIdx && (nowTs - lastSignalDownTs) < DBLCLICK_MS;
        lastSignalDownTs = nowTs;
        lastSignalDownIdx = idx;
        suppressNextDrag = isDouble;

        if (isDouble) {
            e.preventDefault();
            lastSignalDownIdx = null;
            if (sig.computed === true) openComputedVariableForEdit(sig);
            return;
        }

        updateSignalSelection(idx, e);

        // Groupe de drag: la selection entiere si l'item saisi en fait partie, dans
        // l'ordre de la liste filtree (celui du futur plot), sinon l'item seul.
        const group = selectedSignals.has(idx)
            ? filteredSignalIndices.filter(i => selectedSignals.has(i))
            : [idx];
        S.draggedSignal = idx;
        S.draggedSignalGroup = group;

        // Prefetch de la vue groupee sous la cle exacte du futur plot (analogiques
        // seulement: les booleens rejoignent le plot dedie, hors de cette cle), puis
        // prechargements individuels pour l'etat de la liste - ils retrouveront le
        // travail du batch serveur sous le verrou de session.
        const analogs = group.filter(i => !isBoolSignalIndex(i));
        if (analogs.length) prefetchSignalView(analogs);
        // Priorite au groupe clique: il passe devant les survols encore en file
        // d'attente (parcours inverse pour que la tete de file respecte l'ordre
        // du groupe apres les unshift successifs).
        [...group].reverse().forEach(i => {
            if (S.signalsInfo[i]?.loaded === false) ensureSignalPreloaded(i, true);
        });

        item.classList.add('dragging');
        const dropZone = document.getElementById(`dropZone-${S.activeTabId}`);
        if (dropZone) dropZone.classList.add('active');
    });

    // Le drag natif demarre malgre tout sur mouvement (attribut draggable). S'il survient
    // dans la fenetre d'un double-clic, on l'annule pour que le dblclick s'ouvre.
    container.addEventListener('dragstart', e => {
        if (suppressNextDrag && e.target.closest('.signal-item')) {
            e.preventDefault();
            suppressNextDrag = false;
        }
    });

    // Clic simple (sans drag: le navigateur supprime le click apres un vrai drag) sur
    // un item d'un groupe selectionne: repli sur la selection simple, comme un explorateur.
    container.addEventListener('click', e => {
        const item = e.target.closest('.signal-item');
        if (!item || e.ctrlKey || e.metaKey || e.shiftKey) return;
        const idx = parseInt(item.dataset.index);
        if (selectedSignals.size > 1 && selectedSignals.has(idx)) {
            selectedSignals.clear();
            selectedSignals.add(idx);
            selectionAnchor = idx;
            renderVirtualList(true);
        }
    });

    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') clearSignalSelection();
    });

    container.addEventListener('dragend', e => {
        const item = e.target.closest('.signal-item');
        if (item) item.classList.remove('dragging');
        S.draggedSignal = null;
        S.draggedSignalGroup = [];
        const dropZone = document.getElementById(`dropZone-${S.activeTabId}`);
        if (dropZone) dropZone.classList.remove('active');
        document.querySelectorAll('.plot-container').forEach(p => p.classList.remove('drop-target'));
    });

    // Precharge au survol (lazy EDA). mouseover/out remontent (delegables).
    let preloadTimer = null;
    let preloadIdx = null;
    container.addEventListener('mouseover', e => {
        const item = e.target.closest('.signal-item');
        if (!item) return;
        const idx = parseInt(item.dataset.index);
        if (preloadIdx === idx) return;
        preloadIdx = idx;
        const sig = S.signalsInfo[idx];
        if (!ectx.currentLazySessionId || !sig || sig.loaded !== false) return;
        clearTimeout(preloadTimer);
        preloadTimer = setTimeout(() => ensureSignalPreloaded(idx), 50);
    });
    container.addEventListener('mouseout', e => {
        const item = e.target.closest('.signal-item');
        if (!item) return;
        if (!item.contains(e.relatedTarget)) {
            clearTimeout(preloadTimer);
            preloadTimer = null;
            preloadIdx = null;
        }
    });
}

// =========================================================================
// Signal List
// =========================================================================
export function renderSignalList() {
    const container = document.getElementById('signalList');
    if (!container) return;

    // La structure de liste virtuelle peut avoir été invalidée: au changement de source,
    // l'indicateur "Chargement..." écrase innerHTML et détache l'ancien sizer du conteneur.
    // On la reconstruit alors. Les écouteurs sont attachés au conteneur lui-même (et non aux
    // items), donc ils survivent à l'écrasement: on les binde une seule fois.
    const vlistValid = container._vlist && container._vlist.sizer.parentNode === container;

    if (!vlistValid) {
        container.textContent = '';
        container.style.position = 'relative';
        container.style.padding = '0';
        const sizer = document.createElement('div');
        sizer.className = 'vlist-sizer';
        sizer.style.position = 'relative';
        sizer.style.width = '100%';
        container.appendChild(sizer);
        container._vlist = { sizer, first: -1, last: -1 };
        if (!container._signalEventsBound) {
            setupSignalListEvents(container);
            container._signalEventsBound = true;
        }
        // Re-rendu apres layout: la hauteur reelle du viewport peut n'etre
        // connue qu'au tick suivant (vue tout juste affichee).
        requestAnimationFrame(() => renderVirtualList(true));
    }

    computeFilteredSignals();
    renderVirtualList(true);
}

