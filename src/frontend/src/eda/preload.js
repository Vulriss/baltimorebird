// Baltimore Bird - File de prechargement des signaux a priorite (survol / clic)
// Module extrait de app.js (refactoring): voir src/eda/ARCHITECTURE.md

import { S } from '../core/state.js';
import { API, ectx } from './context.js';
import { prefetchSignalView } from './data-views.js';

// =========================================================================
// File de prechargement a priorite. Chaque preload passe le verrou de session
// cote serveur: si tous les survols partaient immediatement en HTTP, un clic
// (drag) arriverait derriere N requetes deja en vol et attendrait son tour.
// On limite donc la concurrence cote client; le surplus attend ici, ou une
// demande prioritaire (mousedown) peut passer en tete de file et ne patienter
// que derriere les requetes deja parties.
// =========================================================================
const preloadInFlight = new Set();

// indices dont la requete HTTP est partie
const preloadQueue = [];

// { idx, sess } en attente, tete = prochain envoi
const PRELOAD_CONCURRENCY = 2;

// Point d'entree unique (survol, mousedown, depot de groupe). priority=true met
// la demande en tete de file - ou l'y remonte si elle attendait deja.
export function ensureSignalPreloaded(signalIndex, priority = false) {
    if (!ectx.currentLazySessionId) return;
    const sig = S.signalsInfo[signalIndex];
    if (!sig || sig.loaded !== false || preloadInFlight.has(signalIndex)) return;

    const pos = preloadQueue.findIndex(q => q.idx === signalIndex && q.sess === ectx.currentLazySessionId);
    if (pos !== -1) {
        if (priority && pos > 0) {
            const [entry] = preloadQueue.splice(pos, 1);
            preloadQueue.unshift(entry);
        }
        return;
    }

    const entry = { idx: signalIndex, sess: ectx.currentLazySessionId };
    if (priority) preloadQueue.unshift(entry);
    else preloadQueue.push(entry);

    // Feedback immediat: le spinner apparait des la mise en file, pas a l'envoi.
    const el = document.getElementById(`signal-item-${signalIndex}`);
    if (el) {
        el.classList.add('loading');
        const loader = el.querySelector('.signal-loader');
        if (loader) loader.style.display = 'block';
    }

    pumpPreloadQueue();
}

// Vide la file tant que des slots de concurrence sont libres. Les entrees d'une
// session revolue (fichier bascule pendant l'attente) sont abandonnees: leurs
// indices ne designent plus les memes signaux.
function pumpPreloadQueue() {
    while (preloadInFlight.size < PRELOAD_CONCURRENCY && preloadQueue.length) {
        const { idx, sess } = preloadQueue.shift();
        if (sess !== ectx.currentLazySessionId) continue;
        const sig = S.signalsInfo[idx];
        if (!sig || sig.loaded !== false) {
            const el = document.getElementById(`signal-item-${idx}`);
            if (el) {
                el.classList.remove('loading');
                const loader = el.querySelector('.signal-loader');
                if (loader) loader.style.display = 'none';
            }
            continue;
        }
        preloadInFlight.add(idx);
        fetchSignalPreload(idx).finally(() => {
            preloadInFlight.delete(idx);
            pumpPreloadQueue();
        });
    }
}

// Precharge cote serveur un signal non charge et met a jour son item de liste, retrouve
// par id a chaque etape: la liste virtuelle recycle les elements pendant l'await, une
// reference capturee peut pointer un item obsolete. En cas de succes, enchaine
// immediatement un prefetch de vue: apres un simple survol, le depot est instantane.
// N'appeler que via la file (pumpPreloadQueue): les gardes sont faites en amont.
async function fetchSignalPreload(signalIndex) {
    const sig = S.signalsInfo[signalIndex];
    if (!sig) return;

    const itemEl = () => document.getElementById(`signal-item-${signalIndex}`);
    const startEl = itemEl();
    if (startEl) {
        startEl.classList.add('loading');
        const loader = startEl.querySelector('.signal-loader');
        if (loader) loader.style.display = 'block';
    }

    try {
        const headers = {};
        const token = sessionStorage.getItem('auth_token');
        if (token) headers['Authorization'] = 'Bearer ' + token;

        const response = await fetch(
            `${API}/eda/preload-signal/${ectx.currentLazySessionId}/${signalIndex}`,
            { method: 'POST', headers }
        );
        const data = await response.json();

        if (response.ok && data.status === 'ready') {
            sig.loaded = true;
            if (data.string_map) {
                sig.stringMap = data.string_map;
                sig.isCategorical = true;
            }
            if (data.unit) sig.unit = data.unit;

            const readyEl = itemEl();
            if (readyEl) {
                readyEl.classList.remove('not-loaded');
                const dot = readyEl.querySelector('.signal-dot');
                if (dot) dot.classList.remove('lazy-indicator');
            }
            prefetchSignalView(signalIndex);
        } else {
            const errEl = itemEl();
            if (errEl) errEl.classList.add('load-error');
            console.warn(`[LazyEDA] Échec préchargement signal ${signalIndex}:`, data.error);
        }
    } catch (e) {
        const errEl = itemEl();
        if (errEl) errEl.classList.add('load-error');
        console.error(`[LazyEDA] Erreur préchargement signal ${signalIndex}:`, e);
    } finally {
        // Le retrait de preloadInFlight et la relance de la file sont assures par
        // pumpPreloadQueue (finally sur la promesse), pas ici.
        const doneEl = itemEl();
        if (doneEl) {
            doneEl.classList.remove('loading');
            const loader = doneEl.querySelector('.signal-loader');
            if (loader) loader.style.display = 'none';
        }
    }
}

