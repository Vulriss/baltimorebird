// Baltimore Bird - Curseurs C1/C2: plugin uPlot, mesures, clavier, selection legende
// Module extrait de app.js (refactoring): voir src/eda/ARCHITECTURE.md

import { S } from '../core/state.js';
import { resizePlotCharts } from './bootstrap.js';
import { ectx } from './context.js';
import { isSeriesSynth, seriesDescriptor } from './overlay.js';
import { autoScaleY, isFirstPlot, renderPlotFromCache, resolveSignalStyle } from './plot-ui.js';
import { removeSignalFromPlot } from './plots.js';
import { effectiveRunOffset } from './runs.js';
import { effectiveCache } from './transforms.js';
import { redoView, undoView } from './view-nav.js';

// =========================================================================
// Cursors
// =========================================================================
export function cursorPlugin() {
    let line1, line2;
    let timeLabel1, timeLabel2;
    let deltaLine, deltaLabel;
    let labelPool1 = [];
    let labelPool2 = [];
    let over;
    let draggingCursor = null;
    let dragRafId = null;
    let pendingClientX = 0;
    let dragOverRect = null;
    let onDocMouseMove = null;
    let onDocMouseUp = null;

    // Hauteur d'une ligne de label (px) et espace reserve en haut pour les labels
    // de temps/delta empiles, recalcule a chaque rendu par updateTimeLabels.
    const LABEL_ROW_H = 18;
    const VALUE_LABEL_H = 18;
    let topReserved = 2 + LABEL_ROW_H;

    // Place un label en haut (temps/delta) sur la premiere ligne libre evitant le
    // chevauchement horizontal avec ceux deja places. Retourne l'indice de ligne.
    function placeTopLabel(placed, centerX, width) {
        const half = width / 2;
        const x0 = centerX - half;
        const x1 = centerX + half;
        let row = 0;
        while (row < 6) {
            const conflict = placed.some(p => p.row === row && !(x1 < p.x0 || x0 > p.x1));
            if (!conflict) break;
            row++;
        }
        placed.push({ row, x0, x1 });
        return row;
    }

    // Largeur estimee d'un label monospace (10px ~6px/char + padding + bordure).
    function estLabelWidth(text) {
        return text.length * 6 + 16;
    }

    // Repartit verticalement des labels de valeurs pour eviter les chevauchements,
    // en restant sous la zone des labels de temps et dans la hauteur du graphe.
    function declutterValueLabels(entries, height) {
        const n = entries.length;
        if (n === 0) return;
        entries.sort((a, b) => a.y - b.y);
        const top = topReserved + VALUE_LABEL_H / 2;
        const bottom = Math.max(top, height - VALUE_LABEL_H / 2);
        let prev = -Infinity;
        for (let i = 0; i < n; i++) {
            const y = Math.max(entries[i].y, top, prev + VALUE_LABEL_H);
            entries[i].y = y;
            prev = y;
        }
        if (entries[n - 1].y > bottom) {
            let next = Infinity;
            for (let i = n - 1; i >= 0; i--) {
                const y = Math.min(entries[i].y, bottom, next - VALUE_LABEL_H);
                entries[i].y = y;
                next = y;
            }
        }
    }

    // Construit, repartit et positionne les labels de valeurs d'un curseur.
    // side='left' place les labels a gauche du curseur, 'right' a droite.
    function layoutCursorValueLabels(u, plot, cursorVal, xPos, labelPool, side) {
        const entries = [];
        plot.signals.forEach(sigIdx => {
            const cached = effectiveCache(plot, sigIdx);
            if (!cached) return;
            // Serie decalee (offset): la valeur affichee a l'abscisse du curseur correspond
            // a l'echantillon brut a (cursorVal - offset). Meme helper que la table de mesure.
            const lookupVal = cursorLookupTime(sigIdx, cursorVal);
            const result = getValueAtTime(cached.timestamps, cached.values, lookupVal, cached.stringMap);
            if (result === null) return;
            const yOff = plot.isBoolPlot ? (plot.laneOffsets?.[sigIdx] || 0) : 0;
            const yPos = u.valToPos(result.numeric + yOff, 'y');
            if (yPos < 0 || yPos > u.height) return;
            // Couleur resolue (inclut l'override utilisateur): cached.color est remis a
            // la couleur serveur a chaque refetch (zoom/dezoom), donc ne pas l'utiliser.
            const color = resolveSignalStyle(plot, sigIdx, cached.color).color;
            entries.push({ y: yPos, color, text: result.display });
        });

        declutterValueLabels(entries, u.height);

        // Bascule du cote d'affichage pres des bords: le cote naturel (gauche pour le
        // curseur de gauche, droite pour celui de droite) ferait sortir les labels de la
        // zone de trace quand le curseur est colle a un bord. On bascule alors vers le
        // cote oppose s'il offre la place. La largeur est estimee sur le label le plus
        // large (meme heuristique monospace que les labels de temps).
        const plotWidth = (u.over ? u.over.offsetWidth : u.width) || 0;
        let maxLabelWidth = 0;
        for (const en of entries) {
            const w = estLabelWidth(en.text);
            if (w > maxLabelWidth) maxLabelWidth = w;
        }
        if (side === 'left' && xPos - 4 - maxLabelWidth < 0
                && xPos + 4 + maxLabelWidth <= plotWidth) {
            side = 'right';
        } else if (side === 'right' && xPos + 4 + maxLabelWidth > plotWidth
                && xPos - 4 - maxLabelWidth >= 0) {
            side = 'left';
        }

        entries.forEach((en, i) => {
            let label = labelPool[i];
            if (!label) {
                label = document.createElement('div');
                label.className = 'cursor-label';
                over.appendChild(label);
                labelPool[i] = label;
            }
            label.style.display = 'block';
            label.style.setProperty('--sig-color', en.color);
            if (label.textContent !== en.text) label.textContent = en.text;
            label.style.transform = side === 'left'
                ? `translate3d(${xPos - 4}px, ${en.y}px, 0) translate(-100%, -50%)`
                : `translate3d(${xPos + 4}px, ${en.y}px, 0) translateY(-50%)`;
        });
        for (let i = entries.length; i < labelPool.length; i++) {
            if (labelPool[i]) labelPool[i].style.display = 'none';
        }
    }

    function updateTimeLabels(u, isFirst) {
        // Le temps des curseurs et le delta ne sont utiles qu'une fois: l'axe X est
        // partage par tous les graphes. On ne les affiche que sur le premier; ailleurs
        // on libere l'espace haut pour les labels de valeurs.
        if (!isFirst) {
            if (timeLabel1) timeLabel1.style.display = 'none';
            if (timeLabel2) timeLabel2.style.display = 'none';
            if (deltaLine) deltaLine.style.display = 'none';
            if (deltaLabel) deltaLabel.style.display = 'none';
            topReserved = 2;
            return;
        }

        const has1 = S.cursor1 !== null;
        const has2 = S.cursor2 !== null;
        const x1 = has1 ? u.valToPos(S.cursor1, 'x') : 0;
        const x2 = has2 ? u.valToPos(S.cursor2, 'x') : 0;
        const placed = [];
        let maxRow = 0;

        // Labels de temps: centres sur leur curseur, empiles en lignes s'ils se
        // chevauchent horizontalement.
        if (has1 && timeLabel1) {
            const text = S.cursor1.toFixed(3) + 's';
            if (timeLabel1.textContent !== text) timeLabel1.textContent = text;
            const row = placeTopLabel(placed, x1, estLabelWidth(text));
            maxRow = Math.max(maxRow, row);
            timeLabel1.style.display = 'block';
            timeLabel1.style.transform =
                `translate3d(${x1 + 3}px, ${row * LABEL_ROW_H}px, 0) translateX(-50%)`;
        } else if (timeLabel1) {
            timeLabel1.style.display = 'none';
        }

        if (has2 && timeLabel2) {
            const text = S.cursor2.toFixed(3) + 's';
            if (timeLabel2.textContent !== text) timeLabel2.textContent = text;
            const row = placeTopLabel(placed, x2, estLabelWidth(text));
            maxRow = Math.max(maxRow, row);
            timeLabel2.style.display = 'block';
            timeLabel2.style.transform =
                `translate3d(${x2 + 3}px, ${row * LABEL_ROW_H}px, 0) translateX(-50%)`;
        } else if (timeLabel2) {
            timeLabel2.style.display = 'none';
        }

        // Delta: ligne au sommet entre les curseurs, label centre sur la premiere
        // ligne libre (sous les labels de temps si necessaire).
        if (has1 && has2 && deltaLine && deltaLabel) {
            const left = Math.min(x1, x2);
            const width = Math.max(x1, x2) - left;

            deltaLine.style.display = 'block';
            deltaLine.style.transform = `translate3d(${left}px, 0, 0)`;
            deltaLine.style.width = width + 'px';

            const deltaText = 'Δ ' + Math.abs(S.cursor2 - S.cursor1).toFixed(3) + 's';
            if (deltaLabel.textContent !== deltaText) deltaLabel.textContent = deltaText;
            const center = left + width / 2;
            const row = placeTopLabel(placed, center, estLabelWidth(deltaText));
            maxRow = Math.max(maxRow, row);
            deltaLabel.style.display = 'block';
            deltaLabel.style.transform =
                `translate3d(${center}px, ${row * LABEL_ROW_H}px, 0) translateX(-50%)`;
        } else {
            if (deltaLine) deltaLine.style.display = 'none';
            if (deltaLabel) deltaLabel.style.display = 'none';
        }

        // Reserve la hauteur occupee par les lignes de labels pour que les labels
        // de valeurs ne les recouvrent pas.
        topReserved = 2 + (maxRow + 1) * LABEL_ROW_H;
    }

    // Positionne lignes, labels et delta des curseurs sans redessiner le canvas.
    // Appelee par le hook draw (zoom, nouvelles donnees) et directement pendant
    // le drag (les echelles ne changent pas: un redraw complet serait du gaspillage).
    function updateOverlay(u) {
        const plot = S.plots.find(p => p.chart === u);
        if (!plot) return;

        updateTimeLabels(u, isFirstPlot(plot));

        // Cote d'affichage des labels de valeurs: avec deux curseurs, celui de
        // gauche affiche a gauche, celui de droite a droite (pas de collision au
        // centre). Avec un seul curseur: a droite.
        let side1 = 'right';
        let side2 = 'right';
        if (S.cursor1 !== null && S.cursor2 !== null) {
            const leftIsCursor1 = u.valToPos(S.cursor1, 'x') <= u.valToPos(S.cursor2, 'x');
            side1 = leftIsCursor1 ? 'left' : 'right';
            side2 = leftIsCursor1 ? 'right' : 'left';
        }

        // --- Cursor 1 ---
        if (S.cursor1 !== null) {
            const xPos = u.valToPos(S.cursor1, 'x');
            line1.style.transform = `translate3d(${xPos}px, 0, 0)`;
            line1.style.display = 'block';
            layoutCursorValueLabels(u, plot, S.cursor1, xPos, labelPool1, side1);
        } else {
            line1.style.display = 'none';
            labelPool1.forEach(l => { if (l) l.style.display = 'none'; });
        }

        // --- Cursor 2 ---
        if (S.cursor2 !== null) {
            const xPos = u.valToPos(S.cursor2, 'x');
            line2.style.transform = `translate3d(${xPos}px, 0, 0)`;
            line2.style.display = 'block';
            layoutCursorValueLabels(u, plot, S.cursor2, xPos, labelPool2, side2);
        } else {
            line2.style.display = 'none';
            labelPool2.forEach(l => { if (l) l.style.display = 'none'; });
        }

        updateCursorReadout(plot);
    }

    return {
        hooks: {
            init: u => {
                over = u.root.querySelector('.u-over');
                
                over.addEventListener('dblclick', e => {
                    undoView();
                });

                line1 = document.createElement('div');
                line1.className = 'cursor-line cursor-1';
                line1.style.display = 'none';
                over.appendChild(line1);

                timeLabel1 = document.createElement('div');
                timeLabel1.className = 'cursor-time-label';
                timeLabel1.style.cssText = '--cursor-color: var(--cursor-a);';
                timeLabel1.style.display = 'none';
                over.appendChild(timeLabel1);

                line2 = document.createElement('div');
                line2.className = 'cursor-line cursor-2';
                line2.style.display = 'none';
                over.appendChild(line2);

                timeLabel2 = document.createElement('div');
                timeLabel2.className = 'cursor-time-label';
                timeLabel2.style.cssText = '--cursor-color: var(--cursor-b);';
                timeLabel2.style.display = 'none';
                over.appendChild(timeLabel2);

                deltaLine = document.createElement('div');
                deltaLine.className = 'cursor-delta-line';
                deltaLine.style.display = 'none';
                over.appendChild(deltaLine);

                deltaLabel = document.createElement('div');
                deltaLabel.className = 'cursor-delta-label';
                deltaLabel.style.display = 'none';
                over.appendChild(deltaLabel);

                // Chemin léger pour le drag des curseurs: repositionne l'overlay
                // de ce chart sans redraw canvas
                u.updateCursorOverlay = () => updateOverlay(u);

                line1.addEventListener('mousedown', e => {
                    e.stopPropagation();
                    e.preventDefault();
                    draggingCursor = 1;
                    lastTouchedCursor = 1;
                    interactionFocus = 'cursor';
                    dragOverRect = over.getBoundingClientRect();
                    line1.classList.add('dragging');
                    document.body.style.cursor = 'ew-resize';
                    document.body.style.userSelect = 'none';
                });

                line2.addEventListener('mousedown', e => {
                    e.stopPropagation();
                    e.preventDefault();
                    draggingCursor = 2;
                    lastTouchedCursor = 2;
                    interactionFocus = 'cursor';
                    dragOverRect = over.getBoundingClientRect();
                    line2.classList.add('dragging');
                    document.body.style.cursor = 'ew-resize';
                    document.body.style.userSelect = 'none';
                });

                onDocMouseMove = e => {
                    if (draggingCursor === null) return;
                    pendingClientX = e.clientX;
                    if (dragRafId !== null) return;
                    dragRafId = requestAnimationFrame(() => {
                        dragRafId = null;
                        if (draggingCursor === null) return;
                        const rect = dragOverRect || over.getBoundingClientRect();
                        const x = Math.max(0, Math.min(pendingClientX - rect.left, rect.width));
                        const time = u.posToVal(x, 'x');
                        if (draggingCursor === 1) S.cursor1 = time;
                        else S.cursor2 = time;
                        updateCursors();
                    });
                };
                document.addEventListener('mousemove', onDocMouseMove);

                onDocMouseUp = () => {
                    if (draggingCursor !== null) {
                        line1.classList.remove('dragging');
                        line2.classList.remove('dragging');
                        draggingCursor = null;
                        dragOverRect = null;
                        document.body.style.cursor = '';
                        document.body.style.userSelect = '';
                    }
                };
                document.addEventListener('mouseup', onDocMouseUp);

                over.addEventListener('click', e => {
                    if (e.ctrlKey || e.metaKey) {
                        const x = e.clientX - over.getBoundingClientRect().left;
                        placeCursorAt(u.posToVal(x, 'x'));
                    }
                });
            },
            destroy: u => {
                if (onDocMouseMove) document.removeEventListener('mousemove', onDocMouseMove);
                if (onDocMouseUp) document.removeEventListener('mouseup', onDocMouseUp);
                if (dragRafId !== null) cancelAnimationFrame(dragRafId);
                delete u.updateCursorOverlay;
            },
            draw: u => updateOverlay(u)
        }
    };
}

