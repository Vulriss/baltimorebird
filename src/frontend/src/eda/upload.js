// Baltimore Bird - Modale d'upload EDA (fichier MF4 + DBC)
// Module extrait de app.js (refactoring): voir src/eda/ARCHITECTURE.md

import { closeCreateVariableModal } from './computed-vars.js';
import { API } from './context.js';
import { activateLazySession, loadSources } from './sessions.js';

// =========================================================================
// EDA File Upload Modal
// =========================================================================
let edaSelectedFile = null;

let edaSelectedDbc = null;

let currentSessionId = null;

const EDA_DATA_EXTENSIONS = ['mf4', 'csv', 'mat', 'dat', 'blf'];

const EDA_DBC_EXTENSIONS = ['dbc', 'arxml'];

function fileExtension(name) {
    const i = name.lastIndexOf('.');
    return i === -1 ? '' : name.slice(i + 1).toLowerCase();
}

function setEdaFile(file) {
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

function setEdaDbcFile(file) {
    edaSelectedDbc = file;
    const edaDbcInputDisplay = document.getElementById('edaDbcInputDisplay');
    const edaDbcSelected = document.getElementById('edaDbcSelected');
    const edaDbcFileName = document.getElementById('edaDbcFileName');

    if (edaDbcInputDisplay) edaDbcInputDisplay.style.display = 'none';
    if (edaDbcSelected) edaDbcSelected.style.display = 'flex';
    if (edaDbcFileName) edaDbcFileName.textContent = file.name;
}

export function handleEdaFileSelect(input) {
    if (input.files[0]) setEdaFile(input.files[0]);
}

export function handleEdaDbcSelect(input) {
    if (input.files[0]) setEdaDbcFile(input.files[0]);
}

// Glisser-deposer sur la modal d'upload, cable a la premiere ouverture (la modale est
// injectee dynamiquement). Routage par extension: .dbc/.arxml vers le slot DBC, les
// formats de donnees vers le slot principal - un depot de deux fichiers (mesure + DBC)
// remplit donc les deux slots en un seul geste.
function setupUploadModalDropZones() {
    const modal = document.getElementById('uploadModal');
    if (!modal || modal._dndWired) return;
    modal._dndWired = true;
    const content = modal.querySelector('.modal-content');
    if (!content) return;

    const hasFiles = e => e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');

    ['dragenter', 'dragover'].forEach(type => content.addEventListener(type, e => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        content.classList.add('drag-over');
    }));

    content.addEventListener('dragleave', e => {
        if (!content.contains(e.relatedTarget)) content.classList.remove('drag-over');
    });

    content.addEventListener('drop', e => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        content.classList.remove('drag-over');

        let matched = 0;
        for (const file of e.dataTransfer.files) {
            const ext = fileExtension(file.name);
            if (EDA_DBC_EXTENSIONS.includes(ext)) {
                setEdaDbcFile(file);
                matched++;
            } else if (EDA_DATA_EXTENSIONS.includes(ext)) {
                setEdaFile(file);
                matched++;
            }
        }
        if (!matched && typeof showNotification === 'function') {
            showNotification(
                `Format non reconnu. Attendus: .${EDA_DATA_EXTENSIONS.join(', .')} `
                + `(donnees) ou .${EDA_DBC_EXTENSIONS.join(', .')} (base CAN).`,
                'warning'
            );
        }
    });
}

export function openUploadModal() {
    const modal = document.getElementById('uploadModal');
    if (!modal) return;
    // Les modales sont injectées dynamiquement : resynchronise les éléments
    // dépendants de l'état d'authentification (notes invité/connecté)
    if (typeof updateAuthUI === 'function') updateAuthUI();
    setupUploadModalDropZones();
    // Entrée = raccourci du bouton "Charger" des qu'un fichier est selectionne (bouton actif).
    if (!modal._enterWired) {
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' || !modal.classList.contains('active')) return;
            const btn = document.getElementById('edaUploadBtn');
            if (btn && !btn.disabled) { e.preventDefault(); uploadEdaFile(); }
        });
        modal._enterWired = true;
    }
    modal.classList.add('active');
}

export function closeUploadModal(event) {
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

export function removeEdaFile() {
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

export function removeEdaDbc() {
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

export async function uploadEdaFile() {
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
                await activateLazySession(data.session_id, data.filename, data.ephemeral === true, true);
                
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

