// Baltimore Bird - Sources de donnees et cycle de vie des sessions (lazy, ephemere, changeSource)
// Module extrait de app.js (refactoring): voir src/eda/ARCHITECTURE.md

import { S } from '../core/state.js';
import { clearBoolZones, restoreBoolZones, snapshotBoolZones } from './bool-zones.js';
import { API, ectx } from './context.js';
import { updateCursors } from './cursors.js';
import { maybeApplyDeepLink } from './deeplink.js';
import { setFileStats } from './file-info.js';
import { applyLayout, exportCurrentLayout } from './layout-state.js';
import { deletePlot } from './plot-legend.js';
import { exitComparison, registerRun } from './runs.js';
import { computeFilteredSignals, renderSignalList, renderVirtualList } from './signal-list.js';

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
        // Les demos restent cependant etiquetees "(exemple)" pour qu'on les distingue
        // d'un vrai fichier au premier coup d'oeil dans le selecteur.
        selector.innerHTML = '';
        const appendOption = (src, suffix) => {
            const option = document.createElement('option');
            option.value = src.id;
            option.textContent = src.name + (suffix || '') + (src.available === false ? ' (non disponible)' : '');
            option.disabled = src.available === false;
            selector.appendChild(option);
        };
        data.sources.filter(s => s.category === 'demo' || !s.category).forEach(s => appendOption(s, ' (exemple)'));
        data.sources.filter(s => s.category === 'user').forEach(s => appendOption(s));

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

        // La source courante est conservee si elle figure toujours dans la liste:
        // data.current est la source par defaut du serveur, pas forcement le fichier
        // affiche (un upload recharge la liste avant de basculer sur le nouveau fichier,
        // et l'espace de travail du fichier quitte est range sous ectx.currentSource).
        const current = ectx.currentSource
            && Array.from(selector.options).some(o => o.value === ectx.currentSource);
        if (current) {
            selector.value = ectx.currentSource;
        } else if (data.current) {
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

// =========================================================================
// Espaces de travail par fichier
// =========================================================================
// Chaque fichier ouvert est une instance distincte de l'EDA: ses onglets de layout,
// ses graphes, sa fenetre temporelle et ses curseurs. En quittant un fichier on
// photographie son espace de travail; en y revenant on le restaure, et un fichier
// jamais affiche demarre sur un onglet vide. La cle est la valeur de source du
// <select> (id de demo ou "session_<id>"). En comparaison, l'espace de travail est
// commun aux runs compares: aucune bascule n'y est photographiee.
const workspaces = new Map();

const BLANK_LAYOUT = { tabs: [{ name: 'Main', plots: [] }] };

// Meme format que la session ephemere persistee (layout, vue, curseurs, onglet actif),
// pour que les deux restaurations passent par restoreWorkspace.
function captureWorkspace() {
    const activeTab = S.tabs.find(t => t.id === S.activeTabId);
    if (activeTab) {
        activeTab.cursor1 = S.cursor1;
        activeTab.cursor2 = S.cursor2;
        activeTab.view = { min: ectx.globalView.min, max: ectx.globalView.max };
    }
    return {
        layout: exportCurrentLayout(),
        view: { min: ectx.globalView.min, max: ectx.globalView.max },
        cursorsByTab: S.tabs.map(t => [t.cursor1, t.cursor2]),
        tabViews: S.tabs.map(t => (t.view ? { min: t.view.min, max: t.view.max } : null)),
        activeTabIndex: Math.max(0, S.tabs.findIndex(t => t.id === S.activeTabId)),
        // Zones etendues avec leurs plages: le layout n'en porte que l'etat on/off.
        boolZones: snapshotBoolZones(S.signalsInfo),
        // Recherche de la liste de signaux et position de defilement de cette liste.
        search: document.getElementById('search')?.value || '',
        signalListScroll: document.getElementById('signalList')?.scrollTop || 0,
    };
}

// Remet la recherche (et le defilement) propres au fichier; vide pour un fichier neuf.
function restoreSignalSearch(saved) {
    const input = document.getElementById('search');
    if (!input) return;
    input.value = (saved && typeof saved.search === 'string') ? saved.search : '';
    computeFilteredSignals();
    const list = document.getElementById('signalList');
    if (list) list.scrollTop = (saved && Number.isFinite(saved.signalListScroll)) ? saved.signalListScroll : 0;
    renderVirtualList(true);
}

// Photographie l'espace de travail du fichier courant avant une bascule. Ignore un
// run deja supprime (deleteRun bascule apres l'avoir retire du registre).
function stashWorkspace() {
    const key = ectx.currentSource;
    if (!key || S.comparing || S.tabs.length === 0) return;
    if (key.startsWith('session_') && !S.runs.some(r => 'session_' + r.sessionId === key)) return;
    workspaces.set(key, captureWorkspace());
}

// Oublie l'espace de travail d'un fichier ferme.
export function discardWorkspace(key) {
    workspaces.delete(key);
}

window.discardWorkspace = discardWorkspace;

const validView = v => v && Number.isFinite(v.min) && Number.isFinite(v.max) && v.max > v.min;

// Restaure l'espace de travail d'un fichier, une fois ses signaux charges (les noms du
// layout sont resolus contre S.signalsInfo). Sans photo: un onglet "Main" vide.
async function restoreWorkspace(key) {
    const saved = workspaces.get(key);
    workspaces.delete(key);
    const hasTabs = saved && saved.layout && Array.isArray(saved.layout.tabs) && saved.layout.tabs.length > 0;
    restoreSignalSearch(saved);

    S.cursor1 = null;
    S.cursor2 = null;
    if (!hasTabs) {
        await applyLayout(BLANK_LAYOUT);
        updateCursors();
        return;
    }

    // Fenetre posee avant applyLayout: l'onglet actif est hydrate (et ses donnees
    // demandees) directement sur la bonne fenetre. Les autres onglets restent differes
    // et seront construits a leur premier affichage, sur leur propre fenetre.
    if (validView(saved.view)) ectx.globalView = { min: saved.view.min, max: saved.view.max };
    const activeIndex = Number.isInteger(saved.activeTabIndex) ? saved.activeTabIndex : 0;
    await applyLayout(saved.layout, activeIndex);
    // Zones remises avec leurs plages photographiees: visibles sur toutes les vues des
    // le retour, y compris celles d'un booleen dont l'onglet n'est pas encore construit.
    // Les plages sont recalculees a l'arrivee du cache (refreshBoolZoneRanges).
    restoreBoolZones(saved.boolZones, S.signalsInfo);

    const cursors = Array.isArray(saved.cursorsByTab) ? saved.cursorsByTab : [];
    const views = Array.isArray(saved.tabViews) ? saved.tabViews : [];
    S.tabs.forEach((tab, idx) => {
        const pair = cursors[idx];
        tab.cursor1 = Array.isArray(pair) && Number.isFinite(pair[0]) ? pair[0] : null;
        tab.cursor2 = Array.isArray(pair) && Number.isFinite(pair[1]) ? pair[1] : null;
        // L'onglet actif garde la fenetre sur laquelle il vient d'etre rendu.
        if (tab.id !== S.activeTabId && validView(views[idx])) tab.view = { ...views[idx] };
    });

    const active = S.tabs.find(t => t.id === S.activeTabId);
    if (active) {
        S.cursor1 = active.cursor1;
        S.cursor2 = active.cursor2;
    }
    updateCursors();
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

        Object.assign(saved, captureWorkspace());
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

// Bascule l'EDA sur une session lazy (fichier uploadé), met à jour le sélecteur
// de sources et persiste les sessions éphémères pour survivre au refresh. L'espace
// de travail du fichier quitte est photographie, celui du fichier ouvert restaure.
export async function activateLazySession(sessionId, filename, ephemeral) {
    // Avant tout await: la photo doit preceder les purges, et closeValue (run-list.js)
    // compte sur une photo prise des le retour de l'evenement change.
    stashWorkspace();

    const headers = {};
    const token = sessionStorage.getItem('auth_token');
    if (token) headers['Authorization'] = 'Bearer ' + token;

    const res = await fetch(`${API}/eda/list-signals/${sessionId}`, { headers });
    const listing = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error(listing.error || 'Session indisponible');
    }

    S.unresolvedComputedVars = [];

    S.plots.slice().forEach(p => deletePlot(p.id));
    // Purge les zones etendues residuelles d'un fichier precedent (photographiees avec
    // son espace de travail).
    clearBoolZones();
    ectx.currentLazySessionId = sessionId;
    S.signalsInfo = listing.signals;
    window.signalsInfo = S.signalsInfo;
    ectx.globalView = { min: listing.time_range.min, max: listing.time_range.max };
    ectx.acquisitionView = { ...ectx.globalView };

    setFileStats({ signals: listing.n_signals, duration: listing.duration });

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

    await restoreWorkspace(sourceId);
    await maybeApplyDeepLink();
    return listing;
}

// Au chargement de la page, tente de restaurer la session éphémère précédente: sa
// photo persistee devient l'espace de travail du fichier, restaure a l'activation.
export async function restoreEphemeralSession() {
    const saved = loadEphemeralSession();
    if (!saved) return false;

    const key = 'session_' + saved.sessionId;
    workspaces.set(key, saved);
    try {
        await activateLazySession(saved.sessionId, saved.filename, true);
        return true;
    } catch (e) {
        // Session expirée côté serveur
        workspaces.delete(key);
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
            await activateLazySession(sessionId, filename, ephemeral);
        } catch (e) {
            showNotification('Cette session a expiré', 'warning');
            clearEphemeralSession();
            selector.querySelector(`option[value="${newSource}"]`)?.remove();
            selector.value = ectx.currentSource || 'mf4';
        }
        return;
    }

    // Espace de travail du fichier quitte, avant la purge des graphes (et avant tout
    // await, cf. activateLazySession).
    stashWorkspace();

    // Affiche un indicateur de chargement
    const signalList = document.getElementById('signalList');
    if (signalList) {
        signalList.innerHTML = '<div class="signal-list-empty">Chargement...</div>';
    }
    
    // Efface les plots existants
    S.plots.slice().forEach(p => deletePlot(p.id));
    // Purge les zones etendues residuelles d'une source precedente (photographiees avec
    // son espace de travail).
    clearBoolZones();
    
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
            
            setFileStats({ signals: data.n_signals, duration: data.duration });
            
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
            
            setFileStats({ signals: info.n_signals, duration: info.duration });
            
            renderSignalList();
            updateSourceSelector();

            console.log(`Switched to source: ${ectx.currentSource}`);
        }

        await restoreWorkspace(ectx.currentSource);
    } catch (e) {
        console.error('Failed to change source:', e);
        alert('Erreur lors du changement de source: ' + e.message);
        selector.value = ectx.currentSource; // Revert
        // Les graphes du fichier courant ont ete purges avant l'echec: on remet son
        // espace de travail, photographie en entree.
        await restoreWorkspace(ectx.currentSource);
    }
}

