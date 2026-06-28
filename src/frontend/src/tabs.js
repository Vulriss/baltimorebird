import { S } from './state.js';

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
    
    // Update tab buttons
    renderTabs();
    
    // Resize charts after tab switch
    setTimeout(window.resizePlotCharts, 50);
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
                const sigIdx = S.draggedSignal;
                const fromPlotId = S.draggedFromPlotId;
                const destId = window.dropSignal(sigIdx);
                if (fromPlotId !== null && fromPlotId !== destId) {
                    window.removeSignalFromPlot(fromPlotId, sigIdx);
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
            const sigIdx = S.draggedSignal;
            const fromPlotId = S.draggedFromPlotId;
            const destId = window.dropSignal(sigIdx);
            if (fromPlotId !== null && fromPlotId !== destId) {
                window.removeSignalFromPlot(fromPlotId, sigIdx);
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
