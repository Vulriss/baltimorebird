// Baltimore Bird - Entete et legende de panneau: table, styles, zones etendues
// Module extrait de app.js (refactoring): voir src/eda/ARCHITECTURE.md

import { S } from '../core/state.js';
import { openAnalysisPopover } from './analysis.js';
import { extractBoolHighRanges } from './bool-zones.js';
import { ectx } from './context.js';
import { isLegendSignalSelected, toggleLegendSignalSelection, updateCursorReadout } from './cursors.js';
import { isSeriesSynth, seriesDescriptor } from './overlay.js';
import { FILL_MODES, PATH_MODES, effectiveFillMode, effectivePathMode, exitSolo, isFirstPlot, renderPlotFromCache, rerenderPlotFromCache, resolveSignalStyle } from './plot-ui.js';
import { rebuildPlotsLayout } from './plots.js';
import { signalActiveColorMap } from './signal-list.js';
import { SAVGOL_WINDOWS, SIGNAL_TRANSFORMS, effectiveCache, setSignalTransform, signalTransform } from './transforms.js';
import { refreshAllPlots } from './view-nav.js';
import { openZoneStatsPopover } from './zone-stats.js';
import { hexToRgb, rgbToHsv, hsvToHex } from './color-utils.js';

export function deletePlotInTab(tabId, plotId) {
    const idx = S.plots.findIndex(p => p.id === plotId);
    if (idx === -1) return;

    const plot = S.plots[idx];
    if (plot.chart) plot.chart.destroy();

    // Le panneau supprime etait-il le plus bas ? Si oui, le nouveau dernier
    // devra afficher l'axe temporel.
    const deletedWasLast = idx === S.plots.length - 1;
    // ... et etait-il le premier ? L'en-tete de legende (Name/A/B/Δ/unit + ligne t)
    // n'est rendu que sur S.plots[0] au moment ou sa legende est construite: sans
    // reconstruction, le nouveau premier panneau reste sans bandeau.
    const deletedWasFirst = idx === 0;

    // Nettoie les zones etendues des signaux du panneau supprime (sinon elles
    // restent dessinees en fond des autres panneaux).
    plot.signals.forEach(sigIdx => {
        ectx.extendedBoolZones.delete(sigIdx);
        ectx.disabledBoolZones.delete(sigIdx);
    });

    plot.element.remove();
    S.plots.splice(idx, 1);

    const tab = S.tabs.find(t => t.id === tabId);
    if (tab) tab.plots = S.plots;

    updateSignalActiveStates();

    const wrapper = document.getElementById(`plotsWrapper-${tabId}`);

    if (S.plots.length === 0) {
        if (wrapper) wrapper.querySelectorAll('.splitter').forEach(s => s.remove());
        const empty = document.createElement('div');
        empty.className = 'empty-plot';
        empty.id = `emptyPlot-${tabId}`;
        empty.textContent = 'Glissez un signal ici pour créer un graphique';
        if (wrapper) wrapper.appendChild(empty);
        setupEmptyPlotDropZone(tabId);
        return;
    }

    rebuildPlotsLayout(tabId);

    // Le dernier panneau a change: il doit desormais porter l'axe temporel.
    if (deletedWasLast && S.plots.length > 0) {
        rerenderPlotFromCache(S.plots[S.plots.length - 1]);
    }

    // Le panneau supprime ne doit plus etre la cible du raccourci Shift+Y:
    // mouseleave ne se declenche pas sur un noeud retire du DOM.
    if (ectx.hoveredPlotId === plotId) ectx.hoveredPlotId = null;

    // S'il etait affiche seul, sortir du mode solo: sinon les autres panneaux
    // resteraient masques sans aucun moyen de revenir.
    if (plot._solo) exitSolo(tabId);

    // Le premier panneau a change: reconstruire sa legende pour y poser le bandeau
    // (Name/A/B/Δ/unit et ligne temps), et rafraichir les valeurs des curseurs.
    if (deletedWasFirst && S.plots.length > 0) {
        updatePlotHeader(S.plots[0]);
        // Le bandeau porte aussi la ligne temps (t / A / B / Δ): la repeupler, sinon
        // elle reste a "-" jusqu'au prochain deplacement de curseur.
        updateCursorReadout(S.plots[0]);
    }

    setTimeout(() => {
        S.plots.forEach(p => {
            if (!p.chart) return;
            const body = p.element.querySelector('.plot-body');
            if (body) p.chart.setSize({ width: body.clientWidth, height: body.clientHeight });
            // Redessine pour purger d'eventuelles zones etendues supprimees.
            p.chart.redraw();
        });
    }, 50);
}

export function deletePlot(plotId) {
    const plot = S.plots.find(p => p.id === plotId);
    if (plot && plot.tabId) {
        deletePlotInTab(plot.tabId, plotId);
    }
}

