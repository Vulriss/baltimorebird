/**
 * Storage Module - User storage management in settings
 */
const StorageManager = (() => {
    const state = {
        currentCategory: 'mf4',
        files: [],
        info: null,
        selectedFile: null,
        fileToDelete: null,
        showDefaultFiles: false,
        initialized: false
    };

    const CATEGORIES = Object.freeze({
        mf4: { name: 'Fichiers MF4', extensions: '.mf4, .mdf, .dat', accept: '.mf4,.mdf,.dat' },
        dbc: { name: 'Fichiers DBC', extensions: '.dbc', accept: '.dbc' },
        layouts: { name: 'Layouts', extensions: '.json', accept: '.json' },
        mappings: { name: 'Mappings', extensions: '.json', accept: '.json' },
        analyses: { name: 'Analyses', extensions: '.json, .py', accept: '.json,.py' }
    });

    const $ = (id) => document.getElementById(id);
    const setText = (id, text) => { const el = $(id); if (el) el.textContent = text; };
    const setHTML = (id, html) => { const el = $(id); if (el) el.innerHTML = html; };
    const setDisplay = (id, show) => { const el = $(id); if (el) el.style.display = show ? '' : 'none'; };

    async function api(endpoint, options = {}) {
        const token = sessionStorage.getItem('auth_token');
        const headers = { ...options.headers };
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const response = await fetch(endpoint, { ...options, headers });
        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.error || `HTTP ${response.status}`);
        }
        return response;
    }

    async function loadInfo() {
        try {
            const res = await api('/api/storage/info');
            state.info = await res.json();
            renderQuota();
            renderTabCounts();
        } catch (error) {
            console.error('Error loading storage info:', error);
        }
    }

    async function loadFiles() {
        const listEl = $('storageFilesList');
        if (!listEl) return;

        listEl.innerHTML = '<div class="storage-loading">Chargement...</div>';

        try {
            const includeDefault = state.showDefaultFiles ? 'true' : 'false';
            const res = await api(`/api/storage/files?category=${state.currentCategory}&include_default=${includeDefault}`);
            state.files = (await res.json()).files;
            renderFiles();
        } catch (error) {
            console.error('Error loading files:', error);
            listEl.innerHTML = '<div class="storage-empty">Erreur de chargement</div>';
        }
    }

    function refresh() {
        loadInfo();
        loadFiles();
    }

    function renderQuota() {
        const info = state.info;
        if (!info) return;

        setText('storageUsed', info.used_human);
        setText('storageTotal', info.quota_human);
        setText('storagePercent', info.usage_percent + '%');

        const barFill = $('storageBarFill');
        if (barFill) {
            barFill.style.width = info.usage_percent + '%';
            barFill.classList.toggle('critical', info.usage_percent > 90);
            barFill.classList.toggle('warning', info.usage_percent > 75 && info.usage_percent <= 90);
        }

        if (info.by_category) {
            const detailsHTML = Object.entries(info.by_category)
                .map(([cat, catInfo]) => `
                    <div class="storage-quota-category">
                        <span class="storage-quota-category-name">${CATEGORIES[cat]?.name || cat}</span>
                        <span class="storage-quota-category-value">${catInfo.used_human} (${catInfo.count})</span>
                    </div>
                `).join('');
            setHTML('storageDetails', detailsHTML);
        }
    }

    function renderTabCounts() {
        const byCategory = state.info?.by_category;
        if (!byCategory) return;
        Object.entries(byCategory).forEach(([cat, info]) => setText(`count-${cat}`, info.count));
    }

    function renderFiles() {
        const listEl = $('storageFilesList');
        if (!listEl) return;

        if (!state.files?.length) {
            listEl.innerHTML = `
                <div class="storage-empty">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                    </svg>
                    <p>Aucun fichier dans cette catégorie</p>
                </div>
            `;
            return;
        }

        const defaultFiles = state.files.filter(f => f.is_default);
        const userFiles = state.files.filter(f => !f.is_default);
        let html = '';

        if (userFiles.length > 0) {
            html += `
                <div class="storage-files-group">
                    <div class="storage-files-group-title">Mes fichiers</div>
                    ${userFiles.map(renderFileItem).join('')}
                </div>
            `;
        }

        if (defaultFiles.length > 0 && state.showDefaultFiles) {
            html += `
                <div class="storage-files-group">
                    <div class="storage-files-group-title">Fichiers de démonstration</div>
                    ${defaultFiles.map(renderFileItem).join('')}
                </div>
            `;
        }

        listEl.innerHTML = html;
    }

    function renderFileItem(file) {
        const dateStr = new Date(file.uploaded_at).toLocaleDateString('fr-FR', {
            day: '2-digit', month: 'short', year: 'numeric'
        });

        const deleteBtn = file.is_default ? '' : `
            <button class="storage-file-btn danger"
                    data-action="promptDelete"
                    data-file-id="${file.id}"
                    data-filename="${file.filename.replace(/"/g, '&quot;')}"
                    title="Supprimer">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="3 6 5 6 21 6"/>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                </svg>
            </button>
        `;

        return `
            <div class="storage-file-item ${file.is_default ? 'default' : ''}" data-file-id="${file.id}">
                <div class="storage-file-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                        <polyline points="14 2 14 8 20 8"/>
                    </svg>
                    ${file.is_default ? '<span class="storage-file-badge">DEMO</span>' : ''}
                </div>
                <div class="storage-file-info">
                    <div class="storage-file-name" title="${file.filename}">${file.filename}</div>
                    <div class="storage-file-meta">
                        <span class="storage-file-size">${file.size_human}</span>
                        <span class="storage-file-date">${dateStr}</span>
                        ${file.description ? `<span class="storage-file-desc" title="${file.description}">${file.description}</span>` : ''}
                    </div>
                </div>
                <div class="storage-file-actions">
                    <button class="storage-file-btn"
                            data-action="download"
                            data-file-id="${file.id}"
                            data-is-default="${file.is_default}"
                            title="Télécharger">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                            <polyline points="7 10 12 15 17 10"/>
                            <line x1="12" y1="15" x2="12" y2="3"/>
                        </svg>
                    </button>
                    ${deleteBtn}
                </div>
            </div>
        `;
    }

    function switchCategory(category, element) {
        state.currentCategory = category;
        const config = CATEGORIES[category];

        document.querySelectorAll('.storage-tab').forEach(tab => tab.classList.remove('active'));
        element?.classList.add('active');

        setText('storageCategoryTitle', config?.name || category);
        setText('storageUploadHint', `Extensions: ${config?.extensions || ''}`);

        const fileInput = $('storageFileInput');
        if (fileInput) fileInput.accept = config?.accept || '';

        loadFiles();
    }

    function toggleDefaultFiles() {
        state.showDefaultFiles = $('showDefaultFiles')?.checked ?? false;
        loadFiles();
    }

    function openUploadModal() {
        const modal = $('storageUploadModal');
        if (!modal) return;

        modal.classList.add('active');
        const config = CATEGORIES[state.currentCategory];
        setText('storageUploadHint', `Extensions: ${config?.extensions || ''}`);

        const fileInput = $('storageFileInput');
        if (fileInput) fileInput.accept = config?.accept || '';
    }

    function closeUploadModal() {
        $('storageUploadModal')?.classList.remove('active');
        resetUploadModal();
    }

    function resetUploadModal() {
        state.selectedFile = null;
        const fileInput = $('storageFileInput');
        if (fileInput) fileInput.value = '';

        setDisplay('storageUploadZone', true);
        setDisplay('storageUploadSelected', false);
        setDisplay('storageUploadProgress', false);

        const uploadBtn = $('storageUploadBtn');
        if (uploadBtn) uploadBtn.disabled = true;

        const descInput = $('storageUploadDescription');
        if (descInput) descInput.value = '';
    }

    function handleFileSelection(file) {
        state.selectedFile = file;
        setDisplay('storageUploadZone', false);
        setDisplay('storageUploadSelected', true);
        setText('storageUploadFilename', file.name);
        setText('storageUploadFilesize', formatFileSize(file.size));

        const uploadBtn = $('storageUploadBtn');
        if (uploadBtn) uploadBtn.disabled = false;
    }

    function removeSelectedFile() {
        state.selectedFile = null;
        const fileInput = $('storageFileInput');
        if (fileInput) fileInput.value = '';

        setDisplay('storageUploadZone', true);
        setDisplay('storageUploadSelected', false);

        const uploadBtn = $('storageUploadBtn');
        if (uploadBtn) uploadBtn.disabled = true;
    }

    async function upload() {
        if (!state.selectedFile) return;

        const progressFill = $('storageUploadProgressFill');
        const progressText = $('storageUploadProgressText');
        const uploadBtn = $('storageUploadBtn');
        const description = $('storageUploadDescription')?.value || '';

        setDisplay('storageUploadProgress', true);
        if (uploadBtn) uploadBtn.disabled = true;

        const formData = new FormData();
        formData.append('file', state.selectedFile);
        formData.append('description', description);

        const xhr = new XMLHttpRequest();

        xhr.upload.addEventListener('progress', (e) => {
            if (!e.lengthComputable) return;
            const percent = Math.round((e.loaded / e.total) * 100);
            if (progressFill) progressFill.style.width = percent + '%';
            if (progressText) progressText.textContent = percent + '%';
        });

        xhr.addEventListener('load', () => {
            if (xhr.status === 201) {
                showNotification('Fichier uploadé avec succès', 'success');
                closeUploadModal();
                refresh();
            } else {
                const err = JSON.parse(xhr.responseText || '{}');
                showNotification(err.error || 'Upload échoué', 'error');
                if (uploadBtn) uploadBtn.disabled = false;
                setDisplay('storageUploadProgress', false);
            }
        });

        xhr.addEventListener('error', () => {
            showNotification('Erreur réseau', 'error');
            if (uploadBtn) uploadBtn.disabled = false;
            setDisplay('storageUploadProgress', false);
        });

        const token = sessionStorage.getItem('auth_token');
        xhr.open('POST', `/api/storage/files/${state.currentCategory}`);
        if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
        xhr.send(formData);
    }

    async function download(fileId, isDefault) {
        const endpoint = isDefault
            ? `/api/storage/default/${fileId}/download`
            : `/api/storage/files/${fileId}/download`;

        const token = sessionStorage.getItem('auth_token');
        if (isDefault || !token) {
            window.open(endpoint, '_blank');
            return;
        }

        try {
            const res = await fetch(endpoint, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (!res.ok) throw new Error('Download failed');

            const blob = await res.blob();
            const contentDisposition = res.headers.get('Content-Disposition');
            const filenameMatch = contentDisposition?.match(/filename="?([^"]+)"?/);
            const filename = filenameMatch?.[1] || 'download';

            const blobUrl = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = blobUrl;
            link.download = filename;
            link.click();
            URL.revokeObjectURL(blobUrl);
        } catch (error) {
            console.error('Download error:', error);
            showNotification('Erreur lors du téléchargement', 'error');
        }
    }

    function promptDelete(fileId, filename) {
        state.fileToDelete = fileId;
        setText('storageDeleteFilename', filename);
        $('storageDeleteModal')?.classList.add('active');
    }

    function closeDeleteModal() {
        $('storageDeleteModal')?.classList.remove('active');
        state.fileToDelete = null;
    }

    async function confirmDelete() {
        if (!state.fileToDelete) return;

        try {
            await api(`/api/storage/files/${state.fileToDelete}`, { method: 'DELETE' });
            showNotification('Fichier supprimé', 'success');
            closeDeleteModal();
            refresh();
        } catch (error) {
            console.error('Delete error:', error);
            showNotification(error.message || 'Erreur lors de la suppression', 'error');
        }
    }

    function setupDropZone() {
        const dropZone = $('storageUploadZone');
        if (!dropZone) return;

        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropZone.classList.add('dragover');
        });

        dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));

        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropZone.classList.remove('dragover');
            const file = e.dataTransfer.files[0];
            if (file) handleFileSelection(file);
        });
    }

    function setupEventListeners() {
        const storageSection = $('settings-storage');
        if (!storageSection) return;

        // Single delegated click listener for the storage section
        storageSection.addEventListener('click', (e) => {
            const target = e.target.closest('[data-action]');
            if (!target) return;

            e.preventDefault();
            const { action, category, fileId, filename, isDefault } = target.dataset;

            switch (action) {
                case 'switchCategory': switchCategory(category, target); break;
                case 'refresh': refresh(); break;
                case 'openUpload': openUploadModal(); break;
                case 'download': download(fileId, isDefault === 'true'); break;
                case 'promptDelete': promptDelete(fileId, filename); break;
            }
        });

        // Upload modal events
        const uploadModal = $('storageUploadModal');
        if (uploadModal) {
            uploadModal.addEventListener('click', (e) => {
                const target = e.target.closest('[data-action]');
                if (!target) {
                    // Click on backdrop closes modal
                    if (e.target === uploadModal) closeUploadModal();
                    return;
                }

                e.preventDefault();
                switch (target.dataset.action) {
                    case 'closeUpload': closeUploadModal(); break;
                    case 'browseFile': $('storageFileInput')?.click(); break;
                    case 'removeSelected': removeSelectedFile(); break;
                    case 'upload': upload(); break;
                }
            });
        }

        // Delete modal events
        const deleteModal = $('storageDeleteModal');
        if (deleteModal) {
            deleteModal.addEventListener('click', (e) => {
                const target = e.target.closest('[data-action]');
                if (!target) {
                    if (e.target === deleteModal) closeDeleteModal();
                    return;
                }

                e.preventDefault();
                switch (target.dataset.action) {
                    case 'closeDelete': closeDeleteModal(); break;
                    case 'confirmDelete': confirmDelete(); break;
                }
            });
        }

        // Checkbox change event
        const showDefaultCheckbox = $('showDefaultFiles');
        if (showDefaultCheckbox) {
            showDefaultCheckbox.addEventListener('change', toggleDefaultFiles);
        }

        // File input change event
        const fileInput = $('storageFileInput');
        if (fileInput) {
            fileInput.addEventListener('change', () => {
                const file = fileInput.files[0];
                if (file) handleFileSelection(file);
            });
        }

        // Escape key closes modals
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            closeUploadModal();
            closeDeleteModal();
        });
    }

    async function init() {
        if (!state.initialized) {
            setupEventListeners();
            setupDropZone();
            state.initialized = true;
        }
        await loadInfo();
        await loadFiles();
    }

    return Object.freeze({ init, refresh });
})();

// Global alias for settings.js integration
const initStorage = () => StorageManager.init();
// =========================================================================
// Expose globals for other modules (Vite compatibility)
// =========================================================================
window.StorageManager = StorageManager;
window.initStorage = initStorage;
