/**
 * Baltimore Bird - État applicatif partagé (Phase 2).
 *
 * Centralise les variables d'état mutables partagées entre app.js et les futurs modules
 * (signaux, plots, onglets). Règle d'usage: on mute les propriétés de S, jamais la liaison
 * elle-même, afin que tous les modules voient la même valeur. Les liaisons importées en ESM
 * sont en lecture seule chez l'importateur, d'où le recours à un objet conteneur.
 */
export const S = {
    signalsInfo: [],
    plots: [],
    activeTabId: null,
    tabs: [],
    cursor1: null,
    cursor2: null,
    draggedSignal: null,
    draggedFromPlotId: null,
    tabIdCounter: 0,
};

// Exposition pour le debug (devtools) et un accès éventuel d'autres modules en façade.
window.S = S;
