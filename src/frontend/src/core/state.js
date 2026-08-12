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
    // Reorganisation verticale des panneaux: id du panneau en cours de glissement
    // (poignee ⠿), sinon null. Distingue le drag de panneau du drag de signal, qui
    // partagent les memes zones de depot.
    draggedPlotId: null,
    tabIdCounter: 0,
    // Multi-fichiers: runs = fichiers uploades (registre du selecteur de source), activeRunId
    // = fichier actif (source de drag). comparing = mode comparaison explicite (opt-in): le
    // roster et la conversion en series overlay ne s'activent que dans ce mode. La participation
    // d'un run a la comparaison est portee par run.compared. Les sources demo restent hors runs.
    runs: [],
    activeRunId: null,
    comparing: false,
    // Fenetre temporelle partagee entre les onglets (zoom/pan communs) ou propre a
    // chacun. Par defaut true = comportement historique (globalView unique).
    // Desactive, chaque onglet memorise sa fenetre dans tab.view.
    syncTabViews: true,
};

// Exposition pour le debug (devtools) et un accès éventuel d'autres modules en façade.
window.S = S;
