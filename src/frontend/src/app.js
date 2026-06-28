import { S } from './state.js';
import { getUnitConversion } from './units.js';

// =========================================================================
// State
// =========================================================================
const API = '/api';

let plotIdCounter = 0;
let globalView = { min: 0, max: 100 };

// Applique le theme sauvegarde des le chargement (sombre par defaut) pour limiter le flash.
(function initTheme() {
    try {
        const saved = localStorage.getItem('bb-theme') || 'dark';
        document.documentElement.setAttribute('data-theme', saved);
    } catch (_) { /* localStorage indisponible */ }
})();

// Bascule de theme clair / sombre depuis la nav, globale (presente sur toutes les vues).
// Persistee via 'bb-theme'. Au changement, redessine les graphes existants pour que les
// couleurs d'axes et de grille, lues sur les tokens CSS, suivent le theme courant.
function setupNavThemeToggle() {
    const btn = document.getElementById('navThemeToggle');
    if (!btn || btn._listenerAdded) return;
    const sync = () => {
        const light = document.documentElement.getAttribute('data-theme') === 'light';
        btn.classList.toggle('active', light);
        btn.setAttribute('aria-pressed', light ? 'true' : 'false');
    };
    sync();
    btn.addEventListener('click', () => {
        const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
        try { localStorage.setItem('bb-theme', next); } catch (_) { /* stockage indisponible */ }
        document.documentElement.setAttribute('data-theme', next);
        sync();
        if (S.plots) S.plots.forEach(p => p.chart && p.chart.redraw());
    });
    btn._listenerAdded = true;
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupNavThemeToggle);
} else {
    setupNavThemeToggle();
}

// Plage temporelle complete de l'acquisition courante, fixee a chaque chargement.
// Sert de cible au Reset Zoom (independamment de la source de demonstration).
let acquisitionView = { min: 0, max: 100 };
let viewHistory = [];
const MAX_HISTORY = 20;
let redoStack = [];
let currentSource = null;
let currentLazySessionId = null;

let extendedBoolZones = new Map();
let disabledBoolZones = new Set();

// Tabs system

// Flag pour éviter la double initialisation
let edaInitialized = false;

// =========================================================================
// Init
// =========================================================================
async function init() {
    // Vérifie que les éléments DOM existent (vue chargée)
    const signalList = document.getElementById('signalList');
    if (!signalList) {
        console.log('EDA: Vue pas encore chargée, init différée');
        return;
    }
    
    // Évite la double initialisation
    if (edaInitialized) {
        console.log('EDA: Déjà initialisé');
        return;
    }
    
    console.log('EDA: Initialisation...');
    
    // Setup les event listeners
    setupEventListeners();
    
    try {
        // Charge les sources disponibles
        await loadSources();
        
        // Charge les données
        const res = await fetch(`${API}/info`);
        const info = await res.json();
        
        S.signalsInfo = info.signals;
        window.signalsInfo = S.signalsInfo;
        globalView = { min: info.time_range.min, max: info.time_range.max };
        acquisitionView = { ...globalView };
        currentSource = info.source;
        
        document.getElementById('statSignals').textContent = info.n_signals;
        document.getElementById('statDuration').textContent = info.duration.toFixed(0) + 's';
        
        renderSignalList();
        updateSourceSelector();

        // Restaure une éventuelle session éphémère (fichier temporaire d'invité)
        // survivant au rafraîchissement de la page, dans la limite d'une heure
        await restoreEphemeralSession();

        // Initialize create variable modal
        setupCreateVariableListeners();

        // Create first tab (sauf si la restauration de session en a déjà créé)
        if (S.tabs.length === 0) {
            createTab('Main');
        }
        
        edaInitialized = true;
        console.log('EDA: Initialisation terminée');
        
    } catch (e) {
        console.error('Init error:', e);
        document.getElementById('signalList').innerHTML = 
            '<div style="color:#ff6666;padding:20px;">Erreur connexion serveur</div>';
    }

    if (typeof updateAuthUI === 'function') {
        updateAuthUI();
    }
}

// Alias pour le ViewLoader
function initEDA() {
    init();
}

// Alias pour compatibilité
function initApp() {
    init();
}