// Reordonne un signal dans son panneau (drag-reorg des lignes de legende): retire le signal
// deplace et le reinsere a la position de la ligne cible, puis re-rend chart et legende.
function reorderSignalInPlot(plotId, draggedIdx, targetIdx) {
    const plot = S.plots.find(p => p.id === plotId);
    if (!plot || draggedIdx === targetIdx) return;
    const from = plot.signals.indexOf(draggedIdx);
    if (from === -1) return;
    plot.signals.splice(from, 1);
    const to = plot.signals.indexOf(targetIdx);
    plot.signals.splice(to === -1 ? plot.signals.length : to, 0, draggedIdx);
    const tab = S.tabs.find(t => t.id === S.activeTabId);
    if (tab) tab.plots = S.plots;
    rerenderPlotFromCache(plot);
    updatePlotHeader(plot);
}

// =========================================================================
// Palette de couleurs rapide + nuancier inline
// =========================================================================
// Accents Catppuccin adaptes au theme courant: Mocha (vifs, concus pour fond
// sombre) en theme sombre, Latte (plus satures/fonces, lisibles sur clair) en
// theme clair. Valeurs concretes (pas des var(--ctp-*)): la couleur d'un signal
// est stockee et persistee telle quelle dans le layout, elle ne doit pas
// changer avec le theme apres coup.
const PRESET_COLORS_DARK = [
    '#f38ba8', '#eba0ac', '#fab387', '#f9e2af',
    '#a6e3a1', '#94e2d5', '#89dceb', '#74c7ec',
    '#89b4fa', '#b4befe', '#cba6f7', '#f5c2e7',
    '#f2cdcd', '#f5e0dc', '#cdd6f4', '#9399b2',
];
const PRESET_COLORS_LIGHT = [
    '#d20f39', '#e64553', '#fe640b', '#df8e1d',
    '#40a02b', '#179299', '#04a5e5', '#209fb5',
    '#1e66f5', '#7287fd', '#8839ef', '#ea76cb',
    '#dd7878', '#dc8a68', '#4c4f69', '#7c7f93',
];

function presetColors() {
    const light = document.documentElement.getAttribute('data-theme') === 'light';
    return light ? PRESET_COLORS_LIGHT : PRESET_COLORS_DARK;
}

// --- Conversions HSV <-> hex (nuancier inline) ---
let colorPopoverEl = null;
let colorPopoverInput = null;

function closeColorPopover() {
    if (colorPopoverEl) {
        colorPopoverEl.remove();
        colorPopoverEl = null;
        colorPopoverInput = null;
    }
}

