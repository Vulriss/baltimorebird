// Baltimore Bird - Serialisation/restauration des layouts (export, apply, hydratation)
// Module extrait de app.js (refactoring): voir src/eda/ARCHITECTURE.md

import { S } from '../core/state.js';
import { API, ectx } from './context.js';
import { canRenderFromCache } from './data-views.js';
import { renderCommentPlot, setCommentPlotSignal } from './events-strip.js';
import { plotHasSynth, renderOverlayFromCache } from './overlay.js';
import { updatePlotHeader } from './plot-legend.js';
import { addSignalToPlot, createPlotInTab, ensureBoolPlot, ensureCommentPlot, isBoolSignalIndex, isEventSignalIndex } from './plots.js';
import { renderBoolPlot } from './render.js';
import { renderSignalList } from './signal-list.js';
import { renderPlotFromCacheFiltered } from './transforms.js';
import { applyGlobalViewLocal, refreshAllPlots } from './view-nav.js';

// =========================================================================
// Layout Save/Load System
// =========================================================================

/**
 * Exporte l'état actuel en format layout JSON.
 * Les signaux sont référencés par nom (pas index) pour la portabilité.
 */
export function exportCurrentLayout() {
    const layoutTabs = S.tabs.map(tab => {
        // Onglet importe pas encore hydrate: sa specification differee est deja au format
        // d'export ({flex, signals:[{name, style}]}); on l'emet telle quelle pour ne pas
        // perdre ses graphes lors d'une sauvegarde anticipee.
        if (tab._pendingLayout && !tab._hydrated) {
            return { name: tab.name, plots: tab._pendingLayout };
        }
        const tabPlots = (tab.plots || []).map(plot => {
            const plotSignals = plot.signals.map(sigIdx => {
                const sig = S.signalsInfo[sigIdx];
                const style = plot.signalStyles?.[sigIdx] || { color: sig?.color || '#fff', width: 1.5, dash: '' };
                return {
                    name: sig?.name || `Signal_${sigIdx}`,
                    style: {
                        color: style.color,
                        width: style.width,
                        dash: style.dash || '',
                        path: style.path || '',
                        fill: style.fill || ''
                    }
                };
            });
            
            // Re-emet les signaux absents du fichier courant (gardes en grise): sans cela,
            // un aller-retour A -> B -> A les perdrait definitivement des le passage sur B.
            (plot.missingSignals || []).forEach(ms => {
                plotSignals.push({
                    name: ms.name,
                    style: {
                        color: ms.style?.color || '#7f849c',
                        width: ms.style?.width ?? 1.5,
                        dash: ms.style?.dash || '',
                        path: ms.style?.path || '',
                        fill: ms.style?.fill || ''
                    }
                });
            });

            // Récupérer le ratio flex du plot
            const flex = plot.element?.style?.flex || '1';
            
            return {
                flex: parseFloat(flex) || 1,
                signals: plotSignals
            };
        });
        
        return {
            name: tab.name,
            plots: tabPlots
        };
    });
    
    // Récupérer les variables calculées
    const computedVars = S.signalsInfo
        .filter(sig => sig.computed)
        .map(sig => ({
            name: sig.name,
            unit: sig.unit || '',
            description: sig.description || '',
            formula: sig.formula || '',
            source_signals: sig.source_signals || []
        }));
    
    return {
        tabs: layoutTabs,
        computed_variables: computedVars
    };
}

/**
 * Applique un layout au système.
 * Résout les noms de signaux vers les index actuels.
 */
// Applique un style sauvegarde a un signal d'un panneau (restauration layout).
function applyRestoredStyle(plot, sigIdx, style) {
    if (!style) return;
    if (!plot.signalStyles) plot.signalStyles = {};
    plot.signalStyles[sigIdx] = {
        color: style.color,
        width: style.width || 1.5,
        dash: style.dash || '',
        path: style.path || '',
        fill: style.fill || ''
    };
}

