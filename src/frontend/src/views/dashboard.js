// =========================================================================
// Dashboard Management V2 - Tree Structure
// Fichier: js/dashboard-v2.js
// =========================================================================

const DashboardEditor = (function() {
    'use strict';

    // =========================================================================
    // State
    // =========================================================================
    
    let initialized = false;
    let currentPanel = 'execution';
    let canvasBlocks = [];
    let blockIdCounter = 0;
    let currentScriptId = null;
    // Les scripts de demo livres avec l'application sont en lecture seule cote API : on les
    // execute tels quels, et « Enregistrer sous » est le seul chemin vers une version modifiable.
    let currentScriptReadonly = false;
    let isScriptModified = false;
    let scriptsList = [];
    let signalMappings = [];
    let mappingIdCounter = 0;
    let dragState = {
        type: null,        // 'palette' | 'canvas'
        blockType: null,   // For palette drags
        blockId: null,     // For canvas drags
        sourceParent: null // Parent array reference for canvas drags
    };
    let livePreviewTimer = null;
    let livePreviewAbortController = null;
    let selectedBlockId = null;
    let synthSourceRenderTimer = null;

    const SCRIPTS_API = '/api/scripts';

    // =========================================================================
    // Block Definitions
    // =========================================================================

    const BLOCK_DEFINITIONS = {
        title: {
            name: 'Titre',
            icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M8 7v10M16 7v10M12 7v10"/></svg>`,
            color: '#f38ba8',
            config: [
                { id: 'title', label: 'Titre', type: 'text', default: 'Nouveau rapport' },
                { id: 'subtitle', label: 'Sous-titre', type: 'text', default: '' },
                { id: 'author', label: 'Auteur', type: 'text', default: '' }
            ],
            generateCode: (config) => `document.append({'kind': 'title', 'title': ${JSON.stringify(config.title || '')}, 'subtitle': ${JSON.stringify(config.subtitle || '')}, 'author': ${JSON.stringify(config.author || '')}})`
        },
        synthetic_source: {
            name: 'Source synthétique',
            icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19V5M4 19h16"/><path d="m7 15 3-4 3 2 5-7"/></svg>`,
            color: '#f9e2af',
            config: [
                { id: 'name', label: 'Nom de variable', type: 'text', default: 'df' },
                { id: 'samples', label: 'Échantillons', type: 'number', default: 1000 },
                { id: 'period', label: 'Période (s)', type: 'number', default: 0.01 },
                { id: 'seed', label: 'Seed', type: 'number', default: 42 },
                { id: 'signals', label: 'Signaux (JSON)', type: 'textarea', default: '[{"name":"signal_a","unit":"V","kind":"sine","amplitude":1,"frequency":0.5}]' }
            ],
            generateCode: (config) => `synthetic_source(${config.name || 'df'}, samples=${config.samples}, seed=${config.seed})`
        },
        section: {
            name: 'Section',
            icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16M4 12h16M4 18h7"/></svg>`,
            color: '#8b5cf6',
            isContainer: true,
            config: [
                { id: 'title', label: 'Titre', type: 'text', default: 'Nouvelle Section' },
                { id: 'level', label: 'Niveau', type: 'select', options: ['H1', 'H2', 'H3'], default: 'H1' }
            ],
            generateCode: (config) => `report.add(Section("${config.title}", level=${config.level === 'H1' ? 1 : config.level === 'H2' ? 2 : 3}))`
        },
        text: {
            name: 'Texte',
            icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/></svg>`,
            color: '#64748b',
            config: [
                { id: 'content', label: 'Contenu', type: 'textarea', default: 'Votre texte ici...' }
            ],
            generateCode: (config) => `report.add(Text("""${config.content}"""))`
        },
        callout: {
            name: 'Callout',
            icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
            color: '#f59e0b',
            config: [
                { id: 'type', label: 'Type', type: 'select', options: ['info', 'success', 'warning', 'danger'], default: 'info' },
                { id: 'title', label: 'Titre', type: 'text', default: 'Information' },
                { id: 'content', label: 'Contenu', type: 'textarea', default: 'Message...' }
            ],
            generateCode: (config) => `report.add(Callout("${config.type}", "${config.title}", "${config.content}"))`
        },
        metrics: {
            name: 'Métriques',
            icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>`,
            color: '#22c55e',
            config: [
                { id: 'metrics', label: 'Métriques', type: 'textarea', default: 'Points: len(df)\nDurée: df["time"].max()' }
            ],
            generateCode: (config) => {
                const metricsStr = config.metrics || '';
                if (!metricsStr.trim()) return 'report.add(Metrics([]))';
                const lines = metricsStr.split('\n').filter(m => m.includes(':'));
                const formatted = lines.map(m => {
                    const parts = m.split(':');
                    return `("${parts[0].trim()}", ${parts[1]?.trim() || '""'})`;
                }).join(',\n    ');
                return `report.add(Metrics([\n    ${formatted}\n]))`;
            }
        },
        table: {
            name: 'Tableau',
            icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/></svg>`,
            color: '#06b6d4',
            config: [
                { id: 'source', label: 'Source', type: 'source', options: [], default: 'df' },
                { id: 'caption', label: 'Légende', type: 'text', default: 'Tableau de données' },
                { id: 'max_rows', label: 'Max lignes', type: 'number', default: 20 }
            ],
            generateCode: (config) => `report.add(Table(${config.source || 'df'}, caption="${config.caption}", max_rows=${config.max_rows}))`
        },
        lineplot: {
            name: 'Line Plot',
            icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>`,
            color: '#6366f1',
            config: [
                { id: 'source', label: 'Source', type: 'source', options: [], default: 'df' },
                { id: 'signal', label: 'Signal', type: 'select', options: [], default: '' },
                { id: 'title', label: 'Titre', type: 'text', default: 'Graphique' },
                { id: 'color', label: 'Couleur', type: 'color', default: '#6366f1' }
            ],
            generateCode: (config) => `report.add(LinePlot(${config.source || 'df'}, x="time", y="${config.signal}", title="${config.title}", color="${config.color}"))`
        },
        scatter: {
            name: 'Scatter Plot',
            icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="7.5" cy="7.5" r="2"/><circle cx="16.5" cy="7.5" r="2"/><circle cx="7.5" cy="16.5" r="2"/><circle cx="16.5" cy="16.5" r="2"/><circle cx="12" cy="12" r="2"/></svg>`,
            color: '#ec4899',
            config: [
                { id: 'x', label: 'Axe X', type: 'select', options: [], default: '' },
                { id: 'y', label: 'Axe Y', type: 'select', options: [], default: '' },
                { id: 'color_by', label: 'Couleur par', type: 'select', options: [], default: '' },
                { id: 'title', label: 'Titre', type: 'text', default: 'Scatter Plot' }
            ],
            generateCode: (config) => `report.add(ScatterPlot(df, x="${config.x}", y="${config.y}"${config.color_by ? `, color="${config.color_by}"` : ''}, title="${config.title}"))`
        },
        histogram: {
            name: 'Histogram',
            icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="12" width="4" height="9"/><rect x="10" y="6" width="4" height="15"/><rect x="17" y="9" width="4" height="12"/></svg>`,
            color: '#14b8a6',
            config: [
                { id: 'signal', label: 'Signal', type: 'select', options: [], default: '' },
                { id: 'bins', label: 'Bins', type: 'number', default: 30 },
                { id: 'title', label: 'Titre', type: 'text', default: 'Distribution' }
            ],
            generateCode: (config) => `report.add(Histogram(df, column="${config.signal}", bins=${config.bins}, title="${config.title}"))`
        },
        stats: {
            name: 'Stats',
            icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>`,
            color: '#a855f7',
            config: [
                { id: 'signals', label: 'Signaux', type: 'text', default: '*' },
                { id: 'caption', label: 'Légende', type: 'text', default: 'Statistiques' }
            ],
            generateCode: (config) => `report.add(StatsTable(df, signals="${config.signals}", caption="${config.caption}"))`
        },
        latex: {
            name: 'LaTeX',
            icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><text x="4" y="17" font-size="14" font-family="serif" fill="currentColor">∑</text></svg>`,
            color: '#78716c',
            config: [
                { id: 'expression', label: 'Expression', type: 'text', default: 'E = mc^2' }
            ],
            generateCode: (config) => `report.add(LaTeX(r"${config.expression}"))`
        },
        python: {
            name: 'Python',
            icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`,
            color: '#334155',
            hideCodePreview: true, // No duplicate preview for code blocks
            config: [
                { id: 'code', label: 'Code', type: 'code', default: "return {'data': [], 'layout': {'title': {'text': 'Figure personnalisée'}}}" },
                { id: 'inputs', label: 'Variables (séparées par des virgules)', type: 'text', default: 'df' },
                { id: 'output', label: 'Sortie', type: 'select', options: ['figure', 'table'], default: 'figure' }
            ],
            generateCode: (config) => config.code
        }
    };

    const SECTION_COLORS = {
        'H1': '#8b5cf6',
        'H2': '#6366f1',
        'H3': '#818cf8'
    };

    // =========================================================================
    // Utilities
    // =========================================================================

    function escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function generateId() {
        return `block_${++blockIdCounter}`;
    }

    function formatDate(dateString) {
        const date = new Date(dateString);
        const now = new Date();
        const diff = now - date;
        
        if (diff < 60000) return 'À l\'instant';
        if (diff < 3600000) return `Il y a ${Math.floor(diff / 60000)} min`;
        if (diff < 86400000) return `Il y a ${Math.floor(diff / 3600000)}h`;
        
        return date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
    }

    // =========================================================================
    // Tree Operations
    // =========================================================================

    /**
     * Find a block by ID in the tree
     * Returns { block, parent, index } or null
     */
    function findBlockInTree(blockId, blocks = canvasBlocks, parent = null) {
        for (let i = 0; i < blocks.length; i++) {
            if (blocks[i].id === blockId) {
                return { block: blocks[i], parent: blocks, index: i };
            }
            if (blocks[i].children && blocks[i].children.length > 0) {
                const found = findBlockInTree(blockId, blocks[i].children, blocks[i]);
                if (found) return found;
            }
        }
        return null;
    }

    /**
     * Create a new block with default config
     */
    function createBlock(blockType) {
        const def = BLOCK_DEFINITIONS[blockType];
        if (!def) return null;

        const config = {};
        def.config.forEach(field => {
            config[field.id] = field.default;
        });

        applyDynamicDefaults(blockType, config);

        return {
            id: generateId(),
            type: blockType,
            config: config,
            collapsed: false,
            codePreviewExpanded: false,
            children: def.isContainer ? [] : undefined
        };
    }

    /**
     * Insert a block at a specific position
     * position: { parent: array, index: number }
     */
    function insertBlock(block, position) {
        position.parent.splice(position.index, 0, block);
        markModified();
        render();
    }

    /**
     * Remove a block from the tree
     */
    function removeBlock(blockId) {
        const found = findBlockInTree(blockId);
        if (found) {
            found.parent.splice(found.index, 1);
            if (selectedBlockId === blockId) {
                selectedBlockId = null;
            }
            markModified();
            render();
        }
    }

    /**
     * Move a block to a new position
     */
    function moveBlock(blockId, newPosition) {
        const found = findBlockInTree(blockId);
        if (!found) return;

        // Remove from old position
        const [block] = found.parent.splice(found.index, 1);

        // Adjust index if moving within same parent and after original position
        let adjustedIndex = newPosition.index;
        if (found.parent === newPosition.parent && found.index < newPosition.index) {
            adjustedIndex--;
        }

        // Insert at new position
        newPosition.parent.splice(adjustedIndex, 0, block);
        markModified();
        render();
    }

    /**
     * Flatten tree to array (for code generation)
     */
    function flattenTree(blocks = canvasBlocks, result = []) {
        for (const block of blocks) {
            result.push(block);
            if (block.children && block.children.length > 0) {
                flattenTree(block.children, result);
            }
        }
        return result;
    }

    /**
     * Expand or collapse all sections
     */
    function setAllCollapsed(collapsed) {
        function traverse(blocks) {
            for (const block of blocks) {
                if (block.type === 'section') {
                    block.collapsed = collapsed;
                }
                if (block.children) {
                    traverse(block.children);
                }
            }
        }
        traverse(canvasBlocks);
        render();
    }

    // =========================================================================
    // Panel Switching
    // =========================================================================

    function switchPanel(panel) {
        currentPanel = panel;
        
        document.querySelectorAll('.dashboard-toggle-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.panel === panel);
        });
        
        const toggle = document.getElementById('dashboardToggle');
        if (toggle) {
            toggle.classList.remove('edition', 'mapping');
            if (panel === 'edition') toggle.classList.add('edition');
            else if (panel === 'mapping') toggle.classList.add('mapping');
        }
        
        const track = document.getElementById('dashboardSliderTrack');
        if (track) {
            track.classList.remove('show-edition', 'show-mapping');
            if (panel === 'edition') track.classList.add('show-edition');
            else if (panel === 'mapping') track.classList.add('show-mapping');
        }
    }

    // =========================================================================
    // Console
    // =========================================================================

    function logToConsole(message, type = '') {
        const consoleEl = document.getElementById('consoleContent');
        if (!consoleEl) return;
        
        const time = new Date().toLocaleTimeString('fr-FR', { 
            hour: '2-digit', 
            minute: '2-digit', 
            second: '2-digit' 
        });
        
        const line = document.createElement('div');
        line.className = 'console-line';
        line.innerHTML = `<span class="console-time">[${time}]</span><span class="console-message ${type}">${escapeHtml(message)}</span>`;
        
        consoleEl.appendChild(line);
        consoleEl.scrollTop = consoleEl.scrollHeight;
    }

    function clearConsole() {
        const consoleEl = document.getElementById('consoleContent');
        if (consoleEl) {
            consoleEl.innerHTML = '';
            logToConsole('Console effacée.');
        }
    }

    // =========================================================================
    // Scripts Management
    // =========================================================================

    async function loadScriptsList() {
        const listContainer = document.getElementById('scriptsList');
        const countEl = document.getElementById('scriptsCount');
        
        if (!listContainer) return;
        
        listContainer.innerHTML = '<div class="scripts-loading">Chargement des scripts...</div>';
        
        try {
            const res = await authFetch(SCRIPTS_API);
            const data = await res.json();
            
            scriptsList = data.scripts || [];
            if (countEl) countEl.textContent = `${scriptsList.length} script(s)`;
            
            if (scriptsList.length === 0) {
                listContainer.innerHTML = `
                    <div class="scripts-empty">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                            <polyline points="14 2 14 8 20 8"/>
                            <line x1="12" y1="18" x2="12" y2="12"/>
                            <line x1="9" y1="15" x2="15" y2="15"/>
                        </svg>
                        <p>Aucun script disponible</p>
                        <p class="scripts-empty-hint">Créez un nouveau script dans l'onglet Édition</p>
                    </div>
                `;
                return;
            }
            
            renderScriptsList();
            
        } catch (e) {
            console.error('Failed to load scripts:', e);
            listContainer.innerHTML = `
                <div class="scripts-empty">
                    <p style="color: #ff6666;">Erreur de chargement</p>
                    <p class="scripts-empty-hint">${escapeHtml(e.message)}</p>
                </div>
            `;
        }
    }

    function renderScriptsList() {
        const listContainer = document.getElementById('scriptsList');
        if (!listContainer) return;
        
        listContainer.innerHTML = scriptsList.map(script => {
            const statusClass = script.lastRunStatus === 'success' ? 'success' : 
                               script.lastRunStatus === 'error' ? 'error' : '';
            const statusIcon = script.lastRunStatus === 'success' ? '✓' : 
                              script.lastRunStatus === 'error' ? '✗' : '';
            
            return `
                <div class="script-card" data-script-id="${script.id}">
                    <div class="script-card-main">
                        <div class="script-card-icon">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                                <polyline points="14 2 14 8 20 8"/>
                                <line x1="16" y1="13" x2="8" y2="13"/>
                                <line x1="16" y1="17" x2="8" y2="17"/>
                            </svg>
                        </div>
                        <div class="script-card-content">
                            <div class="script-card-name">${escapeHtml(script.name)}</div>
                            <div class="script-card-meta">
                                <span class="script-card-blocks">${script.blockCount || 0} blocs</span>
                                ${script.lastRun
                                    ? `<span class="script-card-status ${statusClass}">${statusIcon} ${formatDate(script.lastRun)}</span>`
                                    : ''}
                            </div>
                        </div>
                    </div>
                    <div class="script-card-actions">
                        <button class="script-btn script-btn-edit" data-action="edit" data-script-id="${script.id}"
                                title="Éditer">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                            </svg>
                            <span>Éditer</span>
                        </button>
                        <button class="script-btn script-btn-report" data-action="report" data-script-id="${script.id}"
                                title="Générer le rapport HTML">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                                <polyline points="14 2 14 8 20 8"/>
                            </svg>
                            <span>Rapport</span>
                        </button>
                        <button class="script-btn script-btn-run" data-action="run" data-script-id="${script.id}"
                                title="Exécuter">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <polygon points="5 3 19 12 5 21 5 3"/>
                            </svg>
                            <span>Exécuter</span>
                        </button>
                    </div>
                </div>
            `;
        }).join('');

        // Delegation posee une seule fois : renderScriptsList() est rejoue a chaque rafraichissement.
        if (listContainer.dataset.actionsBound !== 'true') {
            listContainer.addEventListener('click', handleScriptAction);
            listContainer.dataset.actionsBound = 'true';
        }
    }

    function handleScriptAction(e) {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;

        const action = btn.dataset.action;
        const scriptId = btn.dataset.scriptId;

        if (action === 'edit') {
            editScript(scriptId);
        } else if (action === 'run') {
            runScript(scriptId);
        } else if (action === 'report') {
            const script = scriptsList.find(item => item.id === scriptId);
            downloadReport(scriptId, script ? script.name : 'rapport');
        }
    }

    async function runScript(scriptId) {
        const script = scriptsList.find(s => s.id === scriptId);
        const scriptName = script ? script.name : scriptId;
        
        logToConsole(`Démarrage de "${scriptName}"...`, 'info');
        
        try {
            const res = await authFetch(`${SCRIPTS_API}/${scriptId}/run`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
            
            const data = await res.json();
            
            if (data.success) {
                logToConsole(`Chargement des données...`);
                logToConsole(`Génération du rapport...`);
                const statusMessage = data.status === 'partial'
                    ? 'Rapport généré avec des blocs en échec.'
                    : 'Rapport généré avec succès !';
                const statusType = data.status === 'partial' ? 'warning' : 'success';
                logToConsole(`${data.status === 'partial' ? '⚠' : '✓'} ${statusMessage} (${data.duration}s)`, statusType);
                if (data.block_status) {
                    const failedBlocks = Object.entries(data.block_status)
                        .filter(([, status]) => status === 'failed')
                        .map(([blockId]) => blockId);
                    if (failedBlocks.length > 0) {
                        logToConsole(`Blocs en échec : ${failedBlocks.join(', ')}`, 'error');
                    }
                    const skippedBlocks = Object.entries(data.block_status)
                        .filter(([, status]) => status === 'skipped')
                        .map(([blockId]) => blockId);
                    if (skippedBlocks.length > 0) {
                        logToConsole(`Blocs ignorés : ${skippedBlocks.join(', ')}`, 'warning');
                    }
                }
                if (data.block_errors) {
                    Object.entries(data.block_errors).forEach(([blockId, message]) => {
                        logToConsole(`${blockId}: ${message}`, 'error');
                    });
                }
                loadScriptsList();
            } else {
                logToConsole(`✗ Erreur: ${data.error}`, 'error');
            }
        } catch (e) {
            console.error('Failed to run script:', e);
            logToConsole(`✗ Erreur d'exécution: ${e.message}`, 'error');
        }
    }

    async function editScript(scriptId) {
        switchPanel('edition');
        logToConsole(`Chargement du script pour édition...`, 'info');
        
        try {
            const res = await authFetch(`${SCRIPTS_API}/${scriptId}`);
            const script = await res.json();
            
            if (script.error) {
                logToConsole(`✗ Erreur: ${script.error}`, 'error');
                return;
            }
            
            loadScriptInEditor(script);
            logToConsole(`✓ Script "${script.name}" chargé`, 'success');
        } catch (e) {
            console.error('Failed to load script:', e);
            logToConsole(`✗ Erreur de chargement: ${e.message}`, 'error');
        }
    }

    function loadScriptInEditor(script) {
        currentScriptId = script.id;
        currentScriptReadonly = Boolean(script._readonly || script.readonly);
        
        const nameInput = document.getElementById('currentScriptName');
        if (nameInput) nameInput.value = script.name;
        
        // Convert flat blocks to tree structure
        canvasBlocks = convertToTree(script.blocks || []);
        
        // Update blockIdCounter
        const maxId = flattenTree(canvasBlocks).reduce((max, b) => {
            const num = parseInt(b.id.replace('block_', '')) || 0;
            return num > max ? num : max;
        }, blockIdCounter);
        blockIdCounter = maxId;
        
        isScriptModified = false;
        updateStatus('Chargé');
        render();
        refreshLivePreview();
    }

    /**
     * Convert flat block array to tree structure
     * Sections contain blocks until the next section of same or higher level
     */
    function convertToTree(flatBlocks) {
        const result = [];
        const stack = [{ level: 0, children: result }];

        for (const block of flatBlocks) {
            const blockType = block.type === 'code' ? 'python' : block.type;
            const def = BLOCK_DEFINITIONS[blockType];
            if (!def) continue;

            const newBlock = {
                id: block.id || generateId(),
                type: blockType,
                config: normalizeLoadedConfig(blockType, { ...getDefaultConfig(blockType), ...block.config }),
                collapsed: false,
                children: def.isContainer ? [] : undefined
            };

            if (blockType === 'section') {
                const level = newBlock.config.level === 'H1' ? 1 :
                              newBlock.config.level === 'H2' ? 2 : 3;

                // Pop stack until we find a parent with lower level
                while (stack.length > 1 && stack[stack.length - 1].level >= level) {
                    stack.pop();
                }

                // Add to current parent
                stack[stack.length - 1].children.push(newBlock);

                // Push this section as new potential parent
                stack.push({ level: level, children: newBlock.children });
            } else {
                // Regular block - add to current parent
                stack[stack.length - 1].children.push(newBlock);
            }
        }

        return result;
    }

    function normalizeLoadedConfig(blockType, config) {
        if (blockType === 'section') {
            // La recette stocke le niveau en nombre (1/2/3), l'editeur en 'H1'/'H2'/'H3'
            config.level = { 1: 'H1', 2: 'H2', 3: 'H3' }[config.level] || String(config.level || 'H1').toUpperCase();
        }
        if (blockType === 'synthetic_source' && Array.isArray(config.signals)) {
            config.signals = JSON.stringify(config.signals);
        }
        if (blockType === 'python' && Array.isArray(config.inputs)) {
            config.inputs = config.inputs.join(', ');
        }
        if (blockType === 'lineplot' && config.source === undefined) {
            config.source = 'df';
        }
        if (blockType === 'lineplot' && config.y === undefined && config.signal !== undefined) {
            config.y = config.signal;
        }
        if (blockType === 'lineplot' && config.y) {
            // L'editeur pilote le signal via le champ 'signal', la recette via 'y'
            config.signal = config.y;
        }
        if (blockType === 'table' && config.source === undefined && config.data !== undefined) {
            config.source = config.data;
        }
        if (blockType === 'table' && config.source === undefined) {
            config.source = 'df';
        }
        return config;
    }

    function getDefaultConfig(blockType) {
        const def = BLOCK_DEFINITIONS[blockType];
        if (!def) return {};
        
        const config = {};
        def.config.forEach(field => {
            config[field.id] = field.default;
        });
        return config;
    }

    // =========================================================================
    // Rendering
    // =========================================================================

    function render() {
        renderCanvas();
        renderOutline();
    }

    function renderCanvas() {
        const canvasEmpty = document.getElementById('canvasEmpty');
        const canvasBlocksContainer = document.getElementById('canvasBlocks');
        const editionCanvas = document.getElementById('editionCanvas');

        if (!canvasEmpty || !canvasBlocksContainer) return;

        if (canvasBlocks.length === 0) {
            canvasEmpty.style.display = 'flex';
            canvasBlocksContainer.style.display = 'none';
            return;
        }

        canvasEmpty.style.display = 'none';
        canvasBlocksContainer.style.display = 'block';

        const scrollTop = editionCanvas ? editionCanvas.scrollTop : 0;
        const focusState = captureFocusState();

        if (typeof CodeEditor !== 'undefined') {
            CodeEditor.destroyAll();
        }

        canvasBlocksContainer.innerHTML = renderBlockList(canvasBlocks, 0);

        setupDragAndDrop();
        setupCodeEditors();
        highlightCode();
        restoreFocusState(focusState);

        if (editionCanvas) {
            editionCanvas.scrollTop = scrollTop;
        }
    }

    /**
     * Capture which config field is currently focused so it can be restored after
     * renderCanvas() rebuilds the DOM (innerHTML replacement drops native focus/caret).
     */
    function captureFocusState() {
        const active = document.activeElement;
        if (!active || !active.dataset || !active.dataset.blockId || !active.dataset.fieldId) return null;

        const state = {
            blockId: active.dataset.blockId,
            fieldId: active.dataset.fieldId,
            selectionStart: null,
            selectionEnd: null
        };
        if (typeof active.selectionStart === 'number') {
            state.selectionStart = active.selectionStart;
            state.selectionEnd = active.selectionEnd;
        }
        return state;
    }

    function restoreFocusState(state) {
        if (!state) return;
        const el = document.querySelector(`[data-block-id="${state.blockId}"][data-field-id="${state.fieldId}"]`);
        if (!el) return;

        el.focus();
        if (state.selectionStart !== null && typeof el.setSelectionRange === 'function') {
            el.setSelectionRange(state.selectionStart, state.selectionEnd);
        }
    }

    function renderBlockList(blocks, depth) {
        let html = '';
        
        for (let i = 0; i < blocks.length; i++) {
            const block = blocks[i];
            html += `<div class="canvas-drop-zone" data-depth="${depth}" data-index="${i}"></div>`;
            html += renderBlock(block, depth);
        }
        
        // Final drop zone
        html += `<div class="canvas-drop-zone" data-depth="${depth}" data-index="${blocks.length}"></div>`;
        
        return html;
    }

    function renderBlock(block, depth) {
        const def = BLOCK_DEFINITIONS[block.type];
        if (!def) return '';

        const isSection = block.type === 'section';
        const level = isSection ? block.config.level?.toLowerCase() : '';
        const blockColor = isSection ? (SECTION_COLORS[block.config.level] || def.color) : def.color;
        const collapsed = block.collapsed && isSection;
        const isSelected = block.id === selectedBlockId;

        let html = `
            <div class="canvas-block ${isSection ? 'is-section' : ''} ${isSection ? level : ''} ${collapsed ? 'collapsed' : ''} ${isSelected ? 'selected' : ''}"
                 data-block-id="${block.id}"
                 data-depth="${depth}"
                 style="--block-color: ${blockColor};">
                
                <div class="canvas-block-header" draggable="true">
                    ${isSection ? `
                        <button class="section-toggle" data-action="toggle-section" data-block-id="${block.id}">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <polyline points="6 9 12 15 18 9"/>
                            </svg>
                        </button>
                    ` : ''}
                    <div class="canvas-block-icon">${def.icon}</div>
                    <div class="canvas-block-info">
                        <div class="canvas-block-title">${def.name}</div>
                        <div class="canvas-block-subtitle">${getBlockSubtitle(block)}</div>
                    </div>
                    <div class="canvas-block-actions">
                        <button class="canvas-block-action" data-action="move-up" data-block-id="${block.id}" title="Monter">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="18 15 12 9 6 15"/></svg>
                        </button>
                        <button class="canvas-block-action" data-action="move-down" data-block-id="${block.id}" title="Descendre">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
                        </button>
                        <button class="canvas-block-action delete" data-action="delete" data-block-id="${block.id}" title="Supprimer">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                        </button>
                    </div>
                </div>
                
                <div class="canvas-block-body">
                    <div class="canvas-block-config">
                        ${renderBlockConfig(block)}
                    </div>
                    
                    ${!def.hideCodePreview ? `
                        <div class="canvas-block-code ${block.codePreviewExpanded ? 'expanded' : ''}" data-block-id="${block.id}">
                            <div class="canvas-block-code-header" data-action="toggle-code" data-block-id="${block.id}">
                                <div class="canvas-block-code-header-left">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
                                    Python
                                </div>
                                <button class="canvas-block-code-copy" data-action="copy-code" data-block-id="${block.id}">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                                    Copier
                                </button>
                            </div>
                            <pre class="canvas-block-code-content"><code class="language-python">${escapeHtml(def.generateCode(block.config))}</code></pre>
                        </div>
                    ` : ''}
                </div>
        `;
        
        // Render children for sections
        if (isSection && block.children) {
            html += `
                <div class="canvas-block-children">
                    ${block.children.length > 0 ? renderBlockList(block.children, depth + 1) : `
                        <div class="canvas-drop-zone empty-section" data-depth="${depth + 1}" data-index="0" data-parent-id="${block.id}">
                            <span>Glissez des blocs ici</span>
                        </div>
                    `}
                </div>
            `;
        }
        
        html += '</div>';
        return html;
    }

    function getBlockSubtitle(block) {
        switch (block.type) {
            case 'title': return block.config.title || 'Sans titre';
            case 'section': return block.config.title || 'Sans titre';
            case 'text': return (block.config.content || '').substring(0, 40) + (block.config.content?.length > 40 ? '...' : '');
            case 'lineplot': 
            case 'histogram': return block.config.signal || 'Non configuré';
            case 'scatter': return block.config.x && block.config.y ? `${block.config.x} vs ${block.config.y}` : 'Non configuré';
            case 'table': return block.config.caption || 'Tableau';
            case 'python':
            case 'code': return (block.config.code || '').split('\n')[0]?.substring(0, 30) || 'Code personnalisé';
            default: return '';
        }
    }

    function renderBlockConfig(block) {
        const def = BLOCK_DEFINITIONS[block.type];
        if (!def) return '';

        const rows = def.config.map(field => {
            let input = '';
            const value = block.config[field.id];
            const options = getFieldOptions(block, field);
            
            switch (field.type) {
                case 'text':
                    input = `<input type="text" class="block-config-input" value="${escapeHtml(value || '')}" 
                             data-block-id="${block.id}" data-field-id="${field.id}">`;
                    break;
                case 'number':
                    input = `<input type="number" class="block-config-input" value="${value || 0}" 
                             data-block-id="${block.id}" data-field-id="${field.id}">`;
                    break;
                case 'textarea':
                    input = `<textarea class="block-config-input" rows="3" 
                             data-block-id="${block.id}" data-field-id="${field.id}">${escapeHtml(value || '')}</textarea>`;
                    break;
                case 'code':
                    // Use a hidden script tag to safely store code with special characters
                    const encodedValue = btoa(encodeURIComponent(value || ''));
                    input = `<div class="code-editor-container" id="code-editor-${block.id}"
                                  data-block-id="${block.id}" data-field-id="${field.id}" 
                                  data-initial-value="${encodedValue}"></div>`;
                    break;
                case 'select':
                    const renderedOptions = options.length > 0
                        ? options.map(opt => `<option value="${opt}" ${value === opt ? 'selected' : ''}>${opt}</option>`).join('')
                        : '<option value="">Aucune option</option>';
                    input = `<select class="block-config-select" data-block-id="${block.id}" data-field-id="${field.id}">${renderedOptions}</select>`;
                    break;
                case 'source':
                    const sourceListId = `bb-source-opts-${block.id}`;
                    const sourceOptions = options.map(opt => `<option value="${escapeHtml(opt)}"></option>`).join('');
                    input = `<input type="text" class="block-config-input" list="${sourceListId}" value="${escapeHtml(value || '')}"
                             data-block-id="${block.id}" data-field-id="${field.id}">
                             <datalist id="${sourceListId}">${sourceOptions}</datalist>`;
                    break;
                case 'color':
                    input = `<input type="color" class="block-config-color" value="${value || '#6366f1'}" 
                             data-block-id="${block.id}" data-field-id="${field.id}">`;
                    break;
            }
            
            return `<div class="block-config-row"><label class="block-config-label">${field.label}</label>${input}</div>`;
        });

        if (block.type === 'python') {
            const availableInputs = listSourceNames();
            const validation = describePythonInputs(block.config.inputs, availableInputs);
            const outputContract = describePythonOutput(block.config.output);
            rows.push(`
                <div class="block-config-row">
                    <label class="block-config-label">Variables disponibles</label>
                    <div class="block-config-meta">
                        <div class="block-config-help">${escapeHtml(availableInputs.join(', ') || 'Aucune source synthétique disponible')}</div>
                    </div>
                </div>
            `);
            rows.push(`
                <div class="block-config-row">
                    <label class="block-config-label">Validation inputs</label>
                    <div class="block-config-meta">
                        ${validation.messages.map(message => `<div class="${message.type === 'error' ? 'block-config-error' : 'block-config-help'}">${escapeHtml(message.text)}</div>`).join('')}
                    </div>
                </div>
            `);
            rows.push(`
                <div class="block-config-row">
                    <label class="block-config-label">Contrat ${escapeHtml(block.config.output || 'figure')}</label>
                    <div class="block-config-meta">
                        ${outputContract.map(message => `<div class="block-config-help">${escapeHtml(message)}</div>`).join('')}
                    </div>
                </div>
            `);
            rows.push(`
                <div class="block-config-row">
                    <label class="block-config-label">Imports</label>
                    <div class="block-config-meta">
                        <div class="block-config-help">Autorisés: numpy/np, pandas/pd, polars/pl, math, statistics, datetime, re, json, typing.</div>
                        <div class="block-config-help">Interdits: open, exec, eval, globals, accès système et imports hors allowlist.</div>
                    </div>
                </div>
            `);
        }

        return rows.join('');
    }

    function getFieldOptions(block, field) {
        if (!Array.isArray(field.options) || field.options.length > 0) {
            return Array.isArray(field.options) ? field.options : [];
        }

        if (field.id === 'source') {
            return listSourceNames();
        }

        if (field.id === 'signal' && block.type === 'lineplot') {
            return listSignalsForSource(block.config.source || 'df');
        }

        return [];
    }

    function listSourceNames() {
        const names = flattenTree()
            .filter(block => block.type === 'synthetic_source')
            .map(block => String(block.config.name || '').trim())
            .filter(Boolean);
        return names.length > 0 ? names : ['df'];
    }

    function listSignalsForSource(sourceName) {
        const source = flattenTree().find(block => {
            return block.type === 'synthetic_source' && String(block.config.name || '').trim() === sourceName;
        });
        if (!source) {
            return [];
        }

        return parseSignals(source.config.signals)
            .map(signal => String(signal?.name || '').trim())
            .filter(Boolean);
    }

    function applyDynamicDefaults(blockType, config) {
        if (blockType === 'table') {
            const firstSource = listSourceNames()[0] || 'df';
            config.source = config.source || config.data || firstSource;
            delete config.data;
        }

        if (blockType === 'lineplot') {
            const firstSource = listSourceNames()[0] || 'df';
            config.source = config.source || firstSource;
            const signalOptions = listSignalsForSource(config.source);
            config.signal = signalOptions.includes(config.signal) ? config.signal : (signalOptions[0] || '');
        }
    }

    function isValidIdentifier(value) {
        return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
    }

    function describePythonInputs(value, availableInputs) {
        const knownInputs = new Set(availableInputs);
        const inputs = parsePythonInputs(value);
        const duplicates = inputs.filter((name, index) => inputs.indexOf(name) !== index);
        const unknowns = inputs.filter(name => !knownInputs.has(name));
        const messages = [];

        if (inputs.length === 0) {
            messages.push({ type: 'error', text: 'Déclarez au moins une variable d’entrée.' });
        } else {
            messages.push({ type: 'info', text: `Entrées déclarées: ${inputs.join(', ')}` });
        }

        if (duplicates.length > 0) {
            messages.push({ type: 'error', text: `Entrées dupliquées: ${Array.from(new Set(duplicates)).join(', ')}` });
        }

        if (unknowns.length > 0) {
            messages.push({ type: 'error', text: `Entrées inconnues: ${Array.from(new Set(unknowns)).join(', ')}` });
        } else if (inputs.length > 0) {
            messages.push({ type: 'info', text: 'Toutes les entrées pointent vers une source disponible.' });
        }

        return { inputs, messages };
    }

    function describePythonOutput(output) {
        if (output === 'table') {
            return [
                'Retour attendu: un dict avec les clés columns et rows.',
                'columns contient les noms de colonnes; rows contient les lignes sérialisables.',
                'Toute autre forme sera rejetée par le backend.'
            ];
        }

        return [
            'Retour attendu: un dict Plotly avec les clés data et layout.',
            'Le bloc doit renvoyer une spécification JSON sérialisable, jamais du HTML ni du JavaScript.',
            'Toute autre forme sera rejetée par le backend.'
        ];
    }

    function validateRecipeDraft(blocks) {
        const errors = [];
        const sourceNames = new Set();

        blocks.forEach(block => {
            if (block.type === 'synthetic_source') {
                const sourceName = String(block.config.name || '').trim();
                if (!isValidIdentifier(sourceName)) {
                    errors.push(`Bloc ${block.id}: le nom de source doit être un identifiant Python valide.`);
                } else if (sourceNames.has(sourceName)) {
                    errors.push(`Bloc ${block.id}: le nom de source ${sourceName} est dupliqué.`);
                } else {
                    sourceNames.add(sourceName);
                }

                parseSignals(block.config.signals).forEach((signal, index) => {
                    const signalName = String(signal?.name || '').trim();
                    if (!isValidIdentifier(signalName)) {
                        errors.push(`Bloc ${block.id}: le signal ${index + 1} doit avoir un identifiant valide.`);
                    }
                });
            }
        });

        blocks.forEach(block => {
            if (block.type === 'lineplot') {
                const sourceName = String(block.config.source || '').trim();
                const signalName = String(block.config.signal || '').trim();
                if (!sourceNames.has(sourceName)) {
                    errors.push(`Bloc ${block.id}: la source ${sourceName || '(vide)'} est inconnue.`);
                }
                if (!signalName) {
                    errors.push(`Bloc ${block.id}: sélectionnez un signal à tracer.`);
                }
            }

            if (block.type === 'python') {
                const inputs = parsePythonInputs(block.config.inputs);
                if (!String(block.config.code || '').trim()) {
                    errors.push(`Bloc ${block.id}: le code Python est vide.`);
                }
                inputs.forEach(inputName => {
                    if (!isValidIdentifier(inputName)) {
                        errors.push(`Bloc ${block.id}: l'entrée Python ${inputName} n'est pas un identifiant valide.`);
                    } else if (!sourceNames.has(inputName)) {
                        errors.push(`Bloc ${block.id}: l'entrée Python ${inputName} ne correspond à aucune source disponible.`);
                    }
                });
                if (new Set(inputs).size !== inputs.length) {
                    errors.push(`Bloc ${block.id}: les entrées Python ne doivent pas contenir de doublons.`);
                }
            }
        });

        return errors;
    }

    function renderOutline() {
        const outlineContent = document.getElementById('outlineContent');
        if (!outlineContent) return;
        
        const allBlocks = flattenTree();
        const sections = allBlocks.filter(b => b.type === 'section');
        const totalBlocks = allBlocks.length;
        
        if (sections.length === 0) {
            outlineContent.innerHTML = '<div class="outline-empty"><p>Ajoutez des blocs Section pour voir la structure</p></div>';
            return;
        }
        
        const outlineItems = sections.map(block => {
            const level = block.config.level || 'H1';
            const title = block.config.title || 'Sans titre';
            return `
                <div class="outline-item ${level.toLowerCase()}" data-block-id="${block.id}">
                    <div class="outline-item-icon">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16M4 12h16M4 18h7"/></svg>
                    </div>
                    <span class="outline-item-text" title="${escapeHtml(title)}">${escapeHtml(title)}</span>
                </div>
            `;
        }).join('');
        
        outlineContent.innerHTML = outlineItems + `<div class="outline-stats">${sections.length} section(s) • ${totalBlocks} bloc(s)</div>`;
    }

    function highlightCode() {
        if (typeof Prism !== 'undefined') {
            requestAnimationFrame(() => {
                // Highlight code previews
                document.querySelectorAll('.canvas-block-code-content code').forEach(block => {
                    Prism.highlightElement(block);
                });
            });
        }
    }

    // Hauteur choisie par l'utilisateur pour chaque editeur de code, conservee
    // entre deux rendus du canvas (le conteneur DOM est recree a chaque rendu).
    const codeEditorHeights = new Map();

    function trackCodeEditorHeight(container, blockId) {
        const stored = codeEditorHeights.get(blockId);
        if (stored) container.style.height = `${stored}px`;

        const observer = new ResizeObserver((entries) => {
            for (const entry of entries) {
                const height = Math.round(entry.contentRect.height);
                if (height > 0) codeEditorHeights.set(blockId, height);
            }
        });
        observer.observe(container);
    }

    async function setupCodeEditors() {
        // Check if CodeEditor module is available
        if (typeof CodeEditor === 'undefined') {
            console.warn('CodeEditor module not loaded');
            return;
        }

        const containers = document.querySelectorAll('.code-editor-container');
        
        for (const container of containers) {
            // Skip if already initialized
            if (container.dataset.initialized === 'true') continue;
            
            const blockId = container.dataset.blockId;
            const fieldId = container.dataset.fieldId;
            
            // Decode base64 encoded value
            let initialValue = '';
            try {
                const encoded = container.dataset.initialValue || '';
                if (encoded) {
                    initialValue = decodeURIComponent(atob(encoded));
                }
            } catch (e) {
                console.warn('Failed to decode initial value:', e);
            }
            
            trackCodeEditorHeight(container, blockId);

            try {
                await CodeEditor.create(container, {
                    value: initialValue,
                    minHeight: 150,
                    onChange: (newValue) => {
                        updateBlockConfig(blockId, fieldId, newValue);
                    },
                    onFocus: () => {
                        selectBlock(blockId);
                    }
                });
                
                container.dataset.initialized = 'true';
            } catch (error) {
                console.error(`Failed to create code editor for block ${blockId}:`, error);
                // Fallback to simple textarea
                container.innerHTML = `<textarea class="code-editor-fallback" 
                    data-block-id="${blockId}" data-field-id="${fieldId}"
                    spellcheck="false">${escapeHtml(initialValue)}</textarea>`;
            }
        }
    }

    // =========================================================================
    // Event Handlers
    // =========================================================================

    function setupEventListeners() {
        const canvas = document.getElementById('editionCanvas');
        if (!canvas) return;

        // Event delegation for canvas
        canvas.addEventListener('click', handleCanvasClick);
        canvas.addEventListener('input', handleConfigInput);
        canvas.addEventListener('change', handleConfigChange);
        canvas.addEventListener('focusin', handleCanvasFocusIn);

        // Outline clicks
        const outline = document.getElementById('outlineContent');
        if (outline) {
            outline.addEventListener('click', handleOutlineClick);
        }

        // Toolbar buttons
        document.querySelectorAll('[data-toolbar-action]').forEach(btn => {
            btn.addEventListener('click', handleToolbarAction);
        });

        // Palette search
        const paletteSearch = document.getElementById('paletteSearch');
        if (paletteSearch) {
            paletteSearch.addEventListener('input', (e) => filterPalette(e.target.value));
        }
    }

    function handleCanvasClick(e) {
        const blockEl = e.target.closest('.canvas-block');
        if (blockEl) {
            selectBlock(blockEl.dataset.blockId);
        }

        const action = e.target.closest('[data-action]');
        if (!action) return;

        const actionType = action.dataset.action;
        const blockId = action.dataset.blockId;

        switch (actionType) {
            case 'toggle-section':
                toggleSection(blockId);
                break;
            case 'toggle-code':
                toggleCodePreview(blockId);
                break;
            case 'copy-code':
                e.stopPropagation();
                copyCode(blockId, action);
                break;
            case 'move-up':
                moveBlockUp(blockId);
                break;
            case 'move-down':
                moveBlockDown(blockId);
                break;
            case 'delete':
                removeBlock(blockId);
                break;
        }
    }

    function handleConfigInput(e) {
        const input = e.target;
        if (!input.dataset.blockId || !input.dataset.fieldId) return;

        updateBlockConfig(input.dataset.blockId, input.dataset.fieldId, input.value);
    }

    function handleCanvasFocusIn(e) {
        const blockEl = e.target.closest('.canvas-block');
        if (blockEl) {
            selectBlock(blockEl.dataset.blockId);
        }
    }

    /**
     * Track the selected block without a full re-render, so the highlight applies
     * instantly and doesn't disturb focus/scroll. renderBlock() also bakes the
     * 'selected' class in from selectedBlockId, so it survives any full re-render.
     */
    function selectBlock(blockId) {
        if (!blockId || selectedBlockId === blockId) return;

        const previousId = selectedBlockId;
        selectedBlockId = blockId;

        if (previousId) {
            const previousEl = document.querySelector(`.canvas-block[data-block-id="${previousId}"]`);
            if (previousEl) previousEl.classList.remove('selected');
        }
        const newEl = document.querySelector(`.canvas-block[data-block-id="${blockId}"]`);
        if (newEl) newEl.classList.add('selected');
    }

    function handleConfigChange(e) {
        const input = e.target;
        if (!input.dataset.blockId || !input.dataset.fieldId) return;

        const value = input.type === 'number' ? parseInt(input.value) : input.value;
        updateBlockConfig(input.dataset.blockId, input.dataset.fieldId, value);
    }

    function handleOutlineClick(e) {
        const item = e.target.closest('.outline-item');
        if (!item) return;

        const blockId = item.dataset.blockId;
        scrollToBlock(blockId);
    }

    function handleToolbarAction(e) {
        const action = e.currentTarget.dataset.toolbarAction;
        
        switch (action) {
            case 'new':
                newScript();
                break;
            case 'save':
                saveScript();
                break;
            case 'save-as':
                saveScriptAs();
                break;
            case 'save-run':
                saveAndRun();
                break;
            case 'generate-report':
                downloadDashboardReport();
                break;
            case 'expand-all':
                setAllCollapsed(false);
                break;
            case 'collapse-all':
                setAllCollapsed(true);
                break;
        }
    }

    // =========================================================================
    // Block Operations
    // =========================================================================

    function toggleSection(blockId) {
        const found = findBlockInTree(blockId);
        if (found && found.block.type === 'section') {
            found.block.collapsed = !found.block.collapsed;
            render();
        }
    }

    function toggleCodePreview(blockId) {
        const found = findBlockInTree(blockId);
        if (!found) return;

        found.block.codePreviewExpanded = !found.block.codePreviewExpanded;

        const codeEl = document.querySelector(`.canvas-block-code[data-block-id="${blockId}"]`);
        if (codeEl) {
            codeEl.classList.toggle('expanded', found.block.codePreviewExpanded);
        }
    }

    function copyCode(blockId, btn) {
        const found = findBlockInTree(blockId);
        if (!found) return;

        const def = BLOCK_DEFINITIONS[found.block.type];
        if (!def) return;

        const code = def.generateCode(found.block.config);
        navigator.clipboard.writeText(code);

        const originalHTML = btn.innerHTML;
        btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> Copié !';
        setTimeout(() => { btn.innerHTML = originalHTML; }, 1500);
    }

    function updateBlockConfig(blockId, fieldId, value) {
        const found = findBlockInTree(blockId);
        if (!found) return;

        found.block.config[fieldId] = value;
        if (found.block.type === 'lineplot' && fieldId === 'source') {
            const signalOptions = listSignalsForSource(value);
            if (!signalOptions.includes(found.block.config.signal)) {
                found.block.config.signal = signalOptions[0] || '';
            }
        }
        markModified();

        // Update code preview
        const def = BLOCK_DEFINITIONS[found.block.type];
        if (def && !def.hideCodePreview) {
            const codeEl = document.querySelector(`.canvas-block-code[data-block-id="${blockId}"] code`);
            if (codeEl) {
                codeEl.textContent = def.generateCode(found.block.config);
                if (typeof Prism !== 'undefined') {
                    Prism.highlightElement(codeEl);
                }
            }
        }

        // Update subtitle
        const subtitleEl = document.querySelector(`.canvas-block[data-block-id="${blockId}"] .canvas-block-subtitle`);
        if (subtitleEl) {
            subtitleEl.textContent = getBlockSubtitle(found.block);
        }

        // Update outline if section title/level changed
        if (found.block.type === 'section' && (fieldId === 'title' || fieldId === 'level')) {
            renderOutline();
            
            if (fieldId === 'level') {
                // Re-render to update visual hierarchy
                render();
            }
        }

        if (found.block.type === 'synthetic_source' && (fieldId === 'name' || fieldId === 'signals')) {
            flattenTree().forEach(block => applyDynamicDefaults(block.type, block.config));

            if (synthSourceRenderTimer) clearTimeout(synthSourceRenderTimer);
            synthSourceRenderTimer = setTimeout(() => {
                synthSourceRenderTimer = null;
                render();
                renderMappings();
            }, 400);
        }
    }

    function moveBlockUp(blockId) {
        const found = findBlockInTree(blockId);
        if (!found || found.index === 0) return;

        const temp = found.parent[found.index - 1];
        found.parent[found.index - 1] = found.block;
        found.parent[found.index] = temp;
        
        markModified();
        render();
    }

    function moveBlockDown(blockId) {
        const found = findBlockInTree(blockId);
        if (!found || found.index >= found.parent.length - 1) return;

        const temp = found.parent[found.index + 1];
        found.parent[found.index + 1] = found.block;
        found.parent[found.index] = temp;
        
        markModified();
        render();
    }

    function scrollToBlock(blockId) {
        const blockEl = document.querySelector(`.canvas-block[data-block-id="${blockId}"]`);
        if (!blockEl) return;

        // Expand parent sections if collapsed
        const found = findBlockInTree(blockId);
        if (found && found.block.type === 'section' && found.block.collapsed) {
            found.block.collapsed = false;
            render();
            // Re-query after render
            setTimeout(() => {
                const el = document.querySelector(`.canvas-block[data-block-id="${blockId}"]`);
                if (el) {
                    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    el.classList.add('highlighted');
                    setTimeout(() => el.classList.remove('highlighted'), 1500);
                }
            }, 50);
            return;
        }

        blockEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        blockEl.classList.add('highlighted');
        setTimeout(() => blockEl.classList.remove('highlighted'), 1500);

        // Update outline active state
        document.querySelectorAll('.outline-item').forEach(item => {
            item.classList.toggle('active', item.dataset.blockId === blockId);
        });
    }

    // =========================================================================
    // Drag & Drop
    // =========================================================================

    function setupDragAndDrop() {
        // Palette blocks
        document.querySelectorAll('.palette-block').forEach(block => {
            block.addEventListener('dragstart', handlePaletteDragStart);
            block.addEventListener('dragend', handleDragEnd);
        });

        // Canvas block headers
        document.querySelectorAll('.canvas-block-header[draggable="true"]').forEach(header => {
            header.addEventListener('dragstart', handleCanvasDragStart);
            header.addEventListener('dragend', handleDragEnd);
        });

        // Drop zones
        document.querySelectorAll('.canvas-drop-zone').forEach(zone => {
            zone.addEventListener('dragover', handleDragOver);
            zone.addEventListener('dragleave', handleDragLeave);
            zone.addEventListener('drop', handleDrop);
        });

        // Canvas empty state
        const canvasEmpty = document.getElementById('canvasEmpty');
        if (canvasEmpty) {
            canvasEmpty.addEventListener('dragover', handleDragOver);
            canvasEmpty.addEventListener('dragleave', handleDragLeave);
            canvasEmpty.addEventListener('drop', handleDrop);
        }
    }

    function handlePaletteDragStart(e) {
        const blockType = e.target.closest('.palette-block').dataset.blockType;
        dragState.type = 'palette';
        dragState.blockType = blockType;
        e.target.closest('.palette-block').classList.add('dragging');
        e.dataTransfer.effectAllowed = 'copy';
    }

    function handleCanvasDragStart(e) {
        const blockEl = e.target.closest('.canvas-block');
        const blockId = blockEl.dataset.blockId;
        
        dragState.type = 'canvas';
        dragState.blockId = blockId;
        
        blockEl.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', blockId);
    }

    function handleDragEnd(e) {
        document.querySelectorAll('.dragging').forEach(el => el.classList.remove('dragging'));
        document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
        
        dragState = { type: null, blockType: null, blockId: null, sourceParent: null };
    }

    function handleDragOver(e) {
        e.preventDefault();
        e.dataTransfer.dropEffect = dragState.type === 'canvas' ? 'move' : 'copy';
        e.currentTarget.classList.add('drag-over');
    }

    function handleDragLeave(e) {
        e.currentTarget.classList.remove('drag-over');
    }

    function handleDrop(e) {
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.classList.remove('drag-over');

        const zone = e.currentTarget;
        const depth = parseInt(zone.dataset.depth) || 0;
        const index = parseInt(zone.dataset.index) || 0;
        const parentId = zone.dataset.parentId;

        // Determine target parent array
        let targetParent = canvasBlocks;
        if (parentId) {
            const parentFound = findBlockInTree(parentId);
            if (parentFound && parentFound.block.children) {
                targetParent = parentFound.block.children;
            }
        } else if (depth > 0) {
            // Find parent at this depth by traversing the tree
            // For simplicity, we use the closest section ancestor
            const closestSection = zone.closest('.canvas-block.is-section');
            if (closestSection) {
                const sectionId = closestSection.dataset.blockId;
                const sectionFound = findBlockInTree(sectionId);
                if (sectionFound && sectionFound.block.children) {
                    targetParent = sectionFound.block.children;
                }
            }
        }

        if (dragState.type === 'palette') {
            // Create new block from palette
            const newBlock = createBlock(dragState.blockType);
            if (newBlock) {
                insertBlock(newBlock, { parent: targetParent, index: index });
            }
        } else if (dragState.type === 'canvas') {
            // Move existing block
            moveBlock(dragState.blockId, { parent: targetParent, index: index });
        }
    }

    function filterPalette(searchTerm) {
        const term = searchTerm.toLowerCase().trim();
        document.querySelectorAll('.palette-block').forEach(block => {
            const name = block.querySelector('.palette-block-name')?.textContent.toLowerCase() || '';
            const desc = block.querySelector('.palette-block-desc')?.textContent.toLowerCase() || '';
            block.style.display = (name.includes(term) || desc.includes(term) || !term) ? 'flex' : 'none';
        });
    }

    // =========================================================================
    // Script Management
    // =========================================================================

    function markModified() {
        isScriptModified = true;
        updateStatus('Modifié');
        scheduleLivePreviewRefresh();
    }

    function updateStatus(status) {
        const statusEl = document.getElementById('scriptStatus');
        if (statusEl) {
            statusEl.textContent = status;
            statusEl.className = 'script-status-indicator';
            if (status === 'Modifié') statusEl.classList.add('modified');
            else if (status === 'Sauvegardé' || status === 'Chargé') statusEl.classList.add('saved');
        }
    }

    function newScript() {
        if (isScriptModified && !confirm('Le script actuel a été modifié. Voulez-vous continuer sans sauvegarder ?')) {
            return;
        }

        currentScriptId = null;
        currentScriptReadonly = false;
        canvasBlocks = [];
        isScriptModified = false;
        
        const nameInput = document.getElementById('currentScriptName');
        if (nameInput) nameInput.value = 'Nouveau Script';
        
        updateStatus('Nouveau');
        render();
        refreshLivePreview();
    }

    function recipeBlock(block) {
        const config = { ...block.config };
        let type = block.type;

        if (type === 'code') type = 'python';
        if (type === 'section') {
            config.level = { H1: 1, H2: 2, H3: 3 }[config.level] || Number(config.level) || 1;
        }
        if (type === 'synthetic_source') {
            try {
                config.signals = JSON.parse(config.signals || '[]');
            } catch (error) {
                throw new Error('La configuration des signaux synthétiques doit être un JSON valide.');
            }
        }
        if (type === 'table') {
            config.source = config.source || config.data || 'df';
            delete config.data;
        }
        if (type === 'lineplot') {
            config.y = config.signal || config.y || '';
            config.x = config.x || 'time';
            delete config.signal;
        }
        if (type === 'python') {
            config.inputs = String(config.inputs || 'df').split(',').map(name => name.trim()).filter(Boolean);
        }
        return { id: block.id, type, config };
    }

    function buildRecipePayload() {
        const flatBlocks = flattenTree();
        flatBlocks.forEach(block => applyDynamicDefaults(block.type, block.config));
        const draftErrors = validateRecipeDraft(flatBlocks);
        if (draftErrors.length > 0) {
            throw new Error(draftErrors[0]);
        }

        return {
            id: currentScriptId || undefined,
            name: document.getElementById('currentScriptName')?.value || 'Nouveau Script',
            version: 1,
            settings: {
                title: document.getElementById('currentScriptName')?.value || 'Rapport',
                author: ''
            },
            blocks: flatBlocks.map(recipeBlock)
        };
    }

    /**
     * Sauvegarde la recette courante.
     * @param {{copyName?: string}} options - copyName force la creation d'un nouveau script.
     */
    async function saveScript(options = {}) {
        const nameInput = document.getElementById('currentScriptName');
        const copyName = options.copyName;

        let recipe;
        try {
            recipe = buildRecipePayload();
        } catch (error) {
            logToConsole(`Erreur de validation: ${error.message}`, 'error');
            return null;
        }

        if (currentScriptReadonly && !copyName) {
            // L'API refuse toute ecriture sur un script de demo : il faut passer par « Enregistrer sous ».
            logToConsole('Script de démo en lecture seule : utilisez « Enregistrer sous » pour le modifier.', 'warning');
            updateStatus('Lecture seule');
            return null;
        }

        if (copyName) {
            delete recipe.id;
            recipe.name = copyName;
            recipe.settings = { ...recipe.settings, title: copyName };
        }

        updateStatus('Sauvegarde...');
        try {
            const creating = !currentScriptId || Boolean(copyName);
            const method = creating ? 'POST' : 'PUT';
            const url = creating ? SCRIPTS_API : `${SCRIPTS_API}/${currentScriptId}`;
            const res = await authFetch(url, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(recipe)
            });
            const data = await res.json();
            if (!res.ok || data.error) throw new Error(data.error || 'Impossible de sauvegarder le script.');
            currentScriptId = data.id || currentScriptId;
            if (copyName) {
                currentScriptReadonly = false;
                if (nameInput) nameInput.value = copyName;
            }
            isScriptModified = false;
            updateStatus('Sauvegardé');
            logToConsole(`Script "${recipe.name}" sauvegardé.`, 'success');
            await loadScriptsList();
            return data;
        } catch (error) {
            updateStatus('Erreur');
            logToConsole(`Erreur de sauvegarde: ${error.message}`, 'error');
            return null;
        }
    }

    /** Cree une copie personnelle modifiable de la recette courante. */
    async function saveScriptAs() {
        const nameInput = document.getElementById('currentScriptName');
        const currentName = nameInput ? nameInput.value : 'Sans nom';
        const proposed = window.prompt('Nom de la copie', `${currentName} (copie)`);
        if (proposed === null) return null;
        const copyName = proposed.trim();
        if (!copyName) {
            logToConsole('Nom de copie vide : enregistrement annulé.', 'warning');
            return null;
        }
        return saveScript({ copyName });
    }

    /**
     * Retourne l'id du script a executer, en ne sauvegardant que si c'est necessaire.
     * Un script de demo non modifie est deja persiste cote serveur : inutile d'en creer une copie.
     */
    async function ensurePersistedScriptId() {
        if (currentScriptId && currentScriptReadonly) {
            if (isScriptModified) {
                logToConsole(
                    'Les modifications locales ne sont pas exécutées : enregistrez d\'abord une copie '
                    + 'via « Enregistrer sous ».',
                    'warning'
                );
            }
            return currentScriptId;
        }
        const saved = await saveScript();
        return saved && currentScriptId ? currentScriptId : null;
    }

    async function saveAndRun() {
        const scriptId = await ensurePersistedScriptId();
        if (!scriptId) return;
        switchPanel('execution');
        await runScript(scriptId);
    }

    function scheduleLivePreviewRefresh() {
        if (livePreviewTimer) {
            clearTimeout(livePreviewTimer);
        }
        livePreviewTimer = setTimeout(refreshLivePreview, 1000);
    }

    function showLivePreviewCode(source) {
        const codeEl = document.getElementById('editionCodePanelCode');
        if (codeEl) {
            codeEl.textContent = source;
            if (typeof Prism !== 'undefined') {
                Prism.highlightElement(codeEl);
            }
        }
        const errorEl = document.getElementById('editionCodePanelError');
        if (errorEl) {
            errorEl.hidden = true;
            errorEl.textContent = '';
        }
    }

    function showLivePreviewError(message) {
        const errorEl = document.getElementById('editionCodePanelError');
        if (errorEl) {
            errorEl.hidden = false;
            errorEl.textContent = message;
        }
        // Le dernier code valide reste affiché : le <pre>/<code> n'est jamais vidé ici.
    }

    async function refreshLivePreview() {
        let recipe;
        try {
            recipe = buildRecipePayload();
        } catch (error) {
            showLivePreviewError(error.message);
            return;
        }

        if (livePreviewAbortController) {
            livePreviewAbortController.abort();
        }
        const controller = new AbortController();
        livePreviewAbortController = controller;

        try {
            const res = await authFetch(`${SCRIPTS_API}/compile-preview`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(recipe),
                signal: controller.signal
            });
            const data = await res.json();
            if (!res.ok || !data.success) {
                const firstError = data.errors?.[0];
                showLivePreviewError(firstError?.message || data.error || 'Compilation refusée.');
                return;
            }
            showLivePreviewCode(data.source);
        } catch (error) {
            if (error.name === 'AbortError') return;
            showLivePreviewError(error.message);
        }
    }

    /**
     * Compile, execute et telecharge le rapport HTML autonome d'un script deja persiste.
     * @param {string} scriptId - Identifiant du script.
     * @param {string} scriptName - Nom affiche, utilise pour le nom de fichier.
     */
    async function downloadReport(scriptId, scriptName) {
        logToConsole('Génération du rapport HTML autonome...', 'info');
        try {
            const res = await authFetch(`${SCRIPTS_API}/${scriptId}/report`, { method: 'POST' });
            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.error || 'Export refusé.');
            }
            const blob = await res.blob();
            const objectUrl = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = objectUrl;
            link.download = `${(scriptName || 'rapport').replace(/[^\w-]+/g, '_')}.html`;
            link.click();
            URL.revokeObjectURL(objectUrl);
            logToConsole('Rapport HTML téléchargé.', 'success');
        } catch (error) {
            logToConsole(`Erreur d'export: ${error.message}`, 'error');
        }
    }

    async function downloadDashboardReport() {
        const scriptId = await ensurePersistedScriptId();
        if (!scriptId) return;
        await downloadReport(scriptId, document.getElementById('currentScriptName')?.value);
    }

    // =========================================================================
    // Mapping (kept from original)
    // =========================================================================

    function addMappingVariable() {
        signalMappings.push({
            id: 'mapping_' + (++mappingIdCounter),
            name: 'NewVariable',
            aliases: [''],
            expanded: true
        });
        renderMappings();
    }

    function renderMappings() {
        const emptyState = document.getElementById('mappingEmpty');
        const itemsContainer = document.getElementById('mappingItems');
        const countEl = document.getElementById('mappingCount');
        
        if (!emptyState || !itemsContainer) return;
        const sourceMappings = flattenTree()
            .filter(block => block.type === 'synthetic_source')
            .map(block => ({
                id: block.id,
                name: block.config.name || '',
                source: 'synthetic_source',
                schema: parseSignals(block.config.signals)
            }));
        if (countEl) countEl.textContent = `${sourceMappings.length} variable(s)`;
        
        if (sourceMappings.length === 0) {
            emptyState.style.display = 'flex';
            itemsContainer.style.display = 'none';
            return;
        }
        
        emptyState.style.display = 'none';
        itemsContainer.style.display = 'block';
        itemsContainer.innerHTML = sourceMappings.map(mapping => `
            <div class="mapping-item" data-block-id="${escapeHtml(mapping.id)}">
                <div class="mapping-item-main">
                    <strong>${escapeHtml(mapping.name || 'Variable non configurée')}</strong>
                    <span>Source synthétique · ${mapping.schema.length} signal(s)</span>
                </div>
                <button type="button" class="mapping-item-action" data-mapping-block-id="${escapeHtml(mapping.id)}">Éditer</button>
            </div>
        `).join('');
    }

    function parseSignals(value) {
        try {
            const parsed = JSON.parse(value || '[]');
            return Array.isArray(parsed) ? parsed : [];
        } catch (error) {
            return [];
        }
    }

    function parsePythonInputs(value) {
        return String(value || '')
            .split(',')
            .map(name => name.trim())
            .filter(Boolean);
    }

    function restrictPaletteToPoc() {
        const allowed = new Set([
            'title', 'synthetic_source', 'section', 'text', 'callout',
            'metrics', 'table', 'lineplot', 'python'
        ]);
        document.querySelectorAll('.palette-block').forEach(block => {
            block.hidden = !allowed.has(block.dataset.blockType);
        });
    }

    // =========================================================================
    // Initialization
    // =========================================================================

    // Splitter vertical entre le canvas et le panneau de code genere.
    const CODE_PANEL_WIDTH_KEY = 'bb.dashboard.codePanelWidth';
    const CODE_PANEL_MIN_WIDTH = 220;

    function applyCodePanelWidth(width) {
        const panel = document.getElementById('editionCodePanel');
        if (panel) panel.style.setProperty('--code-panel-width', `${Math.round(width)}px`);
    }

    function setupCodeSplitter() {
        const splitter = document.getElementById('editionCodeSplitter');
        const split = document.getElementById('editionCanvasSplit');
        if (!splitter || !split) return;

        const saved = parseInt(localStorage.getItem(CODE_PANEL_WIDTH_KEY), 10);
        if (!Number.isNaN(saved)) applyCodePanelWidth(saved);

        splitter.addEventListener('mousedown', (e) => {
            // En layout empile (petits ecrans) le splitter n'est pas redimensionnable.
            if (window.getComputedStyle(split).flexDirection !== 'row') return;
            e.preventDefault();
            splitter.classList.add('dragging');
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';

            const onMove = (moveEvent) => {
                const rect = split.getBoundingClientRect();
                const maxWidth = Math.max(CODE_PANEL_MIN_WIDTH, rect.width * 0.7);
                const width = Math.min(maxWidth, Math.max(CODE_PANEL_MIN_WIDTH, rect.right - moveEvent.clientX));
                applyCodePanelWidth(width);
            };

            const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                splitter.classList.remove('dragging');
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
                const panel = document.getElementById('editionCodePanel');
                if (panel) localStorage.setItem(CODE_PANEL_WIDTH_KEY, String(panel.getBoundingClientRect().width));
            };

            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });

        splitter.addEventListener('dblclick', () => {
            localStorage.removeItem(CODE_PANEL_WIDTH_KEY);
            const panel = document.getElementById('editionCodePanel');
            if (panel) panel.style.removeProperty('--code-panel-width');
        });
    }

    function init() {
        const canvas = document.getElementById('editionCanvas');
        if (!canvas) {
            console.log('Dashboard V2: Vue pas encore chargée');
            return;
        }

        if (initialized) {
            console.log('Dashboard V2: Déjà initialisé, rechargement');
            loadScriptsList();
            return;
        }

        console.log('Dashboard V2: Initialisation...');
        
        setupEventListeners();
        setupDragAndDrop();
        setupCodeSplitter();
        restrictPaletteToPoc();
        loadScriptsList();
        renderMappings();
        
        initialized = true;
        console.log('Dashboard V2: Initialisation terminée');
    }

    // =========================================================================
    // Public API
    // =========================================================================

    return {
        init,
        switchPanel,
        clearConsole,
        newScript,
        saveScript,
        saveScriptAs,
        downloadDashboardReport,
        setAllCollapsed,
        addMappingVariable
    };

})();

// Global function aliases for HTML onclick handlers
function switchDashboardPanel(panel) { DashboardEditor.switchPanel(panel); }
function clearConsole() { DashboardEditor.clearConsole(); }
function newScript() { DashboardEditor.newScript(); }
function saveScript() { DashboardEditor.saveScript(); }
function downloadDashboardReport() { DashboardEditor.downloadDashboardReport(); }
function expandAllSections() { DashboardEditor.setAllCollapsed(false); }
function collapseAllSections() { DashboardEditor.setAllCollapsed(true); }
function addMappingVariable() { DashboardEditor.addMappingVariable(); }
function initDashboard() { DashboardEditor.init(); }
// =========================================================================
// Expose globals for other modules (Vite compatibility)
// =========================================================================
window.DashboardEditor = DashboardEditor;
window.initDashboard = initDashboard;
window.switchDashboardPanel = switchDashboardPanel;
window.clearConsole = clearConsole;
window.newScript = newScript;
window.saveScript = saveScript;
window.downloadDashboardReport = downloadDashboardReport;
window.expandAllSections = expandAllSections;
window.collapseAllSections = collapseAllSections;
window.addMappingVariable = addMappingVariable;