function openColorPopover(input, plotId, sigIdx) {
    // Re-clic sur la meme pastille: bascule fermer/ouvrir
    if (colorPopoverInput === input) {
        closeColorPopover();
        return;
    }
    closeColorPopover();

    const pop = document.createElement('div');
    pop.className = 'color-preset-popover';

    // Etat HSV courant du nuancier, initialise depuis la couleur du signal.
    const rgb = hexToRgb(input.value) || { r: 137, g: 180, b: 250 };
    const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);

    // Application live throttlee par frame: updateSignalStyle fait une mise a
    // jour ciblee (pas de rebuild de legende), le popover reste donc ouvert
    // pendant qu'on glisse dans le nuancier.
    let rafPending = false;
    function applyColor(hex, immediate = false) {
        input.value = hex;
        preview.style.background = hex;
        hexField.value = hex;
        if (immediate) {
            updateSignalStyle(plotId, sigIdx, 'color', hex);
            return;
        }
        if (rafPending) return;
        rafPending = true;
        requestAnimationFrame(() => {
            rafPending = false;
            updateSignalStyle(plotId, sigIdx, 'color', input.value);
        });
    }

    function refreshPicker() {
        svArea.style.background =
            `linear-gradient(to top, #000, rgba(0,0,0,0)), ` +
            `linear-gradient(to right, #fff, rgba(255,255,255,0)), ` +
            `hsl(${hsv.h}, 100%, 50%)`;
        svCursor.style.left = `${hsv.s * 100}%`;
        svCursor.style.top = `${(1 - hsv.v) * 100}%`;
        hueCursor.style.left = `${(hsv.h / 360) * 100}%`;
    }

    // --- Presets (ferment le popover: choix rapide) ---
    const grid = document.createElement('div');
    grid.className = 'color-preset-grid';
    const current = (input.value || '').toLowerCase();
    presetColors().forEach(hex => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'color-preset-swatch';
        b.style.background = hex;
        b.title = hex;
        if (hex === current) b.classList.add('current');
        b.addEventListener('click', (e) => {
            e.stopPropagation();
            input.value = hex;
            updateSignalStyle(plotId, sigIdx, 'color', hex);
            closeColorPopover();
        });
        grid.appendChild(b);
    });
    pop.appendChild(grid);

    // --- Nuancier inline: surface saturation/valeur + barre de teinte + hex ---
    const svArea = document.createElement('div');
    svArea.className = 'color-picker-sv';
    const svCursor = document.createElement('div');
    svCursor.className = 'color-picker-sv-cursor';
    svArea.appendChild(svCursor);
    pop.appendChild(svArea);

    const hueBar = document.createElement('div');
    hueBar.className = 'color-picker-hue';
    const hueCursor = document.createElement('div');
    hueCursor.className = 'color-picker-hue-cursor';
    hueBar.appendChild(hueCursor);
    pop.appendChild(hueBar);

    const hexRow = document.createElement('div');
    hexRow.className = 'color-picker-hex-row';
    const preview = document.createElement('span');
    preview.className = 'color-picker-preview';
    const hexField = document.createElement('input');
    hexField.type = 'text';
    hexField.className = 'color-picker-hex';
    hexField.spellcheck = false;
    hexField.maxLength = 7;
    hexRow.appendChild(preview);
    hexRow.appendChild(hexField);
    pop.appendChild(hexRow);

    function dragOn(el, onMove) {
        el.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            el.setPointerCapture(e.pointerId);
            onMove(e);
            const move = (ev) => onMove(ev);
            const up = () => {
                el.removeEventListener('pointermove', move);
                el.removeEventListener('pointerup', up);
            };
            el.addEventListener('pointermove', move);
            el.addEventListener('pointerup', up);
        });
    }

    dragOn(svArea, (e) => {
        const r = svArea.getBoundingClientRect();
        hsv.s = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
        hsv.v = Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height));
        refreshPicker();
        applyColor(hsvToHex(hsv.h, hsv.s, hsv.v));
    });

    dragOn(hueBar, (e) => {
        const r = hueBar.getBoundingClientRect();
        hsv.h = Math.min(359.999, Math.max(0, ((e.clientX - r.left) / r.width) * 360));
        refreshPicker();
        applyColor(hsvToHex(hsv.h, hsv.s, hsv.v));
    });

    hexField.addEventListener('click', (e) => e.stopPropagation());
    hexField.addEventListener('change', () => {
        const parsed = hexToRgb(hexField.value);
        if (!parsed) {
            hexField.value = input.value; // saisie invalide: on restaure
            return;
        }
        const nh = rgbToHsv(parsed.r, parsed.g, parsed.b);
        hsv.h = nh.h; hsv.s = nh.s; hsv.v = nh.v;
        refreshPicker();
        applyColor(hsvToHex(hsv.h, hsv.s, hsv.v), true);
    });

    document.body.appendChild(pop);
    preview.style.background = input.value;
    hexField.value = input.value;
    refreshPicker();

    // Position fixe pres de la pastille, rabattue au-dessus si depassement bas,
    // bornee au viewport a droite.
    const r = input.getBoundingClientRect();
    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;
    let left = Math.min(r.left, window.innerWidth - pw - 8);
    let top = r.bottom + 6;
    if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 6);
    pop.style.left = `${Math.max(8, left)}px`;
    pop.style.top = `${top}px`;

    colorPopoverEl = pop;
    colorPopoverInput = input;
}

// Fermeture au clic exterieur, a Escape, et des qu'on scrolle (position fixe:
// le popover ne suit pas la pastille).
document.addEventListener('pointerdown', (e) => {
    if (colorPopoverEl && !colorPopoverEl.contains(e.target) && e.target !== colorPopoverInput) {
        closeColorPopover();
    }
});
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeColorPopover();
});
document.addEventListener('scroll', () => closeColorPopover(), true);