// =========================================================================
// Utility Functions
// =========================================================================
function escapeHtml(str) {
    if (typeof str !== 'string') return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// =========================================================================
// Sidebar Resize Splitter
// =========================================================================
const SIDEBAR_WIDTH_KEY = 'bb_sidebar_width';
const SIDEBAR_MIN_WIDTH = 180;
const SIDEBAR_MAX_WIDTH = 600;

// Splitter horizontal interne a la sidebar (hauteur de la zone fichiers). Le reste
// revient a la zone signaux, dont la liste virtualisee est re-rendue apres resize.
const SIDEBAR_FILES_HEIGHT_KEY = 'bb_sidebar_files_height';
const SIDEBAR_FILES_MIN_HEIGHT = 60;
const SIDEBAR_FILES_MAX_HEIGHT = 400;
const SIDEBAR_SIGNALS_MIN_HEIGHT = 160;

// =========================================================================
// Liste de signaux virtualisee
// =========================================================================
// La liste peut contenir des milliers de signaux. Tout monter dans le DOM
// (~30k+ noeuds) rend le rendu initial lent et chaque reflow (resize, etc.)
// tres couteux. On ne monte donc que la fenetre visible (+ marge): un conteneur
// "sizer" porte la hauteur totale et positionne en absolu les items visibles.
const SIGNAL_LIST_PAD = 10;     // marge interne (px), reprise du SCSS .signal-list
const SIGNAL_ITEM_SLOT = 40;    // pas vertical par item (hauteur + espacement)
const SIGNAL_ITEM_HEIGHT = 36;  // hauteur d'un item
const SIGNAL_LIST_BUFFER = 6;   // items rendus hors-ecran de part et d'autre
let filteredSignalIndices = [];

// Couleurs des signaux actuellement traces (pour l'etat actif dans la liste).
function signalActiveColorMap() {
    const map = new Map();
    S.plots.forEach(plot => {
        plot.signals.forEach(sigIdx => {
            const customColor = plot.signalStyles?.[sigIdx]?.color;
            const cachedColor = plot.cachedData?.[sigIdx]?.color;
            const defaultColor = S.signalsInfo[sigIdx]?.color;
            map.set(sigIdx, customColor || cachedColor || defaultColor);
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
    item.draggable = isLoaded;
    if (!isLoaded) item.classList.add('not-loaded');

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
function computeFilteredSignals() {
    const input = document.getElementById('search');
    const query = (input?.value || '').toLowerCase().trim();
    if (!query) {
        filteredSignalIndices = S.signalsInfo.map(s => s.index);
        return;
    }
    const terms = query.split(/[\*\s]+/).filter(t => t.length > 0);
    filteredSignalIndices = S.signalsInfo
        .filter(s => terms.every(t => (s.name || '').toLowerCase().includes(t)))
        .map(s => s.index);
}

// Rend la fenetre d'items visibles. force=true reconstruit meme sans changement
// de plage (etat actif/charge modifie, filtre, etc.).
function renderVirtualList(force = false) {
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

    container.addEventListener('mousedown', e => {
        const item = e.target.closest('.signal-item');
        if (!item) return;
        const idx = parseInt(item.dataset.index);
        const sig = S.signalsInfo[idx];
        if (!sig || sig.loaded === false) { e.preventDefault(); return; }
        S.draggedSignal = idx;
        prefetchSignalView(idx);
        item.classList.add('dragging');
        const dropZone = document.getElementById(`dropZone-${S.activeTabId}`);
        if (dropZone) dropZone.classList.add('active');
    });

    container.addEventListener('dragend', e => {
        const item = e.target.closest('.signal-item');
        if (item) item.classList.remove('dragging');
        S.draggedSignal = null;
        const dropZone = document.getElementById(`dropZone-${S.activeTabId}`);
        if (dropZone) dropZone.classList.remove('active');
        document.querySelectorAll('.plot-container').forEach(p => p.classList.remove('drop-target'));
    });

    container.addEventListener('dblclick', e => {
        const item = e.target.closest('.signal-item');
        if (!item) return;
        const sig = S.signalsInfo[parseInt(item.dataset.index)];
        if (sig && sig.computed === true) openComputedVariableForEdit(sig);
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
        if (!currentLazySessionId || !sig || sig.loaded !== false) return;
        clearTimeout(preloadTimer);
        preloadTimer = setTimeout(() => preloadSignalOnHover(idx, item), 150);
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

// Redimensionne tous les graphes a la taille actuelle de leur conteneur.
function resizeAllChartsNow() {
    S.plots.forEach(plot => {
        if (!plot.chart) return;
        const body = plot.element.querySelector('.plot-body');
        if (body) plot.chart.setSize({ width: body.clientWidth, height: body.clientHeight });
    });
}

// Drag de redimensionnement performant: pendant le glissement on ne bouge qu'une
// fine ligne fantome (transform, compositeur seul, aucun reflow) et un bouclier
// transparent capte la souris pour supprimer le :hover sur le contenu. La taille
// reelle n'est appliquee qu'au relachement, via commit(ghostX).
// - startClientX: position initiale du curseur
// - clampGhostX(x): contraint la position X de la ligne fantome
// - commit(ghostX): applique le resultat (appele une fois au relachement)
function beginGhostResize(startClientX, clampGhostX, commit) {
    let ghostX = clampGhostX(startClientX);
    let rafId = null;

    const shield = document.createElement('div');
    shield.style.cssText = 'position:fixed;inset:0;z-index:9998;cursor:col-resize;';
    document.body.appendChild(shield);

    const ghost = document.createElement('div');
    ghost.style.cssText = 'position:fixed;top:0;bottom:0;left:0;width:2px;'
        + 'background:#3b82f6;z-index:9999;pointer-events:none;'
        + `transform:translateX(${ghostX}px);`;
    document.body.appendChild(ghost);

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const move = () => { rafId = null; ghost.style.transform = `translateX(${ghostX}px)`; };
    const onMove = (e) => {
        ghostX = clampGhostX(e.clientX);
        if (rafId === null) rafId = requestAnimationFrame(move);
    };
    const onUp = () => {
        if (rafId !== null) cancelAnimationFrame(rafId);
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        ghost.remove();
        shield.remove();
        commit(ghostX);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
}

// Variante verticale de beginGhostResize: la ligne fantome est horizontale et
// suit clientY. Utilisee par le splitter interne a la sidebar (zone fichiers).
function beginGhostResizeY(startClientY, clampGhostY, commit) {
    let ghostY = clampGhostY(startClientY);
    let rafId = null;

    const shield = document.createElement('div');
    shield.style.cssText = 'position:fixed;inset:0;z-index:9998;cursor:row-resize;';
    document.body.appendChild(shield);

    const ghost = document.createElement('div');
    ghost.style.cssText = 'position:fixed;left:0;right:0;top:0;height:2px;'
        + 'background:#3b82f6;z-index:9999;pointer-events:none;'
        + `transform:translateY(${ghostY}px);`;
    document.body.appendChild(ghost);

    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';

    const move = () => { rafId = null; ghost.style.transform = `translateY(${ghostY}px)`; };
    const onMove = (e) => {
        ghostY = clampGhostY(e.clientY);
        if (rafId === null) rafId = requestAnimationFrame(move);
    };
    const onUp = () => {
        if (rafId !== null) cancelAnimationFrame(rafId);
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        ghost.remove();
        shield.remove();
        commit(ghostY);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
}

// Ajoute un splitter vertical apres la sidebar pour la redimensionner (utile
// pour les noms de signaux longs). La largeur est persistee dans localStorage.
function setupSidebarSplitter() {
    const sidebar = document.querySelector('.sidebar');
    if (!sidebar) return;
    if (sidebar.nextElementSibling?.classList.contains('sidebar-splitter')) return;

    const saved = parseInt(localStorage.getItem(SIDEBAR_WIDTH_KEY), 10);
    if (Number.isFinite(saved) && saved >= SIDEBAR_MIN_WIDTH && saved <= SIDEBAR_MAX_WIDTH) {
        sidebar.style.width = saved + 'px';
    }
    sidebar.style.flexShrink = '0';

    const splitter = document.createElement('div');
    splitter.className = 'sidebar-splitter';
    splitter.style.cssText = 'flex:0 0 5px;cursor:col-resize;'
        + 'background:rgba(255,255,255,0.04);align-self:stretch;';
    sidebar.insertAdjacentElement('afterend', splitter);

    splitter.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const left = sidebar.getBoundingClientRect().left;
        const clamp = (x) => Math.min(left + SIDEBAR_MAX_WIDTH, Math.max(left + SIDEBAR_MIN_WIDTH, x));
        splitter.style.background = 'rgba(255,255,255,0.15)';
        beginGhostResize(e.clientX, clamp, (ghostX) => {
            splitter.style.background = 'rgba(255,255,255,0.04)';
            const width = Math.round(ghostX - left);
            sidebar.style.width = width + 'px';
            try {
                localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
            } catch (err) { /* stockage indisponible */ }
            requestAnimationFrame(resizeAllChartsNow);
        });
    });
}

// Splitter interne a la sidebar: ajuste la hauteur de la zone fichiers, la zone
// signaux occupant le reste. La hauteur est persistee et la liste virtualisee est
// re-rendue (force) apres resize, sa hauteur visible ayant change.
function setupSidebarVSplitter() {
    const files = document.getElementById('sidebarFiles');
    const splitter = document.getElementById('sidebarVSplitter');
    const sidebar = document.querySelector('.sidebar');
    if (!files || !splitter || !sidebar || splitter._listenerAdded) return;

    const clampHeight = (h) => Math.min(SIDEBAR_FILES_MAX_HEIGHT, Math.max(SIDEBAR_FILES_MIN_HEIGHT, h));
    const saved = parseInt(localStorage.getItem(SIDEBAR_FILES_HEIGHT_KEY), 10);
    if (Number.isFinite(saved)) files.style.height = clampHeight(saved) + 'px';

    splitter.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const top = files.getBoundingClientRect().top;
        const sidebarBottom = sidebar.getBoundingClientRect().bottom;
        const maxByLayout = Math.min(top + SIDEBAR_FILES_MAX_HEIGHT, sidebarBottom - SIDEBAR_SIGNALS_MIN_HEIGHT);
        const clampY = (y) => Math.min(maxByLayout, Math.max(top + SIDEBAR_FILES_MIN_HEIGHT, y));
        beginGhostResizeY(e.clientY, clampY, (ghostY) => {
            const height = Math.round(ghostY - top);
            files.style.height = height + 'px';
            try {
                localStorage.setItem(SIDEBAR_FILES_HEIGHT_KEY, String(height));
            } catch (err) { /* stockage indisponible */ }
            renderVirtualList(true);
        });
    });
    splitter._listenerAdded = true;
}

// =========================================================================
// Largeur partagee des legendes (plot-legend)
// =========================================================================
// Toutes les legendes partagent une meme largeur, reglable via un splitter entre
// le graphe et sa legende. Permet d'afficher les noms complets des signaux.
const LEGEND_WIDTH_KEY = 'bb_legend_width';
const LEGEND_MIN_WIDTH = 120;
const LEGEND_MAX_WIDTH = 700;
let legendWidth = null; // null => largeur par defaut du CSS

function loadLegendWidth() {
    const saved = parseInt(localStorage.getItem(LEGEND_WIDTH_KEY), 10);
    if (Number.isFinite(saved) && saved >= LEGEND_MIN_WIDTH && saved <= LEGEND_MAX_WIDTH) {
        legendWidth = saved;
    }
}

// Applique la largeur partagee a une legende (transition coupee pour eviter un
// decalage avec le redimensionnement du graphe).
function applyLegendWidthTo(el) {
    if (legendWidth == null || !el) return;
    el.style.transition = 'none';
    el.style.width = legendWidth + 'px';
}

// Applique la largeur partagee a toutes les legendes existantes.
function applyLegendWidth() {
    if (legendWidth == null) return;
    document.querySelectorAll('.plot-legend').forEach(applyLegendWidthTo);
}

// Demarre le redimensionnement (lie) des legendes depuis le splitter d'un plot.
function startLegendResize(e, plotMain, splitter) {
    e.preventDefault();
    const mainRight = plotMain.getBoundingClientRect().right;
    const clamp = (x) => Math.min(
        mainRight - LEGEND_MIN_WIDTH,
        Math.max(mainRight - LEGEND_MAX_WIDTH, x)
    );
    splitter.style.background = 'rgba(255,255,255,0.15)';
    beginGhostResize(e.clientX, clamp, (ghostX) => {
        splitter.style.background = 'rgba(255,255,255,0.04)';
        legendWidth = Math.round(mainRight - ghostX);
        try {
            localStorage.setItem(LEGEND_WIDTH_KEY, String(legendWidth));
        } catch (err) { /* stockage indisponible */ }
        applyLegendWidth();
        requestAnimationFrame(resizeAllChartsNow);
    });
}

// =========================================================================
// Event Listeners Setup
// =========================================================================
function setupEventListeners() {
    // Splitter de redimensionnement de la sidebar
    setupSidebarSplitter();
    // Splitter interne fichiers / signaux
    setupSidebarVSplitter();

    // Largeur partagee des legendes (persistee)
    loadLegendWidth();

    // Search
    const searchInput = document.getElementById('search');
    if (searchInput && !searchInput._listenerAdded) {
        searchInput.addEventListener('input', () => {
            computeFilteredSignals();
            const container = document.getElementById('signalList');
            if (container) container.scrollTop = 0;
            renderVirtualList(true);
        });
        searchInput._listenerAdded = true;
    }
    
    // Cursor Button: ajoute un curseur, comportement identique au Ctrl+clic gauche
    const addCursorBtn = document.getElementById('addCursorBtn');
    if (addCursorBtn && !addCursorBtn._listenerAdded) {
        addCursorBtn.addEventListener('click', addCursorFromButton);
        addCursorBtn._listenerAdded = true;
    }

    // Bouton bascule des infos de curseur (temps, ligne/valeur de delta, valeurs par
    // courbe). Actif par defaut: pas de classe sur body, donc labels visibles.
    const cursorLabelsToggle = document.getElementById('cursorLabelsToggle');
    if (cursorLabelsToggle && !cursorLabelsToggle._listenerAdded) {
        cursorLabelsToggle.addEventListener('click', () => {
            const on = cursorLabelsToggle.classList.toggle('active');
            cursorLabelsToggle.setAttribute('aria-pressed', on ? 'true' : 'false');
            document.body.classList.toggle('hide-cursor-labels', !on);
        });
        cursorLabelsToggle._listenerAdded = true;
    }

    // Reset Button
    const resetBtn = document.getElementById('resetBtn');
    if (resetBtn && !resetBtn._listenerAdded) {
        resetBtn.addEventListener('click', () => {
            // Reset complet: bornes Y liberees et fenetre temporelle ramenee a la
            // plage complete de l'acquisition courante (et non d'une source de demo).
            S.plots.forEach(p => { p.yRange = null; });
            viewHistory = [];
            redoStack = [];
            globalView = { ...acquisitionView };
            refreshAllPlots();
        });
        resetBtn._listenerAdded = true;
    }
    
    // Clear Button
    const clearBtn = document.getElementById('clearBtn');
    if (clearBtn && !clearBtn._listenerAdded) {
        clearBtn.addEventListener('click', () => {
            S.plots.slice().forEach(p => deletePlot(p.id));
        });
        clearBtn._listenerAdded = true;
    }

    // EDA-specific event listeners
    setupEdaEventListeners();
}

function setupEdaEventListeners() {
    // Source selector
    const sourceSelector = document.getElementById('sourceSelector');
    if (sourceSelector && !sourceSelector._listenerAdded) {
        sourceSelector.addEventListener('change', function() {
            if (typeof changeSource === 'function') changeSource();
        });
        sourceSelector._listenerAdded = true;
    }

    // Upload buttons
    const uploadBtnAuth = document.getElementById('uploadBtnAuth');
    if (uploadBtnAuth && !uploadBtnAuth._listenerAdded) {
        uploadBtnAuth.addEventListener('click', function() {
            if (typeof openUploadModal === 'function') openUploadModal();
        });
        uploadBtnAuth._listenerAdded = true;
    }

    const uploadBtnGuest = document.getElementById('uploadBtnGuest');
    if (uploadBtnGuest && !uploadBtnGuest._listenerAdded) {
        uploadBtnGuest.addEventListener('click', function() {
            if (typeof openUploadModal === 'function') openUploadModal();
        });
        uploadBtnGuest._listenerAdded = true;
    }

    // Tab add button
    const tabAddBtn = document.getElementById('tabAddBtn');
    if (tabAddBtn && !tabAddBtn._listenerAdded) {
        tabAddBtn.addEventListener('click', function() {
            if (typeof createTab === 'function') createTab();
        });
        tabAddBtn._listenerAdded = true;
    }

    // Save layout button
    const saveLayoutBtn = document.getElementById('saveLayoutBtn');
    if (saveLayoutBtn && !saveLayoutBtn._listenerAdded) {
        saveLayoutBtn.addEventListener('click', function() {
            if (typeof window.saveLayout === 'function') window.saveLayout();
        });
        saveLayoutBtn._listenerAdded = true;
    }

    // Load layout button
    const loadLayoutBtn = document.getElementById('loadLayoutBtn');
    if (loadLayoutBtn && !loadLayoutBtn._listenerAdded) {
        loadLayoutBtn.addEventListener('click', function() {
            if (typeof window.loadLayout === 'function') window.loadLayout();
        });
        loadLayoutBtn._listenerAdded = true;
    }
}

// =========================================================================
// Data Sources
// =========================================================================
async function loadSources() {
    try {
        // Prépare les headers avec auth si disponible
        const headers = {};
        const token = sessionStorage.getItem('auth_token');
        if (token) {
            headers['Authorization'] = 'Bearer ' + token;
        }
        
        const res = await fetch(`${API}/sources`, { headers });
        const data = await res.json();
        
        const selector = document.getElementById('sourceSelector');
        if (!selector) return;

        // Liste a plat (sans groupes): la categorisation demo / utilisateur n'a pas
        // de sens pour une comparaison, personne ne compare un fichier de demo a un upload.
        selector.innerHTML = '';
        const appendOption = (src) => {
            const option = document.createElement('option');
            option.value = src.id;
            option.textContent = src.name + (src.available === false ? ' (non disponible)' : '');
            option.disabled = src.available === false;
            selector.appendChild(option);
        };
        data.sources.filter(s => s.category === 'demo' || !s.category).forEach(appendOption);
        data.sources.filter(s => s.category === 'user').forEach(appendOption);

        if (data.current) {
            selector.value = data.current;
            currentSource = data.current;
        }
        if (typeof window.refreshRunList === 'function') window.refreshRunList();
    } catch (e) {
        console.error('Failed to load sources:', e);
    }
}

function updateSourceSelector() {
    const selector = document.getElementById('sourceSelector');
    if (currentSource && selector) {
        selector.value = currentSource;
    }
    if (typeof window.refreshRunList === 'function') window.refreshRunList();
}

const EPHEMERAL_SESSION_KEY = 'bb_ephemeral_session';
const EPHEMERAL_SESSION_TTL_MS = 60 * 60 * 1000; // Aligné sur le timeout serveur (1h)

function saveEphemeralSession(sessionId, filename) {
    try {
        localStorage.setItem(EPHEMERAL_SESSION_KEY, JSON.stringify({
            sessionId, filename, savedAt: Date.now()
        }));
    } catch (e) { /* stockage local indisponible: la session ne survivra pas au refresh */ }
}

// Snapshot du travail en cours (layout + zoom) dans la session éphémère,
// pour ne rien perdre en cas de rafraîchissement de la page
function persistEphemeralWorkspace() {
    if (!currentLazySessionId) return;
    try {
        const raw = localStorage.getItem(EPHEMERAL_SESSION_KEY);
        if (!raw) return;
        const saved = JSON.parse(raw);
        if (saved.sessionId !== currentLazySessionId) return;

        saved.layout = exportCurrentLayout();
        saved.view = { min: globalView.min, max: globalView.max };

        // Curseurs de mesure: synchronise l'onglet actif puis sauvegarde par onglet
        const activeTab = S.tabs.find(t => t.id === S.activeTabId);
        if (activeTab) {
            activeTab.cursor1 = S.cursor1;
            activeTab.cursor2 = S.cursor2;
        }
        saved.cursorsByTab = S.tabs.map(t => [t.cursor1, t.cursor2]);
        saved.activeTabIndex = Math.max(0, S.tabs.findIndex(t => t.id === S.activeTabId));

        saved.savedAt = Date.now();
        localStorage.setItem(EPHEMERAL_SESSION_KEY, JSON.stringify(saved));
    } catch (e) { /* best effort */ }
}

window.addEventListener('beforeunload', persistEphemeralWorkspace);
window.addEventListener('pagehide', persistEphemeralWorkspace);
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') persistEphemeralWorkspace();
});

function loadEphemeralSession() {
    try {
        const raw = localStorage.getItem(EPHEMERAL_SESSION_KEY);
        if (!raw) return null;
        const saved = JSON.parse(raw);
        if (!saved.sessionId || Date.now() - saved.savedAt > EPHEMERAL_SESSION_TTL_MS) {
            localStorage.removeItem(EPHEMERAL_SESSION_KEY);
            return null;
        }
        return saved;
    } catch (e) {
        return null;
    }
}

function clearEphemeralSession() {
    try { localStorage.removeItem(EPHEMERAL_SESSION_KEY); } catch (e) { /* no-op */ }
}

// Bascule l'EDA sur une session lazy (fichier uploadé), met à jour le sélecteur
// de sources et persiste les sessions éphémères pour survivre au refresh.
async function activateLazySession(sessionId, filename, ephemeral) {
    const headers = {};
    const token = sessionStorage.getItem('auth_token');
    if (token) headers['Authorization'] = 'Bearer ' + token;

    const res = await fetch(`${API}/eda/list-signals/${sessionId}`, { headers });
    const listing = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error(listing.error || 'Session indisponible');
    }

    S.plots.slice().forEach(p => deletePlot(p.id));
    // Purge les zones etendues residuelles d'un fichier precedent.
    extendedBoolZones.clear();
    disabledBoolZones.clear();
    currentLazySessionId = sessionId;
    S.signalsInfo = listing.signals;
    window.signalsInfo = S.signalsInfo;
    globalView = { min: listing.time_range.min, max: listing.time_range.max };
    acquisitionView = { ...globalView };

    document.getElementById('statSignals').textContent = listing.n_signals;
    document.getElementById('statDuration').textContent = listing.duration.toFixed(0) + 's';

    // Le fichier apparaît dans le sélecteur et y est sélectionné
    const selector = document.getElementById('sourceSelector');
    const sourceId = 'session_' + sessionId;
    if (selector) {
        let option = selector.querySelector(`option[value="${sourceId}"]`);
        if (!option) {
            option = document.createElement('option');
            option.value = sourceId;
            selector.appendChild(option);
        }
        option.textContent = filename + (ephemeral ? ' (temporaire)' : '');
        selector.value = sourceId;
    }
    currentSource = sourceId;

    if (ephemeral) {
        saveEphemeralSession(sessionId, filename);
    }

    renderSignalList();
    if (typeof window.refreshRunList === 'function') window.refreshRunList();
    return listing;
}

// Au chargement de la page, tente de restaurer la session éphémère précédente
async function restoreEphemeralSession() {
    const saved = loadEphemeralSession();
    if (!saved) return false;

    try {
        await activateLazySession(saved.sessionId, saved.filename, true);

        if (saved.layout && saved.layout.tabs && saved.layout.tabs.length > 0) {
            await applyLayout(saved.layout);
        }
        if (saved.view && Number.isFinite(saved.view.min) && Number.isFinite(saved.view.max)
                && saved.view.max > saved.view.min) {
            globalView = { min: saved.view.min, max: saved.view.max };
            refreshAllPlots();
        }

        if (Array.isArray(saved.cursorsByTab)) {
            saved.cursorsByTab.forEach((pair, idx) => {
                if (S.tabs[idx] && Array.isArray(pair)) {
                    S.tabs[idx].cursor1 = Number.isFinite(pair[0]) ? pair[0] : null;
                    S.tabs[idx].cursor2 = Number.isFinite(pair[1]) ? pair[1] : null;
                }
            });
            const activeIdx = Number.isInteger(saved.activeTabIndex) ? saved.activeTabIndex : 0;
            const activeTab = S.tabs[activeIdx] || S.tabs[0];
            if (activeTab) {
                S.cursor1 = activeTab.cursor1;
                S.cursor2 = activeTab.cursor2;
                updateCursors();
            }
        }

        return true;
    } catch (e) {
        // Session expirée côté serveur
        clearEphemeralSession();
        return false;
    }
}

async function changeSource() {
    const selector = document.getElementById('sourceSelector');
    if (!selector) return;
    
    const newSource = selector.value;
    
    if (newSource === currentSource) return;

    // Option de session lazy (fichier uploadé): réactivation directe, pas de POST source
    if (newSource.startsWith('session_')) {
        const sessionId = newSource.slice('session_'.length);
        const label = selector.options[selector.selectedIndex]?.textContent || '';
        const ephemeral = label.includes('(temporaire)');
        const filename = label.replace(' (temporaire)', '');
        try {
            await activateLazySession(sessionId, filename, ephemeral);
        } catch (e) {
            showNotification('Cette session a expiré', 'warning');
            clearEphemeralSession();
            selector.querySelector(`option[value="${newSource}"]`)?.remove();
            selector.value = currentSource || 'mf4';
        }
        return;
    }

    // Affiche un indicateur de chargement
    const signalList = document.getElementById('signalList');
    if (signalList) {
        signalList.innerHTML = '<div class="signal-list-empty">Chargement...</div>';
    }
    
    // Efface les plots existants
    S.plots.slice().forEach(p => deletePlot(p.id));
    // Purge les zones etendues residuelles d'une source precedente.
    extendedBoolZones.clear();
    disabledBoolZones.clear();
    
    try {
        // Change la source côté serveur. Le token n'est joint que s'il existe :
        // les sources de démonstration sont accessibles sans authentification.
        const token = typeof getAuthToken === 'function' ? getAuthToken() : null;
        const res = (token && typeof authFetch === 'function')
            ? await authFetch(`${API}/source/${newSource}`, { method: 'POST' })
            : await fetch(`${API}/source/${newSource}`, { method: 'POST' });
        
        const data = await res.json();
        
        if (data.error) {
            throw new Error(data.error);
        }
        
        // Pour les sources lazy (fichiers utilisateur), les infos sont déjà dans la réponse
        if (data.lazy && data.signals) {
            if (data.session_id) {
                currentLazySessionId = data.session_id;
            }
            
            S.signalsInfo = data.signals;
            window.signalsInfo = S.signalsInfo;
            globalView = { min: data.time_range.min, max: data.time_range.max };
            acquisitionView = { ...globalView };
            currentSource = data.source;
            
            document.getElementById('statSignals').textContent = data.n_signals;
            document.getElementById('statDuration').textContent = data.duration.toFixed(0) + 's';
            
            renderSignalList();
            updateSourceSelector();
            
            console.log(`Switched to lazy source: ${currentSource}`);
        } else {
            // Pour les sources classiques, recharge les infos via /api/info
            currentLazySessionId = null;
            
            const infoRes = (token && typeof authFetch === 'function')
                ? await authFetch(`${API}/info`)
                : await fetch(`${API}/info`);
            
            const info = await infoRes.json();
            
            S.signalsInfo = info.signals;
            window.signalsInfo = S.signalsInfo;
            globalView = { min: info.time_range.min, max: info.time_range.max };
            acquisitionView = { ...globalView };
            currentSource = info.source;
            
            document.getElementById('statSignals').textContent = info.n_signals;
            document.getElementById('statDuration').textContent = info.duration.toFixed(0) + 's';
            
            renderSignalList();
            updateSourceSelector();
            
            console.log(`Switched to source: ${currentSource}`);
        }
        
    } catch (e) {
        console.error('Failed to change source:', e);
        alert('Erreur lors du changement de source: ' + e.message);
        selector.value = currentSource; // Revert
    }
}

// =========================================================================
// Signal List
// =========================================================================
function renderSignalList() {
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


async function preloadSignalOnHover(signalIndex, itemElement) {
    if (!currentLazySessionId) return;
    
    // Vérifier si déjà chargé
    const sig = S.signalsInfo[signalIndex];
    if (!sig || sig.loaded !== false) return;
    
    // Afficher le loader
    const loader = itemElement.querySelector('.signal-loader');
    if (loader) loader.style.display = 'block';
    
    itemElement.classList.add('loading');
    
    try {
        const headers = {};
        const token = sessionStorage.getItem('auth_token');
        if (token) {
            headers['Authorization'] = 'Bearer ' + token;
        }
        
        const response = await fetch(
            `${API}/eda/preload-signal/${currentLazySessionId}/${signalIndex}`,
            { method: 'POST', headers }
        );
        
        const data = await response.json();
        
        if (response.ok && data.status === 'ready') {
            // Mettre à jour l'état du signal
            sig.loaded = true;
            
            if (data.string_map) {
                sig.stringMap = data.string_map;
                sig.isCategorical = true;
            }

            if (data.unit) {
                sig.unit = data.unit;
            }

            // Mettre à jour l'affichage
            itemElement.classList.remove('not-loaded', 'loading');
            itemElement.draggable = true;
            
            const dot = itemElement.querySelector('.signal-dot');
            if (dot) {
                dot.classList.remove('lazy-indicator');
            }

            const catLabel = data.is_categorical ? ' [categorical]' : '';
            console.log(`[LazyEDA] Signal "${sig.name}" préchargé (${data.n_samples} pts)${catLabel}`);
        } else {
            console.warn(`[LazyEDA] Échec préchargement signal ${signalIndex}:`, data.error);
            itemElement.classList.add('load-error');
        }
        
    } catch (e) {
        console.error(`[LazyEDA] Erreur préchargement signal ${signalIndex}:`, e);
        itemElement.classList.add('load-error');
    } finally {
        if (loader) loader.style.display = 'none';
        itemElement.classList.remove('loading');
    }
}


function extractBoolHighRanges(timestamps, values, threshold = 0.5) {
    const ranges = [];
    let inHigh = false;
    let rangeStart = null;
    
    for (let i = 0; i < timestamps.length; i++) {
        const isHigh = values[i] > threshold;
        
        if (isHigh && !inHigh) {
            // Début d'une zone high
            rangeStart = timestamps[i];
            inHigh = true;
        } else if (!isHigh && inHigh) {
            // Fin d'une zone high
            ranges.push([rangeStart, timestamps[i]]);
            inHigh = false;
        }
    }
    
    // Si on termine en high, fermer la dernière range
    if (inHigh && rangeStart !== null) {
        ranges.push([rangeStart, timestamps[timestamps.length - 1]]);
    }
    
    return ranges;
}

function boolZonesPlugin() {
    return {
        hooks: {
            drawClear: u => {
                // Dessine les zones AVANT les données (en fond)
                if (extendedBoolZones.size === 0) return;
                
                const ctx = u.ctx;
                const { left, top, width, height } = u.bbox;
                
                // Facteur de scale pour device pixel ratio
                const pxRatio = devicePixelRatio || 1;
                
                extendedBoolZones.forEach((zoneData, sigIdx) => {
                    const { color, ranges } = zoneData;
                    
                    // Couleur avec opacité réduite (20%)
                    ctx.fillStyle = colorWithOpacity(color, 0.15);
                    
                    ranges.forEach(([start, end]) => {
                        // Convertir les temps en positions pixels
                        const xStart = u.valToPos(start, 'x', true);
                        const xEnd = u.valToPos(end, 'x', true);
                        
                        // Ne dessiner que si visible dans la vue
                        if (xEnd < left || xStart > left + width) return;
                        
                        // Clipper aux limites du graphique
                        const drawX = Math.max(left, xStart);
                        const drawWidth = Math.min(left + width, xEnd) - drawX;
                        
                        if (drawWidth > 0) {
                            ctx.fillRect(drawX, top, drawWidth, height);
                        }
                    });
                });
            }
        }
    };
}

// =========================================================================
// Layout Save/Load System
// =========================================================================

/**
 * Exporte l'état actuel en format layout JSON.
 * Les signaux sont référencés par nom (pas index) pour la portabilité.
 */
function exportCurrentLayout() {
    const layoutTabs = S.tabs.map(tab => {
        const tabPlots = (tab.plots || []).map(plot => {
            const plotSignals = plot.signals.map(sigIdx => {
                const sig = S.signalsInfo[sigIdx];
                const style = plot.signalStyles?.[sigIdx] || { color: sig?.color || '#fff', width: 1.5, dash: '' };
                return {
                    name: sig?.name || `Signal_${sigIdx}`,
                    style: {
                        color: style.color,
                        width: style.width,
                        dash: style.dash || '',
                        path: style.path || '',
                        fill: style.fill || ''
                    }
                };
            });
            
            // Récupérer le ratio flex du plot
            const flex = plot.element?.style?.flex || '1';
            
            return {
                flex: parseFloat(flex) || 1,
                signals: plotSignals
            };
        });
        
        return {
            name: tab.name,
            plots: tabPlots
        };
    });
    
    // Récupérer les variables calculées
    const computedVars = S.signalsInfo
        .filter(sig => sig.computed)
        .map(sig => ({
            name: sig.name,
            unit: sig.unit || '',
            description: sig.description || '',
            formula: sig.formula || '',
            source_signals: sig.source_signals || []
        }));
    
    return {
        tabs: layoutTabs,
        computed_variables: computedVars
    };
}

/**
 * Applique un layout au système.
 * Résout les noms de signaux vers les index actuels.
 */
// Applique un style sauvegarde a un signal d'un panneau (restauration layout).
function applyRestoredStyle(plot, sigIdx, style) {
    if (!style) return;
    if (!plot.signalStyles) plot.signalStyles = {};
    plot.signalStyles[sigIdx] = {
        color: style.color,
        width: style.width || 1.5,
        dash: style.dash || '',
        path: style.path || '',
        fill: style.fill || ''
    };
}

async function applyLayout(layout) {
    if (!layout || !layout.tabs) {
        console.error('Layout invalide');
        return false;
    }
    
    // Créer un map nom -> index pour les signaux actuels
    const signalNameToIndex = {};
    S.signalsInfo.forEach(sig => {
        signalNameToIndex[sig.name] = sig.index;
    });
    
    // 1. D'abord créer les variables calculées si nécessaire
    if (layout.computed_variables && layout.computed_variables.length > 0) {
        for (const cv of layout.computed_variables) {
            // Vérifier si elle existe déjà
            const existing = S.signalsInfo.find(s => s.name === cv.name && s.computed);
            if (!existing) {
                // Reconstruire le mapping A, B, C... -> signal names
                const mapping = {};
                const formulaVars = [...new Set((cv.formula.match(/\b([A-Z])\b/g) || []))].sort();
                
                formulaVars.forEach((varLetter, idx) => {
                    if (idx < (cv.source_signals || []).length) {
                        const sourceName = cv.source_signals[idx];
                        if (signalNameToIndex[sourceName] !== undefined) {
                            mapping[varLetter] = sourceName;
                        }
                    }
                });
                
                // Créer la variable si tous les signaux sources existent
                if (Object.keys(mapping).length === formulaVars.length) {
                    try {
                        const cvHeaders = { 'Content-Type': 'application/json' };
                        const cvToken = sessionStorage.getItem('auth_token');
                        if (cvToken) cvHeaders['Authorization'] = 'Bearer ' + cvToken;
                        const response = await fetch(`${API}/create-variable`, {
                            method: 'POST',
                            headers: cvHeaders,
                            body: JSON.stringify({
                                name: cv.name,
                                unit: cv.unit || '',
                                description: cv.description || '',
                                formula: cv.formula,
                                mapping: mapping,
                                session_id: currentLazySessionId
                            })
                        });
                        
                        if (response.ok) {
                            console.log(`Created computed variable: ${cv.name}`);
                        }
                    } catch (e) {
                        console.warn(`Failed to create computed variable ${cv.name}:`, e);
                    }
                } else {
                    console.warn(`Cannot create ${cv.name}: missing source signals`);
                }
            }
        }
        
        // Recharger signalsInfo après création des variables
        const infoRes = await fetch(`${API}/info`);
        const info = await infoRes.json();
        S.signalsInfo = info.signals;
        S.signalsInfo.forEach(sig => {
            signalNameToIndex[sig.name] = sig.index;
        });
        renderSignalList();
    }
    
    // 2. Effacer les tabs existants
    const tabIds = S.tabs.map(t => t.id);
    tabIds.forEach(id => {
        const tab = S.tabs.find(t => t.id === id);
        if (tab && tab.plots) {
            tab.plots.forEach(p => {
                if (p.chart) p.chart.destroy();
            });
        }
        // Supprimer le contenu DOM de ce tab
        const tabContent = document.getElementById(`content-${id}`);
        if (tabContent) tabContent.remove();
    });
    S.tabs = [];
    S.plots = [];
    S.activeTabId = null;
    
    // Rafraîchir la liste des tabs (vide maintenant)
    renderTabs();
    
    // 3. Recréer les tabs et plots
    for (let tabIdx = 0; tabIdx < layout.tabs.length; tabIdx++) {
        const layoutTab = layout.tabs[tabIdx];
        const tabId = createTab(layoutTab.name);
        
        if (tabIdx === 0) {
            switchTab(tabId);
        }
        
        // Créer les plots dans ce tab. Les signaux booleens sont toujours
        // routes vers le plot booleen dedie (en bas), independamment de la
        // structure sauvegardee, pour rester coherent avec le drag-and-drop.
        for (const layoutPlot of layoutTab.plots) {
            const normalSigs = [];
            const boolSigs = [];
            for (const sig of layoutPlot.signals) {
                const sigIdx = signalNameToIndex[sig.name];
                if (sigIdx === undefined) continue;
                (isBoolSignalIndex(sigIdx) ? boolSigs : normalSigs).push({ idx: sigIdx, style: sig.style });
            }

            // Plot normal: premier signal a la creation, puis les suivants.
            if (normalSigs.length > 0) {
                const plotId = createPlotInTab(tabId, normalSigs[0].idx);
                const plot = S.plots.find(p => p.id === plotId);
                if (plot) {
                    applyRestoredStyle(plot, normalSigs[0].idx, normalSigs[0].style);
                    for (const s of normalSigs.slice(1)) {
                        addSignalToPlot(plotId, s.idx);
                        applyRestoredStyle(plot, s.idx, s.style);
                    }
                    if (plot.element && layoutPlot.flex) {
                        plot.element.style.flex = layoutPlot.flex.toString();
                    }
                }
            }

            // Booleens: vers le plot booleen dedie (cree en bas si necessaire).
            for (const s of boolSigs) {
                const bp = ensureBoolPlot(tabId);
                addSignalToPlot(bp.id, s.idx);
                applyRestoredStyle(bp, s.idx, s.style);
            }
        }
    }
    
    // Activer le premier tab
    if (S.tabs.length > 0) {
        switchTab(S.tabs[0].id);
    }
    
    // Rafraîchir l'affichage
    renderTabs();
    refreshAllPlots();
    
    return true;
}

// =========================================================================
// Plot Management
// =========================================================================
// Indique si un signal est booleen (route vers le plot booleen dedie).
function isBoolSignalIndex(signalIndex) {
    return S.signalsInfo[signalIndex]?.unit === 'bool';
}

// Reconstruit l'ordre DOM des panneaux et les splitters depuis le tableau plots
// (le plot booleen reste en dernier). Reinitialise les flex pour une repartition
// equitable: corrige le panneau ajoute hors-ecran et le splitter manquant apres
// redimensionnements manuels.
function rebuildPlotsLayout(tabId) {
    const wrapper = document.getElementById(`plotsWrapper-${tabId}`);
    if (!wrapper) return;

    wrapper.querySelectorAll('.splitter').forEach(s => s.remove());

    S.plots.forEach(p => {
        p.element.style.flex = '1';
        wrapper.appendChild(p.element); // deplace le noeud existant dans l'ordre
    });

    for (let i = 1; i < S.plots.length; i++) {
        const splitter = document.createElement('div');
        splitter.className = 'splitter';
        splitter.dataset.above = S.plots[i - 1].id;
        splitter.dataset.below = S.plots[i].id;
        wrapper.insertBefore(splitter, S.plots[i].element);
        setupSplitter(splitter);
    }
}

function createPlotInTab(tabId, signalIndex = null, { isBoolPlot = false } = {}) {
    const tab = S.tabs.find(t => t.id === tabId);
    if (!tab) return;

    const wrapper = document.getElementById(`plotsWrapper-${tabId}`);
    if (!wrapper) return;

    const id = `plot-${tabId}-${tab.plotIdCounter++}`;

    const empty = document.getElementById(`emptyPlot-${tabId}`);
    if (empty) empty.remove();

    const container = document.createElement('div');
    container.className = 'plot-container';
    container.id = id;
    container.style.flex = '1';

    const plotMain = document.createElement('div');
    plotMain.className = 'plot-main';

    const plotBody = document.createElement('div');
    plotBody.className = 'plot-body';
    const chartDiv = document.createElement('div');
    chartDiv.className = 'chart';
    plotBody.appendChild(chartDiv);

    const plotLegend = document.createElement('div');
    plotLegend.className = 'plot-legend';
    applyLegendWidthTo(plotLegend);

    // Splitter vertical entre le graphe et sa legende. Le redimensionnement est
    // lie: il regle la largeur partagee de toutes les legendes.
    const legendSplitter = document.createElement('div');
    legendSplitter.className = 'legend-splitter';
    legendSplitter.style.cssText = 'flex:0 0 5px;cursor:col-resize;'
        + 'background:rgba(255,255,255,0.04);align-self:stretch;';
    legendSplitter.addEventListener('mousedown', (e) => startLegendResize(e, plotMain, legendSplitter));

    plotMain.appendChild(plotBody);
    plotMain.appendChild(legendSplitter);
    plotMain.appendChild(plotLegend);

    // Barre reduite a la seule croix de suppression (overlay en bas a droite),
    // pour maximiser la zone utile du plot-body.
    const plotStats = document.createElement('div');
    plotStats.className = 'plot-stats';

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'plot-delete';
    deleteBtn.title = 'Supprimer';
    deleteBtn.textContent = '✕';
    deleteBtn.addEventListener('click', () => {
        deletePlotInTab(tabId, id);
    });

    plotStats.appendChild(deleteBtn);

    container.appendChild(plotMain);
    container.appendChild(plotStats);

    wrapper.appendChild(container);
    setupPlotDropZone(container, id);

    const plot = {
        id,
        tabId,
        element: container,
        signals: [],
        chart: null,
        cachedData: {},
        // Unité de référence du graphe (fixée par le premier signal). Les signaux suivants
        // sont convertis vers cette unité si possible; sinon marqués en erreur.
        unit: '',
        unitConversions: {},
        unitErrors: new Set(),
        // Borne Y explicite { min, max } posee par un zoom Y/boite, ou null
        // (auto-cadrage de l'echelle Y sur les donnees visibles).
        yRange: null,
        // Plot booleen dedie (lanes discretes), maintenu en bas du panneau.
        isBoolPlot
    };

    // Panneau le plus bas avant insertion: s'il cesse de l'etre, son axe
    // temporel doit disparaitre.
    const prevLast = S.plots.length ? S.plots[S.plots.length - 1] : null;

    // Le plot booleen reste toujours en dernier; un plot normal s'insere avant.
    const boolIdx = S.plots.findIndex(p => p.isBoolPlot);
    if (isBoolPlot || boolIdx === -1) {
        S.plots.push(plot);
    } else {
        S.plots.splice(boolIdx, 0, plot);
    }
    tab.plots = S.plots;

    rebuildPlotsLayout(tabId);

    if (signalIndex !== null) {
        addSignalToPlot(id, signalIndex);
    }

    if (prevLast && prevLast.id !== S.plots[S.plots.length - 1].id) {
        rerenderPlotFromCache(prevLast);
    }
    return id;
}

// Retourne le plot booleen du tab actif, en le creant en bas si necessaire.
function ensureBoolPlot(tabId) {
    let bp = S.plots.find(p => p.isBoolPlot);
    if (!bp) {
        const id = createPlotInTab(tabId, null, { isBoolPlot: true });
        bp = S.plots.find(p => p.id === id);
    }
    return bp;
}

// Point d'entree unique d'un depot de signal. Tout booleen va sur le plot
// booleen dedie (cree en bas au besoin). Retourne l'id du plot destinataire.
function dropSignal(signalIndex, targetPlotId = null) {
    if (isBoolSignalIndex(signalIndex)) {
        const bp = ensureBoolPlot(S.activeTabId);
        addSignalToPlot(bp.id, signalIndex);
        return bp.id;
    }
    if (targetPlotId) {
        const target = S.plots.find(p => p.id === targetPlotId);
        if (target && !target.isBoolPlot) {
            addSignalToPlot(targetPlotId, signalIndex);
            return targetPlotId;
        }
    }
    return createPlotInTab(S.activeTabId, signalIndex);
}

// Keep old createPlot for compatibility, redirect to tab version
function createPlot(signalIndex) {
    return createPlotInTab(S.activeTabId, signalIndex);
}

function setupSplitter(splitter) {
    let startY, startHeightAbove, startHeightBelow, aboveEl, belowEl;

    splitter.addEventListener('mousedown', e => {
        e.preventDefault();
        
        aboveEl = document.getElementById(splitter.dataset.above);
        belowEl = document.getElementById(splitter.dataset.below);
        
        if (!aboveEl || !belowEl) return;

        startY = e.clientY;
        startHeightAbove = aboveEl.offsetHeight;
        startHeightBelow = belowEl.offsetHeight;
        
        splitter.classList.add('active');
        document.body.style.cursor = 'row-resize';
        document.body.style.userSelect = 'none';

        aboveEl.querySelector('.chart').style.visibility = 'hidden';
        belowEl.querySelector('.chart').style.visibility = 'hidden';

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    });

    function onMouseMove(e) {
        // On conserve la hauteur combinee des deux panneaux adjacents: la somme
        // reste constante, donc la hauteur totale de la zone ne change pas et
        // aucun panneau n'est pousse hors de la fenetre. Borne min alignee sur le
        // min-height CSS (100px) pour eviter tout debordement residuel.
        const MIN = 100;
        const total = startHeightAbove + startHeightBelow;
        const delta = e.clientY - startY;
        let above = Math.max(MIN, Math.min(total - MIN, startHeightAbove + delta));
        const below = total - above;
        aboveEl.style.flex = `0 0 ${above}px`;
        belowEl.style.flex = `0 0 ${below}px`;
    }

    function onMouseUp() {
        splitter.classList.remove('active');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);

        aboveEl.querySelector('.chart').style.visibility = '';
        belowEl.querySelector('.chart').style.visibility = '';

        const plotAbove = S.plots.find(p => p.id === aboveEl.id);
        const plotBelow = S.plots.find(p => p.id === belowEl.id);
        
        if (plotAbove?.chart) {
            const body = aboveEl.querySelector('.plot-body');
            plotAbove.chart.setSize({ width: body.clientWidth, height: body.clientHeight });
        }
        if (plotBelow?.chart) {
            const body = belowEl.querySelector('.plot-body');
            plotBelow.chart.setSize({ width: body.clientWidth, height: body.clientHeight });
        }
    }
}

function setupPlotDropZone(element, plotId) {
    element.addEventListener('dragover', e => {
        e.preventDefault();
        element.classList.add('drop-target');
    });
    element.addEventListener('dragleave', () => {
        element.classList.remove('drop-target');
    });
    element.addEventListener('drop', e => {
        e.preventDefault();
        element.classList.remove('drop-target');
        if (S.draggedSignal !== null) {
            const sigIdx = S.draggedSignal;
            const fromPlotId = S.draggedFromPlotId;
            const destId = dropSignal(sigIdx, plotId);
            if (fromPlotId !== null && fromPlotId !== destId) {
                removeSignalFromPlot(fromPlotId, sigIdx);
            }
        }
    });
}

function isConvertibleUnitSignal(sig) {
    const unit = (sig.unit || '').trim();
    if (!unit || unit === 'bool' || unit === 'state') return false;
    if (sig.isCategorical || sig.stringMap) return false;
    return true;
}

// Tente d'aligner l'unité du signal ajouté sur celle déjà présente dans le graphe.
// Premier signal: fixe l'unité de référence. Signal suivant: stocke un facteur de
// conversion (appliqué au cache) ou marque l'unité en erreur si la conversion est impossible.
function adaptSignalUnit(plot, signalIndex) {
    if (plot.isBoolPlot) return;
    if (!plot.unitConversions) plot.unitConversions = {};
    if (!plot.unitErrors) plot.unitErrors = new Set();

    const sig = S.signalsInfo[signalIndex];
    if (!sig) return;
    const unit = (sig.unit || '').trim();

    if (plot.signals.length === 0) {
        plot.unit = unit;
        return;
    }

    if (!plot.unit || !isConvertibleUnitSignal(sig) || unit === plot.unit) return;

    const conv = getUnitConversion(unit, plot.unit);
    if (conv) {
        plot.unitConversions[signalIndex] = conv;
        if (typeof showNotification === 'function') {
            showNotification(`Unité convertie : ${unit} → ${plot.unit}`, 'info');
        }
    } else {
        plot.unitErrors.add(signalIndex);
        if (typeof showNotification === 'function') {
            showNotification(
                `Unité « ${unit} » incompatible avec « ${plot.unit} » - signal ajouté sans conversion`,
                'warning'
            );
        }
    }
}

function addSignalToPlot(plotId, signalIndex) {
    const plot = S.plots.find(p => p.id === plotId);
    if (!plot || plot.signals.includes(signalIndex)) return;

    adaptSignalUnit(plot, signalIndex);

    plot.signals.push(signalIndex);
    updatePlotHeader(plot);
    fetchAndRenderPlot(plot);
    updateSignalActiveStates();
    setTimeout(resizePlotCharts, 100);
}

function updateSignalsLoadedStatus(signalsStatus) {
    if (!signalsStatus || !Array.isArray(signalsStatus)) return;
    
    signalsStatus.forEach(status => {
        const sig = S.signalsInfo.find(s => s.index === status.index);
        if (sig && sig.loaded !== status.loaded) {
            sig.loaded = status.loaded;
            
            const item = document.getElementById(`signal-item-${status.index}`);
            if (item) {
                const dot = item.querySelector('.signal-dot');
                
                if (status.loaded) {
                    item.classList.remove('not-loaded');
                    item.draggable = true;
                    if (dot) dot.classList.remove('lazy-indicator');
                } else {
                    item.classList.add('not-loaded');
                    item.draggable = false;
                    if (dot) dot.classList.add('lazy-indicator');
                }
            }
        }
    });
}

function removeSignalFromPlot(plotId, signalIndex) {
    const plot = S.plots.find(p => p.id === plotId);
    if (!plot) return;
    
    plot.signals = plot.signals.filter(s => s !== signalIndex);
    delete plot.cachedData[signalIndex];
    if (plot.unitConversions) delete plot.unitConversions[signalIndex];
    if (plot.unitErrors) plot.unitErrors.delete(signalIndex);
    cleanupExtendedZones(signalIndex);
    
    if (plot.signals.length === 0) {
        deletePlot(plotId);
    } else {
        updatePlotHeader(plot);
        renderPlotFromCache(plot);
    }
    updateSignalActiveStates();
}

function colorWithOpacity(color, opacity) {
    // Si déjà en hex
    if (color.startsWith('#')) {
        const hex = Math.round(opacity * 255).toString(16).padStart(2, '0');
        return color + hex;
    }
    // Si rgb/hsl, utilise canvas pour convertir
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

function isSteppedSignal(sigData) {
    if (!sigData) return false;
    return sigData.isCategorical || sigData.unit === 'state' || sigData.unit === 'bool';
}

// =========================================================================
// uPlot Options Factory
// Source unique des options partagees par les trois chemins de rendu
// (cache complet, cache filtre, reponse serveur). Seules series/width/height
// et la borne Y varient d'un appel a l'autre.
// =========================================================================

// Zoom par selection: X ou Y adaptatif, bascule en boite 2D au-dela de 50 px
// sur l'axe secondaire, drag minimal de 8 px pour distinguer le clic de pose
// de curseur du zoom. setScale: false delegue entierement le zoom au hook
// setSelect (pas de double application par uPlot).
const PLOT_CURSOR_DRAG = { x: true, y: true, uni: 50, dist: 8, setScale: false };

function resolveSignalStyle(plot, sigIdx, fallbackColor) {
    return plot.signalStyles?.[sigIdx] || { color: fallbackColor, width: 1.5, dash: '' };
}

// Constructeurs de chemins uPlot, instancies a la demande puis memorises
// (uPlot est garanti charge a l'appel, pas forcement a l'evaluation du module).
// 'none' renvoie un constructeur nul (aucune ligne, points seuls).
const PATH_MODES = ['none', 'linear', 'spline', 'stepped'];
const _pathBuilders = {};

function pathRenderer(mode) {
    if (mode === 'none') return () => null;
    if (!_pathBuilders[mode]) {
        _pathBuilders[mode] =
            mode === 'spline' ? uPlot.paths.spline() :
            mode === 'stepped' ? uPlot.paths.stepped({ align: 1 }) :
            uPlot.paths.linear();
    }
    return _pathBuilders[mode];
}

// Mode de trace effectif: la valeur explicite du signal sinon le defaut lie au
// type (escalier pour les booleens, lineaire sinon).
function effectivePathMode(style, unit) {
    return style.path || (unit === 'bool' ? 'stepped' : 'linear');
}

// Modes de remplissage par bande, jusqu'a la courbe voisine du panneau:
// 'above' remplit vers la courbe precedente (au-dessus dans la legende),
// 'below' vers la suivante. Materialise par l'option top-level bands.
const FILL_MODES = ['none', 'above', 'below'];

function effectiveFillMode(style) {
    return style.fill || 'none';
}

// Entree de serie uPlot pour un signal. selected epaissit le trait pour la mise
// en exergue. Les booleens conservent leur aire remplie (zones). _fillMode est
// lu par buildPlotOptions pour construire les bandes inter-courbes.
function buildSeriesConfig(name, unit, style, selected = false) {
    const isBool = unit === 'bool';
    const mode = effectivePathMode(style, unit);
    return {
        label: name,
        stroke: style.color,
        width: selected ? style.width * 2 + 0.5 : style.width,
        dash: style.dash ? style.dash.split(',').map(Number) : undefined,
        fill: isBool ? colorWithOpacity(style.color, 0.4) : undefined,
        paths: pathRenderer(mode),
        // Sans ligne, on montre les points pour que le signal reste visible.
        points: mode === 'none' ? { show: true } : undefined,
        _fillMode: effectiveFillMode(style),
        _mode: mode,
    };
}

// En mode adaptatif, l'axe non reduit occupe toute la dimension du plot: on en
// deduit quels axes ont reellement ete bornes par la selection.
function selectionAxes(u) {
    const sel = u.select;
    return {
        x: sel.width > 1 && sel.width < u.over.offsetWidth - 2,
        y: sel.height > 1 && sel.height < u.over.offsetHeight - 2,
    };
}

// Applique le zoom de la selection.
// - X seul: nouvelle fenetre temporelle globale (rechargement), Y re-auto-cadre
//   sur tous les panneaux concernes.
// - Y seul: borne Y locale au panneau, application immediate sans serveur.
// - Boite (X+Y): X recharge et Y prend les bornes tirees pour ce panneau.
function zoomToSelection(u) {
    const { x: zoomX, y: zoomY } = selectionAxes(u);
    const sel = u.select;
    const plot = S.plots.find(p => p.chart === u);
    const clearSelect = () => u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);

    if (!zoomX && !zoomY) {
        clearSelect();
        return;
    }

    if (zoomY && plot) {
        const yA = u.posToVal(sel.top, 'y');
        const yB = u.posToVal(sel.top + sel.height, 'y');
        plot.yRange = { min: Math.min(yA, yB), max: Math.max(yA, yB) };
    }

    if (zoomX) {
        const xA = u.posToVal(sel.left, 'x');
        const xB = u.posToVal(sel.left + sel.width, 'x');
        const min = Math.min(xA, xB);
        const max = Math.max(xA, xB);
        if (max - min <= 0.01) {
            clearSelect();
            return;
        }
        // Auto-cadrage Y a la nouvelle fenetre pour tous les panneaux, sauf
        // celui dont Y vient d'etre borne explicitement par un drag en boite.
        S.plots.forEach(p => {
            if (zoomY && p === plot) return;
            p.yRange = null;
        });
        recordViewChange();
        globalView = { min, max };
        clearSelect();
        refreshAllPlots();
        return;
    }

    // Zoom Y seul: application immediate sur l'echelle, sans rebuild ni serveur.
    clearSelect();
    if (plot) u.setScale('y', { min: plot.yRange.min, max: plot.yRange.max });
}

// Moyenne d'une serie (valeurs non nulles), pour ordonner les courbes.
function seriesMean(values) {
    let sum = 0;
    let count = 0;
    for (const v of values) {
        if (v != null && Number.isFinite(v)) {
            sum += v;
            count++;
        }
    }
    return count ? sum / count : 0;
}

const FILL_OPACITY = 0.2;
const fillToScaleMin = (u) => u.scales.y.min;
const fillToScaleMax = (u) => u.scales.y.max;

// Construit les remplissages facon "bandes de temperature": chaque courbe en
// mode 'below' se remplit vers le bas jusqu'a la courbe la plus proche situee
// en dessous (par valeur), 'above' vers le haut jusqu'a la plus proche au-dessus.
// La voisine est choisie par valeur moyenne (pas par ordre de liste), comme dans
// l'exemple High/Low. Sans voisine dans la direction, on remplit jusqu'au bord
// du graphe (bas ou haut). La couleur reprend celle de la courbe. Effet de bord
// assume: le remplissage "jusqu'au bord" est pose directement sur la serie.
function buildBands(series, data) {
    const means = series.map((s, i) => (i === 0 ? null : seriesMean(data[i])));
    const bands = [];

    for (let i = 1; i < series.length; i++) {
        const mode = series[i]._fillMode;
        if (mode !== 'above' && mode !== 'below') continue;

        const down = mode === 'below';

        // Courbe voisine la plus proche dans la direction du remplissage.
        let neighbor = null;
        let bestMean = null;
        for (let j = 1; j < series.length; j++) {
            if (j === i) continue;
            const mj = means[j];
            const inDir = down ? mj < means[i] : mj > means[i];
            if (inDir && (bestMean === null || (down ? mj > bestMean : mj < bestMean))) {
                bestMean = mj;
                neighbor = j;
            }
        }

        const fill = colorWithOpacity(series[i].stroke, FILL_OPACITY);

        if (neighbor !== null) {
            // uPlot exige series[0] = bord superieur.
            const upper = down ? i : neighbor;
            const lower = down ? neighbor : i;
            bands.push({ series: [upper, lower], fill });
        } else {
            // Pas de voisine dans cette direction: remplissage jusqu'au bord.
            series[i].fill = fill;
            series[i].fillTo = down ? fillToScaleMin : fillToScaleMax;
        }
    }

    return bands;
}

// Largeur commune de la gouttiere de l'axe Y a TOUS les panneaux (normaux et
// booleen). Indispensable pour que les zones de trace demarrent au meme pixel
// et donc que les axes X restent alignes verticalement entre panneaux.
const Y_AXIS_SIZE = 50;

// Padding droit fixe et identique sur TOUS les panneaux. Sans cela, le panneau
// du bas (axe temporel visible) reserve a droite la place de la derniere
// etiquette, tandis que ceux du haut (axe X masque) n'en reservent pas: leurs
// zones de trace n'auraient pas la meme longueur.
const PLOT_PAD_RIGHT = 20;

// Vrai si le panneau est le dernier (le plus bas) de l'onglet courant.
function isLastPlot(plot) {
    return S.plots.length > 0 && S.plots[S.plots.length - 1].id === plot.id;
}

// Re-rendu d'un panneau depuis le cache courant (sans appel serveur) pour
// reappliquer la visibilite de l'axe temporel quand il devient (ou cesse d'etre)
// le dernier. La vue ne change pas, donc le cache courant suffit, meme si les
// signaux sont incomplets (on ne passe pas par canRenderFromCache).
function rerenderPlotFromCache(plot) {
    if (!plot || plot.signals.length === 0) return;
    if (!plot.cachedData[plot.signals[0]]) return;
    if (plot.isBoolPlot) renderBoolPlot(plot);
    else renderPlotFromCacheFiltered(plot);
}

// Couleurs des graphes lues depuis les tokens CSS du theme courant. Passees en
// fonctions a uPlot (reevaluees au redraw) pour suivre la bascule clair/sombre.
function themeChartColors() {
    const cs = getComputedStyle(document.documentElement);
    return {
        axis: (cs.getPropertyValue('--chart-axis') || '#b6b6b6').trim(),
        grid: (cs.getPropertyValue('--chart-grid') || '#2d2d5a').trim(),
    };
}

// Configuration de l'axe X. L'axe temporel n'est affiche que sur le panneau du
// bas: les autres ne gardent que la grille verticale (sans graduations ni
// gouttiere) pour ne pas dupliquer les etiquettes et gagner de la hauteur.
function xAxisConfig(showTimeAxis) {
    if (showTimeAxis) {
        return { stroke: () => themeChartColors().axis, grid: { stroke: () => themeChartColors().grid, width: 1 }, size: 40 };
    }
    return {
        grid: { stroke: () => themeChartColors().grid, width: 1 },
        ticks: { show: false },
        gap: 0,
        size: 0,
        values: (u, splits) => splits.map(() => ''),
    };
}

// Options uPlot communes a tous les panneaux. axes et drag sont recrees a
// chaque appel: uPlot ecrit des proprietes calculees dessus, les partager
// entre instances creerait des effets de bord. yRange null => Y auto-cadre.
// bands est calcule par buildBands (a besoin des donnees pour ordonner).
// Signature visuelle d'un rendu: si elle est inchangee entre deux rendus du meme
// plot, l'instance uPlot peut etre reutilisee (setData) au lieu d'etre recreee.
function renderSignature(plot, series) {
    const cols = series.slice(1).map(s =>
        [s.label, s.stroke, s.width, s.dash ? s.dash.join('.') : '',
         s.fill || '', s._fillMode || '', s._mode || '', s.points ? 'p' : ''].join('~')
    );
    // X et Y suivent tous deux une fonction range (globalView / plot.yRange), donc
    // absents de la signature: un changement de fenetre ou de borne Y se traduit par
    // un simple setData, pas une reconstruction. Seule la structure visuelle compte.
    return `${isLastPlot(plot)}#${plot.signals.join(',')}#${cols.join('|')}`;
}

// Applique series/donnees au graphe. Tant que la structure visuelle est inchangee
// (zoom/pan X, grossier->fin), on REUTILISE l'instance uPlot via setData: le DOM,
// l'overlay des curseurs et les handlers persistent -> transition sans accroc.
// X suit globalView (fonction range); un changement de signaux/style/borne-Y change
// la signature et declenche une reconstruction.
function commitPlotRender(plot, series, uplotData, bands) {
    const sig = renderSignature(plot, series);

    if (plot.chart && plot._renderSig === sig) {
        // Reutilisation: setData declenche un redraw qui re-evalue les fonctions range
        // X (globalView) et Y (plot.yRange) -> fenetre et cadrage Y suivis sans rebuild.
        plot.chart.setData(uplotData);
        return;
    }

    if (plot.chart) plot.chart.destroy();
    const bodyDiv = plot.element.querySelector('.plot-body');
    const chartDiv = plot.element.querySelector('.chart');
    const width = bodyDiv.clientWidth || 800;
    const height = bodyDiv.clientHeight || 180;
    plot.chart = new uPlot(
        buildPlotOptions(series, width, height, plot, bands && bands.length ? bands : null, isLastPlot(plot)),
        uplotData, chartDiv
    );
    plot._renderSig = sig;
}

// Cadrage Y automatique (yRange null) reproduisant un padding de 10%, robuste aux
// cas degeneres (donnees vides, min==max).
function autoYRange(dataMin, dataMax) {
    if (dataMin == null || dataMax == null || !isFinite(dataMin) || !isFinite(dataMax)) {
        return [0, 1];
    }
    if (dataMin === dataMax) {
        const p = Math.abs(dataMin) * 0.1 || 1;
        return [dataMin - p, dataMax + p];
    }
    const pad = (dataMax - dataMin) * 0.1;
    return [dataMin - pad, dataMax + pad];
}

// Pan des axes facon demo uPlot "Draggable y scales": glisser sur la gouttiere de
// l'axe X (sous la zone de trace) translate la fenetre temporelle globale (partagee
// par tous les panneaux); glisser sur la gouttiere de l'axe Y (a gauche) translate
// l'echelle Y du panneau. La zone de trace conserve le zoom par selection.
function axisDragPlugin() {
    return {
        hooks: {
            ready: u => {
                const plot = S.plots.find(p => p.chart === u);
                if (!plot) return;
                let drag = null;
                let rafPending = false;

                const onMove = e => {
                    if (!drag) return;
                    if (drag.axis === 'x') {
                        const shift = -(e.clientX - drag.startX) * drag.uppX;
                        if (!drag.moved && shift !== 0) {
                            recordViewChange();
                            drag.moved = true;
                        }
                        globalView = { min: drag.xMin + shift, max: drag.xMax + shift };
                        if (!rafPending) {
                            rafPending = true;
                            requestAnimationFrame(() => { rafPending = false; applyGlobalViewLocal(); });
                        }
                    } else {
                        const shift = (e.clientY - drag.startY) * drag.uppY;
                        plot.yRange = { min: drag.yMin + shift, max: drag.yMax + shift };
                        u.setScale('y', { min: plot.yRange.min, max: plot.yRange.max });
                    }
                };

                const onUp = () => {
                    drag = null;
                    document.body.style.cursor = '';
                    window.removeEventListener('mousemove', onMove);
                    window.removeEventListener('mouseup', onUp);
                };

                u.root.addEventListener('mousedown', e => {
                    if (e.button !== 0) return;
                    const r = u.over.getBoundingClientRect();
                    const onX = e.clientY > r.bottom && e.clientX >= r.left && e.clientX <= r.right;
                    const onY = e.clientX < r.left && e.clientY >= r.top && e.clientY <= r.bottom;
                    if (!onX && !onY) return;            // zone de trace: zoom-selection inchange
                    if (onY && plot.isBoolPlot) return;  // Y fixe (lanes) sur les panneaux booleens

                    e.preventDefault();
                    drag = {
                        axis: onX ? 'x' : 'y', moved: false,
                        startX: e.clientX, startY: e.clientY,
                        xMin: globalView.min, xMax: globalView.max,
                        yMin: u.scales.y.min, yMax: u.scales.y.max,
                        uppX: (globalView.max - globalView.min) / r.width,
                        uppY: (u.scales.y.max - u.scales.y.min) / r.height,
                    };
                    document.body.style.cursor = 'grabbing';
                    window.addEventListener('mousemove', onMove);
                    window.addEventListener('mouseup', onUp);
                });
            },
        },
    };
}

function buildPlotOptions(series, width, height, plot, bands = null, showTimeAxis = true) {
    return {
        width,
        height,
        legend: { show: false },
        series,
        bands: bands && bands.length ? bands : undefined,
        padding: [null, PLOT_PAD_RIGHT, null, null],
        scales: {
            x: { time: false, range: () => [globalView.min, globalView.max] },
            // Borne Y lue en direct sur plot.yRange: bornee si zoom Y, auto sinon.
            y: { range: (u, dataMin, dataMax) => plot.yRange
                ? [plot.yRange.min, plot.yRange.max]
                : autoYRange(dataMin, dataMax) },
        },
        axes: [
            xAxisConfig(showTimeAxis),
            { stroke: () => themeChartColors().axis, grid: { stroke: () => themeChartColors().grid, width: 1 }, size: Y_AXIS_SIZE },
        ],
        cursor: { drag: { ...PLOT_CURSOR_DRAG }, points: { show: false } },
        hooks: { setSelect: [zoomToSelection] },
        plugins: [boolZonesPlugin(), cursorPlugin(), axisDragPlugin()],
    };
}

function renderPlotFromCache(plot) {
    if (plot.signals.length === 0) return;

    const firstSigData = plot.cachedData[plot.signals[0]];
    if (!firstSigData) return;

    const uplotData = [firstSigData.timestamps];
    const series = [{}];

    plot.signals.forEach(sigIdx => {
        const sigData = plot.cachedData[sigIdx];
        if (!sigData) return;
        const style = resolveSignalStyle(plot, sigIdx, sigData.color);
        const selected = isLegendSignalSelected(plot.id, sigIdx);
        uplotData.push(sigData.values);
        series.push(buildSeriesConfig(sigData.name, sigData.unit, style, selected));
    });

    const bands = buildBands(series, uplotData);
    commitPlotRender(plot, series, uplotData, bands);

    autoEnableExtendedZones(plot);
}

function deletePlotInTab(tabId, plotId) {
    const idx = S.plots.findIndex(p => p.id === plotId);
    if (idx === -1) return;

    const plot = S.plots[idx];
    if (plot.chart) plot.chart.destroy();

    // Le panneau supprime etait-il le plus bas ? Si oui, le nouveau dernier
    // devra afficher l'axe temporel.
    const deletedWasLast = idx === S.plots.length - 1;

    // Nettoie les zones etendues des signaux du panneau supprime (sinon elles
    // restent dessinees en fond des autres panneaux).
    plot.signals.forEach(sigIdx => {
        extendedBoolZones.delete(sigIdx);
        disabledBoolZones.delete(sigIdx);
    });

    plot.element.remove();
    S.plots.splice(idx, 1);

    const tab = S.tabs.find(t => t.id === tabId);
    if (tab) tab.plots = S.plots;

    updateSignalActiveStates();

    const wrapper = document.getElementById(`plotsWrapper-${tabId}`);

    if (S.plots.length === 0) {
        if (wrapper) wrapper.querySelectorAll('.splitter').forEach(s => s.remove());
        const empty = document.createElement('div');
        empty.className = 'empty-plot';
        empty.id = `emptyPlot-${tabId}`;
        empty.textContent = 'Glissez un signal ici pour créer un graphique';
        if (wrapper) wrapper.appendChild(empty);
        setupEmptyPlotDropZone(tabId);
        return;
    }

    rebuildPlotsLayout(tabId);

    // Le dernier panneau a change: il doit desormais porter l'axe temporel.
    if (deletedWasLast && S.plots.length > 0) {
        rerenderPlotFromCache(S.plots[S.plots.length - 1]);
    }

    setTimeout(() => {
        S.plots.forEach(p => {
            if (!p.chart) return;
            const body = p.element.querySelector('.plot-body');
            if (body) p.chart.setSize({ width: body.clientWidth, height: body.clientHeight });
            // Redessine pour purger d'eventuelles zones etendues supprimees.
            p.chart.redraw();
        });
    }, 50);
}

function deletePlot(plotId) {
    const plot = S.plots.find(p => p.id === plotId);
    if (plot && plot.tabId) {
        deletePlotInTab(plot.tabId, plotId);
    }
}

function updatePlotHeader(plot) {
    const legendDiv = plot.element.querySelector('.plot-legend');
    if (!legendDiv) return;

    const expandedItems = new Set();
    legendDiv.querySelectorAll('.legend-row.expanded').forEach(row => {
        expandedItems.add(row.dataset.sigIdx);
    });

    // Vide et reconstruit avec createElement (CSP safe, XSS safe).
    // Table unifiee (modele desktop): chaque ligne est a la fois l'entree de
    // legende (couleur, nom, depliage, suppression) et la ligne de mesure
    // (valeurs en A, B, delta, unite) - colonnes partagees, aucune duplication.
    legendDiv.innerHTML = '';

    const table = document.createElement('div');
    table.className = 'legend-table';

    const makeCell = (cls, text, attrs) => {
        const cell = document.createElement('span');
        cell.className = cls;
        if (text) cell.textContent = text;
        if (attrs) Object.entries(attrs).forEach(([k, v]) => cell.setAttribute(k, v));
        return cell;
    };

    table.appendChild(makeCell('ct-h lt-measure', 'Name'));
    table.appendChild(makeCell('ct-h ct-ha lt-measure', 'A'));
    table.appendChild(makeCell('ct-h ct-hb lt-measure', 'B'));
    table.appendChild(makeCell('ct-h ct-hd lt-measure', 'Δ'));
    table.appendChild(makeCell('ct-h lt-measure', 'unit'));

    table.appendChild(makeCell('ct-name ct-time-label lt-measure', 't'));
    table.appendChild(makeCell('ct-val ct-a lt-measure', '-', { 'data-time': 'a' }));
    table.appendChild(makeCell('ct-val ct-b lt-measure', '-', { 'data-time': 'b' }));
    table.appendChild(makeCell('ct-val ct-d lt-measure', '-', { 'data-time': 'd' }));
    table.appendChild(makeCell('ct-unit lt-measure', 's'));

    plot.signals.forEach(sigIdx => {
        const sig = S.signalsInfo[sigIdx];
        if (!sig) return;

        const style = plot.signalStyles?.[sigIdx] || { color: sig.color, width: 1.5, dash: '' };

        // display:contents - les cellules participent a la grille parente,
        // le groupe porte l'etat (expanded) et l'identite du signal
        const row = document.createElement('div');
        row.className = 'legend-row';
        row.dataset.sigIdx = sigIdx;
        row.dataset.plotId = plot.id;
        if (expandedItems.has(String(sigIdx))) {
            row.classList.add('expanded');
        }

        // Cellule nom = entree de legende complete
        const nameCell = document.createElement('div');
        nameCell.className = 'lt-name';
        nameCell.title = sig.name;

        const colorInput = document.createElement('input');
        colorInput.type = 'color';
        colorInput.className = 'legend-color-btn';
        colorInput.value = rgbToHex(style.color);

        const nameSpan = document.createElement('span');
        nameSpan.className = 'legend-name';
        nameSpan.textContent = sig.name;
        nameSpan.style.color = style.color;

        const toggleSpan = document.createElement('span');
        toggleSpan.className = 'legend-toggle';
        toggleSpan.textContent = '▼';
        toggleSpan.title = 'Réglages du signal';

        nameCell.appendChild(colorInput);
        nameCell.appendChild(nameSpan);
        nameCell.appendChild(toggleSpan);
        row.appendChild(nameCell);

        // Drag depuis la legende: deplace le signal vers un autre panneau
        nameCell.draggable = true;
        nameCell.addEventListener('dragstart', (e) => {
            S.draggedSignal = sigIdx;
            S.draggedFromPlotId = plot.id;
            nameCell.classList.add('dragging');
            const dropZone = document.getElementById(`dropZone-${S.activeTabId}`);
            if (dropZone) dropZone.classList.add('active');
            e.dataTransfer.effectAllowed = 'move';
        });
        nameCell.addEventListener('dragend', () => {
            nameCell.classList.remove('dragging');
            S.draggedSignal = null;
            S.draggedFromPlotId = null;
            const dropZone = document.getElementById(`dropZone-${S.activeTabId}`);
            if (dropZone) dropZone.classList.remove('active');
            document.querySelectorAll('.plot-container').forEach(pc => pc.classList.remove('drop-target'));
        });

        if (isLegendSignalSelected(plot.id, sigIdx)) {
            row.classList.add('selected');
        }

        row.appendChild(makeCell('ct-val ct-a lt-measure', '-', { 'data-sig': sigIdx, 'data-col': 'a' }));
        row.appendChild(makeCell('ct-val ct-b lt-measure', '-', { 'data-sig': sigIdx, 'data-col': 'b' }));
        row.appendChild(makeCell('ct-val ct-d lt-measure', '-', { 'data-sig': sigIdx, 'data-col': 'd' }));
        const unitConv = plot.unitConversions?.[sigIdx];
        const unitText = unitConv ? unitConv.targetUnit : (sig.unit || '');
        const unitCell = makeCell('ct-unit lt-measure', unitText);
        if (plot.unitErrors?.has(sigIdx)) unitCell.classList.add('ct-unit-error');
        row.appendChild(unitCell);

        // Panneau de reglages (pleine largeur, visible quand la ligne est depliee)
        const controls = document.createElement('div');
        controls.className = 'legend-controls';

        const widthRow = document.createElement('div');
        widthRow.className = 'legend-control-row';
        const widthLabel = document.createElement('label');
        widthLabel.textContent = 'Trait';
        const widthInput = document.createElement('input');
        widthInput.type = 'range';
        widthInput.min = '0.5';
        widthInput.max = '5';
        widthInput.step = '0.5';
        widthInput.value = style.width;
        const widthValue = document.createElement('span');
        widthValue.className = 'legend-width-value';
        widthValue.textContent = style.width;
        widthRow.appendChild(widthLabel);
        widthRow.appendChild(widthInput);
        widthRow.appendChild(widthValue);

        const cached = plot.cachedData?.[sigIdx];
        const isBool = cached?.unit === 'bool' || sig.unit === 'bool';

        controls.appendChild(widthRow);

        // Les booleens n'exposent pas style/trace/remplissage: trace en escalier
        // impose et remplissage en dessous par defaut (gere par le plot booleen).
        if (!isBool) {
            const dashRow = document.createElement('div');
            dashRow.className = 'legend-control-row';
            const dashLabel = document.createElement('label');
            dashLabel.textContent = 'Style';
            const dashSelect = document.createElement('select');
            [
                { value: '', text: 'Continu' },
                { value: '5,5', text: 'Tirets' },
                { value: '2,2', text: 'Pointillés' },
                { value: '10,5,2,5', text: 'Mixte' }
            ].forEach(opt => {
                const option = document.createElement('option');
                option.value = opt.value;
                option.textContent = opt.text;
                option.selected = style.dash === opt.value;
                dashSelect.appendChild(option);
            });
            dashRow.appendChild(dashLabel);
            dashRow.appendChild(dashSelect);
            controls.appendChild(dashRow);
            dashSelect.addEventListener('change', (e) => {
                updateSignalStyle(plot.id, sigIdx, 'dash', e.target.value);
            });

            const pathRow = document.createElement('div');
            pathRow.className = 'legend-control-row';
            const pathLabel = document.createElement('label');
            pathLabel.textContent = 'Tracé';
            const pathSelect = document.createElement('select');
            const currentPath = effectivePathMode(style, sig.unit || '');
            [
                { value: 'none', text: 'Aucun' },
                { value: 'linear', text: 'Linéaire' },
                { value: 'spline', text: 'Spline' },
                { value: 'stepped', text: 'Escalier' }
            ].forEach(opt => {
                const option = document.createElement('option');
                option.value = opt.value;
                option.textContent = opt.text;
                option.selected = currentPath === opt.value;
                pathSelect.appendChild(option);
            });
            pathRow.appendChild(pathLabel);
            pathRow.appendChild(pathSelect);
            controls.appendChild(pathRow);
            pathSelect.addEventListener('change', (e) => {
                updateSignalStyle(plot.id, sigIdx, 'path', e.target.value);
            });

            const fillRow = document.createElement('div');
            fillRow.className = 'legend-control-row';
            const fillLabel = document.createElement('label');
            fillLabel.textContent = 'Remplissage';
            const fillSelect = document.createElement('select');
            const currentFill = effectiveFillMode(style);
            [
                { value: 'none', text: 'Aucun' },
                { value: 'above', text: 'Au-dessus' },
                { value: 'below', text: 'En dessous' }
            ].forEach(opt => {
                const option = document.createElement('option');
                option.value = opt.value;
                option.textContent = opt.text;
                option.selected = currentFill === opt.value;
                fillSelect.appendChild(option);
            });
            fillRow.appendChild(fillLabel);
            fillRow.appendChild(fillSelect);
            controls.appendChild(fillRow);
            fillSelect.addEventListener('change', (e) => {
                updateSignalStyle(plot.id, sigIdx, 'fill', e.target.value);
            });
        }

        if (isBool) {
            const extendRow = document.createElement('div');
            extendRow.className = 'legend-control-row legend-extend-row';

            const extendLabel = document.createElement('label');
            extendLabel.textContent = 'Étendre zones';
            extendLabel.title = 'Afficher les zones HIGH sur tous les graphiques';

            const extendToggle = document.createElement('input');
            extendToggle.type = 'checkbox';
            extendToggle.className = 'extend-zones-toggle';
            extendToggle.checked = extendedBoolZones.has(sigIdx);

            extendToggle.addEventListener('change', (e) => {
                toggleExtendedZones(plot.id, sigIdx, e.target.checked);
            });

            extendRow.appendChild(extendLabel);
            extendRow.appendChild(extendToggle);
            controls.appendChild(extendRow);
        }

        row.appendChild(controls);

        // Event listeners: la fleche ouvre les reglages, le clic sur la ligne
        // (nom ou cellules de mesure) selectionne/deselectionne le signal
        toggleSpan.addEventListener('click', (e) => {
            e.stopPropagation();
            row.classList.toggle('expanded');
        });

        const selectableCells = [nameCell, ...row.querySelectorAll('.ct-val, .ct-unit')];
        selectableCells.forEach(cell => {
            cell.addEventListener('click', (e) => {
                if (e.target.classList.contains('legend-color-btn')
                        || e.target.classList.contains('legend-toggle')) {
                    return;
                }
                toggleLegendSignalSelection(plot.id, sigIdx);
            });
        });

        colorInput.addEventListener('click', (e) => e.stopPropagation());
        colorInput.addEventListener('change', (e) => {
            updateSignalStyle(plot.id, sigIdx, 'color', e.target.value);
        });

        widthInput.addEventListener('change', (e) => {
            updateSignalStyle(plot.id, sigIdx, 'width', e.target.value);
        });

        table.appendChild(row);
    });

    legendDiv.appendChild(table);

    updateCursorReadout(plot);
}

function autoEnableExtendedZones(plot) {
    if (!plot || !plot.cachedData) return;
    
    let hasBoolSignals = false;
    
    plot.signals.forEach(sigIdx => {
        const cached = plot.cachedData[sigIdx];
        if (!cached) return;
        
        const isBool = cached.unit === 'bool';
        
        if (isBool) {
            hasBoolSignals = true;
            
            // Ne pas réactiver si désactivé manuellement
            if (!extendedBoolZones.has(sigIdx) && !disabledBoolZones.has(sigIdx)) {
                const ranges = extractBoolHighRanges(cached.timestamps, cached.values);
                const color = plot.signalStyles?.[sigIdx]?.color || cached.color;
                
                extendedBoolZones.set(sigIdx, { color, ranges, plotId: plot.id });
                console.log(`[BoolZones] Auto-enabled for "${cached.name}": ${ranges.length} zones`);
            }
        }
    });

    if (hasBoolSignals) {
        updatePlotHeader(plot);
    }
}

function rgbToHex(color) {
    if (!color) return '#ffffff';
    if (color.startsWith('hsl')) {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 1, 1);
        const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
        return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
    }
    if (color.startsWith('#')) return color;
    const match = color.match(/\d+/g);
    if (match) {
        return '#' + match.slice(0, 3).map(x => parseInt(x).toString(16).padStart(2, '0')).join('');
    }
    return '#ffffff';
}

function updateSignalStyle(plotId, sigIdx, property, value) {
    const plot = S.plots.find(p => p.id === plotId);
    if (!plot) return;

    if (!plot.signalStyles) plot.signalStyles = {};
    if (!plot.signalStyles[sigIdx]) {
        const sig = S.signalsInfo[sigIdx];
        plot.signalStyles[sigIdx] = { color: sig?.color || '#fff', width: 1.5, dash: '' };
    }

    if (property === 'width') {
        plot.signalStyles[sigIdx].width = parseFloat(value);
        const row = plot.element.querySelector(`.legend-row[data-sig-idx="${sigIdx}"]`);
        const widthValue = row?.querySelector('.legend-width-value');
        if (widthValue) widthValue.textContent = value;
    } else if (property === 'color') {
        plot.signalStyles[sigIdx].color = value;
        const colorRow = plot.element.querySelector(`.legend-row[data-sig-idx="${sigIdx}"]`);
        const nameSpan = colorRow?.querySelector('.legend-name');
        if (nameSpan) nameSpan.style.color = value;
    } else if (property === 'dash') {
        plot.signalStyles[sigIdx].dash = value;
    } else if (property === 'path') {
        plot.signalStyles[sigIdx].path = PATH_MODES.includes(value) ? value : 'linear';
    } else if (property === 'fill') {
        plot.signalStyles[sigIdx].fill = FILL_MODES.includes(value) ? value : 'none';
    }

    if (property === 'color' && plot.cachedData[sigIdx]) {
        plot.cachedData[sigIdx].color = value;
    }
    if (property === 'color') {
        updateExtendedZoneColor(sigIdx, value);
    }

    renderPlotFromCache(plot);
    
    // Update sidebar signal colors when plot color changes
    updateSignalActiveStates();
}

function toggleExtendedZones(plotId, sigIdx, enabled) {
    console.log(`[BoolZones] Toggle called: plotId=${plotId}, sigIdx=${sigIdx}, enabled=${enabled}`);
    
    const plot = S.plots.find(p => p.id === plotId);
    if (!plot) return;
    
    const cached = plot.cachedData[sigIdx];
    if (!cached) return;
    
    if (enabled) {
        const ranges = extractBoolHighRanges(cached.timestamps, cached.values);
        const color = plot.signalStyles?.[sigIdx]?.color || cached.color;
        
        extendedBoolZones.set(sigIdx, { color, ranges, plotId });
        disabledBoolZones.delete(sigIdx);
        console.log(`[BoolZones] Enabled for "${cached.name}": ${ranges.length} zones`);
    } else {
        extendedBoolZones.delete(sigIdx);
        disabledBoolZones.add(sigIdx);
        console.log(`[BoolZones] Disabled for "${cached.name}"`);
    }
    
    refreshAllPlots();
}

function updateExtendedZoneColor(sigIdx, newColor) {
    if (extendedBoolZones.has(sigIdx)) {
        const zoneData = extendedBoolZones.get(sigIdx);
        zoneData.color = newColor;
        refreshAllPlots();
    }
}

function cleanupExtendedZones(sigIdx) {
    if (extendedBoolZones.has(sigIdx)) {
        extendedBoolZones.delete(sigIdx);
    }
    disabledBoolZones.delete(sigIdx);
    refreshAllPlots();
}

function updateSignalActiveStates() {
    const signalColors = signalActiveColorMap();

    S.signalsInfo.forEach(sig => {
        const item = document.getElementById(`signal-item-${sig.index}`);
        if (item) {
            const dot = item.querySelector('.signal-dot');
            const isActive = signalColors.has(sig.index);
            
            item.classList.toggle('active', isActive);
            
            if (isActive && dot) {
                const color = signalColors.get(sig.index);
                dot.style.setProperty('--signal-color', color);
                item.style.setProperty('--signal-color', color);
            } else if (dot) {
                dot.style.removeProperty('--signal-color');
                item.style.removeProperty('--signal-color');
            }
        }
    });
}

// =========================================================================
// Data Fetching & Rendering (with local filtering optimization)
// =========================================================================

/**
 * Check if all signals in a plot can be rendered from cache (no API call needed).
 */
// Cache de vues par plot: memorise les reponses serveur indexees par
// (plage, resolution, signaux) pour rejouer instantanement une vue deja visitee
// (zoom arriere, double-clic, historique) sans aller-retour reseau.
const MAX_VIEW_CACHE = 16;

// Resolution cible d'un plot, en points. Pilotee par la largeur reelle du plot en
// pixels (x devicePixelRatio): inutile de tracer plus de points que de pixels. La
// valeur est arrondie au bucket SUPERIEUR (jamais en dessous de la largeur reelle,
// pour qu'il y ait toujours >= 1 point par colonne et que la courbe couvre toute la
// vue), ce qui stabilise aussi la cle du cache lors des petits redimensionnements.
// Bornee [MIN, MAX] (le backend clampe aussi a 10000).
const PX_BUCKET = 64;
const MIN_TARGET_POINTS = 300;
const MAX_TARGET_POINTS = 10000;

function targetPointsForPlot(plot) {
    const body = plot.element && plot.element.querySelector('.plot-body');
    const cssWidth = (body && body.clientWidth) || 800;
    const dpr = window.devicePixelRatio || 1;
    const raw = Math.ceil(cssWidth * dpr);
    const bucketed = Math.ceil(raw / PX_BUCKET) * PX_BUCKET;
    return Math.min(MAX_TARGET_POINTS, Math.max(MIN_TARGET_POINTS, bucketed));
}

// Cle d'une vue: plage + signaux, SANS la resolution. La resolution (maxPts) peut
// deriver d'une frame a l'autre (mesures de largeur instables au layout/resize), ce
// qui fragmentait le cache et provoquait des re-fetch au zoom arriere. On la sort donc
// de la cle et on la memorise a cote (voir storeViewCache / rejeu conditionnel).
function viewKey(signalsStr) {
    const r = v => Math.round(v * 1000) / 1000;
    return `${r(globalView.min)}:${r(globalView.max)}:${signalsStr}`;
}

function viewCacheKey(plot) {
    return viewKey(plot.signals.join(','));
}

// Requetes /view lancees au pickup (dragstart) d'un signal, pour masquer le cout de
// prechargement + reseau derriere le geste de drag. La cle reprend le format de
// viewKey afin qu'un plot frais (1 seul signal) la retrouve a la release.
const prefetchCache = new Map();
const PREFETCH_TTL = 15000;

// Largeur ou un nouveau plot atterrira: les plots sont empiles verticalement, donc
// tous partagent la largeur du conteneur. Sert a choisir la resolution de la requete.
function estimatedMaxPtsForNewPlot() {
    const existingBody = document.querySelector('.plot-body');
    let cssWidth = existingBody && existingBody.clientWidth;
    if (!cssWidth) {
        const dz = document.getElementById(`dropZone-${S.activeTabId}`)
            || document.querySelector('.plots-container');
        cssWidth = (dz && dz.clientWidth) || 800;
    }
    const dpr = window.devicePixelRatio || 1;
    const raw = Math.ceil(cssWidth * dpr);
    const bucketed = Math.ceil(raw / PX_BUCKET) * PX_BUCKET;
    return Math.min(MAX_TARGET_POINTS, Math.max(MIN_TARGET_POINTS, bucketed));
}

function prefetchSignalView(signalIndex) {
    if (signalIndex == null) return;
    const sig = S.signalsInfo[signalIndex];
    if (!sig || sig.loaded === false) return;

    const key = viewKey(String(signalIndex));
    if (prefetchCache.has(key)) return;

    const maxPts = estimatedMaxPtsForNewPlot();
    let url = `${API}/view?signals=${signalIndex}&start=${globalView.min}&end=${globalView.max}&max_points=${maxPts}`;
    const headers = {};
    if (currentLazySessionId) {
        url += `&session_id=${encodeURIComponent(currentLazySessionId)}`;
        const token = sessionStorage.getItem('auth_token');
        if (token) headers['Authorization'] = 'Bearer ' + token;
    }

    const promise = fetch(url, { headers }).then(res => res.json()).catch(() => null);
    prefetchCache.set(key, { promise, maxPts });
    setTimeout(() => prefetchCache.delete(key), PREFETCH_TTL);
}

function storeViewCache(plot, key, data, maxPts) {
    if (!plot.viewCache) plot.viewCache = new Map();
    plot.viewCache.delete(key);
    plot.viewCache.set(key, { data, maxPts });
    while (plot.viewCache.size > MAX_VIEW_CACHE) {
        plot.viewCache.delete(plot.viewCache.keys().next().value);
    }
}

// Rejoue une reponse serveur (en cache) via le chemin de rendu normal, sans reseau.
function replayServerData(plot, data) {
    if (plot.isBoolPlot) {
        cacheServerSignals(plot, data);
        renderBoolPlot(plot);
    } else {
        renderPlotChart(plot, data);
    }
    if (data.signals_status) updateSignalsLoadedStatus(data.signals_status);
}

// Vrai si le cache courant couvre la fenetre demandee (meme non "complet"):
// permet un rendu grossier immediat lors d'un zoom avant, en attendant le serveur.
function cacheCoversView(plot, viewMin, viewMax) {
    const TOLERANCE = 0.5;
    if (plot.signals.length === 0) return false;
    for (const sigIdx of plot.signals) {
        const c = plot.cachedData[sigIdx];
        if (!c || !c.timestamps || c.timestamps.length === 0) return false;
        if (c.timestamps[0] > viewMin + TOLERANCE ||
            c.timestamps[c.timestamps.length - 1] < viewMax - TOLERANCE) return false;
    }
    return true;
}

function canRenderFromCache(plot, viewMin, viewMax) {
    for (const sigIdx of plot.signals) {
        const cached = plot.cachedData[sigIdx];
        if (!cached) return false;
        if (!cached.isComplete) return false;
        if (!cached.fullTimeRange) return false;
        // isComplete => le cache contient TOUTE la serie. Aucune donnee n'existe au-dela
        // de fullTimeRange : une vue plus large (dezoom) n'a rien a recuperer cote serveur
        // et se rend donc en local (filterCachedData borne proprement aux donnees presentes).
    }
    return true;
}

/**
 * Filter cached data to the current view range (client-side).
 */
function filterCachedData(timestamps, values, viewMin, viewMax) {
    const n = timestamps.length;
    if (n === 0) return { timestamps: [], values: [] };

    // On etend d'un point de chaque cote de la fenetre: indispensable pour le rendu
    // escalier de donnees eparses (un palier sans front dans la vue serait sinon vide),
    // et sans effet visible pour les signaux denses (le point hors-vue est clippe).
    let lo = 0;
    while (lo < n && timestamps[lo] < viewMin) lo++;
    let hi = n - 1;
    while (hi >= 0 && timestamps[hi] > viewMax) hi--;

    let startIdx = lo > 0 ? lo - 1 : 0;
    let endIdx = hi < n - 1 ? hi + 1 : n - 1;
    if (startIdx > endIdx) {
        startIdx = Math.max(0, Math.min(lo, n - 1));
        endIdx = startIdx;
    }

    const filteredTs = [];
    const filteredVals = [];
    for (let i = startIdx; i <= endIdx; i++) {
        filteredTs.push(timestamps[i]);
        filteredVals.push(values[i]);
    }
    return { timestamps: filteredTs, values: filteredVals };
}

/**
 * Render plot using local filtering (no API call).
 */
function renderPlotFromCacheFiltered(plot) {
    if (plot.signals.length === 0) return;

    const filteredData = {};
    let commonTimestamps = null;
    
    for (const sigIdx of plot.signals) {
        const cached = plot.cachedData[sigIdx];
        if (!cached) continue;
        
        const filtered = filterCachedData(cached.timestamps, cached.values, globalView.min, globalView.max);
        filteredData[sigIdx] = filtered;
        
        if (!commonTimestamps) {
            commonTimestamps = filtered.timestamps;
        }
    }
    
    if (!commonTimestamps || commonTimestamps.length === 0) return;
    
    const uplotData = [commonTimestamps];
    const series = [{}];

    plot.signals.forEach(sigIdx => {
        const cached = plot.cachedData[sigIdx];
        const filtered = filteredData[sigIdx];
        if (!cached || !filtered) return;
        const style = resolveSignalStyle(plot, sigIdx, cached.color);
        uplotData.push(filtered.values);
        series.push(buildSeriesConfig(cached.name, cached.unit, style));
    });

    const bands = buildBands(series, uplotData);
    commitPlotRender(plot, series, uplotData, bands);

    autoEnableExtendedZones(plot);
}

// --- Full send : rapatriement pleine résolution côté client ---
// Après le premier rendu (vue décimée via /view), on rapatrie en tâche de fond les signaux
// affichés en pleine résolution (binaire). Une fois en cache avec isComplete, tout le pan/zoom
// est rendu localement par canRenderFromCache -> renderPlotFromCacheFiltered, sans réseau.
const fullDataInFlight = new Set();

async function fetchRawSignals(indices) {
    if (!currentLazySessionId || indices.length === 0) return null;
    let url = `${API}/raw?session_id=${encodeURIComponent(currentLazySessionId)}&signals=${indices.join(',')}`;
    const headers = {};
    const token = sessionStorage.getItem('auth_token');
    if (token) headers['Authorization'] = 'Bearer ' + token;

    const res = await fetch(url, { headers });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();

    const headerLen = new DataView(buf).getUint32(0, true);
    const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, headerLen)));
    let off = 4 + headerLen;
    const signals = [];
    for (const h of header.signals) {
        const n = h.n;
        // slice() recopie sur un buffer aligné (requis par Float64Array/Float32Array).
        const timestamps = new Float64Array(buf.slice(off, off + n * 8)); off += n * 8;
        const values = new Float32Array(buf.slice(off, off + n * 4)); off += n * 4;
        let mn = Infinity, mx = -Infinity;
        for (let i = 0; i < values.length; i++) { const v = values[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
        signals.push({
            index: h.index, name: h.name, unit: h.unit, color: h.color,
            timestamps, values, is_complete: true,
            string_map: h.string_map || null, is_categorical: h.is_categorical || false,
            stats: { min: mn === Infinity ? 0 : mn, max: mx === -Infinity ? 0 : mx },
        });
    }
    return { signals };
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
    if (!currentLazySessionId || !plot || plot.signals.length === 0) return;
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
            if (canRenderFromCache(plot, globalView.min, globalView.max)) {
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

async function fetchAndRenderPlot(plot) {
    if (plot.signals.length === 0) return;

    // 1) Signaux complets deja en cache: rendu client immediat.
    if (canRenderFromCache(plot, globalView.min, globalView.max)) {
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

    // 2bis) Requete deja lancee au pickup (drag): un plot frais (1 signal) la retrouve
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
    if (!plot.isBoolPlot && cacheCoversView(plot, globalView.min, globalView.max)) {
        renderPlotFromCacheFiltered(plot);
    }

    const signalIndices = plot.signals.join(',');
    let url = `${API}/view?signals=${signalIndices}&start=${globalView.min}&end=${globalView.max}&max_points=${maxPts}`;

    const headers = {};
    if (currentLazySessionId) {
        url += `&session_id=${encodeURIComponent(currentLazySessionId)}`;
        const token = sessionStorage.getItem('auth_token');
        if (token) {
            headers['Authorization'] = 'Bearer ' + token;
        }
    }

    const startTime = performance.now();

    try {
        const res = await fetch(url, { headers });
        const data = await res.json();

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
function cacheServerSignals(plot, data) {
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
            isComplete: sig.is_complete,
            timeRange: newTimeRange,
            fullTimeRange: sig.is_complete ? newTimeRange : null,
            stringMap: sig.string_map || null,
            isCategorical: sig.is_categorical || false
        };

        applyUnitConversion(plot, sig.index);
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
    return Array.from(values, v =>
        (v === null || v === undefined || Number.isNaN(v)) ? v : v * factor + offset
    );
}

function renderPlotChart(plot, data) {
    if (!data.signals || data.signals.length === 0) return;

    cacheServerSignals(plot, data);

    const timestamps = data.signals[0].timestamps;
    const uplotData = [timestamps];
    const series = [{}];

    data.signals.forEach(sig => {
        const style = resolveSignalStyle(plot, sig.index, sig.color);
        const conv = plot.unitConversions?.[sig.index];
        uplotData.push(conv ? convertValues(sig.values, conv) : sig.values);
        series.push(buildSeriesConfig(sig.name, conv ? conv.targetUnit : sig.unit, style));
    });

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
        padding: [null, PLOT_PAD_RIGHT, null, null],
        scales: {
            x: { time: false, range: [globalView.min, globalView.max] },
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
function renderBoolPlot(plot) {
    if (plot.signals.length === 0) return;

    const chartDiv = plot.element.querySelector('.chart');
    const bodyDiv = plot.element.querySelector('.plot-body');

    if (plot.chart) plot.chart.destroy();

    const first = plot.cachedData[plot.signals[0]];
    if (!first || !first.timestamps || first.timestamps.length === 0) return;

    // Signaux booleens recuperes ensemble => timestamps alignes. On borne a la vue MAIS
    // en gardant le point le plus proche AU-DELA de chaque bord (sinon l'escalier est
    // coupe aux bords, ou disparait dans un palier sans front). Le point hors-vue est
    // clippe par l'echelle X.
    const ts = first.timestamps;
    const N = ts.length;
    let lo = 0;
    while (lo < N && ts[lo] < globalView.min) lo++;
    let hi = N - 1;
    while (hi >= 0 && ts[hi] > globalView.max) hi--;
    let startIdx = lo > 0 ? lo - 1 : 0;
    let endIdx = hi < N - 1 ? hi + 1 : N - 1;
    if (startIdx > endIdx) {
        startIdx = Math.max(0, Math.min(lo, N - 1));
        endIdx = startIdx;
    }

    const filteredTs = [];
    const keepIdx = [];
    for (let i = startIdx; i <= endIdx; i++) {
        filteredTs.push(ts[i]);
        keepIdx.push(i);
    }
    if (filteredTs.length === 0) return;

    const n = plot.signals.length;
    const laneOffsets = {};
    const uplotData = [filteredTs];
    const series = [{}];

    plot.signals.forEach((sigIdx, k) => {
        const cached = plot.cachedData[sigIdx];
        if (!cached) return;

        const lane = n - 1 - k;          // premier signal en haut
        const base = lane * 2;
        laneOffsets[sigIdx] = base;

        uplotData.push(keepIdx.map(i => {
            const v = cached.values[i];
            return v == null ? null : v + base;
        }));

        const style = resolveSignalStyle(plot, sigIdx, cached.color);
        series.push({
            label: cached.name,
            stroke: style.color,
            width: style.width,
            paths: pathRenderer('stepped'),
            fill: colorWithOpacity(style.color, 0.3),
            fillTo: base,
            points: { show: false },
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

// Historique des niveaux de zoom/vue. recordViewChange() memorise l'etat courant
// avant un changement (zoom ou pan) et invalide le redo. undoView()/redoView()
// naviguent dans les vues precedentes/suivantes (Ctrl+Z / Ctrl+Y, double-clic).
function recordViewChange() {
    viewHistory.push({ ...globalView });
    if (viewHistory.length > MAX_HISTORY) viewHistory.shift();
    redoStack = [];
}

function applyRestoredView(view) {
    S.plots.forEach(p => { p.yRange = null; }); // Y se recadre sur la fenetre restauree
    globalView = view;
    refreshAllPlots();
}

function undoView() {
    if (viewHistory.length === 0) return false;
    redoStack.push({ ...globalView });
    if (redoStack.length > MAX_HISTORY) redoStack.shift();
    applyRestoredView(viewHistory.pop());
    return true;
}

function redoView() {
    if (redoStack.length === 0) return false;
    viewHistory.push({ ...globalView });
    if (viewHistory.length > MAX_HISTORY) viewHistory.shift();
    applyRestoredView(redoStack.pop());
    return true;
}

function refreshAllPlots() {
    S.plots.forEach(plot => fetchAndRenderPlot(plot));
}

// Re-fenetrage local pour une nouvelle fenetre X (pan): rejoue le cache complet sans
// aucune requete /view. Ne retombe sur le serveur que pour un panneau dont les donnees
// ne sont pas encore entierement rapatriees (full send encore en cours).
function applyGlobalViewLocal() {
    S.plots.forEach(plot => {
        if (plot.signals.length === 0) return;
        if (canRenderFromCache(plot, globalView.min, globalView.max)) {
            if (plot.isBoolPlot) renderBoolPlot(plot);
            else renderPlotFromCacheFiltered(plot);
        } else {
            fetchAndRenderPlot(plot);
        }
    });
}

// =========================================================================
// Cursors
// =========================================================================
function cursorPlugin() {
    let line1, line2;
    let timeLabel1, timeLabel2;
    let deltaLine, deltaLabel;
    let labelPool1 = [];
    let labelPool2 = [];
    let over;
    let draggingCursor = null;
    let dragRafId = null;
    let pendingClientX = 0;
    let dragOverRect = null;
    let onDocMouseMove = null;
    let onDocMouseUp = null;

    // Hauteur d'une ligne de label (px) et espace reserve en haut pour les labels
    // de temps/delta empiles, recalcule a chaque rendu par updateTimeLabels.
    const LABEL_ROW_H = 18;
    const VALUE_LABEL_H = 18;
    let topReserved = 2 + LABEL_ROW_H;

    // Place un label en haut (temps/delta) sur la premiere ligne libre evitant le
    // chevauchement horizontal avec ceux deja places. Retourne l'indice de ligne.
    function placeTopLabel(placed, centerX, width) {
        const half = width / 2;
        const x0 = centerX - half;
        const x1 = centerX + half;
        let row = 0;
        while (row < 6) {
            const conflict = placed.some(p => p.row === row && !(x1 < p.x0 || x0 > p.x1));
            if (!conflict) break;
            row++;
        }
        placed.push({ row, x0, x1 });
        return row;
    }

    // Largeur estimee d'un label monospace (10px ~6px/char + padding + bordure).
    function estLabelWidth(text) {
        return text.length * 6 + 16;
    }

    // Repartit verticalement des labels de valeurs pour eviter les chevauchements,
    // en restant sous la zone des labels de temps et dans la hauteur du graphe.
    function declutterValueLabels(entries, height) {
        const n = entries.length;
        if (n === 0) return;
        entries.sort((a, b) => a.y - b.y);
        const top = topReserved + VALUE_LABEL_H / 2;
        const bottom = Math.max(top, height - VALUE_LABEL_H / 2);
        let prev = -Infinity;
        for (let i = 0; i < n; i++) {
            const y = Math.max(entries[i].y, top, prev + VALUE_LABEL_H);
            entries[i].y = y;
            prev = y;
        }
        if (entries[n - 1].y > bottom) {
            let next = Infinity;
            for (let i = n - 1; i >= 0; i--) {
                const y = Math.min(entries[i].y, bottom, next - VALUE_LABEL_H);
                entries[i].y = y;
                next = y;
            }
        }
    }

    // Construit, repartit et positionne les labels de valeurs d'un curseur.
    // side='left' place les labels a gauche du curseur, 'right' a droite.
    function layoutCursorValueLabels(u, plot, cursorVal, xPos, labelPool, side) {
        const entries = [];
        plot.signals.forEach(sigIdx => {
            const cached = plot.cachedData[sigIdx];
            if (!cached) return;
            const result = getValueAtTime(cached.timestamps, cached.values, cursorVal, cached.stringMap);
            if (result === null) return;
            const yOff = plot.isBoolPlot ? (plot.laneOffsets?.[sigIdx] || 0) : 0;
            const yPos = u.valToPos(result.numeric + yOff, 'y');
            if (yPos < 0 || yPos > u.height) return;
            // Couleur resolue (inclut l'override utilisateur): cached.color est remis a
            // la couleur serveur a chaque refetch (zoom/dezoom), donc ne pas l'utiliser.
            const color = resolveSignalStyle(plot, sigIdx, cached.color).color;
            entries.push({ y: yPos, color, text: result.display });
        });

        declutterValueLabels(entries, u.height);

        entries.forEach((en, i) => {
            let label = labelPool[i];
            if (!label) {
                label = document.createElement('div');
                label.className = 'cursor-label';
                over.appendChild(label);
                labelPool[i] = label;
            }
            label.style.display = 'block';
            label.style.setProperty('--sig-color', en.color);
            if (label.textContent !== en.text) label.textContent = en.text;
            label.style.transform = side === 'left'
                ? `translate3d(${xPos - 4}px, ${en.y}px, 0) translate(-100%, -50%)`
                : `translate3d(${xPos + 4}px, ${en.y}px, 0) translateY(-50%)`;
        });
        for (let i = entries.length; i < labelPool.length; i++) {
            if (labelPool[i]) labelPool[i].style.display = 'none';
        }
    }

    function updateTimeLabels(u, isFirst) {
        // Le temps des curseurs et le delta ne sont utiles qu'une fois: l'axe X est
        // partage par tous les graphes. On ne les affiche que sur le premier; ailleurs
        // on libere l'espace haut pour les labels de valeurs.
        if (!isFirst) {
            if (timeLabel1) timeLabel1.style.display = 'none';
            if (timeLabel2) timeLabel2.style.display = 'none';
            if (deltaLine) deltaLine.style.display = 'none';
            if (deltaLabel) deltaLabel.style.display = 'none';
            topReserved = 2;
            return;
        }

        const has1 = S.cursor1 !== null;
        const has2 = S.cursor2 !== null;
        const x1 = has1 ? u.valToPos(S.cursor1, 'x') : 0;
        const x2 = has2 ? u.valToPos(S.cursor2, 'x') : 0;
        const placed = [];
        let maxRow = 0;

        // Labels de temps: centres sur leur curseur, empiles en lignes s'ils se
        // chevauchent horizontalement.
        if (has1 && timeLabel1) {
            const text = S.cursor1.toFixed(3) + 's';
            if (timeLabel1.textContent !== text) timeLabel1.textContent = text;
            const row = placeTopLabel(placed, x1, estLabelWidth(text));
            maxRow = Math.max(maxRow, row);
            timeLabel1.style.display = 'block';
            timeLabel1.style.transform =
                `translate3d(${x1 + 3}px, ${row * LABEL_ROW_H}px, 0) translateX(-50%)`;
        } else if (timeLabel1) {
            timeLabel1.style.display = 'none';
        }

        if (has2 && timeLabel2) {
            const text = S.cursor2.toFixed(3) + 's';
            if (timeLabel2.textContent !== text) timeLabel2.textContent = text;
            const row = placeTopLabel(placed, x2, estLabelWidth(text));
            maxRow = Math.max(maxRow, row);
            timeLabel2.style.display = 'block';
            timeLabel2.style.transform =
                `translate3d(${x2 + 3}px, ${row * LABEL_ROW_H}px, 0) translateX(-50%)`;
        } else if (timeLabel2) {
            timeLabel2.style.display = 'none';
        }

        // Delta: ligne au sommet entre les curseurs, label centre sur la premiere
        // ligne libre (sous les labels de temps si necessaire).
        if (has1 && has2 && deltaLine && deltaLabel) {
            const left = Math.min(x1, x2);
            const width = Math.max(x1, x2) - left;

            deltaLine.style.display = 'block';
            deltaLine.style.transform = `translate3d(${left}px, 0, 0)`;
            deltaLine.style.width = width + 'px';

            const deltaText = 'Δ ' + Math.abs(S.cursor2 - S.cursor1).toFixed(3) + 's';
            if (deltaLabel.textContent !== deltaText) deltaLabel.textContent = deltaText;
            const center = left + width / 2;
            const row = placeTopLabel(placed, center, estLabelWidth(deltaText));
            maxRow = Math.max(maxRow, row);
            deltaLabel.style.display = 'block';
            deltaLabel.style.transform =
                `translate3d(${center}px, ${row * LABEL_ROW_H}px, 0) translateX(-50%)`;
        } else {
            if (deltaLine) deltaLine.style.display = 'none';
            if (deltaLabel) deltaLabel.style.display = 'none';
        }

        // Reserve la hauteur occupee par les lignes de labels pour que les labels
        // de valeurs ne les recouvrent pas.
        topReserved = 2 + (maxRow + 1) * LABEL_ROW_H;
    }

    // Positionne lignes, labels et delta des curseurs sans redessiner le canvas.
    // Appelee par le hook draw (zoom, nouvelles donnees) et directement pendant
    // le drag (les echelles ne changent pas: un redraw complet serait du gaspillage).
    function updateOverlay(u) {
        const plot = S.plots.find(p => p.chart === u);
        if (!plot) return;

        updateTimeLabels(u, S.plots[0] === plot);

        // Cote d'affichage des labels de valeurs: avec deux curseurs, celui de
        // gauche affiche a gauche, celui de droite a droite (pas de collision au
        // centre). Avec un seul curseur: a droite.
        let side1 = 'right';
        let side2 = 'right';
        if (S.cursor1 !== null && S.cursor2 !== null) {
            const leftIsCursor1 = u.valToPos(S.cursor1, 'x') <= u.valToPos(S.cursor2, 'x');
            side1 = leftIsCursor1 ? 'left' : 'right';
            side2 = leftIsCursor1 ? 'right' : 'left';
        }

        // --- Cursor 1 ---
        if (S.cursor1 !== null) {
            const xPos = u.valToPos(S.cursor1, 'x');
            line1.style.transform = `translate3d(${xPos}px, 0, 0)`;
            line1.style.display = 'block';
            layoutCursorValueLabels(u, plot, S.cursor1, xPos, labelPool1, side1);
        } else {
            line1.style.display = 'none';
            labelPool1.forEach(l => { if (l) l.style.display = 'none'; });
        }

        // --- Cursor 2 ---
        if (S.cursor2 !== null) {
            const xPos = u.valToPos(S.cursor2, 'x');
            line2.style.transform = `translate3d(${xPos}px, 0, 0)`;
            line2.style.display = 'block';
            layoutCursorValueLabels(u, plot, S.cursor2, xPos, labelPool2, side2);
        } else {
            line2.style.display = 'none';
            labelPool2.forEach(l => { if (l) l.style.display = 'none'; });
        }

        updateCursorReadout(plot);
    }

    return {
        hooks: {
            init: u => {
                over = u.root.querySelector('.u-over');
                
                over.addEventListener('dblclick', e => {
                    undoView();
                });

                line1 = document.createElement('div');
                line1.className = 'cursor-line cursor-1';
                line1.style.display = 'none';
                over.appendChild(line1);

                timeLabel1 = document.createElement('div');
                timeLabel1.className = 'cursor-time-label';
                timeLabel1.style.cssText = '--cursor-color: var(--cursor-a);';
                timeLabel1.style.display = 'none';
                over.appendChild(timeLabel1);

                line2 = document.createElement('div');
                line2.className = 'cursor-line cursor-2';
                line2.style.display = 'none';
                over.appendChild(line2);

                timeLabel2 = document.createElement('div');
                timeLabel2.className = 'cursor-time-label';
                timeLabel2.style.cssText = '--cursor-color: var(--cursor-b);';
                timeLabel2.style.display = 'none';
                over.appendChild(timeLabel2);

                deltaLine = document.createElement('div');
                deltaLine.className = 'cursor-delta-line';
                deltaLine.style.display = 'none';
                over.appendChild(deltaLine);

                deltaLabel = document.createElement('div');
                deltaLabel.className = 'cursor-delta-label';
                deltaLabel.style.display = 'none';
                over.appendChild(deltaLabel);

                // Chemin léger pour le drag des curseurs: repositionne l'overlay
                // de ce chart sans redraw canvas
                u.updateCursorOverlay = () => updateOverlay(u);

                line1.addEventListener('mousedown', e => {
                    e.stopPropagation();
                    e.preventDefault();
                    draggingCursor = 1;
                    dragOverRect = over.getBoundingClientRect();
                    line1.classList.add('dragging');
                    document.body.style.cursor = 'ew-resize';
                    document.body.style.userSelect = 'none';
                });

                line2.addEventListener('mousedown', e => {
                    e.stopPropagation();
                    e.preventDefault();
                    draggingCursor = 2;
                    dragOverRect = over.getBoundingClientRect();
                    line2.classList.add('dragging');
                    document.body.style.cursor = 'ew-resize';
                    document.body.style.userSelect = 'none';
                });

                onDocMouseMove = e => {
                    if (draggingCursor === null) return;
                    pendingClientX = e.clientX;
                    if (dragRafId !== null) return;
                    dragRafId = requestAnimationFrame(() => {
                        dragRafId = null;
                        if (draggingCursor === null) return;
                        const rect = dragOverRect || over.getBoundingClientRect();
                        const x = Math.max(0, Math.min(pendingClientX - rect.left, rect.width));
                        const time = u.posToVal(x, 'x');
                        if (draggingCursor === 1) S.cursor1 = time;
                        else S.cursor2 = time;
                        updateCursors();
                    });
                };
                document.addEventListener('mousemove', onDocMouseMove);

                onDocMouseUp = () => {
                    if (draggingCursor !== null) {
                        line1.classList.remove('dragging');
                        line2.classList.remove('dragging');
                        draggingCursor = null;
                        dragOverRect = null;
                        document.body.style.cursor = '';
                        document.body.style.userSelect = '';
                    }
                };
                document.addEventListener('mouseup', onDocMouseUp);

                over.addEventListener('click', e => {
                    if (e.ctrlKey || e.metaKey) {
                        const x = e.clientX - over.getBoundingClientRect().left;
                        placeCursorAt(u.posToVal(x, 'x'));
                    }
                });
            },
            destroy: u => {
                if (onDocMouseMove) document.removeEventListener('mousemove', onDocMouseMove);
                if (onDocMouseUp) document.removeEventListener('mouseup', onDocMouseUp);
                if (dragRafId !== null) cancelAnimationFrame(dragRafId);
                delete u.updateCursorOverlay;
            },
            draw: u => updateOverlay(u)
        }
    };
}

// Signal selectionne dans la legende: { plotId, sigIdx } ou null.
// Selection par clic sur la ligne du tableau, deselection par le meme clic,
// suppression du signal uniquement via la touche Suppr quand selectionne.
let selectedLegendSignal = null;

function isLegendSignalSelected(plotId, sigIdx) {
    return selectedLegendSignal !== null
        && selectedLegendSignal.plotId === plotId
        && selectedLegendSignal.sigIdx === sigIdx;
}

function toggleLegendSignalSelection(plotId, sigIdx) {
    const wasSelected = isLegendSignalSelected(plotId, sigIdx);
    const previous = selectedLegendSignal;
    selectedLegendSignal = wasSelected ? null : { plotId, sigIdx };

    // Re-rend les plots concernes pour appliquer la mise en exergue du trait
    const affected = new Set();
    if (previous) affected.add(previous.plotId);
    if (selectedLegendSignal) affected.add(selectedLegendSignal.plotId);
    affected.forEach(pid => {
        const plot = S.plots.find(pl => pl.id === pid);
        if (plot) {
            renderPlotFromCache(plot);
            updateLegendSelectionClasses(plot);
        }
    });
}

function updateLegendSelectionClasses(plot) {
    plot.element?.querySelectorAll('.legend-row').forEach(row => {
        const sigIdx = parseInt(row.dataset.sigIdx, 10);
        row.classList.toggle('selected', isLegendSignalSelected(plot.id, sigIdx));
    });
}

// Suppr: retire le signal selectionne. Ignore quand le focus est dans un
// champ de saisie pour ne pas interferer avec l'edition.
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Delete') return;
    if (!selectedLegendSignal) return;
    const target = e.target;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT'
            || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
    }
    const { plotId, sigIdx } = selectedLegendSignal;
    selectedLegendSignal = null;
    removeSignalFromPlot(plotId, sigIdx);
});

// Copie le nom du signal sélectionné dans la liste de droite via Ctrl+C / Cmd+C. On laisse la copie
// native agir si le focus est dans un champ ou si l'utilisateur a sélectionné du texte.
function copyTextToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(() => fallbackCopyText(text));
    } else {
        fallbackCopyText(text);
    }
}

function fallbackCopyText(text) {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try { document.execCommand('copy'); } catch (_) { /* sans effet */ }
    document.body.removeChild(area);
}

document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || (e.key !== 'c' && e.key !== 'C')) return;
    if (!selectedLegendSignal) return;
    const target = e.target;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT'
            || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
    }
    const selection = window.getSelection && window.getSelection().toString();
    if (selection) return;

    const sig = S.signalsInfo[selectedLegendSignal.sigIdx];
    if (!sig) return;
    e.preventDefault();
    copyTextToClipboard(sig.name);
    if (typeof showNotification === 'function') showNotification(`Nom copié : ${sig.name}`, 'success');
});

// Ctrl+Z / Ctrl+Y : bascule vers les niveaux de zoom precedents / suivants.
// Ctrl+Shift+Z fait aussi redo. Inactif si le focus est dans un champ de saisie.
document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const target = e.target;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT'
            || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
    }
    const k = e.key.toLowerCase();
    const isRedo = k === 'y' || (k === 'z' && e.shiftKey);
    const isUndo = k === 'z' && !e.shiftKey;
    if (!isUndo && !isRedo) return;
    if (isRedo ? redoView() : undoView()) e.preventDefault();
});

function formatCursorNumber(v) {
    if (!Number.isFinite(v)) return '-';
    const abs = Math.abs(v);
    if (abs >= 1000) return v.toFixed(1);
    if (abs >= 1) return v.toFixed(3);
    return v.toFixed(4);
}

function setTextIfChanged(el, text) {
    if (el && el.textContent !== text) el.textContent = text;
}

// Met a jour la table de mesure A / B / delta de la legende d'un panneau.
// Appele par le chemin leger des curseurs (drag) et apres reconstruction
// de la legende: uniquement des ecritures DOM gardees, aucun layout force.
function updateCursorReadout(plot) {
    const table = plot.element?.querySelector('.legend-table');
    if (!table) return;

    const active = S.cursor1 !== null || S.cursor2 !== null;
    const both = S.cursor1 !== null && S.cursor2 !== null;

    // Bascule mesure/legende simple + elargissement de la zone, garde sur le
    // changement d'etat: le resize des charts ne doit pas tourner par frame.
    const legendDiv = plot.element.querySelector('.plot-legend');
    if (table.classList.contains('cursors-active') !== active) {
        table.classList.toggle('cursors-active', active);
        if (legendDiv) legendDiv.classList.toggle('has-cursor-table', active);
        if (typeof resizePlotCharts === 'function') {
            setTimeout(resizePlotCharts, 0);
        }
    }

    if (!active) return;

    setTextIfChanged(table.querySelector('[data-time="a"]'),
        S.cursor1 !== null ? S.cursor1.toFixed(3) : '-');
    setTextIfChanged(table.querySelector('[data-time="b"]'),
        S.cursor2 !== null ? S.cursor2.toFixed(3) : '-');
    setTextIfChanged(table.querySelector('[data-time="d"]'),
        both ? (S.cursor2 - S.cursor1).toFixed(3) : '-');

    plot.signals.forEach(sigIdx => {
        const cached = plot.cachedData[sigIdx];
        const rA = (S.cursor1 !== null && cached)
            ? getValueAtTime(cached.timestamps, cached.values, S.cursor1, cached.stringMap) : null;
        const rB = (S.cursor2 !== null && cached)
            ? getValueAtTime(cached.timestamps, cached.values, S.cursor2, cached.stringMap) : null;

        setTextIfChanged(table.querySelector(`[data-sig="${sigIdx}"][data-col="a"]`), rA ? rA.display : '-');
        setTextIfChanged(table.querySelector(`[data-sig="${sigIdx}"][data-col="b"]`), rB ? rB.display : '-');

        let deltaText = '-';
        if (rA && rB && !cached.stringMap
                && Number.isFinite(rA.numeric) && Number.isFinite(rB.numeric)) {
            deltaText = formatCursorNumber(rB.numeric - rA.numeric);
        }
        setTextIfChanged(table.querySelector(`[data-sig="${sigIdx}"][data-col="d"]`), deltaText);
    });
}

function getValueAtTime(timestamps, values, targetTime, stringMap = null) {
    if (!timestamps || !values || timestamps.length === 0) return null;
    
    let lo = 0, hi = timestamps.length - 1;
    while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (timestamps[mid] < targetTime) lo = mid + 1;
        else hi = mid;
    }
    if (lo > 0 && Math.abs(timestamps[lo - 1] - targetTime) < Math.abs(timestamps[lo] - targetTime)) {
        lo = lo - 1;
    }
    
    const numericValue = values[lo];
    
    // Si on a un stringMap, retourner la valeur textuelle
    if (stringMap) {
        const key = Math.round(numericValue);
        const textValue = stringMap[key] !== undefined ? stringMap[key] : numericValue.toFixed(2);
        return { numeric: numericValue, display: textValue };
    }
    
    return { numeric: numericValue, display: numericValue.toFixed(2) };
}

