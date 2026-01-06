/**
 * Navigation & Utilities
 */

// Constants
const CONVERT_API = '/api/convert';
const CONCAT_API = '/api/concat';
const CONCAT_MAX_FILES = 5;
const CONCAT_MAX_FILE_SIZE = 1.5 * 1024 * 1024 * 1024;

// Conversion state
let selectedFile = null;
let selectedDbc = null;
let currentTaskId = null;
let pollInterval = null;

// Concatenation state
let concatFiles = [];
let concatTaskId = null;
let concatPollInterval = null;
let draggedConcatIndex = null;

// Navigation

function toggleNav() {
    const nav = document.getElementById('navMenu');
    nav.classList.toggle('collapsed');
    localStorage.setItem('navCollapsed', nav.classList.contains('collapsed'));

    setTimeout(() => {
        if (typeof resizePlotCharts === 'function') resizePlotCharts();
    }, 300);
}

function switchView(viewId, element) {
    if (event) event.preventDefault();

    document.querySelectorAll('.nav-item[data-view]').forEach(item => item.classList.remove('active'));
    element?.classList.add('active');

    document.querySelectorAll('.view-container').forEach(view => view.classList.remove('active'));
    document.getElementById('view-' + viewId)?.classList.add('active');

    if (viewId === 'eda') {
        setTimeout(() => {
            if (typeof resizePlotCharts === 'function') resizePlotCharts();
        }, 100);
    }
}

function openUtility(utilityId) {
    const viewMap = {
        'data-conversion': 'view-data-conversion',
        'concatenation': 'view-concatenation'
    };

    const targetView = viewMap[utilityId];
    if (!targetView) {
        alert('Utilitaire "' + utilityId + '" - Bientôt disponible !');
        return;
    }

    document.querySelectorAll('.view-container').forEach(view => view.classList.remove('active'));
    document.getElementById(targetView)?.classList.add('active');

    document.querySelectorAll('.nav-item[data-view]').forEach(item => item.classList.remove('active'));
    document.querySelector('[data-view=utilities]')?.classList.add('active');
}

document.addEventListener('DOMContentLoaded', () => {
    if (localStorage.getItem('navCollapsed') === 'true') {
        document.getElementById('navMenu')?.classList.add('collapsed');
    }
});

// Data Conversion

function handleFileSelect(input) {
    const file = input.files[0];
    if (!file) return;

    selectedFile = file;
    document.getElementById('fileInputDisplay').style.display = 'none';
    document.getElementById('fileSelected').style.display = 'flex';
    document.getElementById('fileName').textContent = file.name;
    document.getElementById('fileSize').textContent = formatFileSize(file.size);
    updateConvertButton();
    updateOutputFormats(file.name);
}

function handleDbcSelect(input) {
    const file = input.files[0];
    if (!file) return;

    selectedDbc = file;
    document.getElementById('dbcInputDisplay').style.display = 'none';
    document.getElementById('dbcSelected').style.display = 'flex';
    document.getElementById('dbcFileName').textContent = file.name;
}

function removeFile() {
    selectedFile = null;
    document.getElementById('inputFile').value = '';
    document.getElementById('fileInputDisplay').style.display = 'block';
    document.getElementById('fileSelected').style.display = 'none';
    document.getElementById('outputFormat').innerHTML = '<option value="" disabled selected>Sélectionner un format</option>';
    updateConvertButton();
}

function removeDbc() {
    selectedDbc = null;
    document.getElementById('dbcFile').value = '';
    document.getElementById('dbcInputDisplay').style.display = 'block';
    document.getElementById('dbcSelected').style.display = 'none';
}

function updateConvertButton() {
    const formatSelect = document.getElementById('outputFormat');
    const outputFormat = formatSelect?.value || '';
    const btn = document.getElementById('convertBtn');
    if (btn) btn.disabled = !selectedFile || !outputFormat;
}

async function updateOutputFormats(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    const formatSelect = document.getElementById('outputFormat');

    document.getElementById('csvOptions').style.display = 'none';

    try {
        const res = await fetch(`${CONVERT_API}/formats`);
        const data = await res.json();
        const supportedOutputs = data.supported[ext] || [];

        formatSelect.innerHTML = supportedOutputs.length === 0
            ? '<option value="" disabled selected>Aucune conversion disponible</option>'
            : '<option value="" disabled selected>Sélectionner un format</option>' +
              supportedOutputs.map(fmt => `<option value="${fmt}">.${fmt}</option>`).join('');

        formatSelect.dataset.inputExt = ext;
    } catch (e) {
        console.error('Failed to fetch formats:', e);
        formatSelect.innerHTML = '<option value="" disabled selected>Erreur chargement formats</option>';
    }
}

