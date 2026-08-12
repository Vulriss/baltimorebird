// Baltimore Bird - Etat mutable transverse (ctx) et constantes partagees de la vue EDA
// Module extrait de app.js (refactoring): voir src/eda/ARCHITECTURE.md


// =========================================================================
// State
// =========================================================================
export const API = '/api';

let plotIdCounter = 0;


// Plage temporelle complete de l'acquisition courante, fixee a chaque chargement.
// Sert de cible au Reset Zoom (independamment de la source de demonstration).


export const MAX_HISTORY = 20;


// Tabs system

// Flag pour éviter la double initialisation



// ---------------------------------------------------------------------------
// ectx: etat mutable partage entre les modules EDA. Meme regle que S (state.js):
// on mute les proprietes, jamais la liaison. Chaque propriete etait une variable
// top-level de app.js ecrite ou lue par plusieurs modules.
// ---------------------------------------------------------------------------
export const ectx = {
    globalView: { min: 0, max: 100 },
    acquisitionView: { min: 0, max: 100 },
    viewHistory: [],
    redoStack: [],
    currentSource: null,
    currentLazySessionId: null,
    extendedBoolZones: new Map(),
    disabledBoolZones: new Set(),
    edaInitialized: false,
    hoveredPlotId: null,
};