// Place un curseur au temps donné selon le cycle: c1 vide -> c1, sinon c2 vide -> c2,
// sinon réinitialise sur c1. Logique unique partagée par le Ctrl+clic et le bouton.
function placeCursorAt(time) {
    if (!S.cursor1) S.cursor1 = time;
    else if (!S.cursor2) S.cursor2 = time;
    else { S.cursor1 = time; S.cursor2 = null; }
    updateCursors();
}

// Bouton de la toolbar: même comportement que le Ctrl+clic, en plaçant le curseur
// au centre de la vue temporelle courante (le bouton n'a pas de position de clic).
function addCursorFromButton() {
    if (!Number.isFinite(globalView.min) || !Number.isFinite(globalView.max)) return;
    placeCursorAt((globalView.min + globalView.max) / 2);
}

function updateCursors() {
    S.plots.forEach(p => {
        const chart = p.chart;
        if (!chart) return;
        if (chart.updateCursorOverlay) chart.updateCursorOverlay();
        else chart.redraw();
    });
}

// =========================================================================
// Resize Handler
// =========================================================================
let resizeTimer;
window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
        renderVirtualList(true);
        S.plots.forEach(plot => {
            if (plot.chart) {
                const body = plot.element.querySelector('.plot-body');
                if (body) {
                    plot.chart.setSize({ width: body.clientWidth, height: body.clientHeight });
                }
            }
        });
    }, 100);
});

