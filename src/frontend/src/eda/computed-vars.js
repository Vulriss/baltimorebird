// Baltimore Bird - Variables calculees: drawer, resolveur d'unite bool, soumission
// Module extrait de app.js (refactoring): voir src/eda/ARCHITECTURE.md

import { S } from '../core/state.js';
import { API, ectx } from './context.js';
import { escapeHtml } from './shared-dom.js';
import { renderSignalList } from './signal-list.js';

// =========================================================================
// Create Computed Variable (Drawer)
// =========================================================================
let variableMappings = {};

// { A: { index: 0, name: 'signal_name', color: '#fff' }, B: ... }
let currentMappingLabels = ['A', 'B'];

// Current visible mapping slots
let editingVariableIndex = null;

// Index de la variable en cours d'édition (null = création)

export function openCreateVariableDrawer() {
    const drawer = document.getElementById('createVariableDrawer');
    if (drawer) {
        editingVariableIndex = null;
        resetCreateVariableForm();
        updateDrawerHeader(false);
        drawer.classList.add('active');
    }
}

// Alias pour compatibilité
export function openCreateVariableModal() {
    openCreateVariableDrawer();
}

export function closeCreateVariableDrawer() {
    const drawer = document.getElementById('createVariableDrawer');
    if (drawer) {
        drawer.classList.remove('active');
        drawer.classList.remove('creating');
        editingVariableIndex = null;
    }
}

// Alias pour compatibilité
export function closeCreateVariableModal(event) {
    closeCreateVariableDrawer();
}

/**
 * Ouvre le drawer en mode édition/visualisation pour une variable calculée existante
 */
export function openComputedVariableForEdit(signal) {
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
            const foundSignal = S.signalsInfo.find(s => s.name === signalName);
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
            description.innerHTML = '<strong>Mode visualisation</strong> - Vous pouvez modifier cette variable et cliquer sur "Mettre à jour" pour appliquer les changements.';
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
    if (unitInput) {
        unitInput.value = '';
        delete unitInput.dataset.autoBool;
    }
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
            
            if (S.draggedSignal !== null) {
                const signal = S.signalsInfo[S.draggedSignal];
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
    // Les mappings participent a la detection (regle * / + entre booleens).
    maybeAutoSetBoolUnit();
}

function updateMappingButtons() {
    const removeBtn = document.getElementById('removeMappingBtn');
    if (removeBtn) {
        removeBtn.disabled = currentMappingLabels.length <= 1;
    }
}

// =========================================================================
// Detection de condition et unite bool par defaut
// =========================================================================
// Une formule est une "condition" (resultat 0/1) si elle contient un operateur de
// comparaison ou logique, ou si elle ne fait que combiner des variables toutes
// booleennes avec * (ET logique) et + (OU logique) - la convention numerique
// entre ensembles 0/1.
function formulaLooksLogical(formula) {
    if (!formula) return false;
    // Comparaisons et logique explicites: < > <= >= == != && || & | ^ ~ !
    if (/[<>]|==|!=|&&|\|\||[&|^~!]/.test(formula)) return true;
    // '=' seul (egalite, traduit en == cote serveur)
    if (/(^|[^=<>!])=([^=]|$)/.test(formula)) return true;
    // Mots-operateurs and / or / not (toute casse)
    if (/\b(and|or|not)\b/i.test(formula)) return true;
    // Combinaison purement * / + de variables toutes booleennes
    const vars = [...new Set(formula.match(/\b[A-Z]\b/g) || [])];
    if (!vars.length) return false;
    const allBool = vars.every(v => {
        const m = variableMappings[v];
        if (!m) return false;
        const sig = S.signalsInfo[m.index];
        return (sig && sig.unit === 'bool') || m.unit === 'bool';
    });
    if (!allBool) return false;
    const residue = formula.replace(/\b[A-Z]\b/g, '').replace(/[\s()*+]/g, '');
    return residue === '';
}

// Propose 'bool' comme unite par defaut quand la formule est une condition, sans
// jamais ecraser une saisie manuelle: on ne remplit que le champ vide, et on marque
// la valeur auto (data-auto-bool) pour pouvoir la retirer si la formule redevient
// numerique. Une frappe manuelle dans le champ unite leve le marqueur (listener).
function maybeAutoSetBoolUnit() {
    const unitInput = document.getElementById('newVarUnit');
    const formulaInput = document.getElementById('newVarFormula');
    if (!unitInput || !formulaInput) return;
    const logical = formulaLooksLogical(formulaInput.value.trim());
    if (logical && (!unitInput.value.trim() || unitInput.dataset.autoBool === '1')) {
        unitInput.value = 'bool';
        unitInput.dataset.autoBool = '1';
    } else if (!logical && unitInput.dataset.autoBool === '1') {
        unitInput.value = '';
        delete unitInput.dataset.autoBool;
    }
}

// Resolveur instantane a chaque frappe (et collage) dans la formule. Delegation au
// niveau document, obligatoire ici: la modale est injectee dynamiquement par le
// ViewLoader APRES initEDA - un listener pose directement sur #newVarFormula au
// setup tomberait sur un element inexistant et ne serait jamais attache. 'input'
// bulle jusqu'au document, on filtre par id de cible; une saisie manuelle dans le
// champ unite leve definitivement le marqueur auto.
document.addEventListener('input', (e) => {
    const id = e.target && e.target.id;
    if (id === 'newVarFormula') maybeAutoSetBoolUnit();
    else if (id === 'newVarUnit') delete e.target.dataset.autoBool;
});

export function addMappingSlot() {
    // Get next letter
    const lastLabel = currentMappingLabels[currentMappingLabels.length - 1];
    const nextCharCode = lastLabel.charCodeAt(0) + 1;
    
    if (nextCharCode <= 90) { // 'Z'
        const nextLabel = String.fromCharCode(nextCharCode);
        currentMappingLabels.push(nextLabel);
        renderVariableMappings();
    }
}

export function removeMappingSlot() {
    if (currentMappingLabels.length > 1) {
        const removedLabel = currentMappingLabels.pop();
        delete variableMappings[removedLabel];
        renderVariableMappings();
    }
}

// Cree la variable calculee sur les autres runs compares qui possedent tous les signaux
// sources (par nom). Best-effort par run; resynchronise l'index nom -> position de chacun.
// Un run depourvu des sources est ignore (couverture partielle, comportement attendu).
async function createComputedOnComparedRuns(varDef) {
    const sources = Object.values(varDef.mapping || {});
    const others = S.runs.filter(r => r.compared && r.sessionId !== ectx.currentLazySessionId);
    for (const run of others) {
        if (!run.nameToIndex || !sources.every(n => run.nameToIndex.has(n))) continue;
        try {
            const headers = { 'Content-Type': 'application/json' };
            const token = sessionStorage.getItem('auth_token');
            if (token) headers['Authorization'] = 'Bearer ' + token;
            const res = await fetch(`${API}/create-variable`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ ...varDef, session_id: run.sessionId }),
            });
            if (!res.ok) continue;
            const listRes = await fetch(`${API}/eda/list-signals/${run.sessionId}`,
                { headers: token ? { Authorization: 'Bearer ' + token } : {} });
            const listing = await listRes.json();
            if (Array.isArray(listing.signals)) {
                run.nameToIndex = new Map(listing.signals.map(s => [s.name, s.index]));
                run.signals = listing.signals;
            }
        } catch (e) { /* best-effort: un run en echec n'empeche pas les autres */ }
    }
}

