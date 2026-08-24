// Baltimore Bird - Initialisation de la vue EDA, listeners globaux, redimensionnement
// Module extrait de app.js (refactoring): voir src/eda/ARCHITECTURE.md

import { S } from '../core/state.js';
import { isZoneTooltipEnabled, setZoneTooltipEnabled } from './zone-stats.js';
import { setupCreateVariableListeners } from './computed-vars.js';
import { API, ectx } from './context.js';
import { addCursorFromButton } from './cursors.js';
import { maybeApplyDeepLink, readDeepLinkFromUrl } from './deeplink.js';
import { loadLegendWidth } from './legend-width.js';
import { deletePlot } from './plot-legend.js';
import { comparedAcquisitionRange, requestUpload } from './runs.js';
import { changeSource, loadSources, restoreEphemeralSession, updateSourceSelector } from './sessions.js';
import { setupSidebarSplitter, setupSidebarVSplitter } from './sidebar.js';
import { computeFilteredSignals, renderSignalList, renderVirtualList } from './signal-list.js';
import { refreshAllPlots } from './view-nav.js';

// =========================================================================
// Init
// =========================================================================
export async function init() {
    // Vérifie que les éléments DOM existent (vue chargée)
    const signalList = document.getElementById('signalList');
    if (!signalList) {
        console.log('EDA: Vue pas encore chargée, init différée');
        return;
    }
    
    // Évite la double initialisation
    if (ectx.edaInitialized) {
        console.log('EDA: Déjà initialisé');
        return;
    }
    
    console.log('EDA: Initialisation...');
    
    readDeepLinkFromUrl();
    
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
        ectx.globalView = { min: info.time_range.min, max: info.time_range.max };
        ectx.acquisitionView = { ...ectx.globalView };
        ectx.currentSource = info.source;
        
        document.getElementById('statSignals').textContent = info.n_signals;
        document.getElementById('statDuration').textContent = info.duration.toFixed(0) + 's';
        
        renderSignalList();
        updateSourceSelector();

        // Restaure une éventuelle session éphémère (fichier temporaire d'invité)
        // survivant au rafraîchissement de la page, dans la limite d'une heure
        await restoreEphemeralSession();
        await maybeApplyDeepLink();

        // Initialize create variable modal
        setupCreateVariableListeners();

        // Create first tab (sauf si la restauration de session en a déjà créé)
        if (S.tabs.length === 0) {
            createTab('Main');
        }
        
        ectx.edaInitialized = true;
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
export function initEDA() {
    init();
}

// Alias pour compatibilité
export function initApp() {
    init();
}

// =========================================================================
// Event Listeners Setup
// =========================================================================
function setupEventListeners() {

    document.querySelectorAll('.toolbar-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            // Si desactivation bouton, suppression hover 
            setTimeout(() => {
                if (!btn.classList.contains('active')) {
                    btn.classList.add('just-deactivated');
                }
            }, 0); 
        });
        btn.addEventListener('mouseleave', () => {
            // rétablir le hover classique une fois qu'on quitte le bouton après une désactivation
            btn.classList.remove('just-deactivated');
        });
    });

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

    // Bascule du tooltip de stats sur les zones booleennes etendues.
    // Meme pattern que la synchro d'onglets: preference persistee, etat visuel
    // initialise depuis zone-stats.js (source de verite de la preference).
    const zoneTooltipToggle = document.getElementById('zoneTooltipToggle');
    if (zoneTooltipToggle && !zoneTooltipToggle._listenerAdded) {
        zoneTooltipToggle.classList.toggle('active', isZoneTooltipEnabled());
        zoneTooltipToggle.setAttribute('aria-pressed', isZoneTooltipEnabled() ? 'true' : 'false');

        zoneTooltipToggle.addEventListener('click', () => {
            const on = zoneTooltipToggle.classList.toggle('active');
            zoneTooltipToggle.setAttribute('aria-pressed', on ? 'true' : 'false');
            setZoneTooltipEnabled(on);
        });
        zoneTooltipToggle._listenerAdded = true;
    }

    // Synchronisation des fenetres temporelles entre onglets.
    const syncViewsToggle = document.getElementById('syncViewsToggle');
    if (syncViewsToggle && !syncViewsToggle._listenerAdded) {
        // Preference persistante (comme le theme). Par defaut synchronise = le
        // comportement historique, donc rien ne change pour l'utilisateur existant.
        const saved = localStorage.getItem('bb_sync_tab_views');
        S.syncTabViews = saved === null ? true : saved === 'true';
        syncViewsToggle.classList.toggle('active', S.syncTabViews);
        syncViewsToggle.setAttribute('aria-pressed', S.syncTabViews ? 'true' : 'false');

        syncViewsToggle.addEventListener('click', () => {
            S.syncTabViews = syncViewsToggle.classList.toggle('active');
            syncViewsToggle.setAttribute('aria-pressed', S.syncTabViews ? 'true' : 'false');
            localStorage.setItem('bb_sync_tab_views', S.syncTabViews ? 'true' : 'false');
            // Reactiver la synchro n'impose rien tout de suite: les autres onglets ne
            // sont pas visibles et adopteront la fenetre courante a leur affichage
            // (switchTab compare tab.view a globalView et rejoue le cache si besoin).
            // On memorise la fenetre de l'onglet actif pour que la desynchronisation
            // parte de ce qui est reellement affiche.
            const tab = S.tabs.find(t => t.id === S.activeTabId);
            if (tab && typeof window.getGlobalView === 'function') {
                tab.view = window.getGlobalView();
            }
        });
        syncViewsToggle._listenerAdded = true;
    }

    // Synchronisation des curseurs entre onglets.
    const syncCursorsToggle = document.getElementById('syncCursorsToggle');
    if (syncCursorsToggle && !syncCursorsToggle._listenerAdded) {
        // Preference persistante (comme le theme). Par defaut non synchronise
        const saved = localStorage.getItem('bb_sync_cursors');
        S.syncCursors = saved === null ? false : saved === 'true';
        syncCursorsToggle.classList.toggle('active', S.syncCursors);
        syncCursorsToggle.setAttribute('aria-pressed', S.syncCursors ? 'true' : 'false');

        syncCursorsToggle.addEventListener('click', () => {
            S.syncCursors = syncCursorsToggle.classList.toggle('active');
            syncCursorsToggle.setAttribute('aria-pressed', S.syncCursors ? 'true' : 'false');
            localStorage.setItem('bb_sync_cursors', S.syncCursors ? 'true' : 'false');
            // Si activé, synchro les curseurs de l'onglet actif vers les autres onglets
            if (S.syncCursors && typeof syncCursorsAcrossTabs === 'function') {
                syncCursorsAcrossTabs();
            }
        });
        syncCursorsToggle._listenerAdded = true;
    }

    // Reset Button
    const resetBtn = document.getElementById('resetBtn');
    if (resetBtn && !resetBtn._listenerAdded) {
        resetBtn.addEventListener('click', () => {
            // Reset complet: bornes Y liberees et fenetre temporelle ramenee a la
            // plage complete de l'acquisition courante (et non d'une source de demo).
            S.plots.forEach(p => { p.yRange = null; });
            ectx.viewHistory = [];
            ectx.redoStack = [];
            // En comparaison, ramener a l'union des runs (decalages inclus), sinon a la
            // plage complete de l'acquisition courante.
            ectx.globalView = comparedAcquisitionRange() || { ...ectx.acquisitionView };
            refreshAllPlots();
        });
        resetBtn._listenerAdded = true;
    }
    
    // Clear Button
    const clearBtn = document.getElementById('clearBtn');
    if (clearBtn && !clearBtn._listenerAdded) {
        clearBtn.addEventListener('click', () => {
            S.plots.slice().forEach(p => deletePlot(p.id));
            // Plus rien a l'ecran: le layout charge n'a plus de sens comme cible de
            // mise a jour (le prochain enregistrement creera une nouvelle entree).
            if (typeof window.clearCurrentLayout === 'function') window.clearCurrentLayout();
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
            requestUpload();
        });
        uploadBtnAuth._listenerAdded = true;
    }

    const uploadBtnGuest = document.getElementById('uploadBtnGuest');
    if (uploadBtnGuest && !uploadBtnGuest._listenerAdded) {
        uploadBtnGuest.addEventListener('click', function() {
            requestUpload();
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

export function resizePlotCharts() {
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

