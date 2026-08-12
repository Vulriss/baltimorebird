// Baltimore Bird - Theme clair/sombre et bascule dans la nav
// Module extrait de app.js (refactoring): voir src/eda/ARCHITECTURE.md

import { S } from '../core/state.js';
import { isSeriesSynth, seriesDescriptor } from './overlay.js';
import { updatePlotHeader, updateSignalActiveStates } from './plot-legend.js';
import { runColorFor } from './runs.js';
import { renderVirtualList } from './signal-list.js';
import { refreshAllPlots } from './view-nav.js';

// Applique le theme sauvegarde des le chargement (sombre par defaut) pour limiter le flash.
(function initTheme() {
    try {
        const saved = localStorage.getItem('bb-theme') || 'dark';
        document.documentElement.setAttribute('data-theme', saved);
    } catch (_) { /* localStorage indisponible */ }
})();

// Bascule de theme clair / sombre depuis la nav, globale (presente sur toutes les vues).
// Persistee via 'bb-theme'. Au changement, redessine les graphes existants pour que les
// couleurs d'axes et de grille, lues sur les tokens CSS, suivent le theme courant.
function setupNavThemeToggle() {
    const btn = document.getElementById('navThemeToggle');
    if (!btn || btn._listenerAdded) return;
    const sync = () => {
        const light = document.documentElement.getAttribute('data-theme') === 'light';
        btn.classList.toggle('active', light);
        btn.setAttribute('aria-pressed', light ? 'true' : 'false');
    };
    sync();
    btn.addEventListener('click', () => {
        const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
        try { localStorage.setItem('bb-theme', next); } catch (_) { /* stockage indisponible */ }
        document.documentElement.setAttribute('data-theme', next);
        sync();
        // Les couleurs par fichier sont hex (hors theming HSL), donc on les re-resout ici
        // depuis leur palette: couleur de run (roster) et couleurs des series en overlay.
        if (Array.isArray(S.runs) && typeof runColorFor === 'function') {
            S.runs.forEach(run => { run.color = runColorFor(run.sessionId); });
            if (S.plots) {
                S.plots.forEach(plot => {
                    (plot.signals || []).forEach(key => {
                        if (typeof isSeriesSynth === 'function' && isSeriesSynth(key) && plot.signalStyles?.[key]) {
                            const d = seriesDescriptor(key);
                            if (d.sessionId) plot.signalStyles[key].color = runColorFor(d.sessionId);
                        }
                    });
                });
            }
        }
        // Les couleurs par defaut dependent du theme: reconstruire charts (la signature
        // change avec les couleurs de trait), legendes et pastilles de la liste.
        if (S.plots) {
            S.plots.forEach(p => { if (typeof updatePlotHeader === 'function') updatePlotHeader(p); });
            if (typeof refreshAllPlots === 'function') refreshAllPlots();
        }
        if (typeof renderVirtualList === 'function') renderVirtualList(true);
        if (typeof updateSignalActiveStates === 'function') updateSignalActiveStates();
        if (typeof window.refreshRunList === 'function') window.refreshRunList();
    });
    btn._listenerAdded = true;
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupNavThemeToggle);
} else {
    setupNavThemeToggle();
}

