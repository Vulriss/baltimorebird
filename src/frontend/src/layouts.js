import { layoutToLxf, lxfToLayout } from './lxf.js';
import { S } from './state.js';

/**
 * Baltimore Bird - Gestion des layouts (UI, persistance, format de fichier LXF).
 *
 * Le fichier de layout (téléchargement / import) est au format ASAM Common LXF v1.0.
 * Le stockage en compte (utilisateur connecté) reste interne (JSON via l'API storage).
 * Accès au coeur applicatif via la façade window: applyLayout, exportCurrentLayout, getSignalsInfo.
 */

const API = '/api';

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
        
        const success = await window.applyLayout(layoutData);
        
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
    if (S.tabs.length === 0 || S.tabs.every(t => !t.plots || t.plots.length === 0)) {
        if (typeof showNotification === 'function') {
            showNotification('Rien à sauvegarder - ajoutez des signaux aux plots', 'warning');
        }
        return;
    }
    
    // Utilisateur non connecté: la sauvegarde devient un téléchargement local.
    const guest = !isUserAuthenticated();
    drawer.classList.toggle('guest-mode', guest);
    const saveLabel = document.getElementById('footerSaveLabel');
    if (saveLabel) saveLabel.textContent = guest ? 'Télécharger' : 'Sauvegarder';
    const guestHint = document.getElementById('layoutGuestHint');
    if (guestHint) guestHint.style.display = guest ? 'block' : 'none';
    
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

// Indique si l'utilisateur courant est authentifié (présence d'un token de session).
function isUserAuthenticated() {
    const token = typeof getAuthToken === 'function' ? getAuthToken() : null;
    return Boolean(token);
}

function sanitizeFileName(name) {
    return (name || 'layout')
        .replace(/[^a-zA-Z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 50) || 'layout';
}

// Télécharge le layout courant au format ASAM Common LXF (fichier .lxf).
function downloadLayoutLxf(name) {
    const xml = layoutToLxf(window.exportCurrentLayout());
    const blob = new Blob([xml], { type: 'application/xml' });
    const blobUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = `${sanitizeFileName(name)}.lxf`;
    link.click();
    URL.revokeObjectURL(blobUrl);
}

// Importe un layout depuis un fichier LXF local et l'applique.
function importLayoutFromFile() {
    const notify = (msg, type) => {
        if (typeof showNotification === 'function') showNotification(msg, type);
    };

    // L'input doit être attaché au document: certains navigateurs n'émettent pas l'évènement
    // "change" pour un input détaché, ce qui rendait l'import silencieusement inopérant.
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.lxf,application/xml,text/xml';
    input.style.display = 'none';
    document.body.appendChild(input);

    const cleanup = () => input.remove();

    input.addEventListener('change', async () => {
        const file = input.files && input.files[0];
        if (!file) {
            cleanup();
            return;
        }

        let doc;
        try {
            doc = lxfToLayout(await file.text());
        } catch (e) {
            console.error('Import layout: LXF illisible', e);
            notify('Fichier LXF invalide', 'error');
            cleanup();
            return;
        }

        if (!doc.tabs.length) {
            notify('Fichier LXF sans onglet exploitable', 'warning');
            cleanup();
            return;
        }

        const signalsInfo = window.getSignalsInfo() || [];

        if (!Array.isArray(signalsInfo) || signalsInfo.length === 0) {
            notify("Chargez d'abord un fichier avant d'importer un layout", 'warning');
            cleanup();
            return;
        }

        // Avertit si aucun signal du layout ne correspond au fichier courant (sinon onglets vides).
        const available = new Set(signalsInfo.map(s => s.name));
        const referenced = doc.tabs.flatMap(
            t => (t.plots || []).flatMap(p => (p.signals || []).map(s => s.name))
        );
        if (referenced.length > 0 && !referenced.some(name => available.has(name))) {
            notify('Aucun signal du layout ne correspond au fichier courant', 'warning');
            cleanup();
            return;
        }

        closeLayoutsDrawer();
        const layoutName = file.name.replace(/\.[^.]+$/, '');
        notify(`Import du layout "${layoutName}"...`, 'info');

        try {
            const success = await window.applyLayout(doc);
            notify(
                success ? `Layout "${layoutName}" appliqué` : "Échec de l'application du layout",
                success ? 'success' : 'error'
            );
        } catch (e) {
            console.error('Import layout: échec de applyLayout', e);
            notify("Erreur lors de l'application du layout", 'error');
        } finally {
            cleanup();
        }
    });

    input.click();
}

/**
 * Sauvegarde le layout actuel avec le nom donné.
 * Utilisateur connecté : stockage dans son espace personnel.
 * Utilisateur non connecté : téléchargement du layout (aucun espace de stockage serveur).
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

    const resetForm = () => {
        if (nameInput) nameInput.value = '';
        if (descInput) descInput.value = '';
        closeSaveMode();
    };

    if (!isUserAuthenticated()) {
        downloadLayoutLxf(name);
        if (typeof showNotification === 'function') {
            showNotification(`Layout "${name}" téléchargé`, 'success');
        }
        resetForm();
        return;
    }

    try {
        // Utilise l'API storage pour les layouts (compatible avec Settings > Stockage)
        const response = await authFetch(`${API}/storage/json/layouts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: name,
                description: description,
                content: window.exportCurrentLayout()
            })
        });

        const result = await response.json();

        if (!response.ok) {
            throw new Error(result.error || 'Erreur de sauvegarde');
        }

        if (typeof showNotification === 'function') {
            showNotification(`Layout "${name}" sauvegardé`, 'success');
        }

        resetForm();
        loadLayoutsList();

    } catch (e) {
        console.error('Failed to save layout:', e);
        if (typeof showNotification === 'function') {
            showNotification(e.message || 'Erreur lors de la sauvegarde', 'error');
        }
    }
}

// Exposition des fonctions publiques (onclick du modal + boutons de la toolbar EDA).
window.saveLayout = saveLayout;
window.loadLayout = loadLayout;
window.openLayoutsDrawer = openLayoutsDrawer;
window.closeLayoutsDrawer = closeLayoutsDrawer;
window.loadLayoutById = loadLayoutById;
window.saveCurrentLayout = saveCurrentLayout;
window.importLayoutFromFile = importLayoutFromFile;
window.openSaveLayoutDialog = openSaveLayoutDialog;
window.closeSaveMode = closeSaveMode;