function resizePlotCharts() {
    setTimeout(() => {
        S.plots.forEach(plot => {
            if (plot.chart) {
                const body = plot.element.querySelector('.plot-body');
                if (body) {
                    plot.chart.setSize({ width: body.clientWidth, height: body.clientHeight });
                }
            }
        });
    }, 50);
}

// =========================================================================
// EDA File Upload Modal
// =========================================================================
let edaSelectedFile = null;
let edaSelectedDbc = null;
let currentSessionId = null;

function openUploadModal() {
    const modal = document.getElementById('uploadModal');
    if (!modal) return;
    // Les modales sont injectées dynamiquement : resynchronise les éléments
    // dépendants de l'état d'authentification (notes invité/connecté)
    if (typeof updateAuthUI === 'function') updateAuthUI();
    modal.classList.add('active');
}

function closeUploadModal(event) {
    if (event && event.target !== event.currentTarget) return;
    const modal = document.getElementById('uploadModal');
    if (modal) modal.classList.remove('active');
    resetUploadModal();
}

function resetUploadModal() {
    edaSelectedFile = null;
    edaSelectedDbc = null;
    
    const edaInputFile = document.getElementById('edaInputFile');
    const edaDbcFile = document.getElementById('edaDbcFile');
    const edaFileInputDisplay = document.getElementById('edaFileInputDisplay');
    const edaFileSelected = document.getElementById('edaFileSelected');
    const edaDbcInputDisplay = document.getElementById('edaDbcInputDisplay');
    const edaDbcSelected = document.getElementById('edaDbcSelected');
    const edaUploadProgress = document.getElementById('edaUploadProgress');
    const edaUploadBtn = document.getElementById('edaUploadBtn');
    
    if (edaInputFile) edaInputFile.value = '';
    if (edaDbcFile) edaDbcFile.value = '';
    if (edaFileInputDisplay) edaFileInputDisplay.style.display = 'block';
    if (edaFileSelected) edaFileSelected.style.display = 'none';
    if (edaDbcInputDisplay) edaDbcInputDisplay.style.display = 'block';
    if (edaDbcSelected) edaDbcSelected.style.display = 'none';
    if (edaUploadProgress) edaUploadProgress.style.display = 'none';
    if (edaUploadBtn) edaUploadBtn.disabled = true;
}

