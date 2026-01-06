/**
 * Reports Module - Reports management
 */
const ReportsManager = (() => {
    const API = '/api/reports';

    const state = {
        reports: [],
        currentId: null,
        pendingDeleteId: null,
        pendingDeleteName: null,
        autoRefreshInterval: null
    };

    const $ = (id) => document.getElementById(id);

    function formatDate(timestamp) {
        const date = new Date(timestamp * 1000);
        const now = new Date();
        const diff = now - date;

        if (diff < 60000) return 'À l\'instant';
        if (diff < 3600000) return `Il y a ${Math.floor(diff / 60000)} min`;
        if (diff < 86400000) return `Il y a ${Math.floor(diff / 3600000)}h`;
        if (diff < 604800000) return `Il y a ${Math.floor(diff / 86400000)}j`;

        return date.toLocaleDateString('fr-FR', {
            day: 'numeric',
            month: 'short',
            year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined
        });
    }

    async function loadList() {
        const listContainer = $('reportsList');
        const countEl = $('reportsCount');

        if (state.reports.length === 0) {
            listContainer.innerHTML = '<div class="reports-loading">Chargement...</div>';
        }

        try {
            const res = await fetch(API);
            const data = await res.json();
            const newReports = data.reports || [];

            countEl.textContent = `${newReports.length} rapport(s)`;

            const hasChanged = JSON.stringify(newReports.map(r => r.id)) !== 
                              JSON.stringify(state.reports.map(r => r.id));

            if (hasChanged || state.reports.length === 0) {
                state.reports = newReports;

                if (state.reports.length === 0) {
                    listContainer.innerHTML = `
                        <div class="reports-empty-list">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                                <polyline points="14 2 14 8 20 8"/>
                            </svg>
                            <p>Aucun rapport disponible</p>
                            <p style="margin-top: 8px; color: #444;">Les rapports générés depuis le Dashboard apparaîtront ici</p>
                        </div>
                    `;

                    if (state.currentId) {
                        state.currentId = null;
                        $('reportsEmpty').style.display = 'flex';
                        $('reportsViewer').style.display = 'none';
                    }
                    return;
                }

                renderList();

                if (state.currentId && !state.reports.find(r => r.id === state.currentId)) {
                    state.currentId = null;
                    $('reportsEmpty').style.display = 'flex';
                    $('reportsViewer').style.display = 'none';
                }
            }
        } catch (e) {
            console.error('Failed to load reports:', e);
            if (state.reports.length === 0) {
                listContainer.innerHTML = `
                    <div class="reports-empty-list">
                        <p style="color: #ff6666;">Erreur de chargement</p>
                        <p style="margin-top: 8px;">${e.message}</p>
                    </div>
                `;
            }
        }
    }

    function renderList() {
        const listContainer = $('reportsList');

        listContainer.innerHTML = state.reports.map(report => `
            <div class="report-item ${report.id === state.currentId ? 'active' : ''}"
                 data-report-id="${report.id}"
                 data-action="select">
                <button class="report-item-delete"
                        data-action="confirmDelete"
                        data-report-id="${report.id}"
                        data-report-name="${report.name.replace(/"/g, '&quot;')}"
                        title="Supprimer">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="3 6 5 6 21 6"/>
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                    </svg>
                </button>
                <div class="report-item-header">
                    <div class="report-item-icon">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                            <polyline points="14 2 14 8 20 8"/>
                            <line x1="16" y1="13" x2="8" y2="13"/>
                            <line x1="16" y1="17" x2="8" y2="17"/>
                        </svg>
                    </div>
                    <div class="report-item-info">
                        <div class="report-item-name" title="${report.name}">${report.name}</div>
                        <div class="report-item-meta">
                            <span>
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <circle cx="12" cy="12" r="10"/>
                                    <path d="M12 6v6l4 2"/>
                                </svg>
                                ${formatDate(report.created)}
                            </span>
                            <span>
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                                </svg>
                                ${report.size_kb} KB
                            </span>
                        </div>
                    </div>
                </div>
            </div>
        `).join('');
    }

    function select(reportId) {
        state.currentId = reportId;

        document.querySelectorAll('.report-item').forEach(item => {
            item.classList.toggle('active', item.dataset.reportId === reportId);
        });

        const report = state.reports.find(r => r.id === reportId);
        if (!report) return;

        $('reportsEmpty').style.display = 'none';
        $('reportsViewer').style.display = 'flex';
        $('viewerReportName').textContent = report.name;

        const deleteBtn = document.querySelector('.reports-viewer-actions .reports-action-btn.danger');
        if (deleteBtn) {
            const isDemo = report.name === 'demo' || report.filename === 'demo.html';
            deleteBtn.disabled = isDemo;
            deleteBtn.title = isDemo ? 'Impossible de supprimer le rapport de démonstration' : 'Supprimer';
        }

        $('reportFrame').src = `${API}/${reportId}`;
    }

    function filter(searchTerm) {
        const term = searchTerm.toLowerCase().trim();

        if (!term) {
            renderList();
            return;
        }

        const filtered = state.reports.filter(report =>
            report.name.toLowerCase().includes(term) ||
            report.filename.toLowerCase().includes(term)
        );

        const listContainer = $('reportsList');
        listContainer.innerHTML = filtered.map(report => `
            <div class="report-item ${report.id === state.currentId ? 'active' : ''}"
                 data-report-id="${report.id}"
                 data-action="select">
                <button class="report-item-delete"
                        data-action="confirmDelete"
                        data-report-id="${report.id}"
                        data-report-name="${report.name.replace(/"/g, '&quot;')}"
                        title="Supprimer">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="3 6 5 6 21 6"/>
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                    </svg>
                </button>
                <div class="report-item-header">
                    <div class="report-item-icon">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                            <polyline points="14 2 14 8 20 8"/>
                            <line x1="16" y1="13" x2="8" y2="13"/>
                            <line x1="16" y1="17" x2="8" y2="17"/>
                        </svg>
                    </div>
                    <div class="report-item-info">
                        <div class="report-item-name" title="${report.name}">${report.name}</div>
                        <div class="report-item-meta">
                            <span>
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <circle cx="12" cy="12" r="10"/>
                                    <path d="M12 6v6l4 2"/>
                                </svg>
                                ${formatDate(report.created)}
                            </span>
                            <span>
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                                </svg>
                                ${report.size_kb} KB
                            </span>
                        </div>
                    </div>
                </div>
            </div>
        `).join('');
    }

    function openNewTab() {
        if (!state.currentId) return;
        window.open(`${API}/${state.currentId}`, '_blank');
    }

    function download() {
        if (!state.currentId) return;
        window.open(`${API}/${state.currentId}/download`, '_blank');
    }

    function confirmDelete(reportId, reportName) {
        state.pendingDeleteId = reportId;
        state.pendingDeleteName = reportName;
        $('deleteReportName').textContent = reportName;
        $('reportsDeleteModal').classList.add('show');
    }

    function cancelDelete() {
        state.pendingDeleteId = null;
        state.pendingDeleteName = null;
        $('reportsDeleteModal').classList.remove('show');
    }

    async function executeDelete() {
        if (!state.pendingDeleteId) return;

        const reportId = state.pendingDeleteId;
        cancelDelete();

        try {
            const res = await fetch(`${API}/${reportId}`, { method: 'DELETE' });

            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error || 'Suppression échouée');
            }

            await loadList();
        } catch (e) {
            console.error('Failed to delete report:', e);
            alert(`Erreur: ${e.message}`);
        }
    }

    function deleteCurrent() {
        if (!state.currentId) return;
        const report = state.reports.find(r => r.id === state.currentId);
        if (report) confirmDelete(state.currentId, report.name);
    }

    function startAutoRefresh() {
        stopAutoRefresh();
        state.autoRefreshInterval = setInterval(loadList, 5000);
    }

    function stopAutoRefresh() {
        if (state.autoRefreshInterval) {
            clearInterval(state.autoRefreshInterval);
            state.autoRefreshInterval = null;
        }
    }

    function setupEventListeners() {
        const reportsView = $('view-reports');
        if (!reportsView) return;

        reportsView.addEventListener('click', (e) => {
            const target = e.target.closest('[data-action]');
            if (!target) return;

            e.preventDefault();
            e.stopPropagation();

            const { action, reportId, reportName } = target.dataset;

            switch (action) {
                case 'select': select(reportId); break;
                case 'confirmDelete': confirmDelete(reportId, reportName); break;
                case 'cancelDelete': cancelDelete(); break;
                case 'executeDelete': executeDelete(); break;
                case 'openNewTab': openNewTab(); break;
                case 'download': download(); break;
                case 'deleteCurrent': deleteCurrent(); break;
            }
        });

        const searchInput = reportsView.querySelector('.reports-search input');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => filter(e.target.value));
        }
    }

    function init() {
        setupEventListeners();
        loadList();
        startAutoRefresh();
    }

    function cleanup() {
        stopAutoRefresh();
    }

    return Object.freeze({ init, cleanup });
})();

const initReportsView = () => ReportsManager.init();
const cleanupReportsView = () => ReportsManager.cleanup();
// =========================================================================
// Expose globals for other modules (Vite compatibility)
// =========================================================================
window.ReportsManager = ReportsManager;
window.initReportsView = initReportsView;
window.cleanupReportsView = cleanupReportsView;