// Construit les graphes d'un onglet a partir d'une specification de layout. L'onglet doit
// etre actif (S.plots pointe dessus) au moment de l'appel. Les booleens sont routes vers le
// plot booleen dedie; les signaux absents du fichier courant sont ignores.
function buildTabPlots(tabId, plotsSpec) {
    const nameToIndex = {};
    S.signalsInfo.forEach(sig => { nameToIndex[sig.name] = sig.index; });

    for (const layoutPlot of plotsSpec) {
        const normalSigs = [];
        const boolSigs = [];
        const eventSigs = [];
        // Signaux du layout introuvables dans le fichier courant: conserves en grise
        // (voir updatePlotHeader) au lieu d'etre effaces, et re-emis a l'export pour
        // survivre aux changements de fichier successifs (A -> B -> A).
        const missingSigs = [];
        for (const sig of layoutPlot.signals) {
            const sigIdx = nameToIndex[sig.name];
            if (sigIdx === undefined) { missingSigs.push({ name: sig.name, style: sig.style }); continue; }
            if (isEventSignalIndex(sigIdx)) eventSigs.push(sigIdx);
            else (isBoolSignalIndex(sigIdx) ? boolSigs : normalSigs).push({ idx: sigIdx, style: sig.style });
        }

        // Le panneau est cree s'il a au moins un signal reel OU des absents a montrer
        // (sinon un panneau entierement absent du nouveau fichier disparaitrait).
        if (normalSigs.length > 0 || (missingSigs.length > 0 && boolSigs.length === 0 && eventSigs.length === 0)) {
            // Creer le graphe vide puis poser le style AVANT d'ajouter chaque signal: le
            // premier rendu et la legende utilisent ainsi la bonne couleur (sinon la legende
            // reste sur la couleur par defaut alors que la courbe est recoloriee ensuite).
            const plotId = createPlotInTab(tabId, null);
            const plot = S.plots.find(p => p.id === plotId);
            if (plot) {
                plot.missingSignals = missingSigs;
                for (const s of normalSigs) {
                    applyRestoredStyle(plot, s.idx, s.style);
                    addSignalToPlot(plotId, s.idx);
                }
                if (plot.element && layoutPlot.flex) {
                    plot.element.style.flex = layoutPlot.flex.toString();
                }
                // Aucun signal reel a tracer: la legende n'est pas rafraichie par
                // addSignalToPlot, on la construit ici pour afficher les absents.
                if (normalSigs.length === 0) updatePlotHeader(plot);
            }
        } else if (missingSigs.length > 0 && boolSigs.length > 0) {
            // Les absents d'un panneau booleen rejoignent la legende du strip booleen.
            const bp = ensureBoolPlot(tabId);
            bp.missingSignals = (bp.missingSignals || []).concat(missingSigs);
        }

        for (const s of boolSigs) {
            const bp = ensureBoolPlot(tabId);
            applyRestoredStyle(bp, s.idx, s.style);
            addSignalToPlot(bp.id, s.idx);
        }

        for (const idx of eventSigs) {
            const cp = ensureCommentPlot(tabId);
            setCommentPlotSignal(cp, idx);
        }
    }
}

// Hydratation paresseuse d'un onglet importe: construit ses graphes au premier affichage
// puis declenche le fetch. Sans effet si deja hydrate ou sans layout differe. Retourne true
// si une hydratation a eu lieu (l'onglet doit etre actif a l'appel).
function hydrateTabIfNeeded(tabId) {
    const tab = S.tabs.find(t => t.id === tabId);
    if (!tab || tab._hydrated || !tab._pendingLayout) return false;
    tab._hydrated = true;
    const spec = tab._pendingLayout;
    tab._pendingLayout = null;
    buildTabPlots(tabId, spec);
    refreshAllPlots();
    return true;
}

window.hydrateTabIfNeeded = hydrateTabIfNeeded;

// Facade pour tabs.js: globalView est un module-local d'app.js, mais switchTab doit
// pouvoir la lire (memoriser la fenetre de l'onglet quitte) et la reecrire (restaurer
// celle de l'onglet ouvert quand la synchronisation est coupee).
// Rejoue les rendus sautes pendant que l'onglet etait cache (donnees arrivees en
// arriere-plan). Depuis le cache uniquement: aucun appel reseau.
function replayPendingRenders() {
    S.plots.forEach(plot => {
        if (!plot._needsRender) return;
        plot._needsRender = false;
        if (plot.signals.length === 0) return;
        if (plot.isCommentPlot) { renderCommentPlot(plot); return; }
        if (!canRenderFromCache(plot, ectx.globalView.min, ectx.globalView.max)) return;
        if (plotHasSynth(plot)) renderOverlayFromCache(plot);
        else if (plot.isBoolPlot) renderBoolPlot(plot);
        else renderPlotFromCacheFiltered(plot);
    });
}

window.replayPendingRenders = replayPendingRenders;

window.getGlobalView = () => ({ min: ectx.globalView.min, max: ectx.globalView.max });

window.setGlobalView = (v) => {
    if (!v || !Number.isFinite(v.min) || !Number.isFinite(v.max)) return;
    ectx.globalView = { min: v.min, max: v.max };
};

window.applyGlobalViewLocal = applyGlobalViewLocal;