function onOutputFormatChange() {
    const formatSelect = document.getElementById('outputFormat');
    const outputFormat = formatSelect.value;
    const inputExt = formatSelect.dataset.inputExt;

    const csvOptions = document.getElementById('csvOptions');
    csvOptions.style.display = (inputExt === 'mf4' && outputFormat === 'csv') ? 'block' : 'none';

    updateConvertButton();
}

document.addEventListener('DOMContentLoaded', () => {
    const formatSelect = document.getElementById('outputFormat');
    if (formatSelect) formatSelect.addEventListener('change', updateConvertButton);
});

async function startConversion() {
    if (!selectedFile) return;

    const outputFormat = document.getElementById('outputFormat').value;
    if (!outputFormat) return;

    const formatSelect = document.getElementById('outputFormat');
    const inputExt = formatSelect.dataset.inputExt;
    const resampleRaster = (inputExt === 'mf4' && outputFormat === 'csv')
        ? document.getElementById('resampleRaster').value
        : null;

    document.getElementById('convertState').style.display = 'none';
    document.getElementById('progressState').style.display = 'block';
    document.getElementById('progressFill').style.width = '0%';
    document.getElementById('progressPercent').textContent = '0%';
    document.getElementById('progressText').textContent = 'Upload en cours...';

    try {
        const formData = new FormData();
        formData.append('file', selectedFile);
        if (selectedDbc) formData.append('dbc', selectedDbc);

        const uploadRes = await fetch(`${CONVERT_API}/upload`, { method: 'POST', body: formData });
        if (!uploadRes.ok) {
            const err = await uploadRes.json();
            throw new Error(err.error || 'Upload échoué');
        }

        const uploadData = await uploadRes.json();

        document.getElementById('progressText').textContent = 'Démarrage de la conversion...';
        document.getElementById('progressFill').style.width = '10%';
        document.getElementById('progressPercent').textContent = '10%';

        const startRes = await fetch(`${CONVERT_API}/start`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                file_path: uploadData.file_path,
                output_format: outputFormat,
                dbc_path: uploadData.dbc_path,
                resample_raster: resampleRaster
            })
        });

        if (!startRes.ok) {
            const err = await startRes.json();
            throw new Error(err.error || 'Démarrage conversion échoué');
        }

        const startData = await startRes.json();
        currentTaskId = startData.task_id;
        pollConversionStatus();
    } catch (e) {
        console.error('Conversion error:', e);
        showConversionError(e.message);
    }
}

function pollConversionStatus() {
    if (pollInterval) clearInterval(pollInterval);

    pollInterval = setInterval(async () => {
        try {
            const res = await fetch(`${CONVERT_API}/status/${currentTaskId}`);
            const data = await res.json();

            const progress = Math.max(10, data.progress);
            document.getElementById('progressFill').style.width = progress + '%';
            document.getElementById('progressPercent').textContent = Math.round(progress) + '%';
            document.getElementById('progressText').textContent = data.message || 'Conversion en cours...';

            if (data.status === 'completed') {
                clearInterval(pollInterval);
                pollInterval = null;
                showConversionComplete(data);
            } else if (data.status === 'failed') {
                clearInterval(pollInterval);
                pollInterval = null;
                showConversionError(data.error || 'Conversion échouée');
            }
        } catch (e) {
            console.error('Status poll error:', e);
        }
    }, 500);
}

function showConversionComplete(data) {
    document.getElementById('progressState').style.display = 'none';
    document.getElementById('completeState').style.display = 'flex';
    document.getElementById('outputFileName').textContent = data.output_file || 'output.csv';
}

function showConversionError(message) {
    document.getElementById('progressState').style.display = 'none';
    document.getElementById('errorState').style.display = 'flex';
    document.getElementById('errorMessage').textContent = message;
}

function downloadFile() {
    if (!currentTaskId) return;
    window.open(`${CONVERT_API}/download/${currentTaskId}`, '_blank');
}

function resetConverter() {
    if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
    }

    removeFile();
    removeDbc();
    currentTaskId = null;

    document.getElementById('outputFormat').value = '';
    document.getElementById('outputFormat').innerHTML = '<option value="" disabled selected>Sélectionner un format</option>';
    document.getElementById('csvOptions').style.display = 'none';
    document.getElementById('resampleRaster').value = '0.01';
    document.getElementById('convertState').style.display = 'flex';
    document.getElementById('progressState').style.display = 'none';
    document.getElementById('completeState').style.display = 'none';
    document.getElementById('errorState').style.display = 'none';
    document.getElementById('progressFill').style.width = '0%';
    document.getElementById('progressPercent').textContent = '0%';
}

// MF4 Concatenation

