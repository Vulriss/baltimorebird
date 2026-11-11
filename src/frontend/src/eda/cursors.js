// Baltimore Bird - Curseurs C1/C2: plugin uPlot, mesures, clavier, selection legende
// Module extrait de app.js (refactoring): voir src/eda/ARCHITECTURE.md

import { S } from '../core/state.js';
import { resizePlotCharts } from './bootstrap.js';
import { ectx } from './context.js';
import { isSeriesSynth, seriesDescriptor } from './overlay.js';
import { autoScaleY, renderPlotFromCache, resolveSignalStyle } from './plot-ui.js';
import { removeSignalFromPlot } from './plots.js';
import { effectiveRunOffset } from './runs.js';
import { updateRulerCursors } from './time-ruler.js';
import { effectiveCache } from './transforms.js';
import { redoView, undoView } from './view-nav.js';

// =========================================================================
// Cursors
// =========================================================================
// Le temps des curseurs et le delta sont portes par la regle de temps de l'onglet
// (time-ruler.js); chaque graphe n'affiche que les traits et les valeurs.
export function cursorPlugin() {
    let line1, line2;
    let labelPool1 = [];
    let labelPool2 = [];
    let over;
    let draggingCursor = null;
    let dragRafId = null;
    let pendingClientX = 0;
    let dragOverRect = null;
    let onDocMouseMove = null;
    let onDocMouseUp = null;

    const VALUE_LABEL_H = 18;
    // Demi-largeur de la zone de saisie d'une ligne de curseur (.cursor-line: 6px, margin -3px).
    const CURSOR_HIT_HALF_WIDTH = 3;
    // Marge haute des labels de valeurs.
    const TOP_RESERVED = 2;

    // Largeur estimee d'un label monospace (10px ~6px/char + padding + bordure).
    function estLabelWidth(text) {
        return text.length * 6 + 16;
    }

    // Repartit verticalement des labels de valeurs pour eviter les chevauchements,
    // dans la hauteur du graphe.
    function declutterValueLabels(entries, height) {
        const n = entries.length;
        if (n === 0) return;
        entries.sort((a, b) => a.y - b.y);
        const top = TOP_RESERVED + VALUE_LABEL_H / 2;
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
        // Largeur de la zone de trace deduite de l'echelle plutot que lue dans le layout:
        // un offsetWidth ici, apres les ecritures de labels du graphe precedent, forcait
        // un layout synchrone par curseur et par graphe a chaque frame de glissement.
        const scaleMax = u.scales.x.max;
        const plotWidth = (Number.isFinite(scaleMax) ? u.valToPos(scaleMax, 'x') : u.width) || 0;
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

    // Curseur (1 ou 2) dont la zone de saisie contient l'abscisse x (px dans .u-over),
    // le plus proche si les deux se recouvrent. null si aucun.
    function cursorAtPos(u, x) {
        let best = null;
        let bestDist = CURSOR_HIT_HALF_WIDTH;
        [[1, S.cursor1], [2, S.cursor2]].forEach(([which, val]) => {
            if (val === null) return;
            const dist = Math.abs(u.valToPos(val, 'x') - x);
            if (dist <= bestDist) {
                best = which;
                bestDist = dist;
            }
        });
        return best;
    }

    // Positionne lignes et labels de valeurs des curseurs sans redessiner le canvas.
    // Appelee par le hook draw (zoom, nouvelles donnees) et directement pendant
    // le drag (les echelles ne changent pas: un redraw complet serait du gaspillage).
    function updateOverlay(u) {
        const plot = S.plots.find(p => p.chart === u);
        if (!plot) return;

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

                line2 = document.createElement('div');
                line2.className = 'cursor-line cursor-2';
                line2.style.display = 'none';
                over.appendChild(line2);

                // Chemin léger pour le drag des curseurs: repositionne l'overlay
                // de ce chart sans redraw canvas
                u.updateCursorOverlay = () => updateOverlay(u);

                line1.addEventListener('mousedown', e => {
                    e.stopPropagation();
                    e.preventDefault();
                    // Ctrl+clic: suppression geree par le handler click, pas de drag.
                    if (e.ctrlKey || e.metaKey) return;
                    draggingCursor = 1;
                    lastTouchedCursor = 1;
                    interactionFocus = 'cursor';
                    dragOverRect = over.getBoundingClientRect();
                    line1.classList.add('dragging');
                    document.body.style.cursor = 'ew-resize';
                    document.body.style.userSelect = 'none';
                });

                line1.addEventListener('mouseenter', e => {
                    e.stopPropagation();
                    e.preventDefault();
                    document.body.classList.add('is-cursor-1-hovered');
                })

                line1.addEventListener('mouseleave', e => {
                    if (draggingCursor !== null) return;
                    e.stopPropagation();
                    e.preventDefault();
                    document.body.classList.remove('is-cursor-1-hovered');
                })

                line2.addEventListener('mousedown', e => {
                    e.stopPropagation();
                    e.preventDefault();
                    // Ctrl+clic: suppression geree par le handler click, pas de drag.
                    if (e.ctrlKey || e.metaKey) return;
                    draggingCursor = 2;
                    lastTouchedCursor = 2;
                    interactionFocus = 'cursor';
                    dragOverRect = over.getBoundingClientRect();
                    line2.classList.add('dragging');
                    document.body.style.cursor = 'ew-resize';
                    document.body.style.userSelect = 'none';
                });

                line2.addEventListener('mouseenter', e => {
                    e.stopPropagation();
                    e.preventDefault();
                    document.body.classList.add('is-cursor-2-hovered');
                })

                line2.addEventListener('mouseleave', e => {
                    if (draggingCursor !== null) return;
                    e.stopPropagation();
                    e.preventDefault();
                    document.body.classList.remove('is-cursor-2-hovered');
                })

                onDocMouseMove = e => {
                    if (draggingCursor === null) return;
                    pendingClientX = e.clientX;
                    if (dragRafId !== null) return;
                    dragRafId = requestAnimationFrame(() => {
                        dragRafId = null;
                        if (draggingCursor === null) return;
                        const rect = dragOverRect || over.getBoundingClientRect();
                        const x = Math.max(0, Math.min(pendingClientX - rect.left, rect.width));
                        moveCursorTo(draggingCursor, u.posToVal(x, 'x'));
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
                    if (!(e.ctrlKey || e.metaKey)) return;
                    const x = e.clientX - over.getBoundingClientRect().left;
                    const hit = cursorAtPos(u, x);
                    if (hit !== null) removeCursor(hit);
                    else placeCursorAt(u.posToVal(x, 'x'));
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

// Bornes des decimales des temps curseurs: 3 au zoom usuel (affichage historique),
// 9 au plus (nanoseconde, resolution de viewKey).
const MIN_CURSOR_TIME_DECIMALS = 3;
const MAX_CURSOR_TIME_DECIMALS = 9;

// Decimales des temps curseurs et du delta: juste assez pour distinguer deux pixels
// voisins a l'echelle X courante. Sans chart, repli sur la vue globale (comme nudgeCursor).
export function cursorTimeDecimals(chart) {
    const perPixel = chart
        ? Math.abs(chart.posToVal(1, 'x') - chart.posToVal(0, 'x'))
        : (ectx.globalView.max - ectx.globalView.min) / 1000;
    if (!(perPixel > 0) || !Number.isFinite(perPixel)) return MIN_CURSOR_TIME_DECIMALS;
    const needed = Math.ceil(-Math.log10(perPixel));
    return Math.min(MAX_CURSOR_TIME_DECIMALS, Math.max(MIN_CURSOR_TIME_DECIMALS, needed));
}

function formatCursorNumber(v) {
    if (!Number.isFinite(v)) return '-';
    const abs = Math.abs(v);
    if (abs >= 1000) return v.toFixed(1);
    if (abs >= 1) return v.toFixed(3);
    return v.toFixed(4);
}

// Ecrit le texte d'une cellule de mesure s'il a change. Retourne sa longueur, 0 si la
// cellule n'existe pas (ligne temps hors du premier panneau, signal sans ligne).
function writeCell(cell, text) {
    if (!cell) return 0;
    if (cell.textContent !== text) cell.textContent = text;
    return text.length;
}

// Cellules de mesure d'une table de legende, resolues une fois par table. Les chercher par
// selecteur d'attribut a chaque frame coutait trois parcours de la table par signal: le
// cout d'un glissement de curseur croissait comme le carre du nombre de signaux.
// La legende est reconstruite d'un bloc (plot-legend.js: nouvelle table a chaque rendu),
// donc une entree par element table suffit; le nombre d'enfants sert de garde-fou si une
// ligne etait un jour ajoutee ou retiree en place.
// chars: longueur du plus long texte par colonne, tenue a jour a l'ecriture, pour que la
// synchronisation des colonnes n'ait plus a relire le DOM.
const readoutCells = new WeakMap();

function readoutCellsOf(table) {
    let refs = readoutCells.get(table);
    if (refs && refs.rows === table.childElementCount) return refs;
    refs = { rows: table.childElementCount, time: {}, sig: new Map(), chars: { a: 1, b: 1, d: 1, unit: 0 } };
    table.querySelectorAll('[data-time]').forEach(cell => { refs.time[cell.dataset.time] = cell; });
    table.querySelectorAll('[data-sig]').forEach(cell => {
        let row = refs.sig.get(cell.dataset.sig);
        if (!row) {
            row = {};
            refs.sig.set(cell.dataset.sig, row);
        }
        row[cell.dataset.col] = cell;
    });
    // Les unites ne changent pas entre deux reconstructions de la legende.
    table.querySelectorAll('.ct-unit').forEach(cell => {
        if (cell.textContent.length > refs.chars.unit) refs.chars.unit = cell.textContent.length;
    });
    readoutCells.set(table, refs);
    return refs;
}

// Colonnes de mesure communes a tous les panneaux d'un onglet, comme un seul tableau.
// Chaque legende est une grille distincte: en colonnes auto, chacune se dimensionnait sur
// ses propres valeurs et les colonnes se decalaient d'un strip a l'autre. La police des
// cellules etant a chasse fixe, la largeur d'une colonne se deduit du nombre de caracteres
// de sa plus longue valeur (unite ch): aucune mesure de layout pendant le drag. Une passe
// par frame et par onglet, quel que soit le nombre de panneaux mis a jour. Les longueurs
// viennent de readoutCellsOf (tenues a jour par updateCursorReadout a chaque ecriture):
// la passe ne relit aucune cellule.
// Minimum de la colonne unite: l'en-tete "unit" (4 caracteres).
const LEGEND_COLUMNS = [
    { prop: '--lt-a-ch', key: 'a', min: 1 },
    { prop: '--lt-b-ch', key: 'b', min: 1 },
    { prop: '--lt-d-ch', key: 'd', min: 1 },
    { prop: '--lt-unit-ch', key: 'unit', min: 4 },
];
const pendingColumnSync = new Set();

function syncLegendColumns(wrapper) {
    const all = [];
    // Une table active est toujours passee par updateCursorReadout, donc connue du cache.
    wrapper.querySelectorAll('.legend-table.cursors-active').forEach(table => {
        const refs = readoutCells.get(table);
        if (refs) all.push(refs.chars);
    });
    for (const col of LEGEND_COLUMNS) {
        let chars = col.min;
        for (const tableChars of all) {
            if (tableChars[col.key] > chars) chars = tableChars[col.key];
        }
        const value = String(chars);
        if (wrapper.style.getPropertyValue(col.prop) !== value) wrapper.style.setProperty(col.prop, value);
    }
}

function scheduleLegendColumnSync(plot) {
    const wrapper = plot.element?.closest('.plots-wrapper');
    if (!wrapper || pendingColumnSync.has(wrapper)) return;
    pendingColumnSync.add(wrapper);
    requestAnimationFrame(() => {
        pendingColumnSync.delete(wrapper);
        if (wrapper.isConnected) syncLegendColumns(wrapper);
    });
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

    const refs = readoutCellsOf(table);
    const decimals = cursorTimeDecimals(plot.chart);
    let charsA = writeCell(refs.time.a, S.cursor1 !== null ? S.cursor1.toFixed(decimals) : '-');
    let charsB = writeCell(refs.time.b, S.cursor2 !== null ? S.cursor2.toFixed(decimals) : '-');
    // Pas de formatDuration ici: son prefixe SI (ms/µs) desaccorderait la valeur de
    // la cellule .ct-unit voisine, fixee a "s" pour toute la ligne temps (a/b/d) -
    // meme convention que S.cursor1/S.cursor2 juste au-dessus (toFixed brut).
    let charsD = writeCell(refs.time.d, both ? (S.cursor2 - S.cursor1).toFixed(decimals) : '-');

    plot.signals.forEach(sigIdx => {
        const cells = refs.sig.get(String(sigIdx)) || {};
        const cached = effectiveCache(plot, sigIdx);
        const rA = (S.cursor1 !== null && cached)
            ? getValueAtTime(cached.timestamps, cached.values, cursorLookupTime(sigIdx, S.cursor1), cached.stringMap) : null;
        const rB = (S.cursor2 !== null && cached)
            ? getValueAtTime(cached.timestamps, cached.values, cursorLookupTime(sigIdx, S.cursor2), cached.stringMap) : null;

        charsA = Math.max(charsA, writeCell(cells.a, rA ? rA.display : '-'));
        charsB = Math.max(charsB, writeCell(cells.b, rB ? rB.display : '-'));

        let deltaText = '-';
        if (rA && rB && !cached.stringMap
                && Number.isFinite(rA.numeric) && Number.isFinite(rB.numeric)) {
            deltaText = formatCursorNumber(rB.numeric - rA.numeric);
        }
        charsD = Math.max(charsD, writeCell(cells.d, deltaText));
    });
    // Au moins 1: les lignes de signaux absents du fichier affichent un tiret.
    refs.chars.a = Math.max(1, charsA);
    refs.chars.b = Math.max(1, charsB);
    refs.chars.d = Math.max(1, charsD);
    scheduleLegendColumnSync(plot);
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
// sinon réinitialise sur c1. Logique unique partagée par le Ctrl+clic (graphes, règle)
// et le bouton.
export function placeCursorAt(time) {
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

// Un curseur saisi hors d'un graphe (pastille de la regle) devient, comme au drag de
// son trait, la cible du clavier.
export function touchCursor(which) {
    lastTouchedCursor = which;
    interactionFocus = 'cursor';
}

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
    moveCursorTo(which, Math.min(ectx.globalView.max, Math.max(ectx.globalView.min, current + step)));
    return true;
}

// Supprime le dernier curseur manipule; le curseur restant devient la cible d'un
// eventuel second Suppr. Retourne false si aucun curseur n'est pose.
function removeLastTouchedCursor() {
    const which = resolveTouchedCursor();
    if (which === null) return false;
    removeCursor(which);
    return true;
}

// Supprime le curseur 1 ou 2; l'autre devient la cible du clavier (Suppr, fleches).
// Partage par Suppr et par le Ctrl+clic sur une ligne ou une pastille de curseur.
export function removeCursor(which) {
    if (which === 1) S.cursor1 = null;
    else S.cursor2 = null;
    lastTouchedCursor = which === 1 ? 2 : 1;
    interactionFocus = 'cursor';
    updateCursors();
}

document.addEventListener('keydown', e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const target = e.target;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
    if (nudgeCursor(e.key === 'ArrowRight' ? 1 : -1, e.shiftKey)) e.preventDefault();
});

// =========================================================================
// Verrou de l'ecart entre les deux curseurs
// =========================================================================
// Verrou actif: deplacer un curseur entraine l'autre, l'ecart reste fixe. Il n'a de sens
// qu'avec deux curseurs poses, et tombe de lui-meme des qu'il en manque un (updateCursors).
export function isCursorLockActive() {
    return S.cursorLock && S.cursor1 !== null && S.cursor2 !== null;
}

export function toggleCursorLock() {
    if (S.cursor1 === null || S.cursor2 === null) return false;
    S.cursorLock = !S.cursorLock;
    updateCursors();
    return true;
}

// Deplace un curseur. Point de passage unique des deplacements (glisser d'un trait ou
// d'une pastille, fleches du clavier): c'est ici que le verrou entraine l'autre curseur,
// qui peut alors sortir de la fenetre affichee - l'ecart prime sur la visibilite.
export function moveCursorTo(which, time) {
    const delta = isCursorLockActive() ? S.cursor2 - S.cursor1 : null;
    if (which === 1) {
        S.cursor1 = time;
        if (delta !== null) S.cursor2 = time + delta;
    } else {
        S.cursor2 = time;
        if (delta !== null) S.cursor1 = time - delta;
    }
    updateCursors();
}

// Pose les deux curseurs d'un coup (glisser du delta sur la regle: translation de la paire).
export function setCursorPair(time1, time2) {
    S.cursor1 = time1;
    S.cursor2 = time2;
    updateCursors();
}

// L: bascule le verrou de l'ecart. Inactif dans un champ de saisie ou sans deux curseurs.
document.addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.key.toLowerCase() !== 'l') return;
    const target = e.target;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT'
            || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
    }
    if (toggleCursorLock()) e.preventDefault();
});

// Bouton de la regle de temps: même comportement que le Ctrl+clic, en plaçant le curseur
// au centre de la vue temporelle courante (le bouton n'a pas de position de clic).
export function addCursorFromButton() {
    if (!Number.isFinite(ectx.globalView.min) || !Number.isFinite(ectx.globalView.max)) return;
    placeCursorAt((ectx.globalView.min + ectx.globalView.max) / 2);
}

export function updateCursors() {
    if (S.cursorLock && (S.cursor1 === null || S.cursor2 === null)) S.cursorLock = false;
    if (S.syncCursors) {
        syncCursorsAcrossTabs();
    }
    S.plots.forEach(p => {
        const chart = p.chart;
        if (!chart) return;
        if (chart.updateCursorOverlay) chart.updateCursorOverlay();
        else chart.redraw();
    });
    updateRulerCursors();
}

export function syncCursorsAcrossTabs() {
    if (!Array.isArray(S.tabs)) return;
    S.tabs.forEach(tab => {
        tab.cursor1 = S.cursor1;
        tab.cursor2 = S.cursor2;
    });
}