export function updatePlotHeader(plot) {
    // Le rebuild recree les lignes de legende: un popover de couleur ouvert
    // pointerait un input orphelin, on le ferme.
    closeColorPopover();
    const legendDiv = plot.element.querySelector('.plot-legend');
    if (!legendDiv) return;

    const expandedItems = new Set();
    legendDiv.querySelectorAll('.legend-row.expanded').forEach(row => {
        expandedItems.add(row.dataset.sigIdx);
    });

    // Vide et reconstruit avec createElement (CSP safe, XSS safe).
    // Table unifiee (modele desktop): chaque ligne est a la fois l'entree de
    // legende (couleur, nom, depliage, suppression) et la ligne de mesure
    // (valeurs en A, B, delta, unite) - colonnes partagees, aucune duplication.
    legendDiv.innerHTML = '';

    const table = document.createElement('div');
    table.className = 'legend-table';

    const makeCell = (cls, text, attrs) => {
        const cell = document.createElement('span');
        cell.className = cls;
        if (text) cell.textContent = text;
        if (attrs) Object.entries(attrs).forEach(([k, v]) => cell.setAttribute(k, v));
        return cell;
    };

    // En-tete (Name/A/B/Δ/unit) et ligne temps (t/A/B/Δ/s): communs a tous les panneaux
    // (axe X partage), donc affiches uniquement sur le premier strip pour gagner de la place.
    // Les valeurs par signal restent sur chaque panneau. La mise a jour du temps ne trouve
    // simplement pas ces cellules ailleurs (setTextIfChanged ignore un element absent).
    if (isFirstPlot(plot)) {
        table.appendChild(makeCell('ct-h lt-measure', 'Name'));
        table.appendChild(makeCell('ct-h ct-ha lt-measure', 'A'));
        table.appendChild(makeCell('ct-h ct-hb lt-measure', 'B'));
        table.appendChild(makeCell('ct-h ct-hd lt-measure', 'Δ'));
        table.appendChild(makeCell('ct-h lt-measure', 'unit'));

        table.appendChild(makeCell('ct-name ct-time-label lt-measure', 't'));
        table.appendChild(makeCell('ct-val ct-a lt-measure', '-', { 'data-time': 'a' }));
        table.appendChild(makeCell('ct-val ct-b lt-measure', '-', { 'data-time': 'b' }));
        table.appendChild(makeCell('ct-val ct-d lt-measure', '-', { 'data-time': 'd' }));
        table.appendChild(makeCell('ct-unit lt-measure', 's'));
    }

    plot.signals.forEach(sigIdx => {
        const desc = seriesDescriptor(sigIdx);
        if (!desc.name) return;
        const sig = S.signalsInfo[sigIdx]; // absent pour une serie overlay
        const labelText = desc.runLabel ? `${desc.name} · ${desc.runLabel}` : desc.name;

        const style = resolveSignalStyle(plot, sigIdx, desc.color);

        // display:contents - les cellules participent a la grille parente,
        // le groupe porte l'etat (expanded) et l'identite du signal
        const row = document.createElement('div');
        row.className = 'legend-row';
        row.dataset.sigIdx = sigIdx;
        row.dataset.plotId = plot.id;
        if (expandedItems.has(String(sigIdx))) {
            row.classList.add('expanded');
        }

        // Cellule nom = entree de legende complete
        const nameCell = document.createElement('div');
        nameCell.className = 'lt-name';
        nameCell.title = labelText;

        const colorInput = document.createElement('input');
        colorInput.type = 'color';
        colorInput.className = 'legend-color-btn';
        colorInput.value = rgbToHex(style.color);

        const nameSpan = document.createElement('span');
        nameSpan.className = 'legend-name';
        nameSpan.textContent = labelText;
        nameSpan.style.color = style.color;

        const toggleSpan = document.createElement('span');
        toggleSpan.className = 'legend-toggle';
        toggleSpan.textContent = '▼';
        toggleSpan.title = 'Réglages du signal';

        nameCell.appendChild(colorInput);
        nameCell.appendChild(nameSpan);
        nameCell.appendChild(toggleSpan);
        row.appendChild(nameCell);

        // Drag depuis la legende: deplace le signal vers un autre panneau
        nameCell.draggable = true;
        nameCell.addEventListener('dragstart', (e) => {
            S.draggedSignal = sigIdx;
            S.draggedSignalGroup = [sigIdx];
            S.draggedFromPlotId = plot.id;
            nameCell.classList.add('dragging');
            const dropZone = document.getElementById(`dropZone-${S.activeTabId}`);
            if (dropZone) dropZone.classList.add('active');
            e.dataTransfer.effectAllowed = 'move';
        });
        nameCell.addEventListener('dragend', () => {
            nameCell.classList.remove('dragging');
            S.draggedSignal = null;
            S.draggedSignalGroup = [];
            S.draggedFromPlotId = null;
            const dropZone = document.getElementById(`dropZone-${S.activeTabId}`);
            if (dropZone) dropZone.classList.remove('active');
            document.querySelectorAll('.plot-container').forEach(pc => pc.classList.remove('drop-target'));
        });

        // Reorganisation intra-panneau: un drop sur une autre ligne du meme panneau reordonne.
        // Le drop cross-panneau (deplacement) reste gere par la zone du panneau cible.
        nameCell.addEventListener('dragover', (e) => {
            if (S.draggedFromPlotId === plot.id && S.draggedSignal !== sigIdx) {
                e.preventDefault();
                nameCell.classList.add('reorder-target');
            }
        });
        nameCell.addEventListener('dragleave', () => nameCell.classList.remove('reorder-target'));
        nameCell.addEventListener('drop', (e) => {
            nameCell.classList.remove('reorder-target');
            if (S.draggedFromPlotId !== plot.id || S.draggedSignal === sigIdx) return;
            e.preventDefault();
            e.stopPropagation();
            reorderSignalInPlot(plot.id, S.draggedSignal, sigIdx);
        });

        if (isLegendSignalSelected(plot.id, sigIdx)) {
            row.classList.add('selected');
        }

        row.appendChild(makeCell('ct-val ct-a lt-measure', '-', { 'data-sig': sigIdx, 'data-col': 'a' }));
        row.appendChild(makeCell('ct-val ct-b lt-measure', '-', { 'data-sig': sigIdx, 'data-col': 'b' }));
        row.appendChild(makeCell('ct-val ct-d lt-measure', '-', { 'data-sig': sigIdx, 'data-col': 'd' }));
        const unitConv = plot.unitConversions?.[sigIdx];
        const unitText = unitConv ? unitConv.targetUnit : ((sig && sig.unit) || '');
        const unitCell = makeCell('ct-unit lt-measure', unitText);
        if (plot.unitErrors?.has(sigIdx)) unitCell.classList.add('ct-unit-error');
        row.appendChild(unitCell);

        // Panneau de reglages (pleine largeur, visible quand la ligne est depliee)
        const controls = document.createElement('div');
        controls.className = 'legend-controls';

        const widthRow = document.createElement('div');
        widthRow.className = 'legend-control-row';
        const widthLabel = document.createElement('label');
        widthLabel.textContent = 'Trait';
        const widthInput = document.createElement('input');
        widthInput.type = 'range';
        widthInput.min = '0.5';
        widthInput.max = '5';
        widthInput.step = '0.5';
        widthInput.value = style.width;
        const widthValue = document.createElement('span');
        widthValue.className = 'legend-width-value';
        widthValue.textContent = style.width;
        widthRow.appendChild(widthLabel);
        widthRow.appendChild(widthInput);
        widthRow.appendChild(widthValue);

        const cached = effectiveCache(plot, sigIdx);
        const activeTransform = signalTransform(plot, sigIdx);
        const seriesUnit = (activeTransform && cached?.unit) || (sig && sig.unit) || cached?.unit || '';
        const isBool = cached?.unit === 'bool' || seriesUnit === 'bool';

        controls.appendChild(widthRow);

        // Les booleens n'exposent pas style/trace/remplissage: trace en escalier
        // impose et remplissage en dessous par defaut (gere par le plot booleen).
        if (!isBool) {
            const dashRow = document.createElement('div');
            dashRow.className = 'legend-control-row';
            const dashLabel = document.createElement('label');
            dashLabel.textContent = 'Style';
            const dashSelect = document.createElement('select');
            [
                { value: '', text: 'Continu' },
                { value: '5,5', text: 'Tirets' },
                { value: '2,2', text: 'Pointillés' },
                { value: '10,5,2,5', text: 'Mixte' }
            ].forEach(opt => {
                const option = document.createElement('option');
                option.value = opt.value;
                option.textContent = opt.text;
                option.selected = style.dash === opt.value;
                dashSelect.appendChild(option);
            });
            dashRow.appendChild(dashLabel);
            dashRow.appendChild(dashSelect);
            controls.appendChild(dashRow);
            dashSelect.addEventListener('change', (e) => {
                updateSignalStyle(plot.id, sigIdx, 'dash', e.target.value);
            });

            const pathRow = document.createElement('div');
            pathRow.className = 'legend-control-row';
            const pathLabel = document.createElement('label');
            pathLabel.textContent = 'Tracé';
            const pathSelect = document.createElement('select');
            const currentPath = effectivePathMode(style, seriesUnit);
            [
                { value: 'none', text: 'Aucun' },
                { value: 'linear', text: 'Linéaire' },
                { value: 'spline', text: 'Spline' },
                { value: 'stepped', text: 'Escalier' }
            ].forEach(opt => {
                const option = document.createElement('option');
                option.value = opt.value;
                option.textContent = opt.text;
                option.selected = currentPath === opt.value;
                pathSelect.appendChild(option);
            });
            pathRow.appendChild(pathLabel);
            pathRow.appendChild(pathSelect);
            controls.appendChild(pathRow);
            pathSelect.addEventListener('change', (e) => {
                updateSignalStyle(plot.id, sigIdx, 'path', e.target.value);
            });

            const fillRow = document.createElement('div');
            fillRow.className = 'legend-control-row';
            const fillLabel = document.createElement('label');
            fillLabel.textContent = 'Remplissage';
            const fillSelect = document.createElement('select');
            const currentFill = effectiveFillMode(style);
            [
                { value: 'none', text: 'Aucun' },
                { value: 'above', text: 'Au-dessus' },
                { value: 'below', text: 'En dessous' }
            ].forEach(opt => {
                const option = document.createElement('option');
                option.value = opt.value;
                option.textContent = opt.text;
                option.selected = currentFill === opt.value;
                fillSelect.appendChild(option);
            });
            fillRow.appendChild(fillLabel);
            fillRow.appendChild(fillSelect);
            controls.appendChild(fillRow);
            fillSelect.addEventListener('change', (e) => {
                updateSignalStyle(plot.id, sigIdx, 'fill', e.target.value);
            });

            // Mutateurs rapides et analyses: signaux reels hors mode comparaison (les
            // series overlay n'exposent pas ces options). Separes visuellement des
            // reglages d'apparence: ils changent les donnees, pas le style.
            if (!S.comparing && !isSeriesSynth(sigIdx)) {
                const sep = document.createElement('div');
                sep.className = 'legend-controls-sep';
                controls.appendChild(sep);

                const activeT = signalTransform(plot, sigIdx);
                const transformRow = document.createElement('div');
                transformRow.className = 'legend-control-row';
                const transformLabel = document.createElement('label');
                transformLabel.textContent = 'Fonction';
                const transformSelect = document.createElement('select');
                [
                    { value: '', text: 'f(t)' },
                    { value: 'savgol', text: SIGNAL_TRANSFORMS.savgol.label },
                    { value: 'ddt', text: SIGNAL_TRANSFORMS.ddt.label },
                ].forEach(opt => {
                    const option = document.createElement('option');
                    option.value = opt.value;
                    option.textContent = opt.text;
                    option.selected = (activeT ? activeT.mode : '') === opt.value;
                    transformSelect.appendChild(option);
                });
                transformRow.appendChild(transformLabel);
                transformRow.appendChild(transformSelect);
                controls.appendChild(transformRow);
                transformSelect.addEventListener('change', (e) => {
                    setSignalTransform(plot.id, sigIdx, e.target.value || null);
                });

                if (activeT && activeT.mode === 'savgol') {
                    const strengthRow = document.createElement('div');
                    strengthRow.className = 'legend-control-row';
                    const strengthLabel = document.createElement('label');
                    strengthLabel.textContent = 'Intensite';
                    const strengthSelect = document.createElement('select');
                    SAVGOL_WINDOWS.forEach(opt => {
                        const option = document.createElement('option');
                        option.value = String(opt.value);
                        option.textContent = opt.text;
                        option.selected = activeT.window === opt.value;
                        strengthSelect.appendChild(option);
                    });
                    strengthRow.appendChild(strengthLabel);
                    strengthRow.appendChild(strengthSelect);
                    controls.appendChild(strengthRow);
                    strengthSelect.addEventListener('change', (e) => {
                        setSignalTransform(plot.id, sigIdx, 'savgol', parseInt(e.target.value));
                    });
                }

                const analysisRow = document.createElement('div');
                analysisRow.className = 'legend-control-row';
                const analysisLabel = document.createElement('label');
                analysisLabel.textContent = 'Analyse';
                analysisRow.appendChild(analysisLabel);
                const analysisGroup = document.createElement('div');
                analysisGroup.className = 'legend-analysis-group';
                [
                    { kind: 'kde', text: 'KDE', title: 'Densite de probabilite des valeurs (fenetre visible)' },
                    { kind: 'fft', text: 'FFT', title: "Spectre d'amplitude (fenetre visible)" },
                ].forEach(({ kind, text, title }) => {
                    const btn = document.createElement('button');
                    btn.className = 'legend-analysis-btn';
                    btn.textContent = text;
                    btn.title = title;
                    btn.addEventListener('click', () => openAnalysisPopover(plot.id, sigIdx, kind));
                    analysisGroup.appendChild(btn);
                });
                analysisRow.appendChild(analysisGroup);
                controls.appendChild(analysisRow);
            }
        }

        if (isBool) {
            const extendRow = document.createElement('div');
            extendRow.className = 'legend-control-row legend-extend-row';

            const extendLabel = document.createElement('label');
            extendLabel.textContent = 'Étendre zones';
            extendLabel.title = 'Afficher les zones HIGH sur tous les graphiques';

            const extendToggle = document.createElement('input');
            extendToggle.type = 'checkbox';
            extendToggle.className = 'extend-zones-toggle';
            extendToggle.checked = ectx.extendedBoolZones.has(sigIdx);

            extendToggle.addEventListener('change', (e) => {
                toggleExtendedZones(plot.id, sigIdx, e.target.checked);
            });

            extendRow.appendChild(extendLabel);
            extendRow.appendChild(extendToggle);
            controls.appendChild(extendRow);

            // Stats par zone: agregat sur la fenetre visible + liste des zones
            const zstatsRow = document.createElement('div');
            zstatsRow.className = 'legend-control-row';
            const zstatsLabel = document.createElement('label');
            zstatsLabel.textContent = 'Zones';
            const zstatsBtn = document.createElement('button');
            zstatsBtn.className = 'legend-analysis-btn';
            zstatsBtn.textContent = 'Stats';
            zstatsBtn.title = 'Statistiques par zone HIGH (fenêtre visible)';
            zstatsBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                openZoneStatsPopover(zstatsBtn, sigIdx);
            });
            zstatsRow.appendChild(zstatsLabel);
            zstatsRow.appendChild(zstatsBtn);
            controls.appendChild(zstatsRow);
        }

        row.appendChild(controls);

        // Event listeners: la fleche ouvre les reglages, le clic sur la ligne
        // (nom ou cellules de mesure) selectionne/deselectionne le signal
        toggleSpan.addEventListener('click', (e) => {
            e.stopPropagation();
            row.classList.toggle('expanded');
        });

        const selectableCells = [nameCell, ...row.querySelectorAll('.ct-val, .ct-unit')];
        selectableCells.forEach(cell => {
            cell.addEventListener('click', (e) => {
                if (e.target.classList.contains('legend-color-btn')
                        || e.target.classList.contains('legend-toggle')) {
                    return;
                }
                toggleLegendSignalSelection(plot.id, sigIdx);
            });
        });

        colorInput.addEventListener('click', (e) => {
            e.stopPropagation();
            // Bloque le nuancier natif: la palette + le nuancier inline le remplacent
            e.preventDefault();
            openColorPopover(colorInput, plot.id, sigIdx);
        });

        // Double-clic sur la ligne d'un booleen: bascule "Etendre zones" sans
        // ouvrir les reglages. La detection bool se fait au moment du geste
        // (cache pret a ce stade), et la checkbox des reglages est synchronisee
        // si la ligne est depliee. Les deux simples clics prealables basculent
        // la selection aller-retour: etat net inchange, flicker assume.
        nameCell.addEventListener('dblclick', (e) => {
            if (e.target === colorInput || e.target.classList.contains('legend-toggle')) return;
            const unit = plot.cachedData?.[sigIdx]?.unit || S.signalsInfo[sigIdx]?.unit;
            if (unit !== 'bool') return;
            e.preventDefault();
            e.stopPropagation();
            const enabled = !ectx.extendedBoolZones.has(sigIdx);
            toggleExtendedZones(plot.id, sigIdx, enabled);
            const cb = row.querySelector('.extend-zones-toggle');
            if (cb) cb.checked = enabled;
        });
        colorInput.addEventListener('change', (e) => {
            updateSignalStyle(plot.id, sigIdx, 'color', e.target.value);
        });

        widthInput.addEventListener('change', (e) => {
            updateSignalStyle(plot.id, sigIdx, 'width', e.target.value);
        });

        table.appendChild(row);
    });

    // Signaux du layout absents du fichier courant: on garde une ligne grisee, inerte
    // (ni couleur editable, ni drag, ni reglages) plutot que de les effacer. Le layout
    // reste ainsi lisible et complet, et le signal se recolore/reactive tout seul au
    // retour d'un fichier qui le contient. Un bouton de retrait permet de faire le
    // menage quand on sait que le signal ne reviendra pas.
    (plot.missingSignals || []).forEach(ms => {
        const row = document.createElement('div');
        row.className = 'legend-row legend-row-missing';
        row.dataset.missingName = ms.name;

        const nameCell = document.createElement('div');
        nameCell.className = 'lt-name';
        nameCell.title = `${ms.name} — absent de ce fichier`;

        const dot = document.createElement('span');
        dot.className = 'legend-missing-dot';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'legend-name';
        nameSpan.textContent = ms.name;

        const removeBtn = document.createElement('button');
        removeBtn.className = 'legend-missing-remove';
        removeBtn.textContent = '✕';
        removeBtn.title = 'Retirer ce signal du layout';
        removeBtn.setAttribute('aria-label', `Retirer ${ms.name} du layout`);
        removeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            removeMissingSignal(plot.id, ms.name);
        });

        nameCell.appendChild(dot);
        nameCell.appendChild(nameSpan);
        nameCell.appendChild(removeBtn);
        row.appendChild(nameCell);

        row.appendChild(makeCell('ct-val lt-measure', '–'));
        row.appendChild(makeCell('ct-val lt-measure', '–'));
        row.appendChild(makeCell('ct-val lt-measure', '–'));
        row.appendChild(makeCell('ct-unit lt-measure', ''));

        table.appendChild(row);
    });

    legendDiv.appendChild(table);

    updateCursorReadout(plot);
}