function handleConcatFilesSelect(input) {
    const files = Array.from(input.files);

    for (const file of files) {
        if (!file.name.toLowerCase().endsWith('.mf4')) {
            alert(`Le fichier "${file.name}" n'est pas un fichier MF4.`);
            continue;
        }

        if (concatFiles.length >= CONCAT_MAX_FILES) {
            alert(`Maximum ${CONCAT_MAX_FILES} fichiers autorisés.`);
            break;
        }

        if (file.size > CONCAT_MAX_FILE_SIZE) {
            alert(`Le fichier "${file.name}" dépasse la limite de 1.5 GB par fichier.`);
            continue;
        }

        concatFiles.push(file);
    }

    input.value = '';
    renderConcatFileList();
    updateConcatButton();
}

function renderConcatFileList() {
    const container = document.getElementById('concatFileList');
    if (!container) return;

    if (concatFiles.length === 0) {
        container.innerHTML = '<div class="concat-empty">Aucun fichier ajouté</div>';
        updateConcatInfo();
        return;
    }

    container.innerHTML = concatFiles.map((file, index) => `
        <div class="concat-file-item" draggable="true" data-index="${index}">
            <div class="concat-file-order">${index + 1}</div>
            <div class="concat-file-drag">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="8" y1="6" x2="16" y2="6"/>
                    <line x1="8" y1="12" x2="16" y2="12"/>
                    <line x1="8" y1="18" x2="16" y2="18"/>
                </svg>
            </div>
            <div class="concat-file-info">
                <div class="concat-file-name">${file.name}</div>
                <div class="concat-file-size">${formatFileSize(file.size)}</div>
            </div>
            <button class="concat-file-remove" onclick="removeConcatFile(${index})">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="18" y1="6" x2="6" y2="18"/>
                    <line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
            </button>
        </div>
    `).join('');

    setupConcatDragDrop();
    updateConcatInfo();
}

function updateConcatInfo() {
    const infoEl = document.getElementById('concatInfo');
    if (!infoEl) return;

    const totalSize = concatFiles.reduce((sum, file) => sum + file.size, 0);

    infoEl.innerHTML = concatFiles.length === 0
        ? `<span>Max ${CONCAT_MAX_FILES} fichiers, 1.5 GB par fichier</span>`
        : `<span>${concatFiles.length}/${CONCAT_MAX_FILES} fichiers</span>
           <span class="concat-info-sep">•</span>
           <span>Total: ${formatFileSize(totalSize)}</span>`;
}

function setupConcatDragDrop() {
    const items = document.querySelectorAll('.concat-file-item');

    items.forEach(item => {
        item.addEventListener('dragstart', (e) => {
            draggedConcatIndex = parseInt(item.dataset.index);
            item.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
        });

        item.addEventListener('dragend', () => {
            item.classList.remove('dragging');
            draggedConcatIndex = null;
            document.querySelectorAll('.concat-file-item').forEach(i => i.classList.remove('drag-over'));
        });

        item.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            const targetIndex = parseInt(item.dataset.index);
            if (draggedConcatIndex !== null && draggedConcatIndex !== targetIndex) {
                item.classList.add('drag-over');
            }
        });

        item.addEventListener('dragleave', () => item.classList.remove('drag-over'));

        item.addEventListener('drop', (e) => {
            e.preventDefault();
            const targetIndex = parseInt(item.dataset.index);
            if (draggedConcatIndex !== null && draggedConcatIndex !== targetIndex) {
                const draggedFile = concatFiles[draggedConcatIndex];
                concatFiles.splice(draggedConcatIndex, 1);
                concatFiles.splice(targetIndex, 0, draggedFile);
                renderConcatFileList();
            }
        });
    });
}

function removeConcatFile(index) {
    concatFiles.splice(index, 1);
    renderConcatFileList();
    updateConcatButton();
}

function updateConcatButton() {
    const btn = document.getElementById('concatBtn');
    if (btn) btn.disabled = concatFiles.length < 2;
}

