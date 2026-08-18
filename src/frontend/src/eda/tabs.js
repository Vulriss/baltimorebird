import { S } from '../core/state.js';
import { ectx } from './context.js';

// Identifiant de l'onglet en cours de deplacement. Distinct de S.draggedSignal: les zones
// de drop de signaux et le reordonnancement d'onglets s'ignorent mutuellement.
let draggedTabId = null;

function clearTabDropMarkers() {
    document.querySelectorAll('.tab-item.drop-before, .tab-item.drop-after')
        .forEach(el => el.classList.remove('drop-before', 'drop-after'));
}

function moveTab(sourceId, targetId, before) {
    const from = S.tabs.findIndex(t => t.id === sourceId);
    if (from === -1 || sourceId === targetId) return;

    const [moved] = S.tabs.splice(from, 1);
    const to = S.tabs.findIndex(t => t.id === targetId);
    if (to === -1) {
        S.tabs.splice(from, 0, moved);
        return;
    }
    S.tabs.splice(before ? to : to + 1, 0, moved);
    renderTabs();
}

// Reorganisation des onglets par glisser-deposer: indicateur d'insertion avant/apres
// selon la position du curseur par rapport au milieu de l'onglet survole.
function setupTabDrag(tabItem, tab) {
    tabItem.draggable = true;

    tabItem.addEventListener('dragstart', (e) => {
        draggedTabId = tab.id;
        tabItem.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', tab.id);  // requis par Firefox pour initier le drag
    });

    tabItem.addEventListener('dragend', () => {
        draggedTabId = null;
        tabItem.classList.remove('dragging');
        clearTabDropMarkers();
    });

    tabItem.addEventListener('dragover', (e) => {
        if (!draggedTabId || draggedTabId === tab.id) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const rect = tabItem.getBoundingClientRect();
        const before = e.clientX < rect.left + rect.width / 2;
        tabItem.classList.toggle('drop-before', before);
        tabItem.classList.toggle('drop-after', !before);
    });

    tabItem.addEventListener('dragleave', () => {
        tabItem.classList.remove('drop-before', 'drop-after');
    });

    tabItem.addEventListener('drop', (e) => {
        if (!draggedTabId || draggedTabId === tab.id) return;
        e.preventDefault();
        const rect = tabItem.getBoundingClientRect();
        const before = e.clientX < rect.left + rect.width / 2;
        const sourceId = draggedTabId;
        draggedTabId = null;
        clearTabDropMarkers();
        moveTab(sourceId, tab.id, before);
    });
}

function createTab(name = null, activate = true) {
    const id = `tab-${S.tabIdCounter++}`;
    const tabName = name || `View ${S.tabs.length + 1}`;
    
    const tab = {
        id,
        name: tabName,
        plots: [],
        plotIdCounter: 0,
        cursor1: null,
        cursor2: null
    };
    
    S.tabs.push(tab);
    
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
    
    S.tabs.forEach(tab => {
        const tabItem = document.createElement('div');
        tabItem.className = 'tab-item' + (tab.id === S.activeTabId ? ' active' : '');
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
        
        setupTabDrag(tabItem, tab);
        
        tabsList.appendChild(tabItem);
    });
}