function handleEdaFileSelect(input) {
    const file = input.files[0];
    if (file) {
        edaSelectedFile = file;
        const edaFileInputDisplay = document.getElementById('edaFileInputDisplay');
        const edaFileSelected = document.getElementById('edaFileSelected');
        const edaFileName = document.getElementById('edaFileName');
        const edaFileSize = document.getElementById('edaFileSize');
        const edaUploadBtn = document.getElementById('edaUploadBtn');
        
        if (edaFileInputDisplay) edaFileInputDisplay.style.display = 'none';
        if (edaFileSelected) edaFileSelected.style.display = 'flex';
        if (edaFileName) edaFileName.textContent = file.name;
        if (edaFileSize) edaFileSize.textContent = formatEdaFileSize(file.size);
        if (edaUploadBtn) edaUploadBtn.disabled = false;
    }
}

function handleEdaDbcSelect(input) {
    const file = input.files[0];
    if (file) {
        edaSelectedDbc = file;
        const edaDbcInputDisplay = document.getElementById('edaDbcInputDisplay');
        const edaDbcSelected = document.getElementById('edaDbcSelected');
        const edaDbcFileName = document.getElementById('edaDbcFileName');
        
        if (edaDbcInputDisplay) edaDbcInputDisplay.style.display = 'none';
        if (edaDbcSelected) edaDbcSelected.style.display = 'flex';
        if (edaDbcFileName) edaDbcFileName.textContent = file.name;
    }
}