async function startConcatenation() {
    if (concatFiles.length < 2) return;

    document.getElementById('concatConvertState').style.display = 'none';
    document.getElementById('concatProgressState').style.display = 'block';
    document.getElementById('concatProgressFill').style.width = '0%';
    document.getElementById('concatProgressPercent').textContent = '0%';
    document.getElementById('concatProgressText').textContent = 'Upload des fichiers...';

    try {
        const filePaths = [];
        const nFiles = concatFiles.length;

        for (let i = 0; i < nFiles; i++) {
            const file = concatFiles[i];
            const progressBase = (i / nFiles) * 50;

            document.getElementById('concatProgressText').textContent = `Upload fichier ${i + 1}/${nFiles}: ${file.name}`;
            document.getElementById('concatProgressFill').style.width = progressBase + '%';
            document.getElementById('concatProgressPercent').textContent = Math.round(progressBase) + '%';

            const formData = new FormData();
            formData.append('file', file);
            formData.append('index', i);

            const uploadRes = await fetch(`${CONCAT_API}/upload-single`, { method: 'POST', body: formData });
            if (!uploadRes.ok) {
                const err = await uploadRes.json();
                throw new Error(err.error || `Upload échoué pour ${file.name}`);
            }

            const uploadData = await uploadRes.json();
            filePaths.push(uploadData.file_path);

            const progressEnd = ((i + 1) / nFiles) * 50;
            document.getElementById('concatProgressFill').style.width = progressEnd + '%';
            document.getElementById('concatProgressPercent').textContent = Math.round(progressEnd) + '%';
        }

        document.getElementById('concatProgressText').textContent = 'Démarrage de la concaténation...';
        document.getElementById('concatProgressFill').style.width = '55%';
        document.getElementById('concatProgressPercent').textContent = '55%';

        const startRes = await fetch(`${CONCAT_API}/start`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file_paths: filePaths })
        });

        if (!startRes.ok) {
            const err = await startRes.json();
            throw new Error(err.error || 'Démarrage concaténation échoué');
        }

        const startData = await startRes.json();
        concatTaskId = startData.task_id;
        pollConcatStatus();
    } catch (e) {
        console.error('Concatenation error:', e);
        showConcatError(e.message);
    }
}

function pollConcatStatus() {
    if (concatPollInterval) clearInterval(concatPollInterval);

    concatPollInterval = setInterval(async () => {
        try {
            const res = await fetch(`${CONCAT_API}/status/${concatTaskId}`);
            const data = await res.json();

            const progress = 55 + (data.progress / 100) * 45;
            document.getElementById('concatProgressFill').style.width = progress + '%';
            document.getElementById('concatProgressPercent').textContent = Math.round(progress) + '%';
            document.getElementById('concatProgressText').textContent = data.message || 'Concaténation en cours...';

            if (data.status === 'completed') {
                clearInterval(concatPollInterval);
                concatPollInterval = null;
                showConcatComplete(data);
            } else if (data.status === 'failed') {
                clearInterval(concatPollInterval);
                concatPollInterval = null;
                showConcatError(data.error || 'Concaténation échouée');
            }
        } catch (e) {
            console.error('Concat status poll error:', e);
        }
    }, 500);
}

function showConcatComplete(data) {
    document.getElementById('concatProgressState').style.display = 'none';
    document.getElementById('concatCompleteState').style.display = 'flex';
    document.getElementById('concatOutputFileName').textContent = data.output_file || 'merged.mf4';

    if (data.stats) {
        document.getElementById('concatStats').innerHTML = `
            <strong>${data.stats.n_files}</strong> fichiers fusionnés •
            <strong>${data.stats.n_signals}</strong> signaux communs conservés •
            Durée totale: <strong>${data.stats.duration.toFixed(1)}s</strong>
        `;
        document.getElementById('concatStats').style.display = 'block';
    }
}

function showConcatError(message) {
    document.getElementById('concatProgressState').style.display = 'none';
    document.getElementById('concatErrorState').style.display = 'flex';
    document.getElementById('concatErrorMessage').textContent = message;
}

function downloadConcatFile() {
    if (!concatTaskId) return;
    window.open(`${CONCAT_API}/download/${concatTaskId}`, '_blank');
}

function resetConcatenation() {
    if (concatPollInterval) {
        clearInterval(concatPollInterval);
        concatPollInterval = null;
    }

    concatFiles = [];
    concatTaskId = null;

    document.getElementById('concatFileInput').value = '';
    renderConcatFileList();
    updateConcatButton();

    document.getElementById('concatConvertState').style.display = 'flex';
    document.getElementById('concatProgressState').style.display = 'none';
    document.getElementById('concatCompleteState').style.display = 'none';
    document.getElementById('concatErrorState').style.display = 'none';
    document.getElementById('concatProgressFill').style.width = '0%';
    document.getElementById('concatProgressPercent').textContent = '0%';
}
// =========================================================================
// Expose globals for other modules (Vite compatibility)
// =========================================================================
window.toggleNav = toggleNav;
// Conversion functions
window.startConversion = startConversion;
window.downloadFile = downloadFile;
window.resetConverter = resetConverter;
window.removeFile = removeFile;
window.removeDbc = removeDbc;
window.handleFileSelect = handleFileSelect;
window.handleDbcSelect = handleDbcSelect;
// Concatenation functions
window.startConcatenation = startConcatenation;
window.downloadConcatFile = downloadConcatFile;
window.resetConcatenation = resetConcatenation;
window.handleConcatFilesSelect = handleConcatFilesSelect;
window.removeConcatFile = removeConcatFile;