// Signal selectionne dans la legende: { plotId, sigIdx } ou null.
// Selection par clic sur la ligne du tableau, deselection par le meme clic,
// suppression du signal uniquement via la touche Suppr quand selectionne.
let selectedLegendSignals = [];
const selectionAnchorByPlot = new Map();

function unionSelections(a, b) {
    const key = s => `${s.plotId}:${s.sigIdx}`;
    const seen = new Set(a.map(key));
    const out = a.slice();
    for (const s of b) {
        const k = key(s);
        if (!seen.has(k)) {
            out.push(s);
            seen.add(k);
        }
    }
    return out;
}

function selectedInPlot(plotId, selection) {
    return selection.filter(s => s.plotId === plotId);
}

export function isLegendSignalSelected(plotId, sigIdx) {
    return selectedLegendSignals.some(s => s.plotId === plotId && s.sigIdx === sigIdx);
}

export function toggleLegendSignalSelection(plotId, sigIdx, additive = false, range = false) {
    const previous = selectedLegendSignals;
    const plot = S.plots.find(pl => pl.id === plotId);

    if (!plot || !Array.isArray(plot.signals) || plot.signals.length === 0) return;
    const legendOrder = plot.signals; // legend order = signal order
    const clickedIdx = legendOrder.indexOf(sigIdx);
    if (clickedIdx === -1) return; // clicked item not in this legend

    let nextSelection = previous;
    if (range) {
        // Shift select range
        // Determine anchor
        let anchorSig = selectionAnchorByPlot.get(plotId);
        const selInPlot = previous.filter(s => s.plotId === plotId);
        if (anchorSig == null || legendOrder.indexOf(anchorSig) === -1) {
            anchorSig = (selInPlot.length === 1) ? selInPlot[0].sigIdx : sigIdx;
        }
        const anchorIdx = legendOrder.indexOf(anchorSig);
        if (anchorIdx === -1) {
            // Fallback: behave as a simple click 
            nextSelection = (previous.length === 1 && previous[0].plotId === plotId && previous[0].sigIdx === sigIdx)
                ? []
                : [{ plotId, sigIdx }];
            selectionAnchorByPlot.set(plotId, sigIdx);
        } else {
            // Inclusive range [min(anchorIdx, clickedIdx) .. max(...)]
            const a = Math.min(anchorIdx, clickedIdx);
            const b = Math.max(anchorIdx, clickedIdx);
            const rangeItems = legendOrder.slice(a, b + 1).map(si => ({ plotId, sigIdx: si }));
            if (additive) {
                // Ctrl+Shift: add range to existing selection
                nextSelection = unionSelections(previous, rangeItems);
            } else {
                // Shift only: replace selection with range (within this plot)
                nextSelection = rangeItems;
            }
            // Keep anchor for consecutive Shift+clicks
            selectionAnchorByPlot.set(plotId, anchorSig);
        }
    } else if (additive) {
        // Ctrl select one by one to create list
        const idx = previous.findIndex(s => s.plotId === plotId && s.sigIdx === sigIdx);
        nextSelection = (idx === -1)
            ? [...previous, { plotId, sigIdx }]
            : previous.filter((_, i) => i !== idx);
        selectionAnchorByPlot.set(plotId, sigIdx);
    } else {
        // Simple click: replace with this item (or clear if it was the only one)
        const idx = previous.findIndex(s => s.plotId === plotId && s.sigIdx === sigIdx);
        nextSelection = (idx !== -1 && previous.length === 1)
            ? []
            : [{ plotId, sigIdx }];
        selectionAnchorByPlot.set(plotId, sigIdx);
    }

    selectedLegendSignals = nextSelection;
    interactionFocus = 'legend';

    // Re-render affected plots to update highlight
    const affected = new Set();
    previous.forEach(s => affected.add(s.plotId));
    selectedLegendSignals.forEach(s => affected.add(s.plotId));
    affected.forEach(pid => {
        const p = S.plots.find(pl => pl.id === pid);
        if (p) {
            renderPlotFromCache(p);
            updateLegendSelectionClasses(p);
        }
    });
}

