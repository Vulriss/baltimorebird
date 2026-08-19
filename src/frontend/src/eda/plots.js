// Baltimore Bird - Gestion des panneaux: creation, depot, deplacement, splitters
// Module extrait de app.js (refactoring): voir src/eda/ARCHITECTURE.md

import { S } from '../core/state.js';
import { getUnitConversion } from '../core/units.js';
import { resizePlotCharts } from './bootstrap.js';
import { ectx } from './context.js';
import { updateCursorReadout } from './cursors.js';
import { setCommentPlotSignal } from './events-strip.js';
import { applyLegendWidthTo, startLegendResize } from './legend-width.js';
import { addOverlaySeries, isSeriesSynth, plotHasSynth } from './overlay.js';
import { cleanupExtendedZones, deletePlot, deletePlotInTab, updatePlotHeader, updateSignalActiveStates } from './plot-legend.js';
import { autoScaleY, exitSolo, plotIconSvg, renderPlotFromCache, rerenderPlotFromCache, soloPlot, toggleSoloPlot, toggleYLock } from './plot-ui.js';
import { fetchAndRenderPlot } from './render.js';

// Redimensionne tous les graphes a la taille actuelle de leur conteneur.
export function resizeAllChartsNow() {
    S.plots.forEach(plot => {
        if (!plot.chart) return;
        const body = plot.element.querySelector('.plot-body');
        if (body) plot.chart.setSize({ width: body.clientWidth, height: body.clientHeight });
    });
}

// =========================================================================
// Plot Management
// =========================================================================
// Indique si un signal est booleen (route vers le plot booleen dedie).
export function isBoolSignalIndex(signalIndex) {
    return S.signalsInfo[signalIndex]?.unit === 'bool';
}

// Signal special "commentaires" (events Ctrl+K INCA): pas une serie de valeurs, mais un
// jeu de points horodates rendu dans un strip dedie. Reconnu au champ kind du descripteur.
export function isEventSignalIndex(signalIndex) {
    return S.signalsInfo[signalIndex]?.kind === 'event';
}

// Reconstruit l'ordre DOM des panneaux et les splitters depuis le tableau plots
// (le plot booleen reste en dernier). Reinitialise les flex pour une repartition
// equitable: corrige le panneau ajoute hors-ecran et le splitter manquant apres
// redimensionnements manuels.
export function rebuildPlotsLayout(tabId) {
    const wrapper = document.getElementById(`plotsWrapper-${tabId}`);
    if (!wrapper) return;

    wrapper.querySelectorAll('.splitter').forEach(s => s.remove());

    // Un strip booleen/commentaires garde sa hauteur compacte tant qu'il coexiste avec
    // des panneaux analogiques. S'il est SEUL (onglet 100% booleens), la hauteur fixe
    // laisserait un grand vide en dessous: il prend alors tout l'espace disponible.
    const hasAnalog = S.plots.some(p => !p.isBoolPlot && !p.isCommentPlot);

    S.plots.forEach(p => {
        // Seuls les panneaux analogiques sont reequilibres; les strips booleen/commentaires
        // gardent leur hauteur (compacte par defaut ou ajustee au splitter).
        if (!p.isBoolPlot && !p.isCommentPlot) {
            p.element.style.flex = '1';
        } else if (!hasAnalog) {
            // Seul(s) dans l'onglet: occupe(nt) toute la hauteur.
            p.element.style.flex = '1';
            p._expandedAlone = true;
        } else if (p._expandedAlone) {
            // Un panneau analogique est (re)venu: retour a la hauteur compacte.
            p.element.style.flex = p.isCommentPlot ? '0 0 64px' : '0 0 88px';
            p._expandedAlone = false;
        }
        wrapper.appendChild(p.element); // deplace le noeud existant dans l'ordre
    });

    for (let i = 1; i < S.plots.length; i++) {
        const splitter = document.createElement('div');
        splitter.className = 'splitter';
        splitter.dataset.above = S.plots[i - 1].id;
        splitter.dataset.below = S.plots[i].id;
        wrapper.insertBefore(splitter, S.plots[i].element);
        setupSplitter(splitter);
    }
}