function removeEdaFile() {
    edaSelectedFile = null;
    const edaInputFile = document.getElementById('edaInputFile');
    const edaFileInputDisplay = document.getElementById('edaFileInputDisplay');
    const edaFileSelected = document.getElementById('edaFileSelected');
    const edaUploadBtn = document.getElementById('edaUploadBtn');
    
    if (edaInputFile) edaInputFile.value = '';
    if (edaFileInputDisplay) edaFileInputDisplay.style.display = 'block';
    if (edaFileSelected) edaFileSelected.style.display = 'none';
    if (edaUploadBtn) edaUploadBtn.disabled = true;
}

function removeEdaDbc() {
    edaSelectedDbc = null;
    const edaDbcFile = document.getElementById('edaDbcFile');
    const edaDbcInputDisplay = document.getElementById('edaDbcInputDisplay');
    const edaDbcSelected = document.getElementById('edaDbcSelected');
    
    if (edaDbcFile) edaDbcFile.value = '';
    if (edaDbcInputDisplay) edaDbcInputDisplay.style.display = 'block';
    if (edaDbcSelected) edaDbcSelected.style.display = 'none';
}

function formatEdaFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

async function uploadEdaFile() {
    if (!edaSelectedFile) return;

    const isBlf = edaSelectedFile.name.toLowerCase().endsWith('.blf');
    if (isBlf && !edaSelectedDbc) {
        if (typeof showNotification === 'function') {
            showNotification('Un fichier ARXML ou DBC est requis pour décoder un BLF.', 'error');
        }
        return;
    }
    
    const edaUploadProgress = document.getElementById('edaUploadProgress');
    const edaUploadBtn = document.getElementById('edaUploadBtn');
    const edaUploadText = document.getElementById('edaUploadText');
    const edaUploadFill = document.getElementById('edaUploadFill');
    const edaUploadPercent = document.getElementById('edaUploadPercent');
    
    if (edaUploadProgress) edaUploadProgress.style.display = 'block';
    if (edaUploadBtn) edaUploadBtn.disabled = true;
    if (edaUploadText) edaUploadText.textContent = 'Upload en cours...';
    if (edaUploadFill) edaUploadFill.style.width = '0%';
    if (edaUploadPercent) edaUploadPercent.textContent = '0%';
    
    try {
        const formData = new FormData();
        formData.append('file', edaSelectedFile);
        if (edaSelectedDbc) {
            const dbField = edaSelectedDbc.name.toLowerCase().endsWith('.arxml') ? 'arxml' : 'dbc';
            formData.append(dbField, edaSelectedDbc);
        }
        
        const xhr = new XMLHttpRequest();
        
        xhr.upload.addEventListener('progress', (e) => {
            if (e.lengthComputable) {
                const percent = Math.round((e.loaded / e.total) * 100);
                if (edaUploadFill) edaUploadFill.style.width = percent + '%';
                if (edaUploadPercent) edaUploadPercent.textContent = percent + '%';
                if (percent >= 100 && edaUploadText) {
                    // L'envoi est terminé mais le serveur écrit et indexe le fichier
                    edaUploadText.textContent = 'Traitement du fichier sur le serveur...';
                }
            }
        });
        
        xhr.addEventListener('load', async () => {
            if (xhr.status === 200) {
                const data = JSON.parse(xhr.responseText);
                console.log('EDA Upload success:', data);
                
                if (edaUploadText) edaUploadText.textContent = 'Chargement des signaux...';
                if (edaUploadFill) edaUploadFill.style.width = '100%';
                if (edaUploadPercent) edaUploadPercent.textContent = '100%';

                await loadSources();
                await activateLazySession(data.session_id, data.filename, data.ephemeral === true);
                
                if (typeof showNotification === 'function') {
                    const note = data.ephemeral ? ' (fichier temporaire, non sauvegardé)' : '';
                    showNotification(`Fichier "${data.filename}" chargé avec succès${note}`, 'success');
                }

                if (data.blf && typeof showNotification === 'function') {
                    const r = data.blf;
                    const pct = Math.round(r.decoded_ratio * 100);
                    let msg = `BLF décodé : ${r.signal_count} signaux, ${pct}% des trames décodées`;
                    if (r.unknown_frame_ids > 0) {
                        msg += ` - ${r.unknown_frame_ids} identifiant(s) non couvert(s) par la base`;
                    }
                    if (r.dropped_secured_pdus && r.dropped_secured_pdus.length > 0) {
                        msg += ` - ${r.dropped_secured_pdus.length} PDU sécurisé(s) sans payload ignoré(s)`;
                    }
                    showNotification(msg, r.unknown_frame_ids > 0 ? 'info' : 'success');
                }

                if (data.mat && typeof showNotification === 'function') {
                    const r = data.mat;
                    let msg = `.mat lu : ${r.signal_count} signaux (${r.time_series_signals} séries, `
                        + `${r.constant_signals} constantes) sur « ${r.time_variable} »`;
                    if (r.skipped_variables > 0) {
                        msg += ` - ${r.skipped_variables} variable(s) non temporelle(s) ignorée(s)`;
                    }
                    showNotification(msg, 'success');
                }
                
                closeUploadModal();
                
            } else {
                let errMsg = 'Upload échoué';
                try {
                    const err = JSON.parse(xhr.responseText);
                    errMsg = err.error || errMsg;
                } catch (e) {}
                throw new Error(errMsg);
            }
        });
        
        xhr.addEventListener('error', () => {
            throw new Error('Erreur réseau');
        });
        
        xhr.open('POST', `${API}/eda/upload`);
        const token = sessionStorage.getItem('auth_token');
        if (token) {
            xhr.setRequestHeader('Authorization', 'Bearer ' + token);
        }
        xhr.send(formData);
        
    } catch (e) {
        console.error('EDA Upload error:', e);
        if (edaUploadText) edaUploadText.textContent = 'Erreur: ' + e.message;
        if (edaUploadFill) edaUploadFill.style.width = '0%';
        if (edaUploadBtn) edaUploadBtn.disabled = false;
        
        if (typeof showNotification === 'function') {
            showNotification('Erreur: ' + e.message, 'error');
        }
    }
}

