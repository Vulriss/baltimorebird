// Baltimore Bird - Sources de donnees et cycle de vie des sessions (lazy, ephemere, changeSource)
// Module extrait de app.js (refactoring): voir src/eda/ARCHITECTURE.md

import { S } from '../core/state.js';
import { API, ectx } from './context.js';
import { updateCursors } from './cursors.js';
import { maybeApplyDeepLink } from './deeplink.js';
import { applyLayout, exportCurrentLayout } from './layout-state.js';
import { deletePlot } from './plot-legend.js';
import { exitComparison, registerRun } from './runs.js';
import { renderSignalList } from './signal-list.js';
import { refreshAllPlots } from './view-nav.js';

// =========================================================================
// Data Sources
// =========================================================================
export async function loadSources() {
    try {
        // Prépare les headers avec auth si disponible
        const headers = {};
        const token = sessionStorage.getItem('auth_token');
        if (token) {
            headers['Authorization'] = 'Bearer ' + token;
        }
        
        const res = await fetch(`${API}/sources`, { headers });
        const data = await res.json();
        
        const selector = document.getElementById('sourceSelector');
        if (!selector) return;

        // Liste a plat (sans groupes): la categorisation demo / utilisateur n'a pas
        // de sens pour une comparaison, personne ne compare un fichier de demo a un upload.
        selector.innerHTML = '';
        const appendOption = (src) => {
            const option = document.createElement('option');
            option.value = src.id;
            option.textContent = src.name + (src.available === false ? ' (non disponible)' : '');
            option.disabled = src.available === false;
            selector.appendChild(option);
        };
        data.sources.filter(s => s.category === 'demo' || !s.category).forEach(appendOption);
        data.sources.filter(s => s.category === 'user').forEach(appendOption);

        // Reinjecte les fichiers uploades (sessions ephemeres): ils ne figurent pas dans
        // /sources mais doivent rester choisissables. Sans cela, reconstruire le selecteur
        // lors d'un nouvel upload ferait disparaitre les fichiers precedents.
        S.runs.forEach(run => {
            const value = 'session_' + run.sessionId;
            if (selector.querySelector(`option[value="${value}"]`)) return;
            const option = document.createElement('option');
            option.value = value;
            option.textContent = run.filename + (run.ephemeral ? ' (temporaire)' : '');
            selector.appendChild(option);
        });

        if (data.current) {
            selector.value = data.current;
            ectx.currentSource = data.current;
        }
        if (typeof window.refreshRunList === 'function') window.refreshRunList();
    } catch (e) {
        console.error('Failed to load sources:', e);
    }
}

export function updateSourceSelector() {
    const selector = document.getElementById('sourceSelector');
    if (ectx.currentSource && selector) {
        selector.value = ectx.currentSource;
    }
    if (typeof window.refreshRunList === 'function') window.refreshRunList();
}

const EPHEMERAL_SESSION_KEY = 'bb_ephemeral_session';

const EPHEMERAL_SESSION_TTL_MS = 60 * 60 * 1000;

// Aligné sur le timeout serveur (1h)

function saveEphemeralSession(sessionId, filename) {
    try {
        localStorage.setItem(EPHEMERAL_SESSION_KEY, JSON.stringify({
            sessionId, filename, savedAt: Date.now()
        }));
    } catch (e) { /* stockage local indisponible: la session ne survivra pas au refresh */ }
}

// Snapshot du travail en cours (layout + zoom) dans la session éphémère,
// pour ne rien perdre en cas de rafraîchissement de la page
function persistEphemeralWorkspace() {
    if (!ectx.currentLazySessionId) return;
    try {
        const raw = localStorage.getItem(EPHEMERAL_SESSION_KEY);
        if (!raw) return;
        const saved = JSON.parse(raw);
        if (saved.sessionId !== ectx.currentLazySessionId) return;

        saved.layout = exportCurrentLayout();
        saved.view = { min: ectx.globalView.min, max: ectx.globalView.max };

        // Curseurs de mesure: synchronise l'onglet actif puis sauvegarde par onglet
        const activeTab = S.tabs.find(t => t.id === S.activeTabId);
        if (activeTab) {
            activeTab.cursor1 = S.cursor1;
            activeTab.cursor2 = S.cursor2;
        }
        saved.cursorsByTab = S.tabs.map(t => [t.cursor1, t.cursor2]);
        saved.activeTabIndex = Math.max(0, S.tabs.findIndex(t => t.id === S.activeTabId));

        saved.savedAt = Date.now();
        localStorage.setItem(EPHEMERAL_SESSION_KEY, JSON.stringify(saved));
    } catch (e) { /* best effort */ }
}

window.addEventListener('beforeunload', persistEphemeralWorkspace);

window.addEventListener('pagehide', persistEphemeralWorkspace);

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') persistEphemeralWorkspace();
});

function loadEphemeralSession() {
    try {
        const raw = localStorage.getItem(EPHEMERAL_SESSION_KEY);
        if (!raw) return null;
        const saved = JSON.parse(raw);
        if (!saved.sessionId || Date.now() - saved.savedAt > EPHEMERAL_SESSION_TTL_MS) {
            localStorage.removeItem(EPHEMERAL_SESSION_KEY);
            return null;
        }
        return saved;
    } catch (e) {
        return null;
    }
}

