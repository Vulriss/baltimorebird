// Baltimore Bird - Navigation temporelle: undo/redo de vue, pan, rafraichissement
// Module extrait de app.js (refactoring): voir src/eda/ARCHITECTURE.md

import { S } from '../core/state.js';
import { scheduleAnalysisRefresh } from './analysis.js';
import { MAX_HISTORY, ectx } from './context.js';
import { canRenderFromCache } from './data-views.js';
import { renderCommentPlot } from './events-strip.js';
import { fetchAndRenderPlot, renderBoolPlot } from './render.js';
import { renderPlotFromCacheFiltered } from './transforms.js';

// Historique des niveaux de zoom/vue. recordViewChange() memorise l'etat courant
// avant un changement (zoom ou pan) et invalide le redo. undoView()/redoView()
// naviguent dans les vues precedentes/suivantes (Ctrl+Z / Ctrl+Y, double-clic).
export function recordViewChange() {
    ectx.viewHistory.push({ ...ectx.globalView });
    if (ectx.viewHistory.length > MAX_HISTORY) ectx.viewHistory.shift();
    ectx.redoStack = [];
}

function applyRestoredView(view) {
    // Y se recadre sur la fenetre restauree, sauf sur les panneaux verrouilles.
    S.plots.forEach(p => { if (!p.yLocked) p.yRange = null; });
    ectx.globalView = view;
    refreshAllPlots();
}

export function undoView() {
    if (ectx.viewHistory.length === 0) return false;
    ectx.redoStack.push({ ...ectx.globalView });
    if (ectx.redoStack.length > MAX_HISTORY) ectx.redoStack.shift();
    applyRestoredView(ectx.viewHistory.pop());
    return true;
}

export function redoView() {
    if (ectx.redoStack.length === 0) return false;
    ectx.viewHistory.push({ ...ectx.globalView });
    if (ectx.viewHistory.length > MAX_HISTORY) ectx.viewHistory.shift();
    applyRestoredView(ectx.redoStack.pop());
    return true;
}

export function refreshAllPlots() {
    S.plots.forEach(plot => fetchAndRenderPlot(plot));
    scheduleAnalysisRefresh();
}

// Re-fenetrage local pour une nouvelle fenetre X (pan): rejoue le cache complet sans
// aucune requete /view. Ne retombe sur le serveur que pour un panneau dont les donnees
// ne sont pas encore entierement rapatriees (full send encore en cours).
// Pan leger pendant le glissement: translate l'echelle X de chaque graphe sur les donnees
// deja rendues, sans re-decimer (LTTB) ni reconstruire les strips. Le rendu propre (re-
// decimation, cadrage Y, strips) est fait une seule fois au relachement via applyGlobalViewLocal.
export function panPlotsScaleOnly() {
    for (const plot of S.plots) {
        if (plot.chart) plot.chart.setScale('x', { min: ectx.globalView.min, max: ectx.globalView.max });
    }
}

// Un panneau n'est rendu que s'il appartient a l'onglet affiche. Les chemins
// asynchrones aboutissent parfois apres un changement d'onglet: le fetch /view, et
// surtout le full-send differe en idle (jusqu'a 1,5 s + reseau). Rendre un graphe
// invisible est du travail perdu — et en vues desynchronisees il serait rendu sur la
// fenetre d'un AUTRE onglet.
// Le travail reseau n'est jamais perdu: la mise en cache a lieu avant ce garde-fou.
// Le rendu saute est memorise (_needsRender) et rejoue depuis le cache au retour sur
// l'onglet, sinon le panneau resterait fige sur son rendu precedent.
export function plotIsVisible(plot) {
    if (!plot) return false;
    if (plot.tabId !== S.activeTabId) {
        plot._needsRender = true;
        return false;
    }
    return true;
}

export function applyGlobalViewLocal() {
    S.plots.forEach(plot => {
        plot._needsRender = false;
        if (plot.signals.length === 0) return;
        if (plot.isCommentPlot) { renderCommentPlot(plot); return; }
        if (canRenderFromCache(plot, ectx.globalView.min, ectx.globalView.max)) {
            if (plot.isBoolPlot) renderBoolPlot(plot);
            else renderPlotFromCacheFiltered(plot);
        } else {
            fetchAndRenderPlot(plot);
        }
    });
    scheduleAnalysisRefresh();
}