// Retire un signal absent de la legende d'un panneau. Il disparait aussi du layout
// exporte (exportCurrentLayout re-emet plot.missingSignals), donc l'enregistrement
// suivant ne le fera plus reapparaitre.
function removeMissingSignal(plotId, name) {
    const plot = S.plots.find(p => p.id === plotId);
    if (!plot || !plot.missingSignals) return false;
    const before = plot.missingSignals.length;
    plot.missingSignals = plot.missingSignals.filter(ms => ms.name !== name);
    if (plot.missingSignals.length === before) return false;
    updatePlotHeader(plot);
    return true;
}

window.removeMissingSignal = removeMissingSignal;

// Retire d'un coup tous les signaux absents de l'onglet courant. Un layout ancien
// peut en accumuler des dizaines: les retirer un par un serait fastidieux.
function clearAllMissingSignals() {
    let removed = 0;
    S.plots.forEach(plot => {
        if (!plot.missingSignals || plot.missingSignals.length === 0) return;
        removed += plot.missingSignals.length;
        plot.missingSignals = [];
        updatePlotHeader(plot);
    });
    if (removed && typeof showNotification === 'function') {
        showNotification(
            `${removed} signal${removed > 1 ? 'aux' : ''} absent${removed > 1 ? 's' : ''} retiré${removed > 1 ? 's' : ''} de l'onglet`,
            'success'
        );
    }
    return removed;
}