export async function submitCreateVariable() {
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
    
    // Validate that formula uses defined variables. Lettres isolees uniquement
    // (\b): les mots-operateurs AND/OR/NOT ne sont pas des variables A, N, D...
    const formula = formulaInput.value.trim();
    const usedVars = formula.match(/\b[A-Z]\b/g) || [];
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
                    mapping: mapping,
                    session_id: ectx.currentLazySessionId
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
                    mapping: mapping,
                    session_id: ectx.currentLazySessionId
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
            // Rasters heterogenes: le serveur a aligne les voies sur le raster le plus
            // dense (interpolation lineaire, maintien de valeur pour bool/etats). On le
            // signale: la variable n'a pas la cadence brute de chaque source.
            if (data.resample && Array.isArray(data.resample.resampled) && data.resample.resampled.length) {
                const list = data.resample.resampled.join(', ');
                successMessage += ` (${list} interpolé${data.resample.resampled.length > 1 ? 's' : ''}`
                    + ` sur le raster de ${data.resample.raster_of}, ${data.resample.n_samples} pts)`;
            }
            showNotification(successMessage, 'success');
        }
        
        // Recharge la liste des signaux depuis la bonne source, sans toucher aux
        // plots ni a la vue courante.
        if (ectx.currentLazySessionId) {
            const listHeaders = {};
            const listToken = sessionStorage.getItem('auth_token');
            if (listToken) listHeaders['Authorization'] = 'Bearer ' + listToken;
            const listRes = await fetch(`${API}/eda/list-signals/${ectx.currentLazySessionId}`, { headers: listHeaders });
            const listing = await listRes.json();
            S.signalsInfo = listing.signals;
            window.signalsInfo = S.signalsInfo;
            // Le run actif doit connaitre la variable creee, sinon la couverture affiche 0/N
            // et l'overlay ne la trouve pas. On resynchronise son index nom -> position.
            const activeRun = S.runs.find(r => r.sessionId === ectx.currentLazySessionId);
            if (activeRun) {
                activeRun.nameToIndex = new Map(listing.signals.map(s => [s.name, s.index]));
                activeRun.signals = listing.signals;
            }
            document.getElementById('statSignals').textContent = listing.n_signals;
        } else {
            const infoRes = await fetch(`${API}/info`);
            const info = await infoRes.json();
            S.signalsInfo = info.signals;
            window.signalsInfo = S.signalsInfo;
            document.getElementById('statSignals').textContent = info.n_signals;
        }

        renderSignalList();
        // En comparaison, creer aussi la variable sur les autres runs compares qui disposent
        // des signaux sources, pour qu'elle soit presente partout (couverture N/N, overlay).
        if (S.comparing && !isUpdateMode) {
            await createComputedOnComparedRuns({
                name: nameInput.value.trim(),
                unit: unitInput.value.trim() || '',
                description: descInput.value.trim() || '',
                formula,
                mapping,
            });
            renderSignalList();
        }
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
export function setupCreateVariableListeners() {
    // Le bouton dans la sidebar
    const createBtn = document.getElementById('createVariableBtn');
    if (createBtn && !createBtn._listenerAdded) {
        createBtn.addEventListener('click', openCreateVariableDrawer);
        createBtn._listenerAdded = true;
    }

    // NB: le resolveur d'unite bool (formule/unite) est branche par delegation au
    // niveau document (voir maybeAutoSetBoolUnit): la modale est injectee apres
    // initEDA, un listener direct pose ici manquerait les elements.

    // Initialize mappings display
    renderVariableMappings();
}