function updateLegendSelectionClasses(plot) {
    plot.element?.querySelectorAll('.legend-row').forEach(row => {
        const sigIdx = parseInt(row.dataset.sigIdx, 10);
        row.classList.toggle('selected', isLegendSignalSelected(plot.id, sigIdx));
    });
}

// Suppr: cible selon la derniere interaction - le dernier curseur manipule si c'est
// un curseur, sinon le signal selectionne dans la legende. Ignore quand le focus est
// dans un champ de saisie pour ne pas interferer avec l'edition.
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Delete') return;
    const target = e.target;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT'
            || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
    }
    if (interactionFocus === 'cursor') {
        if (removeLastTouchedCursor()) e.preventDefault();
        return;
    }
    if (!selectedLegendSignals.length) return;
    const toDelete = selectedLegendSignals;
    selectedLegendSignals = [];
    toDelete.forEach(({ plotId, sigIdx }) => removeSignalFromPlot(plotId, sigIdx));
});

// Copie le nom du signal sélectionné dans la liste de droite via Ctrl+C / Cmd+C. On laisse la copie
// native agir si le focus est dans un champ ou si l'utilisateur a sélectionné du texte.
function copyTextToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(() => fallbackCopyText(text));
    } else {
        fallbackCopyText(text);
    }
}