window.clearAllMissingSignals = clearAllMissingSignals;

export function autoEnableExtendedZones(plot) {
    if (!plot || !plot.cachedData) return;

    // Premier signal booleen du graphe (dans l'ordre d'ajout): seul candidat a
    // l'activation automatique des zones etendues. Activer tous les booleens
    // superposerait plusieurs jeux de bandes colorees et deviendrait illisible. Les
    // autres booleens restent desactives par defaut (activables manuellement).
    let firstBoolIdx = null;
    let hasBoolSignals = false;
    for (const sigIdx of plot.signals) {
        const cached = plot.cachedData[sigIdx];
        if (cached && cached.unit === 'bool') {
            hasBoolSignals = true;
            firstBoolIdx = sigIdx;
            break;
        }
    }

    if (firstBoolIdx !== null
        && !ectx.extendedBoolZones.has(firstBoolIdx)
        && !ectx.disabledBoolZones.has(firstBoolIdx)) {
        const cached = plot.cachedData[firstBoolIdx];
        const ranges = extractBoolHighRanges(cached.timestamps, cached.values);
        const color = plot.signalStyles?.[firstBoolIdx]?.color || cached.color;
        ectx.extendedBoolZones.set(firstBoolIdx, { color, ranges, plotId: plot.id });
    }

    if (hasBoolSignals) {
        updatePlotHeader(plot);
    }
}

