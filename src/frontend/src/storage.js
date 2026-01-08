/**
 * Storage Module - User storage management in settings
 * Security: All user data is escaped to prevent XSS
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

    // Allowed API endpoints (whitelist)
    const ALLOWED_ENDPOINTS = [
        '/api/storage/info',
        '/api/storage/files',
        '/api/storage/default'
    ];

    const $ = (id) => document.getElementById(id);
    const setText = (id, text) => { const el = $(id); if (el) el.textContent = text; };
    const setDisplay = (id, show) => { const el = $(id); if (el) el.style.display = show ? '' : 'none'; };

    /**
     * Escape HTML to prevent XSS
     */
    function escapeHtml(str) {
        if (typeof str !== 'string') return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    /**
     * Escape attribute value
     */
    function escapeAttr(str) {
        if (typeof str !== 'string') return '';
        return str.replace(/&/g, '&amp;')
                  .replace(/"/g, '&quot;')
                  .replace(/'/g, '&#39;')
                  .replace(/</g, '&lt;')
                  .replace(/>/g, '&gt;');
    }

    /**
     * Validate endpoint against whitelist
     */
    function isValidEndpoint(endpoint) {
        return ALLOWED_ENDPOINTS.some(allowed => endpoint.startsWith(allowed));
    }

    /**
     * Safe API call with endpoint validation
     */
    async function api(endpoint, options = {}) {
        // Validate endpoint
        if (!isValidEndpoint(endpoint)) {
            throw new Error('Invalid API endpoint');
        }

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

        // Safe: static content only
        listEl.textContent = '';
        const loadingDiv = document.createElement('div');
        loadingDiv.className = 'storage-loading';
        loadingDiv.textContent = 'Chargement...';
        listEl.appendChild(loadingDiv);

        try {
            // Validate category against whitelist
            if (!CATEGORIES[state.currentCategory]) {
                throw new Error('Invalid category');
            }
            const includeDefault = state.showDefaultFiles ? 'true' : 'false';
            const res = await api(`/api/storage/files?category=${encodeURIComponent(state.currentCategory)}&include_default=${includeDefault}`);
            state.files = (await res.json()).files;
            renderFiles();
        } catch (error) {
            console.error('Error loading files:', error);
            listEl.textContent = '';
            const errorDiv = document.createElement('div');
            errorDiv.className = 'storage-empty';
            errorDiv.textContent = 'Erreur de chargement';
            listEl.appendChild(errorDiv);
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
            barFill.style.width = Math.min(100, Math.max(0, info.usage_percent)) + '%';
            barFill.classList.toggle('critical', info.usage_percent > 90);
            barFill.classList.toggle('warning', info.usage_percent > 75 && info.usage_percent <= 90);
        }

        // Build quota details using DOM methods
        const detailsEl = $('storageDetails');
        if (detailsEl && info.by_category) {
            detailsEl.textContent = '';
            Object.entries(info.by_category).forEach(([cat, catInfo]) => {
                const div = document.createElement('div');
                div.className = 'storage-quota-category';

                const nameSpan = document.createElement('span');
                nameSpan.className = 'storage-quota-category-name';
                nameSpan.textContent = CATEGORIES[cat]?.name || cat;

                const valueSpan = document.createElement('span');
                valueSpan.className = 'storage-quota-category-value';
                valueSpan.textContent = `${catInfo.used_human} (${catInfo.count})`;

                div.appendChild(nameSpan);
                div.appendChild(valueSpan);
                detailsEl.appendChild(div);
            });
        }
    }

    function renderTabCounts() {
        const byCategory = state.info?.by_category;
        if (!byCategory) return;
        Object.entries(byCategory).forEach(([cat, info]) => {
            // Validate category name
            if (CATEGORIES[cat]) {
                setText(`count-${cat}`, info.count);
            }
        });
    }

    function renderFiles() {
        const listEl = $('storageFilesList');
        if (!listEl) return;

        listEl.textContent = '';

        if (!state.files?.length) {
            const emptyDiv = document.createElement('div');
            emptyDiv.className = 'storage-empty';
            emptyDiv.innerHTML = `
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                </svg>
            `;
            const p = document.createElement('p');
            p.textContent = 'Aucun fichier dans cette catégorie';
            emptyDiv.appendChild(p);
            listEl.appendChild(emptyDiv);
            return;
        }

        const defaultFiles = state.files.filter(f => f.is_default);
        const userFiles = state.files.filter(f => !f.is_default);

        if (userFiles.length > 0) {
            const group = createFileGroup('Mes fichiers', userFiles);
            listEl.appendChild(group);
        }

        if (defaultFiles.length > 0 && state.showDefaultFiles) {
            const group = createFileGroup('Fichiers de démonstration', defaultFiles);
            listEl.appendChild(group);
        }
    }

    function createFileGroup(title, files) {
        const group = document.createElement('div');
        group.className = 'storage-files-group';

        const titleDiv = document.createElement('div');
        titleDiv.className = 'storage-files-group-title';
        titleDiv.textContent = title;
        group.appendChild(titleDiv);

        files.forEach(file => {
            group.appendChild(createFileElement(file));
        });

        return group;
    }

    function createFileElement(file) {
        const item = document.createElement('div');
        item.className = `storage-file-item ${file.is_default ? 'default' : ''}`;
        item.dataset.fileId = file.id;

        // File icon
        const iconDiv = document.createElement('div');
        iconDiv.className = 'storage-file-icon';
        iconDiv.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
            </svg>
        `;
        if (file.is_default) {
            const badge = document.createElement('span');
            badge.className = 'storage-file-badge';
            badge.textContent = 'DEMO';
            iconDiv.appendChild(badge);
        }
        item.appendChild(iconDiv);

        // File info
        const infoDiv = document.createElement('div');
        infoDiv.className = 'storage-file-info';

        const nameDiv = document.createElement('div');
        nameDiv.className = 'storage-file-name';
        nameDiv.title = file.filename;
        nameDiv.textContent = file.filename;  // Safe: textContent escapes
        infoDiv.appendChild(nameDiv);

        const metaDiv = document.createElement('div');
        metaDiv.className = 'storage-file-meta';

        const sizeSpan = document.createElement('span');
        sizeSpan.className = 'storage-file-size';
        sizeSpan.textContent = file.size_human;
        metaDiv.appendChild(sizeSpan);

        const dateSpan = document.createElement('span');
        dateSpan.className = 'storage-file-date';
        dateSpan.textContent = new Date(file.uploaded_at).toLocaleDateString('fr-FR', {
            day: '2-digit', month: 'short', year: 'numeric'
        });
        metaDiv.appendChild(dateSpan);

        if (file.description) {
            const descSpan = document.createElement('span');
            descSpan.className = 'storage-file-desc';
            descSpan.title = file.description;
            descSpan.textContent = file.description;  // Safe: textContent escapes
            metaDiv.appendChild(descSpan);
        }

        infoDiv.appendChild(metaDiv);
        item.appendChild(infoDiv);

        // Actions
        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'storage-file-actions';

        // Download button
        const downloadBtn = document.createElement('button');
        downloadBtn.className = 'storage-file-btn';
        downloadBtn.dataset.action = 'download';
        downloadBtn.dataset.fileId = file.id;
        downloadBtn.dataset.isDefault = file.is_default;
        downloadBtn.title = 'Télécharger';
        downloadBtn.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="7 10 12 15 17 10"/>
                <line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
        `;
        actionsDiv.appendChild(downloadBtn);

        // Delete button (only for non-default files)
        if (!file.is_default) {
            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'storage-file-btn danger';
            deleteBtn.dataset.action = 'promptDelete';
            deleteBtn.dataset.fileId = file.id;
            deleteBtn.dataset.filename = file.filename;  // Safe: stored in dataset
            deleteBtn.title = 'Supprimer';
            deleteBtn.innerHTML = `
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="3 6 5 6 21 6"/>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                </svg>
            `;
            actionsDiv.appendChild(deleteBtn);
        }

        item.appendChild(actionsDiv);
        return item;
    }

    function switchCategory(category, element) {
        // Validate category against whitelist
        if (!CATEGORIES[category]) {
            console.error('Invalid category:', category);
            return;
        }

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
        setText('storageUploadFilename', file.name);  // Safe: setText uses textContent
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

        // Validate category
        if (!CATEGORIES[state.currentCategory]) {
            showNotification('Catégorie invalide', 'error');
            return;
        }

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
        // Safe: category is validated above
        xhr.open('POST', `/api/storage/files/${encodeURIComponent(state.currentCategory)}`);
        if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
        xhr.send(formData);
    }

    async function download(fileId, isDefault) {
        // Validate fileId format (UUID or alphanumeric)
        if (!/^[a-zA-Z0-9_-]+$/.test(fileId)) {
            console.error('Invalid file ID');
            return;
        }

        const endpoint = isDefault
            ? `/api/storage/default/${encodeURIComponent(fileId)}/download`
            : `/api/storage/files/${encodeURIComponent(fileId)}/download`;

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
        // Validate fileId format
        if (!/^[a-zA-Z0-9_-]+$/.test(fileId)) {
            console.error('Invalid file ID');
            return;
        }

        state.fileToDelete = fileId;
        setText('storageDeleteFilename', filename);  // Safe: setText uses textContent
        $('storageDeleteModal')?.classList.add('active');
    }

    function closeDeleteModal() {
        $('storageDeleteModal')?.classList.remove('active');
        state.fileToDelete = null;
    }

    async function confirmDelete() {
        if (!state.fileToDelete) return;

        // Validate fileId format
        if (!/^[a-zA-Z0-9_-]+$/.test(state.fileToDelete)) {
            console.error('Invalid file ID');
            return;
        }

        try {
            await api(`/api/storage/files/${encodeURIComponent(state.fileToDelete)}`, { method: 'DELETE' });
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
                case 'switchCategory':
                    switchCategory(category, target);
                    break;
                case 'refresh':
                    refresh();
                    break;
                case 'openUpload':
                    openUploadModal();
                    break;
                case 'download':
                    download(fileId, isDefault === 'true');
                    break;
                case 'promptDelete':
                    promptDelete(fileId, filename);
                    break;
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
                    case 'closeUpload':
                        closeUploadModal();
                        break;
                    case 'browseFile':
                        $('storageFileInput')?.click();
                        break;
                    case 'removeSelected':
                        removeSelectedFile();
                        break;
                    case 'upload':
                        upload();
                        break;
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
                    case 'closeDelete':
                        closeDeleteModal();
                        break;
                    case 'confirmDelete':
                        confirmDelete();
                        break;
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