function switchTab(tabId) {
    const tab = S.tabs.find(t => t.id === tabId);
    if (!tab) return;
    
    // Save current tab state
    if (S.activeTabId) {
        const currentTab = S.tabs.find(t => t.id === S.activeTabId);
        if (currentTab) {
            currentTab.plots = S.plots;
            currentTab.cursor1 = S.cursor1;
            currentTab.cursor2 = S.cursor2;
            // Fenetre temporelle affichee par cet onglet au moment ou on le quitte.
            // Ses graphes sont rendus sur cette fenetre: c'est a la fois ce qu'il faut
            // restaurer en mode desynchronise, et la reference pour savoir s'il faudra
            // le re-fenetrer au retour.
            if (typeof window.getGlobalView === 'function') {
                currentTab.view = window.getGlobalView();
            }
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
    S.activeTabId = tabId;
    S.plots = tab.plots || [];
    S.cursor1 = tab.cursor1;
    S.cursor2 = tab.cursor2;

    // Vues desynchronisees: l'onglet retrouve SA fenetre. Synchronisees: on garde
    // globalView, l'onglet adopte la fenetre courante.
    if (!S.syncTabViews && tab.view && typeof window.setGlobalView === 'function') {
        window.setGlobalView(tab.view);
    }

    // Hydratation paresseuse d'un onglet importe: ses graphes ne sont construits qu'au
    // premier affichage (le contenu est deja visible ici, le dimensionnement est correct).
    let hydrated = false;
    if (typeof window.hydrateTabIfNeeded === 'function') {
        hydrated = window.hydrateTabIfNeeded(tabId);
    }

    // Re-fenetrage seulement si necessaire. Les graphes de l'onglet sont rendus sur
    // tab.view (la fenetre qu'il affichait quand on l'a quitte): si elle differe de la
    // fenetre courante, il faut les rejouer depuis le cache. Desynchronise, elles sont
    // egales par construction -> aucun travail, le changement d'onglet reste instantane.
    // Une hydratation vient deja de tout rendre sur la fenetre courante.
    if (!hydrated && tab.view && typeof window.getGlobalView === 'function') {
        const cur = window.getGlobalView();
        if ((tab.view.min !== cur.min || tab.view.max !== cur.max)
                && typeof window.applyGlobalViewLocal === 'function') {
            window.applyGlobalViewLocal();
        } else if (typeof window.replayPendingRenders === 'function') {
            // Meme fenetre: rien a re-fenetrer, mais un fetch/full-send peut avoir
            // abouti pendant que l'onglet etait cache (son rendu a alors ete saute).
            window.replayPendingRenders();
        }
    }

    // Update tab buttons
    renderTabs();
    
    // Resize charts after tab switch
    setTimeout(window.resizePlotCharts, 50);
}

// Purge les zones etendues des signaux d'un tab entier: sinon elles restent dessinees dans les autres onglets apres fermeture 
function purgeExtendedZonesForTab(tab) {
    if (!tab || !tab.plots) return;
    tab.plots.forEach(p => {
        (p.signals || []).forEach(sigIdx => {
            ectx.extendedBoolZones.delete(sigIdx);
            ectx.disabledBoolZones.delete(sigIdx);
        });
    });
}

function closeTab(tabId) {
    const tabIndex = S.tabs.findIndex(t => t.id === tabId);
    if (tabIndex === -1) return;
    
    // Don't close if it's the last tab
    if (S.tabs.length === 1) {
        // Instead, clear the tab
        const tab = S.tabs[0];
        tab.plots.forEach(p => {
            if (p.chart) p.chart.destroy();
        });
        tab.plots = [];
        S.plots = [];
        
        const wrapper = document.getElementById(`plotsWrapper-${tabId}`);
        if (wrapper) {
            wrapper.innerHTML = `<div class="empty-plot" id="emptyPlot-${tabId}">Glissez un signal ici pour créer un graphique</div>`;
            setupEmptyPlotDropZone(tabId);
        }
        return;
    }
    
    // Destroy charts in this tab
    const tab = S.tabs[tabIndex];
    purgeExtendedZonesForTab(tab);
    if (tab.plots) {
        tab.plots.forEach(p => {
            if (p.chart) p.chart.destroy();
        });
    }
    
    // Remove tab content
    const tabContent = document.getElementById(`content-${tabId}`);
    if (tabContent) tabContent.remove();
    
    // Remove from array
    S.tabs.splice(tabIndex, 1);
    
    // Switch to another tab if this was active
    if (S.activeTabId === tabId) {
        const newActiveIndex = Math.min(tabIndex, S.tabs.length - 1);
        switchTab(S.tabs[newActiveIndex].id);
    } else {
        renderTabs();
    }
}

function startEditTabName(tabId) {
    const tab = S.tabs.find(t => t.id === tabId);
    if (!tab) return;
    
    const tabItem = document.querySelector(`.tab-item[data-tab-id="${tabId}"]`);
    if (!tabItem) return;
    
    const nameSpan = tabItem.querySelector('.tab-name');
    if (!nameSpan) return;
    
    // Drag desactive pendant l'edition: sinon le parent draggable capture les
    // mouvements de souris et empeche la selection de texte dans l'input.
    // renderTabs (via finishEditTabName) reconstruira l'onglet avec le drag actif.
    tabItem.draggable = false;
    
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
    const tab = S.tabs.find(t => t.id === tabId);
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
            if (S.draggedSignal !== null) {
                const group = (S.draggedSignalGroup && S.draggedSignalGroup.length)
                    ? S.draggedSignalGroup : [S.draggedSignal];
                const fromPlotId = S.draggedFromPlotId;
                const destId = window.dropSignalGroup(group);
                if (fromPlotId !== null && fromPlotId !== destId) {
                    group.forEach(idx => window.removeSignalFromPlot(fromPlotId, idx));
                }
                setTimeout(window.resizePlotCharts, 100);
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
        if (S.draggedSignal !== null) {
            const group = (S.draggedSignalGroup && S.draggedSignalGroup.length)
                ? S.draggedSignalGroup : [S.draggedSignal];
            const fromPlotId = S.draggedFromPlotId;
            const destId = window.dropSignalGroup(group);
            if (fromPlotId !== null && fromPlotId !== destId) {
                group.forEach(idx => window.removeSignalFromPlot(fromPlotId, idx));
            }
            setTimeout(window.resizePlotCharts, 100);
        }
    });
}

window.createTab = createTab;
window.renderTabs = renderTabs;
window.switchTab = switchTab;
window.closeTab = closeTab;
window.startEditTabName = startEditTabName;
window.finishEditTabName = finishEditTabName;
window.setupTabDropZones = setupTabDropZones;
window.setupEmptyPlotDropZone = setupEmptyPlotDropZone;