function rgbToHex(color) {
    if (!color) return '#ffffff';
    if (color.startsWith('hsl')) {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 1, 1);
        const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
        return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
    }
    if (color.startsWith('#')) return color;
    const match = color.match(/\d+/g);
    if (match) {
        return '#' + match.slice(0, 3).map(x => parseInt(x).toString(16).padStart(2, '0')).join('');
    }
    return '#ffffff';
}

function updateSignalStyle(plotId, sigIdx, property, value) {
    const plot = S.plots.find(p => p.id === plotId);
    if (!plot) return;

    if (!plot.signalStyles) plot.signalStyles = {};
    if (!plot.signalStyles[sigIdx]) {
        const sig = S.signalsInfo[sigIdx];
        plot.signalStyles[sigIdx] = { color: sig?.color || '#fff', width: 1.5, dash: '' };
    }

    if (property === 'width') {
        plot.signalStyles[sigIdx].width = parseFloat(value);
        const row = plot.element.querySelector(`.legend-row[data-sig-idx="${sigIdx}"]`);
        const widthValue = row?.querySelector('.legend-width-value');
        if (widthValue) widthValue.textContent = value;
    } else if (property === 'color') {
        plot.signalStyles[sigIdx].color = value;
        const colorRow = plot.element.querySelector(`.legend-row[data-sig-idx="${sigIdx}"]`);
        const nameSpan = colorRow?.querySelector('.legend-name');
        if (nameSpan) nameSpan.style.color = value;
    } else if (property === 'dash') {
        plot.signalStyles[sigIdx].dash = value;
    } else if (property === 'path') {
        plot.signalStyles[sigIdx].path = PATH_MODES.includes(value) ? value : 'linear';
    } else if (property === 'fill') {
        plot.signalStyles[sigIdx].fill = FILL_MODES.includes(value) ? value : 'none';
    }

    if (property === 'color' && plot.cachedData[sigIdx]) {
        plot.cachedData[sigIdx].color = value;
    }
    if (property === 'color') {
        updateExtendedZoneColor(sigIdx, value);
    }

    renderPlotFromCache(plot);
    
    // Update sidebar signal colors when plot color changes
    updateSignalActiveStates();
}