export function createPlotInTab(tabId, signalIndex = null, { isBoolPlot = false, isCommentPlot = false } = {}) {
    const tab = S.tabs.find(t => t.id === tabId);
    if (!tab) return;

    const wrapper = document.getElementById(`plotsWrapper-${tabId}`);
    if (!wrapper) return;

    const id = `plot-${tabId}-${tab.plotIdCounter++}`;

    const empty = document.getElementById(`emptyPlot-${tabId}`);
    if (empty) empty.remove();

    const container = document.createElement('div');
    container.className = 'plot-container';
    container.id = id;
    // Les strips booleen et commentaires n'ont pas besoin d'autant de hauteur qu'un panneau
    // analogique: hauteur fixe compacte (0 0 Npx), preservee au re-layout et donc non
    // reequilibree quand on ajoute un signal ailleurs. Reste redimensionnable au splitter.
    if (isBoolPlot) container.classList.add('bool-strip');
    if (isCommentPlot) container.classList.add('comment-strip');
    container.style.flex = isCommentPlot ? '0 0 64px' : (isBoolPlot ? '0 0 88px' : '1');

    const plotMain = document.createElement('div');
    plotMain.className = 'plot-main';

    const plotBody = document.createElement('div');
    plotBody.className = 'plot-body';
    const chartDiv = document.createElement('div');
    chartDiv.className = 'chart';
    plotBody.appendChild(chartDiv);

    const plotLegend = document.createElement('div');
    plotLegend.className = 'plot-legend';
    applyLegendWidthTo(plotLegend);

    // Splitter vertical entre le graphe et sa legende. Le redimensionnement est
    // lie: il regle la largeur partagee de toutes les legendes.
    const legendSplitter = document.createElement('div');
    legendSplitter.className = 'legend-splitter';
    legendSplitter.style.cssText = 'flex:0 0 5px;cursor:col-resize;'
        + 'background:rgba(255,255,255,0.04);align-self:stretch;';
    legendSplitter.addEventListener('mousedown', (e) => startLegendResize(e, plotMain, legendSplitter));

    plotMain.appendChild(plotBody);
    plotMain.appendChild(legendSplitter);
    plotMain.appendChild(plotLegend);

    // Barre reduite a la seule croix de suppression (overlay en bas a droite),
    // pour maximiser la zone utile du plot-body.
    const plotStats = document.createElement('div');
    plotStats.className = 'plot-stats';

    // Boutons reserves aux panneaux analogiques (ordre affiche: ⇕ ⠿ ✕):
    // - l'echelle Y d'un strip booleen/commentaires est fixe (voies empilees),
    //   l'auto-Y n'y a pas de sens;
    // - ces strips sont ancres en bas par construction (createPlotInTab insere
    //   les analogiques avant eux), les deplacer serait annule au prochain ajout.
    if (!isBoolPlot && !isCommentPlot) {
        const autoYBtn = document.createElement('button');
        autoYBtn.className = 'plot-autoy';
        autoYBtn.title = 'Cadrage Y automatique (Shift+Y sur le panneau survole)';
        autoYBtn.setAttribute('aria-label', 'Cadrage Y automatique');
        autoYBtn.textContent = '⇕';
        autoYBtn.addEventListener('click', () => {
            const plot = S.plots.find(p => p.id === id);
            autoScaleY(plot);
        });
        plotStats.appendChild(autoYBtn);

        const lockBtn = document.createElement('button');
        lockBtn.className = 'plot-lock';
        lockBtn.setAttribute('aria-label', 'Verrouiller l\'echelle Y');
        // Etat initial: Y libre (cadrage auto). updateYLockButton prend le relais
        // ensuite; ici l'objet plot n'existe pas encore.
        lockBtn.innerHTML = plotIconSvg('unlock');
        lockBtn.title = 'Verrouiller l\'echelle Y (elle ne se recadrera plus au zoom/pan)';
        lockBtn.addEventListener('click', () => {
            toggleYLock(S.plots.find(p => p.id === id));
        });
        plotStats.appendChild(lockBtn);

        const soloBtn = document.createElement('button');
        soloBtn.className = 'plot-solo-btn';
        soloBtn.setAttribute('aria-label', 'Agrandir ce panneau seul');
        soloBtn.innerHTML = plotIconSvg('maximize');
        soloBtn.title = 'Agrandir ce panneau seul';
        soloBtn.addEventListener('click', () => {
            toggleSoloPlot(S.plots.find(p => p.id === id));
        });
        plotStats.appendChild(soloBtn);

        const grip = document.createElement('button');
        grip.className = 'plot-grip';
        grip.title = 'Glisser pour deplacer ce panneau';
        grip.setAttribute('aria-label', 'Deplacer ce panneau');
        grip.textContent = '⠿';
        grip.draggable = true;
        grip.addEventListener('dragstart', e => {
            S.draggedPlotId = id;
            // Neutralise le drag de signal: le drop d'un panneau ne doit pas
            // etre interprete comme un depot de signal par setupPlotDropZone.
            S.draggedSignal = null;
            S.draggedSignalGroup = [];
            S.draggedFromPlotId = null;
            container.classList.add('plot-dragging');
            e.dataTransfer.effectAllowed = 'move';
            // Firefox exige une donnee pour amorcer le drag.
            try { e.dataTransfer.setData('text/plain', id); } catch (_) { /* ignore */ }
        });
        grip.addEventListener('dragend', () => {
            S.draggedPlotId = null;
            container.classList.remove('plot-dragging');
            clearPlotDropMarkers();
        });
        plotStats.appendChild(grip);
    }

    // Panneau survole: cible du raccourci Shift+Y (le keydown a pour cible le
    // body, pas l'element sous le curseur).
    container.addEventListener('mouseenter', () => { ectx.hoveredPlotId = id; });
    container.addEventListener('mouseleave', () => {
        if (ectx.hoveredPlotId === id) ectx.hoveredPlotId = null;
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'plot-delete';
    deleteBtn.title = 'Supprimer';
    deleteBtn.textContent = '✕';
    deleteBtn.addEventListener('click', () => {
        deletePlotInTab(tabId, id);
    });

    plotStats.appendChild(deleteBtn);

    container.appendChild(plotMain);
    container.appendChild(plotStats);

    wrapper.appendChild(container);
    setupPlotDropZone(container, id);

    const plot = {
        id,
        tabId,
        element: container,
        signals: [],
        chart: null,
        cachedData: {},
        // Unité de référence du graphe (fixée par le premier signal). Les signaux suivants
        // sont convertis vers cette unité si possible; sinon marqués en erreur.
        unit: '',
        unitConversions: {},
        unitErrors: new Set(),
        // Borne Y explicite { min, max } posee par un zoom Y/boite, ou null
        // (auto-cadrage de l'echelle Y sur les donnees visibles).
        yRange: null,
        // Plot booleen dedie (lanes discretes), maintenu en bas du panneau.
        isBoolPlot,
        // Plot commentaires dedie (points d'events Ctrl+K), maintenu tout en bas.
        isCommentPlot
    };

    // Panneau le plus bas avant insertion: s'il cesse de l'etre, son axe
    // temporel doit disparaitre.
    const prevLast = S.plots.length ? S.plots[S.plots.length - 1] : null;

    // Ordre vertical des panneaux: analogiques, puis le booleen, puis les commentaires
    // (toujours tout en bas). On insere avant l'ancre appropriee.
    if (isCommentPlot) {
        S.plots.push(plot);
    } else if (isBoolPlot) {
        const commentIdx = S.plots.findIndex(p => p.isCommentPlot);
        if (commentIdx === -1) S.plots.push(plot);
        else S.plots.splice(commentIdx, 0, plot);
    } else {
        const anchorIdx = S.plots.findIndex(p => p.isBoolPlot || p.isCommentPlot);
        if (anchorIdx === -1) S.plots.push(plot);
        else S.plots.splice(anchorIdx, 0, plot);
    }
    // Un panneau qui vient d'etre cree doit etre visible: si un autre etait
    // affiche seul, le nouveau resterait masque (ou s'afficherait a cote avec les
    // splitters caches). On sort du solo, l'ajout prime.
    if (soloPlot()) exitSolo(tabId);

    tab.plots = S.plots;

    rebuildPlotsLayout(tabId);

    if (signalIndex !== null) {
        addSignalToPlot(id, signalIndex);
    }

    if (prevLast && prevLast.id !== S.plots[S.plots.length - 1].id) {
        rerenderPlotFromCache(prevLast);
    }
    return id;
}

// Retourne le plot booleen du tab actif, en le creant en bas si necessaire.
export function ensureBoolPlot(tabId) {
    let bp = S.plots.find(p => p.isBoolPlot);
    if (!bp) {
        const id = createPlotInTab(tabId, null, { isBoolPlot: true });
        bp = S.plots.find(p => p.id === id);
    }
    return bp;
}

// Retourne le plot commentaires du tab actif, en le creant tout en bas si necessaire.
export function ensureCommentPlot(tabId) {
    let cp = S.plots.find(p => p.isCommentPlot);
    if (!cp) {
        const id = createPlotInTab(tabId, null, { isCommentPlot: true });
        cp = S.plots.find(p => p.id === id);
    }
    return cp;
}

// Point d'entree unique d'un depot de signal. Tout booleen va sur le plot
// booleen dedie (cree en bas au besoin). Retourne l'id du plot destinataire.
export function dropSignal(signalIndex, targetPlotId = null) {
    return dropSignalGroup([signalIndex], targetPlotId);
}

// Depot d'un groupe de signaux: les booleens rejoignent le plot booleen dedie, les
// analogiques le plot cible (ou un nouveau plot commun), avec un seul fetch par plot
// destinataire. Retourne l'id du plot principal (analogique si present, sinon booleen).
export function dropSignalGroup(signalIndices, targetPlotId = null) {
    const events = signalIndices.filter(isEventSignalIndex);
    const rest = signalIndices.filter(idx => !isEventSignalIndex(idx));
    const bools = rest.filter(isBoolSignalIndex);
    const analogs = rest.filter(idx => !isBoolSignalIndex(idx));
    let destId = null;

    if (analogs.length) {
        let plot = targetPlotId ? S.plots.find(p => p.id === targetPlotId && !p.isBoolPlot && !p.isCommentPlot) : null;
        if (!plot) {
            const id = createPlotInTab(S.activeTabId, null);
            plot = S.plots.find(p => p.id === id);
        }
        addSignalsToPlot(plot.id, analogs);
        destId = plot.id;
    }
    if (bools.length) {
        const bp = ensureBoolPlot(S.activeTabId);
        addSignalsToPlot(bp.id, bools);
        if (destId === null) destId = bp.id;
    }
    // Le signal commentaires est unique par fichier: il alimente le strip dedie, quel que
    // soit le panneau cible du drop. On ne garde que le dernier si plusieurs sont deposes.
    if (events.length) {
        const cp = ensureCommentPlot(S.activeTabId);
        setCommentPlotSignal(cp, events[events.length - 1]);
        if (destId === null) destId = cp.id;
    }
    return destId;
}

// Keep old createPlot for compatibility, redirect to tab version
function createPlot(signalIndex) {
    return createPlotInTab(S.activeTabId, signalIndex);
}

function setupSplitter(splitter) {
    let startY, startHeightAbove, startHeightBelow, aboveEl, belowEl;

    splitter.addEventListener('mousedown', e => {
        e.preventDefault();
        
        aboveEl = document.getElementById(splitter.dataset.above);
        belowEl = document.getElementById(splitter.dataset.below);
        
        if (!aboveEl || !belowEl) return;

        startY = e.clientY;
        startHeightAbove = aboveEl.offsetHeight;
        startHeightBelow = belowEl.offsetHeight;
        
        splitter.classList.add('active');
        document.body.style.cursor = 'row-resize';
        document.body.style.userSelect = 'none';

        aboveEl.querySelector('.chart').style.visibility = 'hidden';
        belowEl.querySelector('.chart').style.visibility = 'hidden';

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    });

    function onMouseMove(e) {
        // On conserve la hauteur combinee des deux panneaux adjacents: la somme
        // reste constante, donc la hauteur totale de la zone ne change pas et
        // aucun panneau n'est pousse hors de la fenetre. Le minimum est aligne sur le
        // min-height CSS de chaque panneau: compact pour les strips booleen/commentaires
        // (sinon ils ne pourraient pas retrecir en dessous de 100px), 100px sinon.
        const minFor = (el) => el.classList.contains('comment-strip') ? 40
            : (el.classList.contains('bool-strip') ? 56 : 100);
        const minAbove = minFor(aboveEl);
        const minBelow = minFor(belowEl);
        const total = startHeightAbove + startHeightBelow;
        const delta = e.clientY - startY;
        let above = Math.max(minAbove, Math.min(total - minBelow, startHeightAbove + delta));
        const below = total - above;
        aboveEl.style.flex = `0 0 ${above}px`;
        belowEl.style.flex = `0 0 ${below}px`;
    }

    function onMouseUp() {
        splitter.classList.remove('active');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);

        aboveEl.querySelector('.chart').style.visibility = '';
        belowEl.querySelector('.chart').style.visibility = '';

        const plotAbove = S.plots.find(p => p.id === aboveEl.id);
        const plotBelow = S.plots.find(p => p.id === belowEl.id);
        
        if (plotAbove?.chart) {
            const body = aboveEl.querySelector('.plot-body');
            plotAbove.chart.setSize({ width: body.clientWidth, height: body.clientHeight });
        }
        if (plotBelow?.chart) {
            const body = belowEl.querySelector('.plot-body');
            plotBelow.chart.setSize({ width: body.clientWidth, height: body.clientHeight });
        }
    }
}

// Retire les marqueurs d'insertion laisses par un glisser-deposer de panneau.
function clearPlotDropMarkers() {
    document.querySelectorAll('.plot-drop-above, .plot-drop-below')
        .forEach(el => el.classList.remove('plot-drop-above', 'plot-drop-below'));
}

// Reordonne le DOM (panneaux + splitters) depuis S.plots SANS toucher aux flex,
// contrairement a rebuildPlotsLayout qui les reinitialise a '1'. Un simple
// deplacement de panneau ne doit pas faire perdre les hauteurs reglees au splitter.
function reorderPlotsDom(tabId) {
    const wrapper = document.getElementById(`plotsWrapper-${tabId}`);
    if (!wrapper) return;
    wrapper.querySelectorAll('.splitter').forEach(s => s.remove());
    S.plots.forEach(p => wrapper.appendChild(p.element));
    for (let i = 1; i < S.plots.length; i++) {
        const splitter = document.createElement('div');
        splitter.className = 'splitter';
        splitter.dataset.above = S.plots[i - 1].id;
        splitter.dataset.below = S.plots[i].id;
        wrapper.insertBefore(splitter, S.plots[i].element);
        setupSplitter(splitter);
    }
}

// Deplace le panneau `draggedId` juste avant (before=true) ou apres le panneau
// `targetId`. Seuls les panneaux analogiques bougent: l'ordre analogiques ->
// booleen -> commentaires est un invariant du layout (cf. createPlotInTab).
function movePlot(draggedId, targetId, before) {
    if (!draggedId || draggedId === targetId) return;
    const from = S.plots.findIndex(p => p.id === draggedId);
    const target = S.plots.find(p => p.id === targetId);
    if (from === -1 || !target) return;
    const moved = S.plots[from];
    if (moved.isBoolPlot || moved.isCommentPlot) return;
    if (target.isBoolPlot || target.isCommentPlot) return;

    const prevFirst = S.plots[0];
    const prevLast = S.plots[S.plots.length - 1];

    S.plots.splice(from, 1);
    let to = S.plots.findIndex(p => p.id === targetId);
    if (to === -1) { S.plots.splice(from, 0, moved); return; }
    S.plots.splice(before ? to : to + 1, 0, moved);

    const tab = S.tabs.find(t => t.id === moved.tabId);
    if (tab) tab.plots = S.plots;

    reorderPlotsDom(moved.tabId);

    // Le bandeau de legende (Name/A/B/Δ/unit + ligne t) n'existe que sur S.plots[0]:
    // si le premier panneau change, reconstruire l'ancien (pour l'enlever) et le
    // nouveau (pour le poser).
    const newFirst = S.plots[0];
    if (prevFirst !== newFirst) {
        updatePlotHeader(prevFirst);
        updatePlotHeader(newFirst);
        updateCursorReadout(newFirst);
    }
    // Idem pour l'axe temporel, porte par le dernier panneau uniquement.
    const newLast = S.plots[S.plots.length - 1];
    if (prevLast !== newLast) {
        rerenderPlotFromCache(prevLast);
        rerenderPlotFromCache(newLast);
    }

    setTimeout(resizePlotCharts, 50);
}

function setupPlotDropZone(element, plotId) {
    element.addEventListener('dragover', e => {
        e.preventDefault();
        // Deplacement de panneau: marqueur d'insertion haut/bas selon la moitie
        // survolee, et pas de surlignage "cible de depot de signal".
        if (S.draggedPlotId) {
            const plot = S.plots.find(p => p.id === plotId);
            if (!plot || plot.isBoolPlot || plot.isCommentPlot || plotId === S.draggedPlotId) return;
            const r = element.getBoundingClientRect();
            const before = (e.clientY - r.top) < r.height / 2;
            element.classList.toggle('plot-drop-above', before);
            element.classList.toggle('plot-drop-below', !before);
            return;
        }
        element.classList.add('drop-target');
    });
    element.addEventListener('dragleave', () => {
        element.classList.remove('drop-target', 'plot-drop-above', 'plot-drop-below');
    });
    element.addEventListener('drop', e => {
        e.preventDefault();
        element.classList.remove('drop-target');

        if (S.draggedPlotId) {
            const r = element.getBoundingClientRect();
            const before = (e.clientY - r.top) < r.height / 2;
            const dragged = S.draggedPlotId;
            S.draggedPlotId = null;
            clearPlotDropMarkers();
            document.querySelectorAll('.plot-dragging')
                .forEach(el => el.classList.remove('plot-dragging'));
            movePlot(dragged, plotId, before);
            return;
        }

        if (S.draggedSignal !== null) {
            const group = (S.draggedSignalGroup && S.draggedSignalGroup.length)
                ? S.draggedSignalGroup : [S.draggedSignal];
            const fromPlotId = S.draggedFromPlotId;

            // capture les modifs de chaque signal avant de le remove/effacer
            const sourcePlot = fromPlotId !== null ? S.plots.find(p => p.id === fromPlotId) : null;
            const carriedOver = new Map();
            if (sourcePlot) {
                group.forEach(idx => {
                    carriedOver.set(idx, {
                        style: sourcePlot.signalStyles?.[idx] ? { ...sourcePlot.signalStyles[idx] } : null,
                        transform: sourcePlot.signalTransforms?.[idx] ? { ...sourcePlot.signalTransforms[idx] } : null,
                    });
                });
            }

            const destId = dropSignalGroup(group, plotId);
            if (fromPlotId !== null && fromPlotId !== destId) {
                group.forEach(idx => removeSignalFromPlot(fromPlotId, idx));
            }

            // Re applique les modifs captures sur le plot destinataire
            if (destId !== null && fromPlotId !== destId) {
                const destPlot = S.plots.find(p => p.id === destId);
                if (destPlot) {
                    let changed = false;
                    group.forEach(idx => {
                        const carried = carriedOver.get(idx);
                        if (!carried) return;
                        if (carried.style) {
                            if (!destPlot.signalStyles) destPlot.signalStyles = {};
                            destPlot.signalStyles[idx] = carried.style;
                            changed = true;
                        }
                        if (carried.transform) {
                            if (!destPlot.signalTransforms) destPlot.signalTransforms = {};
                            destPlot.signalTransforms[idx] = carried.transform;
                            changed = true;
                        }
                    });
                    if (changed) {
                        updatePlotHeader(destPlot);
                        if (plotHasSynth(destPlot)) fetchAndRenderPlot(destPlot);
                        else renderPlotFromCache(destPlot);
                    }
                }
            }
        }
    });
}

function isConvertibleUnitSignal(sig) {
    const unit = (sig.unit || '').trim();
    if (!unit || unit === 'bool' || unit === 'state') return false;
    if (sig.isCategorical || sig.stringMap) return false;
    return true;
}

// Tente d'aligner l'unité du signal ajouté sur celle déjà présente dans le graphe.
// Premier signal: fixe l'unité de référence. Signal suivant: stocke un facteur de
// conversion (appliqué au cache) ou marque l'unité en erreur si la conversion est impossible.
function adaptSignalUnit(plot, signalIndex) {
    if (plot.isBoolPlot) return;
    if (!plot.unitConversions) plot.unitConversions = {};
    if (!plot.unitErrors) plot.unitErrors = new Set();

    const sig = S.signalsInfo[signalIndex];
    if (!sig) return;
    const unit = (sig.unit || '').trim();

    if (plot.signals.length === 0) {
        plot.unit = unit;
        return;
    }

    if (!plot.unit || !isConvertibleUnitSignal(sig) || unit === plot.unit) return;

    const conv = getUnitConversion(unit, plot.unit);
    if (conv) {
        plot.unitConversions[signalIndex] = conv;
        if (typeof showNotification === 'function') {
            showNotification(`Unité convertie : ${unit} → ${plot.unit}`, 'info');
        }
    } else {
        plot.unitErrors.add(signalIndex);
        if (typeof showNotification === 'function') {
            showNotification(
                `Unité « ${unit} » incompatible avec « ${plot.unit} » - signal ajouté sans conversion`,
                'warning'
            );
        }
    }
}

export function addSignalToPlot(plotId, signalIndex) {
    addSignalsToPlot(plotId, [signalIndex]);
}

// Ajout d'un lot de signaux a un plot avec un seul fetch, quel que soit le nombre de
// signaux (le serveur les charge en une passe batch). En mode comparaison, chaque
// signal devient une serie overlay par nom, comme pour un ajout unitaire.
function addSignalsToPlot(plotId, signalIndices) {
    const plot = S.plots.find(p => p.id === plotId);
    if (!plot) return;

    // Mode comparaison: un signal reel devient une serie overlay par nom; les indices
    // synthetiques (series overlay existantes) suivent le chemin standard ci-dessous.
    let toAdd = signalIndices;
    if (S.comparing) {
        toAdd = [];
        for (const idx of signalIndices) {
            if (isSeriesSynth(idx)) {
                toAdd.push(idx);
                continue;
            }
            const dropped = S.signalsInfo[idx];
            if (dropped) addOverlaySeries(plot, dropped.name);
        }
        if (!toAdd.length) return;
    }

    let added = false;
    for (const idx of toAdd) {
        if (plot.signals.includes(idx)) continue;
        adaptSignalUnit(plot, idx);
        plot.signals.push(idx);
        added = true;
    }
    if (!added) return;

    updatePlotHeader(plot);
    fetchAndRenderPlot(plot);
    updateSignalActiveStates();
    setTimeout(resizePlotCharts, 100);
}

export function updateSignalsLoadedStatus(signalsStatus) {
    if (!signalsStatus || !Array.isArray(signalsStatus)) return;
    
    signalsStatus.forEach(status => {
        const sig = S.signalsInfo.find(s => s.index === status.index);
        if (sig && sig.loaded !== status.loaded) {
            sig.loaded = status.loaded;
            
            const item = document.getElementById(`signal-item-${status.index}`);
            if (item) {
                const dot = item.querySelector('.signal-dot');
                
                if (status.loaded) {
                    item.classList.remove('not-loaded');
                    item.draggable = true;
                    if (dot) dot.classList.remove('lazy-indicator');
                } else {
                    item.classList.add('not-loaded');
                    item.draggable = false;
                    if (dot) dot.classList.add('lazy-indicator');
                }
            }
        }
    });
}

export function removeSignalFromPlot(plotId, signalIndex) {
    const plot = S.plots.find(p => p.id === plotId);
    if (!plot) return;

    // La cle peut arriver en chaine (dataset DOM) ou en nombre (etat JS): comparaison
    // robuste pour retirer la bonne serie (index reel ou cle synthetique d'overlay).
    const key = (typeof signalIndex === 'string' && /^\d+$/.test(signalIndex))
        ? Number(signalIndex) : signalIndex;

    plot.signals = plot.signals.filter(s => s !== key);
    delete plot.cachedData[key];
    if (plot._derivedCache) delete plot._derivedCache[key];
    if (plot.signalTransforms) delete plot.signalTransforms[key];
    if (plot.unitConversions) delete plot.unitConversions[key];
    if (plot.unitErrors) plot.unitErrors.delete(key);
    cleanupExtendedZones(key);

    if (plot.signals.length === 0) {
        deletePlot(plotId);
    } else {
        updatePlotHeader(plot);
        if (plotHasSynth(plot)) fetchAndRenderPlot(plot);
        else renderPlotFromCache(plot);
    }
    updateSignalActiveStates();
}

export function colorWithOpacity(color, opacity) {
    // Si déjà en hex
    if (color.startsWith('#')) {
        const hex = Math.round(opacity * 255).toString(16).padStart(2, '0');
        return color + hex;
    }
    // Si rgb/hsl, utilise canvas pour convertir
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

function isSteppedSignal(sigData) {
    if (!sigData) return false;
    return sigData.isCategorical || sigData.unit === 'state' || sigData.unit === 'bool';
}