// Fermer la modale avec Escape
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closeUploadModal();
        closeCreateVariableModal();
    }
});

// =========================================================================
// Create Computed Variable (Drawer)
// =========================================================================
let variableMappings = {}; // { A: { index: 0, name: 'signal_name', color: '#fff' }, B: ... }
let currentMappingLabels = ['A', 'B']; // Current visible mapping slots
let editingVariableIndex = null; // Index de la variable en cours d'édition (null = création)

function openCreateVariableDrawer() {
    const drawer = document.getElementById('createVariableDrawer');
    if (drawer) {
        editingVariableIndex = null;
        resetCreateVariableForm();
        updateDrawerHeader(false);
        drawer.classList.add('active');
    }
}

// Alias pour compatibilité
function openCreateVariableModal() {
    openCreateVariableDrawer();
}

function closeCreateVariableDrawer() {
    const drawer = document.getElementById('createVariableDrawer');
    if (drawer) {
        drawer.classList.remove('active');
        drawer.classList.remove('creating');
        editingVariableIndex = null;
    }
}

// Alias pour compatibilité
function closeCreateVariableModal(event) {
    closeCreateVariableDrawer();
}

/**
 * Ouvre le drawer en mode édition/visualisation pour une variable calculée existante
 */
function openComputedVariableForEdit(signal) {
    const drawer = document.getElementById('createVariableDrawer');
    if (!drawer) return;
    
    editingVariableIndex = signal.index;
    
    // Reset d'abord
    resetCreateVariableForm();
    
    // Pré-remplir les champs
    const nameInput = document.getElementById('newVarName');
    const unitInput = document.getElementById('newVarUnit');
    const descInput = document.getElementById('newVarDescription');
    const formulaInput = document.getElementById('newVarFormula');
    
    if (nameInput) nameInput.value = signal.name || '';
    if (unitInput) unitInput.value = signal.unit || '';
    if (descInput) descInput.value = signal.description || '';
    if (formulaInput) formulaInput.value = signal.formula || '';
    
    // Reconstruire les mappings depuis source_signals et la formule
    const sourceSignals = signal.source_signals || [];
    const formula = signal.formula || '';
    
    // Extraire les variables utilisées dans la formule (A, B, C...)
    const usedVars = [...new Set((formula.match(/\b([A-Z])\b/g) || []))].sort();
    
    // Créer les slots nécessaires
    currentMappingLabels = usedVars.length > 0 ? usedVars : ['A', 'B'];
    variableMappings = {};
    
    // Mapper les variables aux signaux sources
    usedVars.forEach((varLetter, idx) => {
        if (idx < sourceSignals.length) {
            const signalName = sourceSignals[idx];
            // Trouver le signal dans signalsInfo
            const foundSignal = S.signalsInfo.find(s => s.name === signalName);
            if (foundSignal) {
                variableMappings[varLetter] = {
                    index: foundSignal.index,
                    name: foundSignal.name,
                    color: foundSignal.color
                };
            }
        }
    });
    
    renderVariableMappings();
    updateDrawerHeader(true);
    drawer.classList.add('active');
}