export function toggleExtendedZones(plotId, sigIdx, enabled) {
    console.log(`[BoolZones] Toggle called: plotId=${plotId}, sigIdx=${sigIdx}, enabled=${enabled}`);
    
    const plot = S.plots.find(p => p.id === plotId);
    if (!plot) return;
    
    const cached = plot.cachedData[sigIdx];
    if (!cached) return;
    
    if (enabled) {
        const ranges = extractBoolHighRanges(cached.timestamps, cached.values);
        const color = plot.signalStyles?.[sigIdx]?.color || cached.color;
        
        ectx.extendedBoolZones.set(sigIdx, { color, ranges, plotId });
        ectx.disabledBoolZones.delete(sigIdx);
        console.log(`[BoolZones] Enabled for "${cached.name}": ${ranges.length} zones`);
    } else {
        ectx.extendedBoolZones.delete(sigIdx);
        ectx.disabledBoolZones.add(sigIdx);
        console.log(`[BoolZones] Disabled for "${cached.name}"`);
    }
    
    refreshAllPlots();
}

function updateExtendedZoneColor(sigIdx, newColor) {
    if (ectx.extendedBoolZones.has(sigIdx)) {
        const zoneData = ectx.extendedBoolZones.get(sigIdx);
        zoneData.color = newColor;
        refreshAllPlots();
    }
}

export function cleanupExtendedZones(sigIdx) {
    if (ectx.extendedBoolZones.has(sigIdx)) {
        ectx.extendedBoolZones.delete(sigIdx);
    }
    ectx.disabledBoolZones.delete(sigIdx);
    refreshAllPlots();
}

export function updateSignalActiveStates() {
    const signalColors = signalActiveColorMap();

    S.signalsInfo.forEach(sig => {
        const item = document.getElementById(`signal-item-${sig.index}`);
        if (item) {
            const dot = item.querySelector('.signal-dot');
            const isActive = signalColors.has(sig.index);
            
            item.classList.toggle('active', isActive);
            
            if (isActive && dot) {
                const color = signalColors.get(sig.index);
                dot.style.setProperty('--signal-color', color);
                item.style.setProperty('--signal-color', color);
            } else if (dot) {
                dot.style.removeProperty('--signal-color');
                item.style.removeProperty('--signal-color');
            }
        }
    });
}