function fallbackCopyText(text) {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try { document.execCommand('copy'); } catch (_) { /* sans effet */ }
    document.body.removeChild(area);
}

document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || (e.key !== 'c' && e.key !== 'C')) return;
    if (!selectedLegendSignals) return;
    const target = e.target;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT'
            || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
    }
    const selection = window.getSelection && window.getSelection().toString();
    if (selection) return;

    const names = selectedLegendSignals
        .map(s => S.signalsInfo[s.sigIdx]?.name)
        .filter(Boolean);
    if (!names.length) return;
    e.preventDefault();
    copyTextToClipboard(names.join('\n'));
    if (typeof showNotification === 'function') {
        showNotification(names.length > 1 ? `${names.length} noms copiés` : `Nom copié : ${names[0]}`, 'success');
    }
});

// Ctrl+Z / Ctrl+Y : bascule vers les niveaux de zoom precedents / suivants.
// Ctrl+Shift+Z fait aussi redo. Inactif si le focus est dans un champ de saisie.
document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const target = e.target;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT'
            || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
    }
    const k = e.key.toLowerCase();
    const isRedo = k === 'y' || (k === 'z' && e.shiftKey);
    const isUndo = k === 'z' && !e.shiftKey;
    if (!isUndo && !isRedo) return;
    if (isRedo ? redoView() : undoView()) e.preventDefault();
});