export async function applyLayout(layout) {
    if (!layout || !layout.tabs) {
        console.error('Layout invalide');
        return false;
    }
    
    // Créer un map nom -> index pour les signaux actuels
    const signalNameToIndex = {};
    S.signalsInfo.forEach(sig => {
        signalNameToIndex[sig.name] = sig.index;
    });
    
    // 1. D'abord créer les variables calculées si nécessaire
    if (layout.computed_variables && layout.computed_variables.length > 0) {
        for (const cv of layout.computed_variables) {
            // Vérifier si elle existe déjà
            const existing = S.signalsInfo.find(s => s.name === cv.name && s.computed);
            if (!existing) {
                // Reconstruire le mapping A, B, C... -> signal names
                const mapping = {};
                const formulaVars = [...new Set((cv.formula.match(/\b([A-Z])\b/g) || []))].sort();
                
                formulaVars.forEach((varLetter, idx) => {
                    if (idx < (cv.source_signals || []).length) {
                        const sourceName = cv.source_signals[idx];
                        if (signalNameToIndex[sourceName] !== undefined) {
                            mapping[varLetter] = sourceName;
                        }
                    }
                });
                
                // Créer la variable si tous les signaux sources existent
                if (Object.keys(mapping).length === formulaVars.length) {
                    try {
                        const cvHeaders = { 'Content-Type': 'application/json' };
                        const cvToken = sessionStorage.getItem('auth_token');
                        if (cvToken) cvHeaders['Authorization'] = 'Bearer ' + cvToken;
                        const response = await fetch(`${API}/create-variable`, {
                            method: 'POST',
                            headers: cvHeaders,
                            body: JSON.stringify({
                                name: cv.name,
                                unit: cv.unit || '',
                                description: cv.description || '',
                                formula: cv.formula,
                                mapping: mapping,
                                session_id: ectx.currentLazySessionId
                            })
                        });
                        
                        if (response.ok) {
                            console.log(`Created computed variable: ${cv.name}`);
                        }
                    } catch (e) {
                        console.warn(`Failed to create computed variable ${cv.name}:`, e);
                    }
                } else {
                    console.warn(`Cannot create ${cv.name}: missing source signals`);
                }
            }
        }
        
        // Recharger signalsInfo depuis la bonne source (session lazy si active, sinon /info),
        // sinon les variables recreees sur la session ne sont pas refletees et restent
        // introuvables (message "variables n'existent pas" au changement de fichier).
        if (ectx.currentLazySessionId) {
            const rlHeaders = {};
            const rlToken = sessionStorage.getItem('auth_token');
            if (rlToken) rlHeaders['Authorization'] = 'Bearer ' + rlToken;
            const listRes = await fetch(`${API}/eda/list-signals/${ectx.currentLazySessionId}`, { headers: rlHeaders });
            const listing = await listRes.json();
            S.signalsInfo = listing.signals;
            const activeRun = S.runs.find(r => r.sessionId === ectx.currentLazySessionId);
            if (activeRun) {
                activeRun.nameToIndex = new Map(listing.signals.map(s => [s.name, s.index]));
                activeRun.signals = listing.signals;
            }
        } else {
            const infoRes = await fetch(`${API}/info`);
            const info = await infoRes.json();
            S.signalsInfo = info.signals;
        }
        S.signalsInfo.forEach(sig => {
            signalNameToIndex[sig.name] = sig.index;
        });
        renderSignalList();
    }
    
    // 2. Effacer les tabs existants
    const tabIds = S.tabs.map(t => t.id);
    tabIds.forEach(id => {
        const tab = S.tabs.find(t => t.id === id);
        if (tab && tab.plots) {
            tab.plots.forEach(p => {
                if (p.chart) p.chart.destroy();
            });
        }
        // Supprimer le contenu DOM de ce tab
        const tabContent = document.getElementById(`content-${id}`);
        if (tabContent) tabContent.remove();
    });
    S.tabs = [];
    S.plots = [];
    S.activeTabId = null;
    
    // Rafraîchir la liste des tabs (vide maintenant)
    renderTabs();
    
    // 3. Creer tous les onglets, mais ne construire les graphes que de l'onglet actif.
    // Les autres onglets sont hydrates a la demande (premier affichage via switchTab),
    // ce qui evite de recuperer toutes les voies des 9 onglets en une seule fois.
    let firstTabId = null;
    for (let tabIdx = 0; tabIdx < layout.tabs.length; tabIdx++) {
        const layoutTab = layout.tabs[tabIdx];
        const tabId = createTab(layoutTab.name, false); // ne pas activer: ni churn ni build
        const tab = S.tabs.find(t => t.id === tabId);
        if (tab) {
            tab._pendingLayout = layoutTab.plots || [];
            tab._hydrated = false;
        }
        if (tabIdx === 0) firstTabId = tabId;
    }

    // Activer le premier onglet declenche son hydratation (build + fetch) via switchTab.
    if (firstTabId) {
        switchTab(firstTabId);
    } else {
        renderTabs();
    }

    if (typeof window.bbTrack === 'function') window.bbTrack('layout_applied');
    return true;
}

