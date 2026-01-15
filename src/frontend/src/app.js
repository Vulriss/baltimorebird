// =========================================================================
// State
// =========================================================================
const API = '/api';

let signalsInfo = [];
let plots = [];
let plotIdCounter = 0;
let globalView = { min: 0, max: 100 };
let viewHistory = [];
const MAX_HISTORY = 5;
let lodPoints = 2000;
let cursor1 = null, cursor2 = null;
let draggedSignal = null;
let currentSource = null;

// Tabs system
let tabs = [];
let activeTabId = null;
let tabIdCounter = 0;

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
        
        signalsInfo = info.signals;
        window.signalsInfo = signalsInfo;
        globalView = { min: info.time_range.min, max: info.time_range.max };
        currentSource = info.source;
        
        document.getElementById('statSignals').textContent = info.n_signals;
        document.getElementById('statDuration').textContent = info.duration.toFixed(0) + 's';
        
        renderSignalList();
        updateSourceSelector();
        
        // Initialize create variable modal
        setupCreateVariableListeners();
        
        // Create first tab
        createTab('Main');
        
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
// Event Listeners Setup
// =========================================================================
function setupEventListeners() {
    // Search
    const searchInput = document.getElementById('search');
    if (searchInput && !searchInput._listenerAdded) {
        searchInput.addEventListener('input', e => {
            const searchValue = e.target.value.toLowerCase().trim();
            
            document.querySelectorAll('.signal-item').forEach(item => {
                const name = signalsInfo[item.dataset.index]?.name?.toLowerCase() || '';
                
                if (!searchValue) {
                    item.style.display = '';
                    return;
                }
                
                const terms = searchValue.split(/[\*\s]+/).filter(t => t.length > 0);
                
                if (terms.length === 0) {
                    item.style.display = '';
                    return;
                }
                
                const allTermsFound = terms.every(term => name.includes(term));
                item.style.display = allTermsFound ? '' : 'none';
            });
        });
        searchInput._listenerAdded = true;
    }
    
    // LOD Input
    const lodInput = document.getElementById('lodInput');
    if (lodInput && !lodInput._listenerAdded) {
        lodInput.addEventListener('change', e => {
            lodPoints = parseInt(e.target.value) || 2000;
            refreshAllPlots();
        });
        lodInput._listenerAdded = true;
    }
    
    // Reset Button
    const resetBtn = document.getElementById('resetBtn');
    if (resetBtn && !resetBtn._listenerAdded) {
        resetBtn.addEventListener('click', async () => {
            const res = await fetch(`${API}/info`);
            const info = await res.json();
            viewHistory = [];
            globalView = { min: info.time_range.min, max: info.time_range.max };
            refreshAllPlots();
        });
        resetBtn._listenerAdded = true;
    }
    
    // Clear Button
    const clearBtn = document.getElementById('clearBtn');
    if (clearBtn && !clearBtn._listenerAdded) {
        clearBtn.addEventListener('click', () => {
            plots.slice().forEach(p => deletePlot(p.id));
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
            if (typeof saveLayout === 'function') saveLayout();
        });
        saveLayoutBtn._listenerAdded = true;
    }

    // Load layout button
    const loadLayoutBtn = document.getElementById('loadLayoutBtn');
    if (loadLayoutBtn && !loadLayoutBtn._listenerAdded) {
        loadLayoutBtn.addEventListener('click', function() {
            if (typeof loadLayout === 'function') loadLayout();
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
        
        // Groupe les sources par catégorie
        const demoSources = data.sources.filter(s => s.category === 'demo' || !s.category);
        const userSources = data.sources.filter(s => s.category === 'user');
        
        // Vide le selector
        selector.innerHTML = '';
        
        // Sources démo
        if (demoSources.length > 0) {
            const optgroup = document.createElement('optgroup');
            optgroup.label = 'Données démo';
            demoSources.forEach(src => {
                const option = document.createElement('option');
                option.value = src.id;
                option.textContent = src.name + (!src.available ? ' (non disponible)' : '');
                option.disabled = !src.available;
                optgroup.appendChild(option);
            });
            selector.appendChild(optgroup);
        }
        
        // Sources utilisateur
        if (userSources.length > 0) {
            const optgroup = document.createElement('optgroup');
            optgroup.label = 'Mes fichiers';
            userSources.forEach(src => {
                const option = document.createElement('option');
                option.value = src.id;
                option.textContent = src.name;
                optgroup.appendChild(option);
            });
            selector.appendChild(optgroup);
        }
        
        if (data.current) {
            selector.value = data.current;
            currentSource = data.current;
        }
    } catch (e) {
        console.error('Failed to load sources:', e);
    }
}

function updateSourceSelector() {
    const selector = document.getElementById('sourceSelector');
    if (currentSource && selector) {
        selector.value = currentSource;
    }
}

async function changeSource() {
    const selector = document.getElementById('sourceSelector');
    if (!selector) return;
    
    const newSource = selector.value;
    
    if (newSource === currentSource) return;
    
    // Affiche un indicateur de chargement
    const signalList = document.getElementById('signalList');
    if (signalList) {
        signalList.innerHTML = '<div style="color:#888;padding:20px;text-align:center;">Chargement...</div>';
    }
    
    // Efface les plots existants
    plots.slice().forEach(p => deletePlot(p.id));
    
    try {
        // Change la source côté serveur (utilise authFetch si disponible)
        const res = typeof authFetch === 'function'
            ? await authFetch(`${API}/source/${newSource}`, { method: 'POST' })
            : await fetch(`${API}/source/${newSource}`, { method: 'POST' });
        
        const data = await res.json();
        
        if (data.error) {
            throw new Error(data.error);
        }
        
        // Pour les sources lazy (fichiers utilisateur), les infos sont déjà dans la réponse
        if (data.lazy && data.signals) {
            signalsInfo = data.signals;
            window.signalsInfo = signalsInfo;
            globalView = { min: data.time_range.min, max: data.time_range.max };
            currentSource = data.source;
            
            document.getElementById('statSignals').textContent = data.n_signals;
            document.getElementById('statDuration').textContent = data.duration.toFixed(0) + 's';
            
            renderSignalList();
            updateSourceSelector();
            
            console.log(`Switched to lazy source: ${currentSource}`);
        } else {
            // Pour les sources classiques, recharge les infos via /api/info
            const infoRes = typeof authFetch === 'function'
                ? await authFetch(`${API}/info`)
                : await fetch(`${API}/info`);
            
            const info = await infoRes.json();
            
            signalsInfo = info.signals;
            window.signalsInfo = signalsInfo;
            globalView = { min: info.time_range.min, max: info.time_range.max };
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
    
    // Utilise createElement pour éviter XSS
    container.innerHTML = '';
    
    signalsInfo.forEach(sig => {
        const item = document.createElement('div');
        item.className = 'signal-item';
        item.draggable = true;
        item.dataset.index = sig.index;
        item.id = `signal-item-${sig.index}`;
        
        // Marquer les variables calculées
        const isComputed = sig.computed === true;
        if (isComputed) {
            item.classList.add('computed');
            item.dataset.formula = sig.formula || '';
            item.dataset.description = sig.description || '';
            item.dataset.sourceSignals = JSON.stringify(sig.source_signals || []);
            item.title = `Variable calculée: ${sig.formula}\nDouble-clic pour éditer`;
        }
        
        const dot = document.createElement('div');
        dot.className = 'signal-dot';
        
        const nameSpan = document.createElement('span');
        nameSpan.className = 'signal-name';
        nameSpan.textContent = sig.name; // textContent = safe
        
        const unitSpan = document.createElement('span');
        unitSpan.className = 'signal-unit';
        unitSpan.textContent = sig.unit;
        
        item.appendChild(dot);
        item.appendChild(nameSpan);
        item.appendChild(unitSpan);
        
        // Event listeners
        item.addEventListener('dragstart', e => {
            draggedSignal = parseInt(item.dataset.index);
            item.classList.add('dragging');
            const dropZone = document.getElementById(`dropZone-${activeTabId}`);
            if (dropZone) dropZone.classList.add('active');
        });
        
        item.addEventListener('dragend', () => {
            item.classList.remove('dragging');
            draggedSignal = null;
            const dropZone = document.getElementById(`dropZone-${activeTabId}`);
            if (dropZone) dropZone.classList.remove('active');
            document.querySelectorAll('.plot-container').forEach(p => p.classList.remove('drop-target'));
        });
        
        // Double-clic pour éditer les variables calculées
        if (isComputed) {
            item.addEventListener('dblclick', () => {
                openComputedVariableForEdit(sig);
            });
        }
        
        container.appendChild(item);
    });
}

function updateSignalActiveStates() {
    // Build a map of signal index -> color (from the plot where it's displayed)
    const signalColors = new Map();
    plots.forEach(plot => {
        plot.signals.forEach(sigIdx => {
            // Priority: custom style color > cached data color > signalsInfo color
            const customColor = plot.signalStyles?.[sigIdx]?.color;
            const cachedColor = plot.cachedData?.[sigIdx]?.color;
            const defaultColor = signalsInfo[sigIdx]?.color;
            signalColors.set(sigIdx, customColor || cachedColor || defaultColor);
        });
    });

    signalsInfo.forEach(sig => {
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
// Tabs Management
// =========================================================================
function createTab(name = null, activate = true) {
    const id = `tab-${tabIdCounter++}`;
    const tabName = name || `View ${tabs.length + 1}`;
    
    const tab = {
        id,
        name: tabName,
        plots: [],
        plotIdCounter: 0,
        cursor1: null,
        cursor2: null
    };
    
    tabs.push(tab);
    
    // Create tab button
    renderTabs();
    
    // Create tab content area
    const plotsArea = document.querySelector('.plots-area');
    if (!plotsArea) return id;
    
    const tabContent = document.createElement('div');
    tabContent.className = 'tab-content';
    tabContent.id = `content-${id}`;
    tabContent.innerHTML = `
        <div class="plots-wrapper" id="plotsWrapper-${id}">
            <div class="empty-plot" id="emptyPlot-${id}">Glissez un signal ici pour créer un graphique</div>
        </div>
        <div class="drop-zone" id="dropZone-${id}">+ Nouveau graphique</div>
    `;
    plotsArea.appendChild(tabContent);
    
    // Setup drop zones for this tab
    setupTabDropZones(id);
    
    if (activate) {
        switchTab(id);
    }
    
    return id;
}

function renderTabs() {
    const tabsList = document.getElementById('tabsList');
    if (!tabsList) return;
    
    // Vide et reconstruit avec createElement (CSP safe)
    tabsList.innerHTML = '';
    
    tabs.forEach(tab => {
        const tabItem = document.createElement('div');
        tabItem.className = 'tab-item' + (tab.id === activeTabId ? ' active' : '');
        tabItem.dataset.tabId = tab.id;
        
        const nameSpan = document.createElement('span');
        nameSpan.className = 'tab-name';
        nameSpan.dataset.tabId = tab.id;
        nameSpan.textContent = tab.name; // textContent = XSS safe
        
        const closeBtn = document.createElement('button');
        closeBtn.className = 'tab-close';
        closeBtn.dataset.tabId = tab.id;
        closeBtn.title = 'Fermer';
        closeBtn.textContent = '×';
        
        tabItem.appendChild(nameSpan);
        tabItem.appendChild(closeBtn);
        
        // Event listeners
        tabItem.addEventListener('click', (e) => {
            if (!e.target.classList.contains('tab-close') && 
                !e.target.classList.contains('tab-name-input')) {
                switchTab(tab.id);
            }
        });
        
        nameSpan.addEventListener('dblclick', () => {
            startEditTabName(tab.id);
        });
        
        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            closeTab(tab.id);
        });
        
        tabsList.appendChild(tabItem);
    });
}

function switchTab(tabId) {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;
    
    // Save current tab state
    if (activeTabId) {
        const currentTab = tabs.find(t => t.id === activeTabId);
        if (currentTab) {
            currentTab.plots = plots;
            currentTab.cursor1 = cursor1;
            currentTab.cursor2 = cursor2;
        }
    }
    
    // Hide all tab contents
    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    
    // Show selected tab content
    const tabContent = document.getElementById(`content-${tabId}`);
    if (tabContent) {
        tabContent.classList.add('active');
    }
    
    // Restore tab state
    activeTabId = tabId;
    plots = tab.plots || [];
    cursor1 = tab.cursor1;
    cursor2 = tab.cursor2;
    
    // Update tab buttons
    renderTabs();
    
    // Resize charts after tab switch
    setTimeout(resizePlotCharts, 50);
}

function closeTab(tabId) {
    const tabIndex = tabs.findIndex(t => t.id === tabId);
    if (tabIndex === -1) return;
    
    // Don't close if it's the last tab
    if (tabs.length === 1) {
        // Instead, clear the tab
        const tab = tabs[0];
        tab.plots.forEach(p => {
            if (p.chart) p.chart.destroy();
        });
        tab.plots = [];
        plots = [];
        
        const wrapper = document.getElementById(`plotsWrapper-${tabId}`);
        if (wrapper) {
            wrapper.innerHTML = `<div class="empty-plot" id="emptyPlot-${tabId}">Glissez un signal ici pour créer un graphique</div>`;
            setupEmptyPlotDropZone(tabId);
        }
        return;
    }
    
    // Destroy charts in this tab
    const tab = tabs[tabIndex];
    if (tab.plots) {
        tab.plots.forEach(p => {
            if (p.chart) p.chart.destroy();
        });
    }
    
    // Remove tab content
    const tabContent = document.getElementById(`content-${tabId}`);
    if (tabContent) tabContent.remove();
    
    // Remove from array
    tabs.splice(tabIndex, 1);
    
    // Switch to another tab if this was active
    if (activeTabId === tabId) {
        const newActiveIndex = Math.min(tabIndex, tabs.length - 1);
        switchTab(tabs[newActiveIndex].id);
    } else {
        renderTabs();
    }
}

function startEditTabName(tabId) {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;
    
    const tabItem = document.querySelector(`.tab-item[data-tab-id="${tabId}"]`);
    if (!tabItem) return;
    
    const nameSpan = tabItem.querySelector('.tab-name');
    if (!nameSpan) return;
    
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'tab-name-input';
    input.value = tab.name;
    
    input.addEventListener('blur', () => finishEditTabName(tabId, input.value));
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            input.blur();
        } else if (e.key === 'Escape') {
            input.value = tab.name;
            input.blur();
        }
    });
    
    nameSpan.replaceWith(input);
    input.focus();
    input.select();
}

function finishEditTabName(tabId, newName) {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;
    
    tab.name = newName.trim() || tab.name;
    renderTabs();
}

function setupTabDropZones(tabId) {
    const emptyPlot = document.getElementById(`emptyPlot-${tabId}`);
    if (emptyPlot) {
        setupEmptyPlotDropZone(tabId);
    }
    
    const dropZone = document.getElementById(`dropZone-${tabId}`);
    if (dropZone) {
        dropZone.addEventListener('dragover', e => e.preventDefault());
        dropZone.addEventListener('drop', e => {
            e.preventDefault();
            dropZone.classList.remove('active');
            if (draggedSignal !== null) {
                createPlotInTab(activeTabId, draggedSignal);
                setTimeout(resizePlotCharts, 100);
            }
        });
    }
}

function setupEmptyPlotDropZone(tabId) {
    const emptyPlot = document.getElementById(`emptyPlot-${tabId}`);
    if (!emptyPlot) return;
    
    emptyPlot.addEventListener('dragover', e => {
        e.preventDefault();
        emptyPlot.classList.add('drop-target');
    });
    emptyPlot.addEventListener('dragleave', () => {
        emptyPlot.classList.remove('drop-target');
    });
    emptyPlot.addEventListener('drop', e => {
        e.preventDefault();
        emptyPlot.classList.remove('drop-target');
        if (draggedSignal !== null) {
            createPlotInTab(tabId, draggedSignal);
            setTimeout(resizePlotCharts, 100);
        }
    });
}

// =========================================================================
// Layout Save/Load System
// =========================================================================

/**
 * Exporte l'état actuel en format layout JSON.
 * Les signaux sont référencés par nom (pas index) pour la portabilité.
 */
function exportCurrentLayout() {
    const layoutTabs = tabs.map(tab => {
        const tabPlots = (tab.plots || []).map(plot => {
            const plotSignals = plot.signals.map(sigIdx => {
                const sig = signalsInfo[sigIdx];
                const style = plot.signalStyles?.[sigIdx] || { color: sig?.color || '#fff', width: 1.5, dash: '' };
                return {
                    name: sig?.name || `Signal_${sigIdx}`,
                    style: {
                        color: style.color,
                        width: style.width,
                        dash: style.dash || ''
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
    const computedVars = signalsInfo
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
async function applyLayout(layout) {
    if (!layout || !layout.tabs) {
        console.error('Layout invalide');
        return false;
    }
    
    // Créer un map nom -> index pour les signaux actuels
    const signalNameToIndex = {};
    signalsInfo.forEach(sig => {
        signalNameToIndex[sig.name] = sig.index;
    });
    
    // 1. D'abord créer les variables calculées si nécessaire
    if (layout.computed_variables && layout.computed_variables.length > 0) {
        for (const cv of layout.computed_variables) {
            // Vérifier si elle existe déjà
            const existing = signalsInfo.find(s => s.name === cv.name && s.computed);
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
                        const response = await fetch(`${API}/create-variable`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                name: cv.name,
                                unit: cv.unit || '',
                                description: cv.description || '',
                                formula: cv.formula,
                                mapping: mapping
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
        signalsInfo = info.signals;
        signalsInfo.forEach(sig => {
            signalNameToIndex[sig.name] = sig.index;
        });
        renderSignalList();
    }
    
    // 2. Effacer les tabs existants
    const tabIds = tabs.map(t => t.id);
    tabIds.forEach(id => {
        const tab = tabs.find(t => t.id === id);
        if (tab && tab.plots) {
            tab.plots.forEach(p => {
                if (p.chart) p.chart.destroy();
            });
        }
        // Supprimer le contenu DOM de ce tab
        const tabContent = document.getElementById(`content-${id}`);
        if (tabContent) tabContent.remove();
    });
    tabs = [];
    plots = [];
    activeTabId = null;
    
    // Rafraîchir la liste des tabs (vide maintenant)
    renderTabs();
    
    // 3. Recréer les tabs et plots
    for (let tabIdx = 0; tabIdx < layout.tabs.length; tabIdx++) {
        const layoutTab = layout.tabs[tabIdx];
        const tabId = createTab(layoutTab.name);
        
        if (tabIdx === 0) {
            switchTab(tabId);
        }
        
        // Créer les plots dans ce tab
        for (const layoutPlot of layoutTab.plots) {
            // Trouver le premier signal valide pour créer le plot
            let firstSignalIdx = null;
            for (const sig of layoutPlot.signals) {
                if (signalNameToIndex[sig.name] !== undefined) {
                    firstSignalIdx = signalNameToIndex[sig.name];
                    break;
                }
            }
            
            if (firstSignalIdx === null) continue;
            
            // Créer le plot avec le premier signal
            const plotId = createPlotInTab(tabId, firstSignalIdx);
            const plot = plots.find(p => p.id === plotId);
            
            if (plot) {
                // Appliquer le style du premier signal
                const firstSig = layoutPlot.signals.find(s => signalNameToIndex[s.name] !== undefined);
                if (firstSig && firstSig.style) {
                    if (!plot.signalStyles) plot.signalStyles = {};
                    plot.signalStyles[firstSignalIdx] = {
                        color: firstSig.style.color,
                        width: firstSig.style.width || 1.5,
                        dash: firstSig.style.dash || ''
                    };
                }
                
                // Ajouter les autres signaux
                for (const sig of layoutPlot.signals.slice(1)) {
                    const sigIdx = signalNameToIndex[sig.name];
                    if (sigIdx !== undefined) {
                        addSignalToPlot(plotId, sigIdx);
                        if (sig.style) {
                            plot.signalStyles[sigIdx] = {
                                color: sig.style.color,
                                width: sig.style.width || 1.5,
                                dash: sig.style.dash || ''
                            };
                        }
                    }
                }
                
                // Appliquer le ratio flex
                if (plot.element && layoutPlot.flex) {
                    plot.element.style.flex = layoutPlot.flex.toString();
                }
            }
        }
    }
    
    // Activer le premier tab
    if (tabs.length > 0) {
        switchTab(tabs[0].id);
    }
    
    // Rafraîchir l'affichage
    renderTabs();
    refreshAllPlots();
    
    return true;
}

/**
 * Ouvre le drawer de gestion des layouts
 */
function openLayoutsDrawer() {
    const drawer = document.getElementById('layoutsDrawer');
    if (drawer) {
        loadLayoutsList();
        drawer.classList.add('active');
    }
}

function closeLayoutsDrawer() {
    const drawer = document.getElementById('layoutsDrawer');
    if (drawer) {
        drawer.classList.remove('active');
    }
}

/**
 * Charge la liste des layouts depuis le serveur
 */
async function loadLayoutsList() {
    const listContainer = document.getElementById('layoutsList');
    if (!listContainer) return;
    
    listContainer.innerHTML = '<div class="layouts-loading">Chargement...</div>';
    
    try {
        const userLayouts = [];
        const demoLayouts = [];
        
        // Si connecté, utilise uniquement l'API storage
        if (typeof authFetch === 'function') {
            const response = await authFetch(`${API}/storage/files?category=layouts&include_default=true`).catch(() => null);
            
            if (response && response.ok) {
                const data = await response.json();
                if (data.files) {
                    data.files.forEach(file => {
                        const layout = {
                            id: file.id,
                            name: file.filename?.replace('.json', '') || file.original_name?.replace('.json', '') || 'Layout',
                            description: file.description || '',
                            is_demo: file.is_default,
                            tabs_count: '?',
                            _storageFile: true
                        };
                        
                        if (file.is_default) {
                            demoLayouts.push(layout);
                        } else {
                            userLayouts.push(layout);
                        }
                    });
                }
            }
        }
        
        // Si non connecté ou pas de résultats, utilise layouts API pour les démos
        if (demoLayouts.length === 0) {
            const response = await fetch(`${API}/layouts`).catch(() => null);
            if (response && response.ok) {
                const data = await response.json();
                if (data.layouts) {
                    data.layouts.forEach(layout => {
                        if (layout.is_demo) {
                            demoLayouts.push({
                                ...layout,
                                _layoutsApi: true
                            });
                        }
                    });
                }
            }
        }
        
        if (userLayouts.length === 0 && demoLayouts.length === 0) {
            listContainer.innerHTML = '<div class="layouts-empty">Aucun layout disponible</div>';
            return;
        }
        
        listContainer.innerHTML = '';
        
        if (demoLayouts.length > 0) {
            const demoSection = document.createElement('div');
            demoSection.className = 'layouts-section';
            demoSection.innerHTML = '<div class="layouts-section-title">Layouts de démonstration</div>';
            
            demoLayouts.forEach(layout => {
                demoSection.appendChild(createLayoutItem(layout));
            });
            
            listContainer.appendChild(demoSection);
        }
        
        if (userLayouts.length > 0) {
            const userSection = document.createElement('div');
            userSection.className = 'layouts-section';
            userSection.innerHTML = '<div class="layouts-section-title">Mes layouts</div>';
            
            userLayouts.forEach(layout => {
                userSection.appendChild(createLayoutItem(layout));
            });
            
            listContainer.appendChild(userSection);
        }
        
    } catch (e) {
        console.error('Failed to load layouts:', e);
        listContainer.innerHTML = '<div class="layouts-error">Erreur de chargement</div>';
    }
}

function createLayoutItem(layout) {
    const item = document.createElement('div');
    item.className = 'layout-item' + (layout.is_demo ? ' demo' : '');
    
    const info = document.createElement('div');
    info.className = 'layout-info';
    
    const name = document.createElement('div');
    name.className = 'layout-name';
    name.textContent = layout.name;
    if (layout.is_demo) {
        const badge = document.createElement('span');
        badge.className = 'layout-badge';
        badge.textContent = 'DEMO';
        name.appendChild(badge);
    }
    
    const meta = document.createElement('div');
    meta.className = 'layout-meta';
    const tabsText = layout.tabs_count !== '?' ? `${layout.tabs_count} onglet${layout.tabs_count > 1 ? 's' : ''}` : '';
    meta.textContent = tabsText;
    if (layout.description) {
        meta.textContent += (tabsText ? ' • ' : '') + layout.description.substring(0, 50);
    }
    
    info.appendChild(name);
    info.appendChild(meta);
    
    const actions = document.createElement('div');
    actions.className = 'layout-actions';
    
    const loadBtn = document.createElement('button');
    loadBtn.className = 'btn-small btn-primary';
    loadBtn.textContent = 'Charger';
    // Passe les infos de source pour savoir quel endpoint utiliser
    loadBtn.onclick = () => loadLayoutById(layout.id, layout._storageFile, layout._layoutsApi);
    actions.appendChild(loadBtn);
    
    if (!layout.is_demo) {
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'btn-small btn-danger';
        deleteBtn.textContent = '✕';
        deleteBtn.title = 'Supprimer';
        deleteBtn.onclick = (e) => {
            e.stopPropagation();
            deleteLayout(layout.id, layout.name, layout._storageFile);
        };
        actions.appendChild(deleteBtn);
    }
    
    item.appendChild(info);
    item.appendChild(actions);
    
    return item;
}

/**
 * Charge un layout par son ID
 * @param {string} layoutId - ID du layout
 * @param {boolean} isStorageFile - true si le layout vient de /api/storage
 * @param {boolean} isLayoutsApi - true si le layout vient de /api/layouts
 */
async function loadLayoutById(layoutId, isStorageFile = false, isLayoutsApi = false) {
    try {
        let layoutData;
        
        if (isStorageFile) {
            // Charge depuis storage API (layouts utilisateur)
            const response = await authFetch(`${API}/storage/files/${layoutId}/content`);
            if (!response.ok) throw new Error('Layout introuvable');
            const result = await response.json();
            layoutData = result.content || result;
        } else {
            // Charge depuis layouts API (layouts de démo ou anciens layouts)
            const response = typeof authFetch === 'function'
                ? await authFetch(`${API}/layouts/${layoutId}`).catch(() => fetch(`${API}/layouts/${layoutId}`))
                : await fetch(`${API}/layouts/${layoutId}`);
            if (!response.ok) throw new Error('Layout introuvable');
            layoutData = await response.json();
        }
        
        closeLayoutsDrawer();
        
        const layoutName = layoutData.name || 'Layout';
        if (typeof showNotification === 'function') {
            showNotification(`Chargement du layout "${layoutName}"...`, 'info');
        }
        
        const success = await applyLayout(layoutData);
        
        if (success && typeof showNotification === 'function') {
            showNotification(`Layout "${layoutName}" appliqué`, 'success');
        }
        
    } catch (e) {
        console.error('Failed to load layout:', e);
        if (typeof showNotification === 'function') {
            showNotification('Erreur lors du chargement du layout', 'error');
        }
    }
}

/**
 * Supprime un layout
 * @param {string} layoutId - ID du layout
 * @param {string} layoutName - Nom pour l'affichage
 * @param {boolean} isStorageFile - true si le layout vient de /api/storage
 */
async function deleteLayout(layoutId, layoutName, isStorageFile = false) {
    if (!confirm(`Supprimer le layout "${layoutName}" ?`)) {
        return;
    }
    
    try {
        const endpoint = isStorageFile 
            ? `${API}/storage/files/${layoutId}`
            : `${API}/layouts/${layoutId}`;
        
        const response = await authFetch(endpoint, {
            method: 'DELETE'
        });
        
        if (response.ok) {
            if (typeof showNotification === 'function') {
                showNotification('Layout supprimé', 'success');
            }
            loadLayoutsList();
        } else {
            throw new Error('Erreur de suppression');
        }
    } catch (e) {
        console.error('Failed to delete layout:', e);
        if (typeof showNotification === 'function') {
            showNotification('Erreur lors de la suppression', 'error');
        }
    }
}

/**
 * Sauvegarde le layout actuel (ancienne fonction renommée)
 */
function saveLayout() {
    openSaveLayoutDialog();
}

/**
 * Charge un layout (ancienne fonction renommée)
 */
function loadLayout() {
    openLayoutsDrawer();
}

/**
 * Ouvre le dialog pour sauvegarder le layout actuel
 */
function openSaveLayoutDialog() {
    const drawer = document.getElementById('layoutsDrawer');
    if (!drawer) return;
    
    // Vérifier qu'il y a quelque chose à sauvegarder
    if (tabs.length === 0 || tabs.every(t => !t.plots || t.plots.length === 0)) {
        if (typeof showNotification === 'function') {
            showNotification('Rien à sauvegarder - ajoutez des signaux aux plots', 'warning');
        }
        return;
    }
    
    drawer.classList.add('active');
    drawer.classList.add('save-mode');
    
    // Focus sur le champ nom
    setTimeout(() => {
        const nameInput = document.getElementById('saveLayoutName');
        if (nameInput) nameInput.focus();
    }, 100);
}

function closeSaveMode() {
    const drawer = document.getElementById('layoutsDrawer');
    if (drawer) {
        drawer.classList.remove('save-mode');
    }
}

/**
 * Sauvegarde le layout actuel avec le nom donné
 */
async function saveCurrentLayout() {
    const nameInput = document.getElementById('saveLayoutName');
    const descInput = document.getElementById('saveLayoutDesc');
    
    const name = nameInput?.value?.trim();
    const description = descInput?.value?.trim() || '';
    
    if (!name) {
        if (typeof showNotification === 'function') {
            showNotification('Veuillez entrer un nom pour le layout', 'warning');
        }
        return;
    }
    
    const layoutData = exportCurrentLayout();
    
    try {
        // Utilise l'API storage pour les layouts (compatible avec Settings > Stockage)
        const response = await authFetch(`${API}/storage/json/layouts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: name,
                description: description,
                content: layoutData
            })
        });
        
        const result = await response.json();
        
        if (!response.ok) {
            throw new Error(result.error || 'Erreur de sauvegarde');
        }
        
        if (typeof showNotification === 'function') {
            showNotification(`Layout "${name}" sauvegardé`, 'success');
        }
        
        // Reset form et retour à la liste
        if (nameInput) nameInput.value = '';
        if (descInput) descInput.value = '';
        closeSaveMode();
        loadLayoutsList();
        
    } catch (e) {
        console.error('Failed to save layout:', e);
        if (typeof showNotification === 'function') {
            showNotification(e.message || 'Erreur lors de la sauvegarde', 'error');
        }
    }
}

// =========================================================================
// Plot Management
// =========================================================================
function createPlotInTab(tabId, signalIndex) {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;
    
    const wrapper = document.getElementById(`plotsWrapper-${tabId}`);
    if (!wrapper) return;
    
    const id = `plot-${tabId}-${tab.plotIdCounter++}`;
    
    const empty = document.getElementById(`emptyPlot-${tabId}`);
    if (empty) empty.remove();

    if (plots.length > 0) {
        const splitter = document.createElement('div');
        splitter.className = 'splitter';
        splitter.dataset.above = plots[plots.length - 1].id;
        splitter.dataset.below = id;
        wrapper.appendChild(splitter);
        setupSplitter(splitter);
    }

    const container = document.createElement('div');
    container.className = 'plot-container';
    container.id = id;
    container.style.flex = '1';
    
    // Crée le contenu du plot
    const plotMain = document.createElement('div');
    plotMain.className = 'plot-main';
    
    const plotBody = document.createElement('div');
    plotBody.className = 'plot-body';
    const chartDiv = document.createElement('div');
    chartDiv.className = 'chart';
    plotBody.appendChild(chartDiv);
    
    const plotLegend = document.createElement('div');
    plotLegend.className = 'plot-legend';
    
    plotMain.appendChild(plotBody);
    plotMain.appendChild(plotLegend);
    
    const plotStats = document.createElement('div');
    plotStats.className = 'plot-stats';
    
    const statsText = document.createElement('span');
    statsText.className = 'plot-stats-text';
    
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'plot-delete';
    deleteBtn.title = 'Supprimer';
    deleteBtn.textContent = '✕';
    deleteBtn.addEventListener('click', () => {
        deletePlotInTab(tabId, id);
    });
    
    plotStats.appendChild(statsText);
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
        cachedData: {}
    };
    plots.push(plot);
    tab.plots = plots;

    addSignalToPlot(id, signalIndex);
    return id;
}

// Keep old createPlot for compatibility, redirect to tab version
function createPlot(signalIndex) {
    return createPlotInTab(activeTabId, signalIndex);
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
        const delta = e.clientY - startY;
        const newHeightAbove = Math.max(80, startHeightAbove + delta);
        const newHeightBelow = Math.max(80, startHeightBelow - delta);
        aboveEl.style.flex = `0 0 ${newHeightAbove}px`;
        belowEl.style.flex = `0 0 ${newHeightBelow}px`;
    }

    function onMouseUp() {
        splitter.classList.remove('active');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);

        aboveEl.querySelector('.chart').style.visibility = '';
        belowEl.querySelector('.chart').style.visibility = '';

        const plotAbove = plots.find(p => p.id === aboveEl.id);
        const plotBelow = plots.find(p => p.id === belowEl.id);
        
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
        if (draggedSignal !== null) {
            addSignalToPlot(plotId, draggedSignal);
        }
    });
}

function addSignalToPlot(plotId, signalIndex) {
    const plot = plots.find(p => p.id === plotId);
    if (!plot || plot.signals.includes(signalIndex)) return;
    
    plot.signals.push(signalIndex);
    updatePlotHeader(plot);
    fetchAndRenderPlot(plot);
    updateSignalActiveStates();
    setTimeout(resizePlotCharts, 100);
}

function removeSignalFromPlot(plotId, signalIndex) {
    const plot = plots.find(p => p.id === plotId);
    if (!plot) return;
    
    plot.signals = plot.signals.filter(s => s !== signalIndex);
    delete plot.cachedData[signalIndex];
    
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

function renderPlotFromCache(plot) {
    if (plot.signals.length === 0) return;
    
    const chartDiv = plot.element.querySelector('.chart');
    const statsDiv = plot.element.querySelector('.plot-stats');
    const bodyDiv = plot.element.querySelector('.plot-body');
    
    if (plot.chart) {
        plot.chart.destroy();
    }

    const firstSigData = plot.cachedData[plot.signals[0]];
    if (!firstSigData) return;
    
    const uplotData = [firstSigData.timestamps];
    const series = [{}];

    plot.signals.forEach(sigIdx => {
        const sigData = plot.cachedData[sigIdx];
        if (sigData) {
            const style = plot.signalStyles?.[sigIdx] || { color: sigData.color, width: 1.5, dash: '' };
            const isBool = sigData.unit === 'bool';
            
            uplotData.push(sigData.values);
            series.push({
                label: sigData.name,
                stroke: style.color,
                width: style.width,
                dash: style.dash ? style.dash.split(',').map(Number) : undefined,
                fill: isBool ? colorWithOpacity(style.color, .4) : undefined,
                paths: isBool ? uPlot.paths.stepped({ align: 1 }) : undefined,
            });
        }
    });

    const width = bodyDiv.clientWidth || 800;
    const height = bodyDiv.clientHeight || 180;

    const opts = {
        width, height,
        legend: { show: false },
        series,
        scales: { x: { time: false } },
        axes: [
            { stroke: '#666', grid: { stroke: '#2d2d5a' }, size: 40 },
            { stroke: '#666', grid: { stroke: '#2d2d5a' }, size: 50 }
        ],
        cursor: { drag: { x: true, y: false }, points: { show: false } },
        hooks: {
            setSelect: [u => {
                const min = u.posToVal(u.select.left, 'x');
                const max = u.posToVal(u.select.left + u.select.width, 'x');
                if (max - min > 0.01) {
                    viewHistory.push({ ...globalView });
                    if (viewHistory.length > MAX_HISTORY) viewHistory.shift();
                    
                    globalView = { min, max };
                    refreshAllPlots();
                }
                u.setSelect({ left: 0, width: 0 }, false);
            }]
        },
        plugins: [cursorPlugin()]
    };

    plot.chart = new uPlot(opts, uplotData, chartDiv);

    const stats = plot.signals.map(sigIdx => {
        const s = plot.cachedData[sigIdx];
        return s ? `${s.name}: ${s.stats.min.toFixed(2)}/${s.stats.max.toFixed(2)}` : '';
    }).join(' | ');
    statsDiv.querySelector('.plot-stats-text').textContent = stats;
}

function deletePlotInTab(tabId, plotId) {
    const idx = plots.findIndex(p => p.id === plotId);
    if (idx === -1) return;
    
    const plot = plots[idx];
    if (plot.chart) plot.chart.destroy();
    
    const wrapper = document.getElementById(`plotsWrapper-${tabId}`);
    if (!wrapper) return;
    
    wrapper.querySelectorAll('.splitter').forEach(s => {
        if (s.dataset.above === plotId || s.dataset.below === plotId) {
            s.remove();
        }
    });
    
    if (idx > 0 && idx < plots.length - 1) {
        const remainingSplitters = wrapper.querySelectorAll('.splitter');
        remainingSplitters.forEach(s => {
            if (s.dataset.below === plotId && plots[idx + 1]) {
                s.dataset.below = plots[idx + 1].id;
            }
        });
    }
    
    plot.element.remove();
    plots.splice(idx, 1);

    plots.forEach(p => { p.element.style.flex = '1'; });
    updateSignalActiveStates();

    // Update tab's plots reference
    const tab = tabs.find(t => t.id === tabId);
    if (tab) tab.plots = plots;

    if (plots.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-plot';
        empty.id = `emptyPlot-${tabId}`;
        empty.textContent = 'Glissez un signal ici pour créer un graphique';
        wrapper.appendChild(empty);
        setupEmptyPlotDropZone(tabId);
    } else {
        setTimeout(() => {
            plots.forEach(p => {
                if (p.chart) {
                    const h = p.element.querySelector('.plot-body').offsetHeight;
                    const w = p.element.querySelector('.plot-body').offsetWidth;
                    p.chart.setSize({ width: w, height: h });
                }
            });
        }, 50);
    }
}

function deletePlot(plotId) {
    const plot = plots.find(p => p.id === plotId);
    if (plot && plot.tabId) {
        deletePlotInTab(plot.tabId, plotId);
    }
}

function updatePlotHeader(plot) {
    const legendDiv = plot.element.querySelector('.plot-legend');
    if (!legendDiv) return;
    
    // Vide et reconstruit avec createElement (CSP safe, XSS safe)
    legendDiv.innerHTML = '';
    
    plot.signals.forEach(sigIdx => {
        const sig = signalsInfo[sigIdx];
        if (!sig) return;
        
        const style = plot.signalStyles?.[sigIdx] || { color: sig.color, width: 1.5, dash: '' };
        
        const item = document.createElement('div');
        item.className = 'legend-item';
        item.dataset.sigIdx = sigIdx;
        item.dataset.plotId = plot.id;
        
        // Header
        const header = document.createElement('div');
        header.className = 'legend-item-header';
        
        const colorInput = document.createElement('input');
        colorInput.type = 'color';
        colorInput.className = 'legend-color-btn';
        colorInput.value = rgbToHex(style.color);
        
        const nameSpan = document.createElement('span');
        nameSpan.className = 'legend-name';
        nameSpan.title = sig.name;
        nameSpan.textContent = sig.name; // textContent = XSS safe
        
        const toggleSpan = document.createElement('span');
        toggleSpan.className = 'legend-toggle';
        toggleSpan.textContent = '▼';
        
        const removeSpan = document.createElement('span');
        removeSpan.className = 'legend-remove';
        removeSpan.textContent = '×';
        
        header.appendChild(colorInput);
        header.appendChild(nameSpan);
        header.appendChild(toggleSpan);
        header.appendChild(removeSpan);
        
        // Controls
        const controls = document.createElement('div');
        controls.className = 'legend-controls';
        
        // Width row
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
        
        // Dash row
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
        
        controls.appendChild(widthRow);
        controls.appendChild(dashRow);
        
        item.appendChild(header);
        item.appendChild(controls);
        
        // Event listeners
        header.addEventListener('click', (e) => {
            if (e.target.classList.contains('legend-color-btn') ||
                e.target.classList.contains('legend-remove')) {
                return;
            }
            item.classList.toggle('expanded');
        });
        
        colorInput.addEventListener('click', (e) => e.stopPropagation());
        colorInput.addEventListener('change', (e) => {
            updateSignalStyle(plot.id, sigIdx, 'color', e.target.value);
        });
        
        removeSpan.addEventListener('click', (e) => {
            e.stopPropagation();
            removeSignalFromPlot(plot.id, sigIdx);
        });
        
        widthInput.addEventListener('change', (e) => {
            updateSignalStyle(plot.id, sigIdx, 'width', e.target.value);
        });
        
        dashSelect.addEventListener('change', (e) => {
            updateSignalStyle(plot.id, sigIdx, 'dash', e.target.value);
        });
        
        legendDiv.appendChild(item);
    });
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
    const plot = plots.find(p => p.id === plotId);
    if (!plot) return;

    if (!plot.signalStyles) plot.signalStyles = {};
    if (!plot.signalStyles[sigIdx]) {
        const sig = signalsInfo[sigIdx];
        plot.signalStyles[sigIdx] = { color: sig?.color || '#fff', width: 1.5, dash: '' };
    }

    if (property === 'width') {
        plot.signalStyles[sigIdx].width = parseFloat(value);
        const item = plot.element.querySelector(`.legend-item[data-sig-idx="${sigIdx}"]`);
        if (item) item.querySelector('.legend-width-value').textContent = value;
    } else if (property === 'color') {
        plot.signalStyles[sigIdx].color = value;
    } else if (property === 'dash') {
        plot.signalStyles[sigIdx].dash = value;
    }

    if (property === 'color' && plot.cachedData[sigIdx]) {
        plot.cachedData[sigIdx].color = value;
    }

    renderPlotFromCache(plot);
    
    // Update sidebar signal colors when plot color changes
    updateSignalActiveStates();
}

// =========================================================================
// Data Fetching & Rendering (with local filtering optimization)
// =========================================================================

/**
 * Check if all signals in a plot can be rendered from cache (no API call needed).
 */
function canRenderFromCache(plot, viewMin, viewMax) {
    const TOLERANCE = 0.5;
    
    for (const sigIdx of plot.signals) {
        const cached = plot.cachedData[sigIdx];
        if (!cached) return false;
        if (!cached.isComplete) return false;
        if (!cached.fullTimeRange) return false;
        if (cached.fullTimeRange.min > viewMin + TOLERANCE || 
            cached.fullTimeRange.max < viewMax - TOLERANCE) return false;
    }
    return true;
}

/**
 * Filter cached data to the current view range (client-side).
 */
function filterCachedData(timestamps, values, viewMin, viewMax) {
    const filteredTs = [];
    const filteredVals = [];
    
    for (let i = 0; i < timestamps.length; i++) {
        const t = timestamps[i];
        if (t >= viewMin && t <= viewMax) {
            filteredTs.push(t);
            filteredVals.push(values[i]);
        }
    }
    
    return { timestamps: filteredTs, values: filteredVals };
}

/**
 * Render plot using local filtering (no API call).
 */
function renderPlotFromCacheFiltered(plot) {
    if (plot.signals.length === 0) return;
    
    const chartDiv = plot.element.querySelector('.chart');
    const statsDiv = plot.element.querySelector('.plot-stats');
    const bodyDiv = plot.element.querySelector('.plot-body');
    
    if (plot.chart) {
        plot.chart.destroy();
    }

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
        if (cached && filtered) {
            const style = plot.signalStyles?.[sigIdx] || { color: cached.color, width: 1.5, dash: '' };
            const isBool = cached.unit === 'bool';
            
            uplotData.push(filtered.values);
            series.push({
                label: cached.name,
                stroke: style.color,
                width: style.width,
                dash: style.dash ? style.dash.split(',').map(Number) : undefined,
                fill: isBool ? colorWithOpacity(style.color, .4) : undefined,
                paths: isBool ? uPlot.paths.stepped({ align: 1 }) : undefined,
            });
        }
    });

    const width = bodyDiv.clientWidth || 800;
    const height = bodyDiv.clientHeight || 180;

    const opts = {
        width, height,
        legend: { show: false },
        series,
        scales: { x: { time: false } },
        axes: [
            { stroke: '#666', grid: { stroke: '#2d2d5a' }, size: 40 },
            { stroke: '#666', grid: { stroke: '#2d2d5a' }, size: 50 }
        ],
        cursor: { drag: { x: true, y: false }, points: { show: false } },
        hooks: {
            setSelect: [u => {
                const min = u.posToVal(u.select.left, 'x');
                const max = u.posToVal(u.select.left + u.select.width, 'x');
                if (max - min > 0.01) {
                    viewHistory.push({ ...globalView });
                    if (viewHistory.length > MAX_HISTORY) viewHistory.shift();
                    
                    globalView = { min, max };
                    refreshAllPlots();
                }
                u.setSelect({ left: 0, width: 0 }, false);
            }]
        },
        plugins: [cursorPlugin()]
    };

    plot.chart = new uPlot(opts, uplotData, chartDiv);

    const stats = plot.signals.map(sigIdx => {
        const filtered = filteredData[sigIdx];
        if (!filtered || filtered.values.length === 0) return '';
        const min = Math.min(...filtered.values);
        const max = Math.max(...filtered.values);
        const cached = plot.cachedData[sigIdx];
        return `${cached.name}: ${min.toFixed(2)}/${max.toFixed(2)}`;
    }).join(' | ');
    
    const totalPoints = commonTimestamps.length * plot.signals.length;
    statsDiv.querySelector('.plot-stats-text').textContent = `${totalPoints} pts (cache) | ${stats}`;
}

async function fetchAndRenderPlot(plot) {
    if (plot.signals.length === 0) return;

    if (canRenderFromCache(plot, globalView.min, globalView.max)) {
        renderPlotFromCacheFiltered(plot);
        return;
    }

    const signalIndices = plot.signals.join(',');
    const url = `${API}/view?signals=${signalIndices}&start=${globalView.min}&end=${globalView.max}&max_points=${lodPoints}`;

    const startTime = performance.now();

    try {
        const res = await fetch(url);
        const data = await res.json();
        
        const fetchTime = performance.now() - startTime;
        const statServer = document.getElementById('statServer');
        if (statServer) {
            statServer.textContent = `${fetchTime.toFixed(0)}ms`;
        }

        renderPlotChart(plot, data);
        
    } catch (e) {
        console.error('Fetch error:', e);
    }
}

function renderPlotChart(plot, data) {
    const chartDiv = plot.element.querySelector('.chart');
    const statsDiv = plot.element.querySelector('.plot-stats');
    const bodyDiv = plot.element.querySelector('.plot-body');
    
    if (plot.chart) {
        plot.chart.destroy();
    }

    if (!data.signals || data.signals.length === 0) return;

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
            fullTimeRange: sig.is_complete ? newTimeRange : null
        };
    });

    const timestamps = data.signals[0].timestamps;
    const uplotData = [timestamps];
    const series = [{}];

    data.signals.forEach(sig => {
        const style = plot.signalStyles?.[sig.index] || { color: sig.color, width: 1.5, dash: '' };
        const isBool = sig.unit === 'bool';
        
        uplotData.push(sig.values);
        series.push({
            label: sig.name,
            stroke: style.color,
            width: style.width,
            dash: style.dash ? style.dash.split(',').map(Number) : undefined,
            fill: isBool ? colorWithOpacity(style.color, .4) : undefined,
            paths: isBool ? uPlot.paths.stepped({ align: 1 }) : undefined,
        });
    });

    const width = bodyDiv.clientWidth || 800;
    const height = bodyDiv.clientHeight || 180;

    const opts = {
        width, height,
        legend: { show: false },
        series,
        scales: { x: { time: false } },
        axes: [
            { stroke: '#666', grid: { stroke: '#2d2d5a' }, size: 40 },
            { stroke: '#666', grid: { stroke: '#2d2d5a' }, size: 50 }
        ],
        cursor: { drag: { x: true, y: false }, points: { show: false } },
        hooks: {
            setSelect: [u => {
                const min = u.posToVal(u.select.left, 'x');
                const max = u.posToVal(u.select.left + u.select.width, 'x');
                if (max - min > 0.01) {
                    viewHistory.push({ ...globalView });
                    if (viewHistory.length > MAX_HISTORY) viewHistory.shift();
                    
                    globalView = { min, max };
                    refreshAllPlots();
                }
                u.setSelect({ left: 0, width: 0 }, false);
            }]
        },
        plugins: [cursorPlugin()]
    };

    plot.chart = new uPlot(opts, uplotData, chartDiv);

    const completeStatus = data.signals.every(s => s.is_complete) ? '✓' : '↓';
    const stats = data.signals.map(s => 
        `${s.name}: ${s.stats.min.toFixed(2)} / ${s.stats.max.toFixed(2)} (LTTB: ${s.stats.lttb_ms}ms)`
    ).join(' | ');
    const statsText = statsDiv.querySelector('.plot-stats-text');
    if (statsText) {
        statsText.textContent = `${data.view.original_points.toLocaleString()} → ${data.view.returned_points} pts ${completeStatus} | ${stats}`;
    }
}

function refreshAllPlots() {
    plots.forEach(plot => fetchAndRenderPlot(plot));
}

// =========================================================================
// Cursors
// =========================================================================
function cursorPlugin() {
    let line1, line2;
    let timeLabel1, timeLabel2;
    let deltaLine, deltaLabel;
    let labels1 = [], labels2 = [];
    let over;
    let draggingCursor = null;

    function updateTimeLabels(u) {
        if (cursor1 !== null && timeLabel1) {
            const xPos = u.valToPos(cursor1, 'x');
            timeLabel1.style.display = 'block';
            timeLabel1.textContent = cursor1.toFixed(3) + 's';
            timeLabel1.style.left = (xPos + 3) + 'px';
        } else if (timeLabel1) {
            timeLabel1.style.display = 'none';
        }

        if (cursor2 !== null && timeLabel2) {
            const xPos = u.valToPos(cursor2, 'x');
            timeLabel2.style.display = 'block';
            timeLabel2.textContent = cursor2.toFixed(3) + 's';
            timeLabel2.style.left = (xPos + 3) + 'px';
        } else if (timeLabel2) {
            timeLabel2.style.display = 'none';
        }

        if (cursor1 !== null && cursor2 !== null && deltaLine && deltaLabel) {
            const xPos1 = u.valToPos(cursor1, 'x');
            const xPos2 = u.valToPos(cursor2, 'x');
            const left = Math.min(xPos1, xPos2);
            const right = Math.max(xPos1, xPos2);
            const width = right - left;

            deltaLine.style.display = 'block';
            deltaLine.style.left = left + 'px';
            deltaLine.style.width = width + 'px';

            deltaLabel.style.display = 'block';
            deltaLabel.style.left = (left + width / 2) + 'px';
            deltaLabel.textContent = 'Δ ' + Math.abs(cursor2 - cursor1).toFixed(3) + 's';
        } else {
            if (deltaLine) deltaLine.style.display = 'none';
            if (deltaLabel) deltaLabel.style.display = 'none';
        }
    }

    return {
        hooks: {
            init: u => {
                over = u.root.querySelector('.u-over');
                
                over.addEventListener('dblclick', e => {
                    if (viewHistory.length > 0) {
                        globalView = viewHistory.pop();
                        refreshAllPlots();
                    }
                });

                line1 = document.createElement('div');
                line1.className = 'cursor-line cursor-1';
                line1.style.display = 'none';
                over.appendChild(line1);

                timeLabel1 = document.createElement('div');
                timeLabel1.className = 'cursor-time-label';
                timeLabel1.style.cssText = '--cursor-color: rgba(0, 255, 100, 0.9);';
                timeLabel1.style.display = 'none';
                over.appendChild(timeLabel1);

                line2 = document.createElement('div');
                line2.className = 'cursor-line cursor-2';
                line2.style.display = 'none';
                over.appendChild(line2);

                timeLabel2 = document.createElement('div');
                timeLabel2.className = 'cursor-time-label';
                timeLabel2.style.cssText = '--cursor-color: rgba(255, 100, 150, 0.9);';
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

                line1.addEventListener('mousedown', e => {
                    e.stopPropagation();
                    e.preventDefault();
                    draggingCursor = 1;
                    line1.classList.add('dragging');
                    document.body.style.cursor = 'ew-resize';
                    document.body.style.userSelect = 'none';
                });

                line2.addEventListener('mousedown', e => {
                    e.stopPropagation();
                    e.preventDefault();
                    draggingCursor = 2;
                    line2.classList.add('dragging');
                    document.body.style.cursor = 'ew-resize';
                    document.body.style.userSelect = 'none';
                });

                document.addEventListener('mousemove', e => {
                    if (draggingCursor === null) return;
                    const rect = over.getBoundingClientRect();
                    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
                    const time = u.posToVal(x, 'x');
                    if (draggingCursor === 1) cursor1 = time;
                    else cursor2 = time;
                    updateCursors();
                });

                document.addEventListener('mouseup', () => {
                    if (draggingCursor !== null) {
                        line1.classList.remove('dragging');
                        line2.classList.remove('dragging');
                        draggingCursor = null;
                        document.body.style.cursor = '';
                        document.body.style.userSelect = '';
                    }
                });

                over.addEventListener('click', e => {
                    if (e.ctrlKey || e.metaKey) {
                        const x = e.clientX - over.getBoundingClientRect().left;
                        const time = u.posToVal(x, 'x');
                        if (!cursor1) cursor1 = time;
                        else if (!cursor2) cursor2 = time;
                        else { cursor1 = time; cursor2 = null; }
                        updateCursors();
                    }
                });
            },
            draw: u => {
                labels1.forEach(l => l.remove());
                labels2.forEach(l => l.remove());
                labels1 = [];
                labels2 = [];

                const plot = plots.find(p => p.chart === u);
                if (!plot) return;

                updateTimeLabels(u);

                if (cursor1 !== null) {
                    const xPos = u.valToPos(cursor1, 'x');
                    line1.style.left = xPos + 'px';
                    line1.style.display = 'block';
                    
                    plot.signals.forEach(sigIdx => {
                        const cached = plot.cachedData[sigIdx];
                        if (!cached) return;
                        const val = getValueAtTime(cached.timestamps, cached.values, cursor1);
                        if (val === null) return;
                        const yPos = u.valToPos(val, 'y');
                        if (yPos < 0 || yPos > u.height) return;
                        const label = document.createElement('div');
                        label.className = 'cursor-label';
                        label.style.setProperty('--sig-color', cached.color);
                        label.textContent = val.toFixed(2);
                        label.style.left = (xPos + 4) + 'px';
                        label.style.top = yPos + 'px';
                        over.appendChild(label);
                        labels1.push(label);
                    });
                } else {
                    line1.style.display = 'none';
                }
                
                if (cursor2 !== null) {
                    const xPos = u.valToPos(cursor2, 'x');
                    line2.style.left = xPos + 'px';
                    line2.style.display = 'block';
                    
                    plot.signals.forEach(sigIdx => {
                        const cached = plot.cachedData[sigIdx];
                        if (!cached) return;
                        const val = getValueAtTime(cached.timestamps, cached.values, cursor2);
                        if (val === null) return;
                        const yPos = u.valToPos(val, 'y');
                        if (yPos < 0 || yPos > u.height) return;
                        const label = document.createElement('div');
                        label.className = 'cursor-label';
                        label.style.setProperty('--sig-color', cached.color);
                        label.textContent = val.toFixed(2);
                        label.style.left = (xPos + 4) + 'px';
                        label.style.top = yPos + 'px';
                        over.appendChild(label);
                        labels2.push(label);
                    });
                } else {
                    line2.style.display = 'none';
                }
            }
        }
    };
}

function getValueAtTime(timestamps, values, targetTime) {
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
    return values[lo];
}

function updateCursors() {
    plots.forEach(p => p.chart?.redraw());
}

// =========================================================================
// Resize Handler
// =========================================================================
let resizeTimer;
window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
        plots.forEach(plot => {
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
        plots.forEach(plot => {
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
    if (!currentUser) {
        showNotification('Connectez-vous pour uploader des fichiers', 'warning');
        showLoginModal();
        return;
    }

    const modal = document.getElementById('uploadModal');
    if (modal) modal.classList.add('active');
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
            formData.append('dbc', edaSelectedDbc);
        }
        
        const xhr = new XMLHttpRequest();
        
        xhr.upload.addEventListener('progress', (e) => {
            if (e.lengthComputable) {
                const percent = Math.round((e.loaded / e.total) * 100);
                if (edaUploadFill) edaUploadFill.style.width = percent + '%';
                if (edaUploadPercent) edaUploadPercent.textContent = percent + '%';
            }
        });
        
        xhr.addEventListener('load', async () => {
            if (xhr.status === 200) {
                const data = JSON.parse(xhr.responseText);
                console.log('EDA Upload success:', data);
                
                if (edaUploadText) edaUploadText.textContent = 'Chargement des données...';
                if (edaUploadFill) edaUploadFill.style.width = '100%';
                if (edaUploadPercent) edaUploadPercent.textContent = '100%';
                
                await loadSources();
                
                const selector = document.getElementById('sourceSelector');
                if (selector && data.source_id) {
                    selector.value = data.source_id;
                    currentSource = data.source_id;
                }
                
                const infoRes = await fetch(`${API}/info`);
                const info = await infoRes.json();
                
                signalsInfo = info.signals;
        window.signalsInfo = signalsInfo;
                globalView = { min: info.time_range.min, max: info.time_range.max };
                
                document.getElementById('statSignals').textContent = info.n_signals;
                document.getElementById('statDuration').textContent = info.duration.toFixed(0) + 's';
                
                renderSignalList();
                
                if (typeof showNotification === 'function') {
                    showNotification(`Fichier "${data.filename}" chargé avec succès`, 'success');
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
            const foundSignal = signalsInfo.find(s => s.name === signalName);
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
            description.innerHTML = '<strong>📊 Mode visualisation</strong> — Vous pouvez modifier cette variable et cliquer sur "Mettre à jour" pour appliquer les changements.';
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
            
            if (draggedSignal !== null) {
                const signal = signalsInfo[draggedSignal];
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
                    mapping: mapping
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
                    mapping: mapping
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
        
        // Reload info to get updated signals
        const infoRes = await fetch(`${API}/info`);
        const info = await infoRes.json();
        
        signalsInfo = info.signals;
        document.getElementById('statSignals').textContent = info.n_signals;
        
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
window.createTab = createTab;
window.saveLayout = saveLayout;
window.loadLayout = loadLayout;
window.openUploadModal = openUploadModal;
window.closeUploadModal = closeUploadModal;
window.changeSource = changeSource;
window.resizePlotCharts = resizePlotCharts;
window.handleEdaFileSelect = handleEdaFileSelect;
window.handleEdaDbcSelect = handleEdaDbcSelect;
window.removeEdaFile = removeEdaFile;
window.removeEdaDbc = removeEdaDbc;
window.uploadEdaFile = uploadEdaFile;
window.loadSources = loadSources;
window.renderSignalList = renderSignalList;
window.signalsInfo = signalsInfo;
window.openCreateVariableModal = openCreateVariableModal;
window.closeCreateVariableModal = closeCreateVariableModal;
window.openCreateVariableDrawer = openCreateVariableDrawer;
window.closeCreateVariableDrawer = closeCreateVariableDrawer;
window.openComputedVariableForEdit = openComputedVariableForEdit;
window.setupCreateVariableListeners = setupCreateVariableListeners;
window.addMappingSlot = addMappingSlot;
window.removeMappingSlot = removeMappingSlot;
window.submitCreateVariable = submitCreateVariable;
window.openLayoutsDrawer = openLayoutsDrawer;
window.closeLayoutsDrawer = closeLayoutsDrawer;
window.loadLayoutById = loadLayoutById;
window.saveCurrentLayout = saveCurrentLayout;
window.closeSaveMode = closeSaveMode;
window.exportCurrentLayout = exportCurrentLayout;
window.applyLayout = applyLayout;