// Shift+Y: cadrage Y automatique du panneau survole. Sans Ctrl/Meta, donc sans
// conflit avec Ctrl+Y (redo) gere plus haut.
document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || !e.shiftKey) return;
    if (e.key.toLowerCase() !== 'y') return;
    const target = e.target;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT'
            || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
    }
    if (ectx.hoveredPlotId === null) return;
    const plot = S.plots.find(p => p.id === ectx.hoveredPlotId);
    if (autoScaleY(plot)) e.preventDefault();
});

function formatCursorNumber(v) {
    if (!Number.isFinite(v)) return '-';
    const abs = Math.abs(v);
    if (abs >= 1000) return v.toFixed(1);
    if (abs >= 1) return v.toFixed(3);
    return v.toFixed(4);
}

function setTextIfChanged(el, text) {
    if (el && el.textContent !== text) el.textContent = text;
}

// Met a jour la table de mesure A / B / delta de la legende d'un panneau.
// Appele par le chemin leger des curseurs (drag) et apres reconstruction
// de la legende: uniquement des ecritures DOM gardees, aucun layout force.
export function updateCursorReadout(plot) {
    const table = plot.element?.querySelector('.legend-table');
    if (!table) return;

    const active = S.cursor1 !== null || S.cursor2 !== null;
    const both = S.cursor1 !== null && S.cursor2 !== null;

    // Bascule mesure/legende simple + elargissement de la zone, garde sur le
    // changement d'etat: le resize des charts ne doit pas tourner par frame.
    const legendDiv = plot.element.querySelector('.plot-legend');
    if (table.classList.contains('cursors-active') !== active) {
        table.classList.toggle('cursors-active', active);
        if (legendDiv) legendDiv.classList.toggle('has-cursor-table', active);
        if (typeof resizePlotCharts === 'function') {
            setTimeout(resizePlotCharts, 0);
        }
    }

    if (!active) return;

    setTextIfChanged(table.querySelector('[data-time="a"]'),
        S.cursor1 !== null ? S.cursor1.toFixed(3) : '-');
    setTextIfChanged(table.querySelector('[data-time="b"]'),
        S.cursor2 !== null ? S.cursor2.toFixed(3) : '-');
    setTextIfChanged(table.querySelector('[data-time="d"]'),
        both ? (S.cursor2 - S.cursor1).toFixed(3) : '-');

    plot.signals.forEach(sigIdx => {
        const cached = effectiveCache(plot, sigIdx);
        const rA = (S.cursor1 !== null && cached)
            ? getValueAtTime(cached.timestamps, cached.values, cursorLookupTime(sigIdx, S.cursor1), cached.stringMap) : null;
        const rB = (S.cursor2 !== null && cached)
            ? getValueAtTime(cached.timestamps, cached.values, cursorLookupTime(sigIdx, S.cursor2), cached.stringMap) : null;

        setTextIfChanged(table.querySelector(`[data-sig="${sigIdx}"][data-col="a"]`), rA ? rA.display : '-');
        setTextIfChanged(table.querySelector(`[data-sig="${sigIdx}"][data-col="b"]`), rB ? rB.display : '-');

        let deltaText = '-';
        if (rA && rB && !cached.stringMap
                && Number.isFinite(rA.numeric) && Number.isFinite(rB.numeric)) {
            deltaText = formatCursorNumber(rB.numeric - rA.numeric);
        }
        setTextIfChanged(table.querySelector(`[data-sig="${sigIdx}"][data-col="d"]`), deltaText);
    });
}