function clearEphemeralSession() {
    try { localStorage.removeItem(EPHEMERAL_SESSION_KEY); } catch (e) { /* no-op */ }
}

// Noms distincts des signaux references par un layout (onglets hydrates ou differes),
// pour detecter ceux absents du fichier vers lequel on bascule.
function layoutSignalNames(layout) {
    const names = new Set();
    (layout && layout.tabs ? layout.tabs : []).forEach(tab => {
        (tab.plots || []).forEach(plot => {
            (plot.signals || []).forEach(sig => { if (sig && sig.name) names.add(sig.name); });
        });
    });
    return names;
}

// Vrai si le layout porte au moins un signal (evite de re-appliquer un layout vide,
// typiquement au tout premier upload sans graphe existant).
function layoutHasContent(layout) {
    return (layout && layout.tabs ? layout.tabs : []).some(tab =>
        (tab.plots || []).some(plot => (plot.signals || []).length > 0));
}

// Bascule l'EDA sur une session lazy (fichier uploadé), met à jour le sélecteur
// de sources et persiste les sessions éphémères pour survivre au refresh. Quand
// preserveLayout est vrai, le layout courant est re-lié par nom au nouveau fichier.
export async function activateLazySession(sessionId, filename, ephemeral, preserveLayout = false) {
    const headers = {};
    const token = sessionStorage.getItem('auth_token');
    if (token) headers['Authorization'] = 'Bearer ' + token;

    const res = await fetch(`${API}/eda/list-signals/${sessionId}`, { headers });
    const listing = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error(listing.error || 'Session indisponible');
    }

    // Capture le layout courant (par nom) avant toute purge, pour le re-lier au nouveau
    // fichier: on change de fichier sans perdre les strips ni les signaux affiches.
    const preserved = preserveLayout ? exportCurrentLayout() : null;
    const preservedNames = preserved ? layoutSignalNames(preserved) : null;

    S.plots.slice().forEach(p => deletePlot(p.id));
    // Purge les zones etendues residuelles d'un fichier precedent.
    ectx.extendedBoolZones.clear();
    ectx.disabledBoolZones.clear();
    ectx.currentLazySessionId = sessionId;
    S.signalsInfo = listing.signals;
    window.signalsInfo = S.signalsInfo;
    ectx.globalView = { min: listing.time_range.min, max: listing.time_range.max };
    ectx.acquisitionView = { ...ectx.globalView };

    document.getElementById('statSignals').textContent = listing.n_signals;
    document.getElementById('statDuration').textContent = listing.duration.toFixed(0) + 's';

    // Le fichier apparaît dans le sélecteur et y est sélectionné
    const selector = document.getElementById('sourceSelector');
    const sourceId = 'session_' + sessionId;
    if (selector) {
        let option = selector.querySelector(`option[value="${sourceId}"]`);
        if (!option) {
            option = document.createElement('option');
            option.value = sourceId;
            selector.appendChild(option);
        }
        option.textContent = filename + (ephemeral ? ' (temporaire)' : '');
        selector.value = sourceId;
    }
    ectx.currentSource = sourceId;

    if (ephemeral) {
        saveEphemeralSession(sessionId, filename);
    }

    renderSignalList();
    registerRun(sessionId, filename, ephemeral, listing.signals);
    const activatedRun = S.runs.find(r => r.sessionId === sessionId);
    if (activatedRun) {
        activatedRun.duration = listing.duration;
        activatedRun.tMin = listing.time_range ? listing.time_range.min : null;
        activatedRun.tMax = listing.time_range ? listing.time_range.max : null;
    }
    if (typeof window.refreshRunList === 'function') window.refreshRunList();

    // Re-liaison du layout au nouveau fichier: applyLayout resout les noms vers les index
    // du fichier actif; les signaux absents sont ecartes (leur entree disparait de la
    // legende) et signales via une notification, comme au chargement d'un layout.
    if (preserved && layoutHasContent(preserved)) {
        await applyLayout(preserved);
        const available = new Set(S.signalsInfo.map(s => s.name));
        const missing = [...preservedNames].filter(name => !available.has(name));
        if (missing.length && typeof showNotification === 'function') {
            const shown = missing.slice(0, 3).join(', ');
            const extra = missing.length > 3 ? ` (+${missing.length - 3})` : '';
            showNotification(`${missing.length} signal(aux) absent(s) de ce fichier: ${shown}${extra}`, 'warning');
        }
    }
    await maybeApplyDeepLink();
    return listing;
}

