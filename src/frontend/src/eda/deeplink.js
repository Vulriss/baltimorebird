// Baltimore Bird - Liens profonds #view= (fichier, layout, fenetre, curseurs)
// Module extrait de app.js (refactoring): voir src/eda/ARCHITECTURE.md

import { S } from '../core/state.js';
import { notify } from './analysis.js';
import { ectx } from './context.js';
import { updateCursors } from './cursors.js';
import { applyLayout, exportCurrentLayout } from './layout-state.js';

// =========================================================================
// Deep-links de vues: #view=<base64(json)> encode fichier, layout, fenetre,
// curseurs et onglet actif - une URL restaure exactement la vue partagee.
// =========================================================================
let pendingDeepLink = null;

function encodeDeepLink(payload) {
    return btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
}

function decodeDeepLink(encoded) {
    return JSON.parse(decodeURIComponent(escape(atob(encoded))));
}

function activeRunFilename() {
    const run = S.runs.find(r => r.sessionId === ectx.currentLazySessionId);
    return run && run.filename ? run.filename : '';
}

function buildViewLink() {
    const tab = S.tabs.find(t => t.id === S.activeTabId);
    const payload = {
        v: 1,
        f: activeRunFilename(),
        l: exportCurrentLayout(),
        w: [ectx.globalView.min, ectx.globalView.max],
        c: [S.cursor1, S.cursor2],
        t: tab ? tab.name : null,
    };
    return `${location.origin}${location.pathname}#view=${encodeDeepLink(payload)}`;
}

async function copyViewLink() {
    if (!ectx.currentLazySessionId) {
        notify('Chargez un fichier avant de partager une vue.', 'warning');
        return;
    }
    const link = buildViewLink();
    try {
        await navigator.clipboard.writeText(link);
        notify('Lien de la vue copie: il restaure fichier, layout, fenetre et curseurs.', 'success');
    } catch (e) {
        window.prompt('Copiez le lien de la vue:', link);
    }
    if (typeof window.bbTrack === 'function') window.bbTrack('view_link_copy');
}

export function readDeepLinkFromUrl() {
    const match = location.hash.match(/^#view=(.+)$/);
    if (!match) return;
    try {
        pendingDeepLink = decodeDeepLink(match[1]);
    } catch (e) {
        console.warn('[DeepLink] Lien de vue illisible, ignore.');
        pendingDeepLink = null;
    }
}

// Applique le lien en attente si le fichier actif correspond (appele apres l'init et
// apres chaque activation de session); sinon informe l'utilisateur du fichier attendu,
// le lien restant en attente jusqu'au bon chargement.
export async function maybeApplyDeepLink() {
    if (!pendingDeepLink) return;
    const wanted = pendingDeepLink.f || '';
    const current = activeRunFilename();
    if (wanted && wanted !== current) {
        notify(`Vue partagee en attente: chargez le fichier "${wanted}" pour l'appliquer.`, 'info');
        return;
    }
    const link = pendingDeepLink;
    pendingDeepLink = null;

    if (Array.isArray(link.w) && link.w.length === 2
            && Number.isFinite(link.w[0]) && Number.isFinite(link.w[1])) {
        ectx.globalView = { min: link.w[0], max: link.w[1] };
    }
    if (link.l) await applyLayout(link.l);
    if (link.t && typeof window.switchTab === 'function') {
        const tab = S.tabs.find(t => t.name === link.t);
        if (tab) window.switchTab(tab.id);
    }
    if (Array.isArray(link.c)) {
        S.cursor1 = Number.isFinite(link.c[0]) ? link.c[0] : null;
        S.cursor2 = Number.isFinite(link.c[1]) ? link.c[1] : null;
        updateCursors();
    }
    history.replaceState(null, '', location.pathname + location.search);
    notify('Vue partagee appliquee.', 'success');
    if (typeof window.bbTrack === 'function') window.bbTrack('view_link_open');
}

document.addEventListener('click', (e) => {
    if (e.target.closest && e.target.closest('#shareViewBtn')) copyViewLink();
});