// Instant a lire dans la serie brute pour une abscisse curseur donnee: une serie decalee
// (offset de run) est tracee a timestamp + offset, donc la valeur sous le curseur correspond
// a l'echantillon brut a (cursorVal - offset). Partage par les labels sur le curseur et par
// la table de mesure pour qu'ils affichent exactement la meme valeur.
function cursorLookupTime(sigIdx, cursorVal) {
    if (cursorVal === null || cursorVal === undefined) return cursorVal;
    if (!isSeriesSynth(sigIdx)) return cursorVal;
    const d = seriesDescriptor(sigIdx);
    const run = d.sessionId ? S.runs.find(r => r.sessionId === d.sessionId) : null;
    const effOff = effectiveRunOffset(run);
    return effOff ? cursorVal - effOff : cursorVal;
}

function getValueAtTime(timestamps, values, targetTime, stringMap = null) {
    if (!timestamps || !values || timestamps.length === 0) return null;
    
    let lo = 0, hi = timestamps.length - 1;
    while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (timestamps[mid] < targetTime) lo = mid + 1;
        else hi = mid;
    }
    if (lo > 0 && Math.abs(timestamps[lo - 1] - targetTime) < Math.abs(timestamps[lo] - targetTime)) {
        lo = lo - 1;
    }
    
    const numericValue = values[lo];
    
    // Si on a un stringMap, retourner la valeur textuelle
    if (stringMap) {
        const key = Math.round(numericValue);
        const textValue = stringMap[key] !== undefined ? stringMap[key] : numericValue.toFixed(2);
        return { numeric: numericValue, display: textValue };
    }
    
    return { numeric: numericValue, display: numericValue.toFixed(2) };
}