// Au chargement de la page, tente de restaurer la session éphémère précédente
export async function restoreEphemeralSession() {
    const saved = loadEphemeralSession();
    if (!saved) return false;

    try {
        await activateLazySession(saved.sessionId, saved.filename, true);

        if (saved.layout && saved.layout.tabs && saved.layout.tabs.length > 0) {
            await applyLayout(saved.layout);
        }
        if (saved.view && Number.isFinite(saved.view.min) && Number.isFinite(saved.view.max)
                && saved.view.max > saved.view.min) {
            ectx.globalView = { min: saved.view.min, max: saved.view.max };
            refreshAllPlots();
        }

        if (Array.isArray(saved.cursorsByTab)) {
            saved.cursorsByTab.forEach((pair, idx) => {
                if (S.tabs[idx] && Array.isArray(pair)) {
                    S.tabs[idx].cursor1 = Number.isFinite(pair[0]) ? pair[0] : null;
                    S.tabs[idx].cursor2 = Number.isFinite(pair[1]) ? pair[1] : null;
                }
            });
            const activeIdx = Number.isInteger(saved.activeTabIndex) ? saved.activeTabIndex : 0;
            const activeTab = S.tabs[activeIdx] || S.tabs[0];
            if (activeTab) {
                S.cursor1 = activeTab.cursor1;
                S.cursor2 = activeTab.cursor2;
                updateCursors();
            }
        }

        return true;
    } catch (e) {
        // Session expirée côté serveur
        clearEphemeralSession();
        return false;
    }
}

export async function changeSource() {
    const selector = document.getElementById('sourceSelector');
    if (!selector) return;
    
    const newSource = selector.value;
    
    if (newSource === ectx.currentSource) return;

    // Option de session lazy (fichier uploadé): réactivation directe, pas de POST source
    if (newSource.startsWith('session_')) {
        const sessionId = newSource.slice('session_'.length);
        const label = selector.options[selector.selectedIndex]?.textContent || '';
        const ephemeral = label.includes('(temporaire)');
        const filename = label.replace(' (temporaire)', '');
        try {
            await activateLazySession(sessionId, filename, ephemeral, true);
        } catch (e) {
            showNotification('Cette session a expiré', 'warning');
            clearEphemeralSession();
            selector.querySelector(`option[value="${newSource}"]`)?.remove();
            selector.value = ectx.currentSource || 'mf4';
        }
        return;
    }

    // Affiche un indicateur de chargement
    const signalList = document.getElementById('signalList');
    if (signalList) {
        signalList.innerHTML = '<div class="signal-list-empty">Chargement...</div>';
    }
    
    // Efface les plots existants
    S.plots.slice().forEach(p => deletePlot(p.id));
    // Purge les zones etendues residuelles d'une source precedente.
    ectx.extendedBoolZones.clear();
    ectx.disabledBoolZones.clear();
    
    try {
        // Change la source côté serveur. Le token n'est joint que s'il existe :
        // les sources de démonstration sont accessibles sans authentification.
        const token = typeof getAuthToken === 'function' ? getAuthToken() : null;
        const res = (token && typeof authFetch === 'function')
            ? await authFetch(`${API}/source/${newSource}`, { method: 'POST' })
            : await fetch(`${API}/source/${newSource}`, { method: 'POST' });
        
        const data = await res.json();
        
        if (data.error) {
            throw new Error(data.error);
        }
        
        // Pour les sources lazy (fichiers utilisateur), les infos sont déjà dans la réponse
        if (data.lazy && data.signals) {
            if (data.session_id) {
                ectx.currentLazySessionId = data.session_id;
                const label = selector.options[selector.selectedIndex]?.textContent?.trim();
                registerRun(data.session_id, label || data.source, false, data.signals);
            }
            
            S.signalsInfo = data.signals;
            window.signalsInfo = S.signalsInfo;
            ectx.globalView = { min: data.time_range.min, max: data.time_range.max };
            ectx.acquisitionView = { ...ectx.globalView };
            ectx.currentSource = data.source;
            
            document.getElementById('statSignals').textContent = data.n_signals;
            document.getElementById('statDuration').textContent = data.duration.toFixed(0) + 's';
            
            renderSignalList();
            updateSourceSelector();
            
            console.log(`Switched to lazy source: ${ectx.currentSource}`);
        } else {
            // Pour les sources classiques, recharge les infos via /api/info. Les fichiers
            // uploades restent inscrits (choisissables dans le selecteur); on quitte juste
            // la comparaison et on marque l'absence de fichier actif.
            ectx.currentLazySessionId = null;
            S.activeRunId = null;
            if (S.comparing) exitComparison();
            
            const infoRes = (token && typeof authFetch === 'function')
                ? await authFetch(`${API}/info`)
                : await fetch(`${API}/info`);
            
            const info = await infoRes.json();
            
            S.signalsInfo = info.signals;
            window.signalsInfo = S.signalsInfo;
            ectx.globalView = { min: info.time_range.min, max: info.time_range.max };
            ectx.acquisitionView = { ...ectx.globalView };
            ectx.currentSource = info.source;
            
            document.getElementById('statSignals').textContent = info.n_signals;
            document.getElementById('statDuration').textContent = info.duration.toFixed(0) + 's';
            
            renderSignalList();
            updateSourceSelector();
            
            console.log(`Switched to source: ${ectx.currentSource}`);
        }
        
    } catch (e) {
        console.error('Failed to change source:', e);
        alert('Erreur lors du changement de source: ' + e.message);
        selector.value = ectx.currentSource; // Revert
    }
}