/**
 * Met à jour le header du drawer selon le mode (création/édition)
 */
function updateDrawerHeader(isEditMode) {
    const drawer = document.getElementById('createVariableDrawer');
    if (!drawer) return;
    
    const header = drawer.querySelector('.drawer-header h2');
    const description = drawer.querySelector('.drawer-description');
    const submitBtn = document.getElementById('submitCreateVar');
    const nameInput = document.getElementById('newVarName');
    
    if (isEditMode) {
        if (header) header.textContent = 'Variable calculée';
        if (description) {
            description.innerHTML = '<strong>📊 Mode visualisation</strong> - Vous pouvez modifier cette variable et cliquer sur "Mettre à jour" pour appliquer les changements.';
        }
        if (submitBtn) {
            submitBtn.innerHTML = `
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
                    <polyline points="17 21 17 13 7 13 7 21"/>
                    <polyline points="7 3 7 8 15 8"/>
                </svg>
                Mettre à jour`;
        }
        // Désactiver le changement de nom en mode édition
        if (nameInput) {
            nameInput.disabled = true;
            nameInput.title = 'Le nom ne peut pas être modifié';
        }
    } else {
        if (header) header.textContent = 'Créer une variable';
        if (description) {
            description.innerHTML = '<strong>↶ Glissez des signaux</strong> depuis la liste à gauche vers les slots ci-dessous, puis définissez votre formule.';
        }
        if (submitBtn) {
            submitBtn.innerHTML = `
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="20 6 9 17 4 12"></polyline>
                </svg>
                Créer`;
        }
        if (nameInput) {
            nameInput.disabled = false;
            nameInput.title = '';
        }
    }
}

function resetCreateVariableForm() {
    // Reset inputs
    const nameInput = document.getElementById('newVarName');
    const unitInput = document.getElementById('newVarUnit');
    const descInput = document.getElementById('newVarDescription');
    const formulaInput = document.getElementById('newVarFormula');
    
    if (nameInput) nameInput.value = '';
    if (unitInput) unitInput.value = '';
    if (descInput) descInput.value = '';
    if (formulaInput) formulaInput.value = '';
    
    // Reset mappings
    variableMappings = {};
    currentMappingLabels = ['A', 'B'];
    renderVariableMappings();
    
    // Clear errors
    document.querySelectorAll('.drawer-field.error').forEach(f => f.classList.remove('error'));
    document.querySelectorAll('.error-message').forEach(e => e.remove());
}

function renderVariableMappings() {
    const container = document.getElementById('varMappingList');
    if (!container) return;
    
    container.innerHTML = '';
    
    currentMappingLabels.forEach(label => {
        const item = document.createElement('div');
        item.className = 'var-mapping-item';
        item.dataset.label = label;
        
        const labelEl = document.createElement('div');
        labelEl.className = 'var-mapping-label';
        labelEl.textContent = label;
        
        const dropzone = document.createElement('div');
        dropzone.className = 'var-mapping-dropzone' + (variableMappings[label] ? '' : ' empty');
        dropzone.dataset.label = label;
        
        if (variableMappings[label]) {
            const mapping = variableMappings[label];
            dropzone.innerHTML = `
                <div class="mapped-signal">
                    <span class="signal-color-dot" style="background: ${mapping.color || '#888'}"></span>
                    <span class="signal-name">${escapeHtml(mapping.name)}</span>
                    <button class="remove-mapped" title="Retirer">&times;</button>
                </div>
            `;
            // Event listener for remove button
            dropzone.querySelector('.remove-mapped').addEventListener('click', (e) => {
                e.stopPropagation();
                delete variableMappings[label];
                renderVariableMappings();
            });
        } else {
            dropzone.textContent = 'Glissez un signal ici...';
        }
        
        // Drag & drop events
        dropzone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropzone.classList.add('dragover');
        });
        
        dropzone.addEventListener('dragleave', () => {
            dropzone.classList.remove('dragover');
        });
        
        dropzone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropzone.classList.remove('dragover');
            
            if (S.draggedSignal !== null) {
                const signal = S.signalsInfo[S.draggedSignal];
                if (signal) {
                    variableMappings[label] = {
                        index: signal.index,
                        name: signal.name,
                        unit: signal.unit,
                        color: signal.color || '#888'
                    };
                    renderVariableMappings();
                }
            }
        });
        
        item.appendChild(labelEl);
        item.appendChild(dropzone);
        container.appendChild(item);
    });
    
    updateMappingButtons();
}

function updateMappingButtons() {
    const removeBtn = document.getElementById('removeMappingBtn');
    if (removeBtn) {
        removeBtn.disabled = currentMappingLabels.length <= 1;
    }
}

function addMappingSlot() {
    // Get next letter
    const lastLabel = currentMappingLabels[currentMappingLabels.length - 1];
    const nextCharCode = lastLabel.charCodeAt(0) + 1;
    
    if (nextCharCode <= 90) { // 'Z'
        const nextLabel = String.fromCharCode(nextCharCode);
        currentMappingLabels.push(nextLabel);
        renderVariableMappings();
    }
}

function removeMappingSlot() {
    if (currentMappingLabels.length > 1) {
        const removedLabel = currentMappingLabels.pop();
        delete variableMappings[removedLabel];
        renderVariableMappings();
    }
}

async function submitCreateVariable() {
    const drawer = document.getElementById('createVariableDrawer');
    const nameInput = document.getElementById('newVarName');
    const unitInput = document.getElementById('newVarUnit');
    const descInput = document.getElementById('newVarDescription');
    const formulaInput = document.getElementById('newVarFormula');
    
    const isUpdateMode = editingVariableIndex !== null;
    
    // Clear previous errors
    document.querySelectorAll('.drawer-field.error').forEach(f => f.classList.remove('error'));
    document.querySelectorAll('.error-message').forEach(e => e.remove());
    
    let hasError = false;
    
    // Validate name (seulement en mode création)
    if (!isUpdateMode && !nameInput.value.trim()) {
        showFieldError(nameInput, 'Le nom est requis');
        hasError = true;
    }
    
    // Validate formula
    if (!formulaInput.value.trim()) {
        showFieldError(formulaInput, 'La formule est requise');
        hasError = true;
    }
    
    // Validate that formula uses defined variables
    const formula = formulaInput.value.trim();
    const usedVars = formula.match(/[A-Z]/g) || [];
    const uniqueVars = [...new Set(usedVars)];
    
    for (const v of uniqueVars) {
        if (!variableMappings[v]) {
            showFieldError(formulaInput, `La variable "${v}" n'est pas définie. Glissez un signal sur le slot ${v}.`);
            hasError = true;
            break;
        }
    }
    
    if (hasError) return;
    
    // Build mapping for backend
    const mapping = {};
    for (const [label, info] of Object.entries(variableMappings)) {
        mapping[label] = info.name; // Send signal name to backend
    }
    
    // Show creating state
    drawer.classList.add('creating');
    
    try {
        const headers = { 'Content-Type': 'application/json' };
        const token = sessionStorage.getItem('auth_token');
        if (token) {
            headers['Authorization'] = 'Bearer ' + token;
        }
        
        let response;
        let successMessage;
        
        if (isUpdateMode) {
            // Mode mise à jour
            response = await fetch(`${API}/computed-variables/${editingVariableIndex}`, {
                method: 'PUT',
                headers,
                body: JSON.stringify({
                    unit: unitInput.value.trim() || '',
                    description: descInput.value.trim() || '',
                    formula: formula,
                    mapping: mapping,
                    session_id: currentLazySessionId
                })
            });
            successMessage = `Variable "${nameInput.value.trim()}" mise à jour avec succès`;
        } else {
            // Mode création
            response = await fetch(`${API}/create-variable`, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    name: nameInput.value.trim(),
                    unit: unitInput.value.trim() || '',
                    description: descInput.value.trim() || '',
                    formula: formula,
                    mapping: mapping,
                    session_id: currentLazySessionId
                })
            });
            successMessage = `Variable "${nameInput.value.trim()}" créée avec succès`;
        }
        
        const data = await response.json();
        
        if (!response.ok) {
            throw new Error(data.error || 'Erreur lors de l\'opération');
        }
        
        // Success - reload signals
        if (typeof showNotification === 'function') {
            showNotification(successMessage, 'success');
        }
        
        // Recharge la liste des signaux depuis la bonne source, sans toucher aux
        // plots ni a la vue courante.
        if (currentLazySessionId) {
            const listHeaders = {};
            const listToken = sessionStorage.getItem('auth_token');
            if (listToken) listHeaders['Authorization'] = 'Bearer ' + listToken;
            const listRes = await fetch(`${API}/eda/list-signals/${currentLazySessionId}`, { headers: listHeaders });
            const listing = await listRes.json();
            S.signalsInfo = listing.signals;
            window.signalsInfo = S.signalsInfo;
            document.getElementById('statSignals').textContent = listing.n_signals;
        } else {
            const infoRes = await fetch(`${API}/info`);
            const info = await infoRes.json();
            S.signalsInfo = info.signals;
            window.signalsInfo = S.signalsInfo;
            document.getElementById('statSignals').textContent = info.n_signals;
        }

        renderSignalList();
        closeCreateVariableDrawer();
        
    } catch (error) {
        console.error('Create/Update variable error:', error);
        showFieldError(formulaInput, error.message);
        drawer.classList.remove('creating');
    }
}

function showFieldError(input, message) {
    const field = input.closest('.drawer-field') || input.closest('.formula-field');
    if (field) {
        field.classList.add('error');
        
        // Remove existing error message
        const existing = field.querySelector('.error-message');
        if (existing) existing.remove();
        
        const errorEl = document.createElement('div');
        errorEl.className = 'error-message';
        errorEl.textContent = message;
        field.appendChild(errorEl);
    }
}

// Setup create variable event listeners
function setupCreateVariableListeners() {
    // Le bouton dans la sidebar
    const createBtn = document.getElementById('createVariableBtn');
    if (createBtn && !createBtn._listenerAdded) {
        createBtn.addEventListener('click', openCreateVariableDrawer);
        createBtn._listenerAdded = true;
    }
    
    // Initialize mappings display
    renderVariableMappings();
}

// =========================================================================
// NE PAS appeler init() directement - ViewLoader s'en charge
// =========================================================================
// =========================================================================
// Expose globals for other modules (Vite compatibility)
// =========================================================================
window.initEDA = initEDA;
window.initApp = initApp;
window.init = init;
window.openUploadModal = openUploadModal;
window.closeUploadModal = closeUploadModal;
window.changeSource = changeSource;
window.resizePlotCharts = resizePlotCharts;
window.dropSignal = dropSignal;
window.removeSignalFromPlot = removeSignalFromPlot;
window.handleEdaFileSelect = handleEdaFileSelect;
window.handleEdaDbcSelect = handleEdaDbcSelect;
window.removeEdaFile = removeEdaFile;
window.removeEdaDbc = removeEdaDbc;
window.uploadEdaFile = uploadEdaFile;
window.loadSources = loadSources;
window.renderSignalList = renderSignalList;
window.signalsInfo = S.signalsInfo;
window.openCreateVariableModal = openCreateVariableModal;
window.closeCreateVariableModal = closeCreateVariableModal;
window.openCreateVariableDrawer = openCreateVariableDrawer;
window.closeCreateVariableDrawer = closeCreateVariableDrawer;
window.openComputedVariableForEdit = openComputedVariableForEdit;
window.setupCreateVariableListeners = setupCreateVariableListeners;
window.addMappingSlot = addMappingSlot;
window.removeMappingSlot = removeMappingSlot;
window.submitCreateVariable = submitCreateVariable;
window.exportCurrentLayout = exportCurrentLayout;
window.applyLayout = applyLayout;
window.getSignalsInfo = () => S.signalsInfo;
window.currentLazySessionId = null; // Sera mis à jour par changeSource
window.preloadSignalOnHover = preloadSignalOnHover;
window.updateSignalsLoadedStatus = updateSignalsLoadedStatus;
window.extendedBoolZones = extendedBoolZones;
window.toggleExtendedZones = toggleExtendedZones;
window.extractBoolHighRanges = extractBoolHighRanges;
window.disabledBoolZones = disabledBoolZones;