// Place un curseur au temps donné selon le cycle: c1 vide -> c1, sinon c2 vide -> c2,
// sinon réinitialise sur c1. Logique unique partagée par le Ctrl+clic et le bouton.
function placeCursorAt(time) {
    if (!S.cursor1) { S.cursor1 = time; lastTouchedCursor = 1; }
    else if (!S.cursor2) { S.cursor2 = time; lastTouchedCursor = 2; }
    else { S.cursor1 = time; S.cursor2 = null; lastTouchedCursor = 1; }
    interactionFocus = 'cursor';
    updateCursors();
}

// Dernier curseur manipule (drag ou placement): cible de l'ajustement fin au clavier.
let lastTouchedCursor = 1;

// Focus de la derniere interaction: 'cursor' apres manipulation d'un curseur, 'legend'
// apres clic sur un signal de la legende. Arbitre la cible de la touche Suppr.
let interactionFocus = null;

// Curseur effectivement cible par le clavier: le dernier manipule, avec repli sur
// celui qui existe encore. Retourne 1, 2 ou null si aucun curseur n'est pose.
function resolveTouchedCursor() {
    let which = lastTouchedCursor;
    if (which === 2 && S.cursor2 === null) which = 1;
    if (which === 1 && S.cursor1 === null) which = S.cursor2 !== null ? 2 : null;
    return which;
}

// Deplace le dernier curseur manipule d'un pas ecran: fleche = 1 pixel de temps,
// Shift+fleche = 10 pixels. Le pas est derive de l'echelle X d'un chart vivant, donc
// proportionnel au zoom courant. Retourne false si aucun curseur n'est pose.
function nudgeCursor(direction, coarse) {
    const which = resolveTouchedCursor();
    if (which === null) return false;
    interactionFocus = 'cursor';

    const plot = S.plots.find(p => p.chart);
    const perPixel = plot
        ? plot.chart.posToVal(1, 'x') - plot.chart.posToVal(0, 'x')
        : (ectx.globalView.max - ectx.globalView.min) / 1000;
    const step = direction * perPixel * (coarse ? 10 : 1);

    const current = which === 1 ? S.cursor1 : S.cursor2;
    const moved = Math.min(ectx.globalView.max, Math.max(ectx.globalView.min, current + step));
    if (which === 1) S.cursor1 = moved;
    else S.cursor2 = moved;
    updateCursors();
    return true;
}

// Supprime le dernier curseur manipule; le curseur restant devient la cible d'un
// eventuel second Suppr. Retourne false si aucun curseur n'est pose.
function removeLastTouchedCursor() {
    const which = resolveTouchedCursor();
    if (which === null) return false;

    if (which === 1) S.cursor1 = null;
    else S.cursor2 = null;
    lastTouchedCursor = which === 1 ? 2 : 1;
    updateCursors();
    return true;
}

document.addEventListener('keydown', e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const target = e.target;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
    if (nudgeCursor(e.key === 'ArrowRight' ? 1 : -1, e.shiftKey)) e.preventDefault();
});

// Bouton de la toolbar: même comportement que le Ctrl+clic, en plaçant le curseur
// au centre de la vue temporelle courante (le bouton n'a pas de position de clic).
export function addCursorFromButton() {
    if (!Number.isFinite(ectx.globalView.min) || !Number.isFinite(ectx.globalView.max)) return;
    placeCursorAt((ectx.globalView.min + ectx.globalView.max) / 2);
}

export function updateCursors() {
    S.plots.forEach(p => {
        const chart = p.chart;
        if (!chart) return;
        if (chart.updateCursorOverlay) chart.updateCursorOverlay();
        else chart.redraw();
    });
}

