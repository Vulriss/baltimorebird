/**
 * Export PNG de l'onglet actif avec couche d'annotation.
 *
 * Capture: chaque canvas uPlot des graphes de l'onglet est compose, empile verticalement,
 * avec une bande de legende dessinee a partir du DOM rendu (noms + couleurs). Le fond suit
 * le theme courant. Une couche d'annotation (texte, fleche, rectangle, trait libre) se pose
 * par-dessus; le telechargement aplatit capture + annotations en un seul PNG.
 *
 * Les annotations sont stockees en coordonnees "snapshot" (espace de la capture), si bien
 * que l'affichage (reduit pour tenir a l'ecran) et l'export (pleine resolution) restent
 * coherents et nets.
 */

import { hexToRgb, rgbToHsv, hsvToHex } from './color-utils.js';
import { resizeAllChartsNow } from './plots.js';



(function () {
    'use strict';

    const PAD = 16;
    const TITLE_H = 30;
    const LEGEND_ROW_H = 20;
    const PLOT_GAP = 14;
    const TARGET_WIDTH = 1134;
    const TARGET_HEIGHT = 700;
    const DEFAULT_COLORS = ['#f38ba8', '#94e2d5', '#fab387', '#89b4fa', '#a6e3a1', '#f9e2af', '#cba6f7'];

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

    const TOOL_ICONS = {
        text: `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M4 7V4h16v3M12 4v16M9 20h6"/>
            </svg>`,
        arrow: `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="5" y1="19" x2="19" y2="5"/>
                <polyline points="12 5 19 5 19 12"/>
            </svg>`,
        rect: `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2"/>
            </svg>`,
        pen: `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 20h9"/>
                <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>
            </svg>`
    };

    let overlay = null;
    let composite = null;       // canvas de capture (backing = contentW*dpr)
    let contentW = 0;
    let contentH = 0;
    let displayScale = 1;
    let dpr = 1;

    let annotations = [];
    let undone = [];
    let floatingTexts = []; 
    let tool = 'text';
    let color = '#e83e3e';
    let draft = null;           // annotation en cours (drag)
    let annCtx = null;          // contexte de la couche d'annotation (affichage)
    let legendPosition = 'top'; 

    // Rapport en construction: volontairement epargne par close(), la structure survit
    // aux fermetures de la modale pour accumuler les captures d'une meme session.
    const REPORT_PANE_W = 380;
    const report = { title: '', blocks: [] };
    let reportListEl = null;    // conteneur DOM de la liste des blocs (vivant modale ouverte)

    function activeFileName() {
        const S = window.S;
        if (S && S.runs && S.activeRunId) {
            const r = S.runs.find(x => x.sessionId === S.activeRunId);
            if (r && r.filename) return r.filename;
        }
        const sel = document.getElementById('sourceSelector');
        if (sel && sel.selectedIndex >= 0 && sel.options[sel.selectedIndex]) {
            const t = (sel.options[sel.selectedIndex].textContent || '').trim();
            if (t) return t.replace(/\s*\(temporaire\)\s*$/, '');
        }
        return '';
    }

    function exportHeading() {
        const { tabName } = activeTabPlots();
        const file = activeFileName();
        return file ? `${file} - ${tabName}` : tabName;
    }

    function pushAnnotation(a) {
        annotations.push(a);
        undone = [];
    }

    function undo() {
        if (!annotations.length) return;
        const a = annotations.pop();
        undone.push(a);
        if (a && a.type === 'text') {
            try { if (a._el && a._el.remove) a._el.remove(); } catch (e) {}
            floatingTexts = floatingTexts.filter(ft => ft !== a);
        }
        redraw();
    }

    function redo() {
        if (!undone.length) return;
        const a = undone.pop();
        annotations.push(a);
        if (a && a.type === 'text') {
            if (!floatingTexts.includes(a)) floatingTexts.push(a);
            if (overlay) createFloatingTextElement(a);
        }
        redraw();
    }

    function themeColors() {
        const pick = (el) => {
            if (!el) return null;
            const c = getComputedStyle(el).backgroundColor;
            return c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent' ? c : null;
        };
        const bg = pick(document.querySelector('.plots-area'))
            || pick(document.querySelector('.tab-content.active'))
            || pick(document.body) || '#1e1e2e';
        const fg = getComputedStyle(document.body).color || '#cdd6f4';
        const muted = getComputedStyle(document.body).getPropertyValue('--text-secondary').trim() || fg;
        return { bg, fg, muted };
    }

    function activeTabPlots() {
        const S = window.S;
        if (!S || !S.activeTabId) return { plots: [], tabName: 'Export' };
        const wrapper = document.getElementById(`plotsWrapper-${S.activeTabId}`);
        const tab = (S.tabs || []).find(t => t.id === S.activeTabId);
        const tabName = tab && tab.name ? tab.name : 'Export';
        if (!wrapper) return { plots: [], tabName };

        const plots = [];
        wrapper.querySelectorAll('.plot-container').forEach(container => {
            const plot = (S.plots || []).find(p => p.id === container.id);
            if (plot && plot.chart && plot.chart.ctx && plot.chart.ctx.canvas) {
                plots.push({ plot, container });
            }
        });
        return { plots, tabName };
    }

    // Legende d'un graphe lue depuis le DOM rendu (noms + couleurs effectives).
    function legendEntries(container) {
        const out = [];
        container.querySelectorAll('.plot-legend .legend-name').forEach((el, i) => {
            const text = (el.textContent || '').trim();
            if (!text) return;
            const c = el.style.color || DEFAULT_COLORS[i % DEFAULT_COLORS.length];
            out.push({ text, color: c });
        });
        return out;
    }

    // Mesure la hauteur d'une bande de legende (chips a la ligne) pour une largeur donnee.
    function legendHeight(ctx, entries, maxW) {
        if (!entries.length) return 0;
        ctx.font = '12px sans-serif';
        let rows = 1;
        let x = 0;
        const chipGap = 16;
        const dot = 14;
        entries.forEach(e => {
            const w = dot + ctx.measureText(e.text).width + chipGap;
            if (x + w > maxW && x > 0) { rows++; x = 0; }
            x += w;
        });
        return rows * LEGEND_ROW_H + 4;
    }

    function calculateLegendWidth(ctx, entries) {
        if (!entries.length) return 0;
        ctx.font = '12px sans-serif';
        let maxWidth = 0;
        entries.forEach(e => {
            const w = ctx.measureText(e.text).width + 20; 
            maxWidth = Math.max(maxWidth, w);
        });
        return maxWidth; 
    }

    function resizePlotsForLegendPosition() {
        const S = window.S;
        if (!S || !S.plots) return;
        
        const totalGapHeight = (S.plots.length - 1) * PLOT_GAP;
        const titleAndPadding = PAD * 2 + TITLE_H;
        
        let availableHeight;
        
        if (legendPosition === 'top') {
            // Calculer la hauteur totale de la legende top
            let totalLegendHeight = 0;
            S.plots.forEach(plot => {
                const container = plot.element;
                const meas = document.createElement('canvas').getContext('2d');
                const entries = legendEntries(container);
                const legH = legendHeight(meas, entries, TARGET_WIDTH - PAD * 2);
                totalLegendHeight += legH;
            });
            availableHeight = TARGET_HEIGHT - totalGapHeight - totalLegendHeight - titleAndPadding;
        } else {
            // Pas de hauteur quand légende à droite
            availableHeight = TARGET_HEIGHT - totalGapHeight - titleAndPadding;
        }
        
        // Calculer la hauteur actuelle totale des corps de graphe pour determiner les proportions
        let totalCurrentHeight = 0;
        const currentHeights = new Map();
        
        S.plots.forEach(plot => {
            const plotBody = plot.element.querySelector('.plot-body');
            if (plotBody) {
                const height = plotBody.getBoundingClientRect().height;
                currentHeights.set(plot.id, height);
                totalCurrentHeight += height;
            }
        });
        
        // Redimensionner chaque corps de graphe en fonction de sa proportion actuelle par rapport a la hauteur totale disponible
        S.plots.forEach(plot => {
            const plotBody = plot.element.querySelector('.plot-body');
            
            if (plotBody) {
                const currentHeight = currentHeights.get(plot.id) || 1;
                const proportion = currentHeight / Math.max(totalCurrentHeight, 1);
                const finalHeight = Math.floor(availableHeight * proportion);
                
                plotBody.style.height = `${finalHeight}px`;
                plotBody.style.minHeight = `${finalHeight}px`;
                plotBody.style.maxHeight = `${finalHeight}px`;
                plotBody.style.flex = `0 0 ${finalHeight}px`;
            }
        });
        
        // Forcer le recalcul de la mise en page pour que les changements de style prennent effet
        forceResizeCharts();
        setTimeout(forceResizeCharts, 50);
    }

    function drawLegend(ctx, entries, x0, y0, maxW) {
        ctx.font = '12px sans-serif';
        ctx.textBaseline = 'middle';
        const chipGap = 16;
        const dot = 14;
        const tc = themeColors().fg;
        let x = x0;
        let y = y0 + LEGEND_ROW_H / 2;
        entries.forEach(e => {
            const w = dot + ctx.measureText(e.text).width + chipGap;
            if (x + w > x0 + maxW && x > x0) { x = x0; y += LEGEND_ROW_H; }
            ctx.fillStyle = e.color;
            ctx.beginPath();
            ctx.arc(x + 5, y, 4, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = tc;
            ctx.fillText(e.text, x + dot, y);
            x += w;
        });
    }

    function drawLegendVertical(ctx, entries, x0, y0, maxW) {
        ctx.font = '12px sans-serif';
        ctx.textBaseline = 'middle';
        const tc = themeColors().fg;
        let y = y0 + LEGEND_ROW_H / 2;
        
        entries.forEach(e => {
            ctx.fillStyle = e.color;
            ctx.beginPath();
            ctx.arc(x0 + 5, y, 4, 0, Math.PI * 2);
            ctx.fill();
            
            ctx.fillStyle = tc;
            ctx.fillText(e.text, x0 + 14, y);
            
            y += LEGEND_ROW_H;
        });
    }

    // Rasterise un element overlay (ligne de curseur, label de valeur/temps/delta) sur le
    // canvas de capture, a partir de sa position ecran relative au canvas du graphe. Les
    // elements masques (toggle des labels) sont ignores automatiquement (rect nul/hidden).
    function rasterizeOverlayEl(ctx, el, canvasRect, originX, originY) {
        const r = el.getBoundingClientRect();
        if (r.width < 0.5 || r.height < 0.5) return;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return;
        const x = originX + (r.left - canvasRect.left);
        const y = originY + (r.top - canvasRect.top);

        const bg = cs.backgroundColor;
        if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
            ctx.fillStyle = bg;
            ctx.fillRect(x, y, r.width, r.height);
        }
        const border = cs.borderTopWidth ? parseFloat(cs.borderTopWidth) : 0;
        if (border > 0 && cs.borderTopColor && cs.borderTopColor !== 'rgba(0, 0, 0, 0)') {
            ctx.strokeStyle = cs.borderTopColor;
            ctx.lineWidth = border;
            ctx.strokeRect(x, y, r.width, r.height);
        }
        const txt = el.children.length === 0 && el.textContent ? el.textContent.trim() : '';
        if (txt) {
            ctx.fillStyle = cs.color;
            ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
            ctx.textBaseline = 'middle';
            const padL = parseFloat(cs.paddingLeft) || 0;
            ctx.fillText(txt, x + padL, y + r.height / 2);
        }
    }

    // Ligne de curseur verticale: le div est une zone de clic transparente; la ligne
    // visible est le pseudo ::after (couleur var(--cursor-color), largeur ~2px), centre
    // sur le div. On lit la couleur resolue du ::after.
    function drawVCursor(ctx, el, canvasRect, ox, oy) {
        const r = el.getBoundingClientRect();
        if (r.height < 0.5) return;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') return;
        const after = getComputedStyle(el, '::after');
        let color = after && after.backgroundColor;
        if (!color || color === 'rgba(0, 0, 0, 0)' || color === 'transparent') {
            const root = getComputedStyle(document.body);
            if (/cursor-2/.test(el.className)) color = (root.getPropertyValue('--cursor-b') || '').trim() || '#f5c2e7';
            else color = (root.getPropertyValue('--cursor-a') || '').trim() || '#a6e3a1';
        }
        let w = after ? parseFloat(after.width) : 2;
        if (!Number.isFinite(w) || w < 1) w = 2;
        const cx = ox + (r.left - canvasRect.left) + r.width / 2;
        const y = oy + (r.top - canvasRect.top);
        ctx.fillStyle = color;
        ctx.fillRect(cx - w / 2, y, w, r.height);
    }

    // Ligne delta horizontale (degrade pointille entre les deux curseurs).
    function drawDeltaLine(ctx, el, canvasRect, ox, oy) {
        const r = el.getBoundingClientRect();
        if (r.width < 1) return;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') return;
        const x = ox + (r.left - canvasRect.left);
        const y = oy + (r.top - canvasRect.top) + r.height / 2;
        ctx.strokeStyle = 'rgba(255, 170, 68, 0.7)';
        ctx.lineWidth = Math.max(1.5, r.height);
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + r.width, y);
        ctx.stroke();
        ctx.setLineDash([]);
    }

    // Capture les curseurs et leurs labels d'un graphe (ceux actuellement visibles).
    function drawCursors(ctx, container, cnv, originX, originY) {
        const canvasRect = cnv.getBoundingClientRect();
        container.querySelectorAll('.cursor-line').forEach(el => drawVCursor(ctx, el, canvasRect, originX, originY));
        container.querySelectorAll('.cursor-delta-line').forEach(el => drawDeltaLine(ctx, el, canvasRect, originX, originY));
        const labels = '.cursor-time-label, .cursor-delta-label, .cursor-label';
        container.querySelectorAll(labels).forEach(el => {
            rasterizeOverlayEl(ctx, el, canvasRect, originX, originY);
        });
    }

    let originalLayoutState = null;

    function forceResizeCharts() {
        const S = window.S;
        if (!S || !S.plots) return;
        
        S.plots.forEach(plot => {
            if (!plot.chart) return;
            const body = plot.element.querySelector('.plot-body');
            if (body && body.clientWidth > 0 && body.clientHeight > 0) {
                plot.chart.setSize({ 
                    width: body.clientWidth, 
                    height: body.clientHeight 
                });
            }
        });
    }

    function resizePlotsWrapperForTarget() {
        const S = window.S;
        if (!S || !S.activeTabId) return false;
        
        const plotsWrapper = document.getElementById(`plotsWrapper-${S.activeTabId}`);
        if (!plotsWrapper) {
            console.warn('Could not find plots wrapper');
            return false;
        }
        
        // Garder l'etat original de la mise en page pour pouvoir le restaurer plus tard
        if (!originalLayoutState) {
            originalLayoutState = {
                plotBodyStyles: new Map(),
                legendStyles: new Map(),
                splitterStyles: new Map(),
                plotMainStyles: new Map(),
                containerStyles: new Map(),
                wrapperStyle: plotsWrapper.getAttribute('style')
            };
            
            // Sauvegarder les styles actuels de chaque plot et de ses elements enfants
            S.plots.forEach(plot => {
                if (plot.element) {
                    const plotBody = plot.element.querySelector('.plot-body');
                    const legend = plot.element.querySelector('.plot-legend');
                    const splitter = plot.element.querySelector('.legend-splitter');
                    const plotMain = plot.element.querySelector('.plot-main');
                    
                    if (plotBody) {
                        originalLayoutState.plotBodyStyles.set(plot.id, plotBody.getAttribute('style'));
                    }
                    if (legend) {
                        originalLayoutState.legendStyles.set(plot.id, legend.getAttribute('style'));
                    }
                    if (splitter) {
                        originalLayoutState.splitterStyles.set(plot.id, splitter.getAttribute('style'));
                    }
                    if (plotMain) {
                        originalLayoutState.plotMainStyles.set(plot.id, plotMain.getAttribute('style'));
                    }
                    originalLayoutState.containerStyles.set(plot.id, plot.element.getAttribute('style'));
                }
            });
        }
        
        // Calculer la hauteur disponible pour les corps de graphe en tenant compte des legendes et des gaps
        const totalGapHeight = (S.plots.length - 1) * PLOT_GAP;
        let totalLegendHeight = 0;
        S.plots.forEach(plot => {
            const container = plot.element;
            const meas = document.createElement('canvas').getContext('2d');
            const entries = legendEntries(container);
            const legH = legendHeight(meas, entries, TARGET_WIDTH - PAD * 2);
            totalLegendHeight += legH;
        });

        const titleAndPadding = PAD * 2 + TITLE_H;
        const availableHeight = TARGET_HEIGHT - totalGapHeight - totalLegendHeight - titleAndPadding;

        // Calculer la hauteur actuelle totale des corps de graphe pour determiner les proportions
        let totalCurrentHeight = 0;
        const currentHeights = new Map();
        
        S.plots.forEach(plot => {
            const plotBody = plot.element.querySelector('.plot-body');
            if (plotBody) {
                const height = plotBody.getBoundingClientRect().height;
                currentHeights.set(plot.id, height);
                totalCurrentHeight += height;
            }
        });
        
        // Redimensionner chaque corps de graphe en fonction de sa proportion actuelle par rapport a la hauteur totale disponible
        S.plots.forEach(plot => {
            const plotBody = plot.element.querySelector('.plot-body');
            const legend = plot.element.querySelector('.plot-legend');
            const splitter = plot.element.querySelector('.legend-splitter');
            const plotMain = plot.element.querySelector('.plot-main');
            const container = plot.element;
            
            if (plotBody) {
                // Calculer la nouvelle hauteur proportionnelle pour le corps du graphe
                const currentHeight = currentHeights.get(plot.id) || 1;
                const proportion = currentHeight / Math.max(totalCurrentHeight, 1);
                const finalHeight = Math.floor(availableHeight * proportion);
                
                // Appliquer les styles de dimensionnement aux elements du graphe
                plotBody.style.width = `${TARGET_WIDTH - PAD * 2}px`;
                plotBody.style.minWidth = `${TARGET_WIDTH - PAD * 2}px`;
                plotBody.style.maxWidth = `${TARGET_WIDTH - PAD * 2}px`;
                plotBody.style.height = `${finalHeight}px`;
                plotBody.style.minHeight = `${finalHeight}px`;
                plotBody.style.maxHeight = `${finalHeight}px`;
                plotBody.style.flex = `0 0 ${finalHeight}px`;
                plotBody.style.marginLeft = `${PAD}px`;
                plotBody.style.marginRight = `${PAD}px`;
            }
        });
        
        // Appliquer les styles de dimensionnement au wrapper des graphes pour forcer la taille cible
        plotsWrapper.style.width = `${TARGET_WIDTH}px`;
        plotsWrapper.style.height = `${TARGET_HEIGHT}px`;
        plotsWrapper.style.minWidth = `${TARGET_WIDTH}px`;
        plotsWrapper.style.minHeight = `${TARGET_HEIGHT}px`;
        plotsWrapper.style.maxWidth = `${TARGET_WIDTH}px`;
        plotsWrapper.style.maxHeight = `${TARGET_HEIGHT}px`;
        plotsWrapper.style.flex = 'none';
        plotsWrapper.style.overflow = 'hidden';
        plotsWrapper.style.display = 'flex';
        plotsWrapper.style.flexDirection = 'column';
        
        // Forcer le recalcul de la mise en page pour que les changements de style prennent effet
        void plotsWrapper.offsetHeight;

        forceResizeCharts();
        
        return true;
    }

    function restoreLayout() {
        if (!originalLayoutState) return;
        
        const S = window.S;
        if (S && S.activeTabId) {
            const plotsWrapper = document.getElementById(`plotsWrapper-${S.activeTabId}`);
            
            // Restaurer les styles de chaque plot et de ses elements enfants
            if (plotsWrapper) {
                if (originalLayoutState.wrapperStyle !== null && originalLayoutState.wrapperStyle !== '') {
                    plotsWrapper.setAttribute('style', originalLayoutState.wrapperStyle);
                } else {
                    plotsWrapper.removeAttribute('style');
                }
            }
            
            if (S.plots) {
                S.plots.forEach(plot => {
                    if (plot.element) {
                        // Restaurer le style du conteneur du graphe
                        if (originalLayoutState.containerStyles.has(plot.id)) {
                            const savedStyle = originalLayoutState.containerStyles.get(plot.id);
                            if (savedStyle !== null && savedStyle !== '') {
                                plot.element.setAttribute('style', savedStyle);
                            } else {
                                plot.element.removeAttribute('style');
                            }
                        }
                        
                        // Restaurer le style du corps du graphe
                        const plotBody = plot.element.querySelector('.plot-body');
                        if (plotBody && originalLayoutState.plotBodyStyles.has(plot.id)) {
                            const savedStyle = originalLayoutState.plotBodyStyles.get(plot.id);
                            if (savedStyle !== null && savedStyle !== '') {
                                plotBody.setAttribute('style', savedStyle);
                            } else {
                                plotBody.removeAttribute('style');
                            }
                        }
                        
                        // Restaurer le style de la legende
                        const legend = plot.element.querySelector('.plot-legend');
                        if (legend && originalLayoutState.legendStyles.has(plot.id)) {
                            const savedStyle = originalLayoutState.legendStyles.get(plot.id);
                            if (savedStyle !== null && savedStyle !== '') {
                                legend.setAttribute('style', savedStyle);
                            } else {
                                legend.removeAttribute('style');
                            }
                        }
                        
                        // Restaurer le style du splitter de legende
                        const splitter = plot.element.querySelector('.legend-splitter');
                        if (splitter && originalLayoutState.splitterStyles.has(plot.id)) {
                            const savedStyle = originalLayoutState.splitterStyles.get(plot.id);
                            if (savedStyle !== null && savedStyle !== '') {
                                splitter.setAttribute('style', savedStyle);
                            } else {
                                splitter.removeAttribute('style');
                            }
                        }
                        
                        // Restaurer le style du plot-main
                        const plotMain = plot.element.querySelector('.plot-main');
                        if (plotMain && originalLayoutState.plotMainStyles.has(plot.id)) {
                            const savedStyle = originalLayoutState.plotMainStyles.get(plot.id);
                            if (savedStyle !== null && savedStyle !== '') {
                                plotMain.setAttribute('style', savedStyle);
                            } else {
                                plotMain.removeAttribute('style');
                            }
                        }
                    }
                });
                
                // Forcer le recalcul de la mise en page pour que les changements de style prennent effet
                setTimeout(() => {
                    forceResizeCharts();
                    if (typeof resizeAllChartsNow === 'function') {
                        resizeAllChartsNow();
                    }
                    // Rebuild the plots layout if the function is available
                    if (typeof window.rebuildPlotsLayout === 'function') {
                        window.rebuildPlotsLayout(S.activeTabId);
                    }
                }, 200);
            }
        }
        
        originalLayoutState = null;
    }

    function buildComposite() {
        const { plots } = activeTabPlots();
        if (!plots.length) return null;

        dpr = window.devicePixelRatio || 1;
        const colors = themeColors();

        contentW = TARGET_WIDTH;
        contentH = TARGET_HEIGHT;

        // Calculer les dimensions de chaque graphe et de sa legende, pour determiner la hauteur totale du canvas composite
        const plotLayouts = plots.map(({ plot, container }) => {
            const cnv = plot.chart.ctx.canvas;
            const chartW = Math.round(cnv.width / dpr);
            const chartH = Math.round(cnv.height / dpr);
            
            // Mesurer la hauteur de la legende pour ce graphe
            const meas = document.createElement('canvas').getContext('2d');
            const entries = legendEntries(container);

            if (legendPosition === 'top') {
                const legH = legendHeight(meas, entries, contentW - PAD * 2);
                return { cnv, chartW, chartH, entries, legH, legW: 0, container };
            } else {
                const legW = calculateLegendWidth(meas, entries);
                return { cnv, chartW, chartH, entries, legH: 0, legW, container };
            }
        });

        composite = document.createElement('canvas');
        composite.width = Math.round(contentW * dpr);
        composite.height = Math.round(contentH * dpr);
        const ctx = composite.getContext('2d');
        ctx.scale(dpr, dpr);

        // Background
        ctx.fillStyle = colors.bg;
        ctx.fillRect(0, 0, contentW, contentH);

        // Title 
        ctx.textBaseline = 'middle';
        ctx.font = '600 15px sans-serif';
        ctx.fillStyle = colors.fg;
        let heading = exportHeading();
        const maxTitleW = contentW - PAD * 2 - 200;
        if (ctx.measureText(heading).width > maxTitleW) {
            while (heading.length > 1 && ctx.measureText(heading + '...').width > maxTitleW) {
                heading = heading.slice(0, -1);
            }
            heading += '...';
        }
        ctx.fillText(heading, PAD, PAD + TITLE_H / 2 - 2);

        // Timestamp
        ctx.font = '11px sans-serif';
        const stamp = new Date().toLocaleString();
        const sw = ctx.measureText(stamp).width;
        ctx.fillStyle = colors.muted;
        ctx.fillText(stamp, contentW - PAD - sw, PAD + TITLE_H / 2 - 2);

        // Plots
        let currentY = PAD + TITLE_H;
        
        plotLayouts.forEach((layout, index) => {
            if (legendPosition === 'top') {
                // Legend on top
                if (layout.entries.length) {
                    drawLegend(ctx, layout.entries, PAD, currentY, contentW - PAD * 2);
                    currentY += layout.legH;
                }
                
                // Chart
                ctx.drawImage(layout.cnv, PAD, currentY, contentW - PAD * 2, layout.chartH);
                drawCursors(ctx, layout.container, layout.cnv, PAD, currentY);
                
                currentY += layout.chartH + PLOT_GAP;
            } else {
                // Legend on right
                const chartWidth = contentW - PAD * 2 - layout.legW - 10; 
                const legendX = PAD + chartWidth + 10;
                
                // Chart
                ctx.drawImage(layout.cnv, PAD, currentY, chartWidth, layout.chartH);
                drawCursors(ctx, layout.container, layout.cnv, PAD, currentY);
                
                // Legend on right
                if (layout.entries.length) {
                    drawLegendVertical(ctx, layout.entries, legendX, currentY, layout.legW);
                }
                
                currentY += layout.chartH + PLOT_GAP;
            }
        });

        return composite;
    }

    // ---------------------------------------------------------------------
    // Dessin des annotations (memes coordonnees snapshot a l'affichage et a l'export)
    // ---------------------------------------------------------------------
    function drawArrowHead(ctx, x1, y1, x2, y2, size) {
        const a = Math.atan2(y2 - y1, x2 - x1);
        ctx.beginPath();
        ctx.moveTo(x2, y2);
        ctx.lineTo(x2 - size * Math.cos(a - Math.PI / 6), y2 - size * Math.sin(a - Math.PI / 6));
        ctx.moveTo(x2, y2);
        ctx.lineTo(x2 - size * Math.cos(a + Math.PI / 6), y2 - size * Math.sin(a + Math.PI / 6));
        ctx.stroke();
    }

    function drawAnnotation(ctx, a) {
        ctx.strokeStyle = a.color;
        ctx.fillStyle = a.color;
        ctx.lineWidth = a.width || 2.5;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        if (a.type === 'text') {
            ctx.font = `${a.size || 16}px sans-serif`;
            ctx.textBaseline = 'top';
            ctx.fillText(a.text, a.x, a.y);
        } else if (a.type === 'rect') {
            ctx.strokeRect(a.x, a.y, a.w, a.h);
        } else if (a.type === 'arrow') {
            ctx.beginPath();
            ctx.moveTo(a.x1, a.y1);
            ctx.lineTo(a.x2, a.y2);
            ctx.stroke();
            drawArrowHead(ctx, a.x1, a.y1, a.x2, a.y2, 12);
        } else if (a.type === 'pen') {
            const pts = a.points;
            if (pts && pts.length > 1) {
                ctx.beginPath();
                ctx.moveTo(pts[0].x, pts[0].y);
                for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
                ctx.stroke();
            }
        }
    }

    function redraw() {
        if (!annCtx) return;
        annCtx.clearRect(0, 0, contentW, contentH);
        annotations.forEach(a => { if (a.type !== 'text') drawAnnotation(annCtx, a); });
        if (draft && draft.type !== 'text') drawAnnotation(annCtx, draft);
    }

    // ---------------------------------------------------------------------
    // Modale
    // ---------------------------------------------------------------------
    function close() {
        closeColorPopover();
        if (overlay) { overlay.remove(); overlay = null; }
        annotations = [];
        floatingTexts.forEach(ft => { if (ft._el && ft._el.remove) ft._el.remove(); });
        floatingTexts = [];
        draft = null;
        annCtx = null;
        composite = null;
        reportListEl = null;
        restoreLayout();

        // `report` survit deliberement: la structure du rapport est conservee pour
        // accumuler les captures suivantes jusqu'a l'export ou au vidage explicite.
        document.removeEventListener('keydown', onKey, true);
    }

    function onKey(e) {
        // Pendant la saisie d'un texte, on laisse l'input gerer ses propres touches.
        const ae = document.activeElement;
        if (ae && ae.classList
                && (ae.classList.contains('exp-textinput') || ae.classList.contains('exp-rep-input'))) {
            if (e.key === 'Escape') ae.blur();
            return;
        }

        if (e.key === 'Escape') { close(); return; }
        const ctrl = e.ctrlKey || e.metaKey;
        if (!ctrl) return;
        const k = e.key.toLowerCase();
        if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
        else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
    }

    function toCanvasPos(e, canvas) {
        const r = canvas.getBoundingClientRect();
        return {
            x: (e.clientX - r.left) / displayScale,
            y: (e.clientY - r.top) / displayScale,
        };
    }

    function commitText(x, y, value) {
        if (value && value.trim()) {
            const ft = { type: 'text', x, y, text: value.trim(), color, size: 16 };
            floatingTexts.push(ft);
            pushAnnotation(ft);
            if (overlay) createFloatingTextElement(ft);
            redraw();
        }
    }
    
    function createFloatingTextElement(ft) {
        if (!overlay) return;
        const stage = overlay.querySelector('.exp-stage');
        if (!stage) return;
        const stageRect = stage.getBoundingClientRect();

        const el = document.createElement('div');
        el.className = 'floating-text';
        el.textContent = ft.text;
        el.style.position = 'absolute';
        el.style.whiteSpace = 'pre';
        el.style.padding = '2px 6px';
        el.style.background = 'transparent';
        el.style.borderRadius = '3px';
        el.style.color = ft.color || color;
        el.style.font = `${(ft.size || 16) * displayScale}px sans-serif`;
        el.style.cursor = 'move';
        el.style.zIndex = 5000;

        const left = Math.round(stageRect.left + ft.x * displayScale);
        const top = Math.round(stageRect.top + ft.y * displayScale);
        el.style.left = left + 'px';
        el.style.top = top + 'px';

        let dragging = false;
        let startX = 0, startY = 0;

        const onMouseDown = (e) => {
            if (e.button !== 0) return;
            dragging = true;
            startX = e.clientX;
            startY = e.clientY;
            e.preventDefault();
            document.body.style.userSelect = 'none';
        };
        const onMouseMove = (e) => {
            if (!dragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            startX = e.clientX;
            startY = e.clientY;
            const curLeft = parseFloat(el.style.left || 0);
            const curTop = parseFloat(el.style.top || 0);
            el.style.left = (curLeft + dx) + 'px';
            el.style.top = (curTop + dy) + 'px';
        };
        const onMouseUp = (e) => {
            if (!dragging) return;
            dragging = false;
            document.body.style.userSelect = '';
            // Update ft coordinates relative to stage
            const srect = stage.getBoundingClientRect();
            const ex = parseFloat(el.style.left) - srect.left;
            const ey = parseFloat(el.style.top) - srect.top;
            ft.x = ex / displayScale;
            ft.y = ey / displayScale;
        };

        el.addEventListener('mousedown', onMouseDown);
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);

        el.addEventListener('dblclick', () => {
            const inp = document.createElement('input');
            inp.className = 'exp-textinput';
            inp.style.left = el.style.left;
            inp.style.top = el.style.top;
            inp.style.color = ft.color || color;
            inp.value = ft.text;
            document.body.appendChild(inp);
            setTimeout(() => inp.focus(), 0);
            const commit = () => {
                ft.text = inp.value.trim();
                el.textContent = ft.text;
                inp.remove();
            };
            inp.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
                else if (ev.key === 'Escape') { inp.remove(); }
            });
            inp.addEventListener('blur', commit);
        });

        ft._el = el;
        overlay.appendChild(el);
    }

    function makeToolButton(id, label) {
        const b = document.createElement('button');
        b.className = 'exp-tool' + (tool === id ? ' active' : '');
        b.dataset.tool = id;
        b.title = label; 
        if (TOOL_ICONS[id]) {
            b.innerHTML = TOOL_ICONS[id];
        } else {
            b.textContent = label;
        }
        return b;
    }

    // Aplatit capture + annotations sur un canvas final a pleine resolution.
    function flattenToCanvas() {
        const out = document.createElement('canvas');
        out.width = composite.width;
        out.height = composite.height;
        const ctx = out.getContext('2d');
        ctx.drawImage(composite, 0, 0);
        ctx.scale(dpr, dpr);
        annotations.forEach(a => drawAnnotation(ctx, a));
        floatingTexts.forEach(ft => drawAnnotation(ctx, ft));
        return out;
    }

    // ---------------------------------------------------------------------
    // Rapport: blocs image (capture + legende) et texte libre, exportes en HTML autonome
    // ---------------------------------------------------------------------
    function addCaptureToReport() {
        const dataUrl = flattenToCanvas().toDataURL('image/png');
        report.blocks.push({ type: 'image', dataUrl, caption: '' });
        renderReport();
        if (typeof window.bbTrack === 'function') window.bbTrack('report_capture');
    }

    function addTextToReport() {
        report.blocks.push({ type: 'text', text: '' });
        renderReport();
        const areas = reportListEl ? reportListEl.querySelectorAll('.exp-rep-input') : [];
        if (areas.length) areas[areas.length - 1].focus();
    }

    function moveReportBlock(index, delta) {
        const target = index + delta;
        if (target < 0 || target >= report.blocks.length) return;
        const [block] = report.blocks.splice(index, 1);
        report.blocks.splice(target, 0, block);
        renderReport();
    }

    function removeReportBlock(index) {
        report.blocks.splice(index, 1);
        renderReport();
    }

    // Textarea auto-dimensionnee liee a un champ du bloc (mutation d'etat seule,
    // sans re-rendu, pour ne pas voler le focus a la frappe).
    function makeReportTextarea(value, placeholder, onInput) {
        const area = document.createElement('textarea');
        area.className = 'exp-rep-input';
        area.placeholder = placeholder;
        area.value = value;
        area.rows = 2;
        const autosize = () => {
            area.style.height = 'auto';
            area.style.height = Math.min(200, area.scrollHeight) + 'px';
        };
        area.addEventListener('input', () => { onInput(area.value); autosize(); });
        setTimeout(autosize, 0);
        return area;
    }

    function makeBlockControl(label, title, onClick) {
        const b = document.createElement('button');
        b.className = 'exp-rep-ctrl';
        b.textContent = label;
        b.title = title;
        b.addEventListener('click', onClick);
        return b;
    }

    function renderReport() {
        if (!reportListEl) return;
        reportListEl.innerHTML = '';
        if (!report.blocks.length) {
            const empty = document.createElement('div');
            empty.className = 'exp-rep-empty';
            empty.textContent = 'Rapport vide. Ajoutez la vue annotee ou ajoutez un bloc de texte.';
            reportListEl.appendChild(empty);
            return;
        }

        report.blocks.forEach((block, index) => {
            const card = document.createElement('div');
            card.className = 'exp-rep-block';

            const controls = document.createElement('div');
            controls.className = 'exp-rep-controls';
            controls.appendChild(makeBlockControl('\u2191', 'Monter', () => moveReportBlock(index, -1)));
            controls.appendChild(makeBlockControl('\u2193', 'Descendre', () => moveReportBlock(index, 1)));
            controls.appendChild(makeBlockControl('\u00d7', 'Supprimer le bloc', () => removeReportBlock(index)));
            card.appendChild(controls);

            if (block.type === 'image') {
                const img = document.createElement('img');
                img.className = 'exp-rep-thumb';
                img.src = block.dataUrl;
                img.alt = 'Capture annotee';
                card.appendChild(img);

                card.appendChild(makeReportTextarea(
                    block.caption, 'Legende / commentaire...', v => { block.caption = v; }
                ));
            } else {
                card.appendChild(makeReportTextarea(
                    block.text, 'Texte libre...', v => { block.text = v; }
                ));
            }
            reportListEl.appendChild(card);
        });
    }

    function reportTitle() {
        return report.title.trim() || `Rapport - ${new Date().toLocaleDateString()}`;
    }

    function escapeHtml(text) {
        return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function multiline(text) {
        return escapeHtml(text).replace(/\n/g, '<br>');
    }

    // Document HTML autonome (images en data-URL): lisible tel quel, imprimable en PDF
    // via le navigateur (mise en page A4 claire).
    function exportReportHtml() {
        if (!report.blocks.length) {
            if (typeof window.showNotification === 'function') {
                window.showNotification('Le rapport est vide.', 'warning');
            }
            return;
        }

        const title = reportTitle();
        let viewLink = '';
        try {
            if (typeof window.buildViewLink === 'function') {
                viewLink = window.buildViewLink();
            }
        } catch (e) {
            console.warn('Could not generate view link:', e);
        }

        const body = report.blocks.map(block => {
            if (block.type === 'image') {
                const caption = block.caption.trim()
                    ? `<figcaption class="caption">${multiline(block.caption)}</figcaption>` : '';
                const imgHtml = viewLink
                    ? `<a href="${viewLink}" style="text-decoration: none; cursor: pointer;" title="Cliquer pour ouvrir la vue dans Baltimore Bird"><img src="${block.dataUrl}" alt="Capture annotee"></a>`
                    : `<img src="${block.dataUrl}" alt="Capture annotee">`;
                return `<figure>
${imgHtml}
${caption}
</figure>`;
            }
            return block.text.trim() ? `<p class="freetext">${multiline(block.text)}</p>` : '';
        }).join('\n');

        const doc = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
body { font-family: -apple-system, 'Segoe UI', sans-serif; color: #1a1a1a; background: #fff;
       max-width: 920px; margin: 0 auto; padding: 32px 24px; }
h1 { font-size: 20px; border-bottom: 2px solid #1a1a1a; padding-bottom: 8px; }
.gen { color: #666; font-size: 12px; margin-bottom: 28px; }
figure { margin: 0 0 28px; page-break-inside: avoid; max-width: 1134px; }
figure a { display: inline-block; }
figure img { width: 100%; max-width: 100%; border: 1px solid #ddd; border-radius: 4px; }
figure a:hover img { box-shadow: 0 0 8px rgba(0,0,0,0.2); transition: box-shadow 0.2s; cursor: pointer; }
.caption { font-size: 13px; margin-top: 6px; line-height: 1.45; }
.freetext { font-size: 13px; line-height: 1.55; margin: 0 0 22px; }
@media print { body { padding: 0; } }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<div class="gen">Genere par Baltimore Bird le ${escapeHtml(new Date().toLocaleString())}</div>
${body}
</body>
</html>`;

        const d = new Date();
        const pad2 = (n) => String(n).padStart(2, '0');
        const stamp = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`
            + `_${pad2(d.getHours())}${pad2(d.getMinutes())}`;
        const safe = title.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'rapport';

        const blob = new Blob([doc], { type: 'text/html;charset=utf-8' });
        const a = document.createElement('a');
        a.download = `${safe}_${stamp}.html`;
        a.href = URL.createObjectURL(blob);
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        if (typeof window.bbTrack === 'function') window.bbTrack('report_export');
    }

    function buildReportPane() {
        const pane = document.createElement('div');
        pane.className = 'exp-report';

        const sectionTitle = document.createElement('div');
        sectionTitle.className = 'exp-section-title';
        sectionTitle.textContent = 'Rapport';
        pane.appendChild(sectionTitle);

        const titleInput = document.createElement('input');
        titleInput.type = 'text';
        titleInput.className = 'exp-rep-input exp-rep-title';
        titleInput.placeholder = `Saisir un titre (ex: Rapport - ${new Date().toLocaleDateString()})`;
        titleInput.value = report.title;
        titleInput.addEventListener('input', () => { report.title = titleInput.value; });
        pane.appendChild(titleInput);

        const actions = document.createElement('div');
        actions.className = 'exp-rep-actions';

        const textBtn = document.createElement('button');
        textBtn.className = 'exp-tool';
        textBtn.textContent = '+ Texte';
        textBtn.addEventListener('click', addTextToReport);
        actions.appendChild(textBtn);
        pane.appendChild(actions);

        reportListEl = document.createElement('div');
        reportListEl.className = 'exp-rep-list';
        pane.appendChild(reportListEl);

        const footer = document.createElement('div');
        footer.className = 'exp-rep-actions';

        const exportBtn = document.createElement('button');
        exportBtn.className = 'exp-tool exp-primary';
        exportBtn.textContent = 'Exporter HTML';
        exportBtn.addEventListener('click', exportReportHtml);
        footer.appendChild(exportBtn);

        const clearReportBtn = document.createElement('button');
        clearReportBtn.className = 'exp-tool';
        clearReportBtn.textContent = 'Vider';
        clearReportBtn.addEventListener('click', () => {
            if (!report.blocks.length) return;
            if (window.confirm('Vider le rapport en cours ? Les blocs seront perdus.')) {
                report.blocks = [];
                renderReport();
            }
        });
        footer.appendChild(clearReportBtn);
        pane.appendChild(footer);

        renderReport();
        return pane;
    }

    function download() {
        const out = flattenToCanvas();
        const d = new Date();
        const pad2 = (n) => String(n).padStart(2, '0');
        const stamp = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`
            + `_${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
        const safe = exportHeading().replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '');

        const a = document.createElement('a');
        a.download = `${safe}_${stamp}.png`;
        a.href = out.toDataURL('image/png');
        a.click();
        if (typeof window.bbTrack === 'function') window.bbTrack('png_export');
    }

    async function copyImageToClipboard() {
        const out = flattenToCanvas();
        if (!navigator.clipboard || !navigator.clipboard.write) {
            if (typeof window.showNotification === 'function') {
                window.showNotification('Votre navigateur ne supporte pas le presse-papiers d\'images.', 'warning');
            }
            return;
        }
        return new Promise((resolve, reject) => {
            out.toBlob(async (blob) => {
                try {
                    const item = new ClipboardItem({ [blob.type]: blob });
                    await navigator.clipboard.write([item]);
                    if (typeof window.showNotification === 'function') window.showNotification('Image copiée dans le presse-papiers.', 'success');
                    if (typeof window.bbTrack === 'function') window.bbTrack('png_copy');
                    resolve();
                } catch (e) {
                    if (typeof window.showNotification === 'function') window.showNotification('Échec de la copie.', 'error');
                    reject(e);
                }
            });
        });
    }

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

    function openColorPopover(input) {
        // Re-clic sur la meme pastille: bascule fermer/ouvrir
        if (colorPopoverInput === input) {
            closeColorPopover();
            return;
        }
        closeColorPopover();

        const pop = document.createElement('div');
        pop.className = 'color-preset-popover';
        pop.style.position = 'fixed';
        pop.style.zIndex = '10000'; 
        pop.style.pointerEvents = 'auto';
    
        // Etat HSV courant du nuancier, initialise depuis la couleur du signal.
        const rgb = hexToRgb(input.value) || { r: 232, g: 62, b: 62 };
        const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
    
        // Application live throttlee par frame
        let rafPending = false;
        function applyColor(hex, immediate = false) {
            input.value = hex;
            preview.style.background = hex;
            hexField.value = hex;
            if (immediate) {
                color = hex;
                const toolbar = input.closest('.exp-toolbar');
                if (toolbar) toolbar.style.setProperty('--selected-color', hex);
                return;
            }
            if (rafPending) return;
            rafPending = true;
            requestAnimationFrame(() => {
                rafPending = false;
                color = input.value;
                const toolbar = input.closest('.exp-toolbar');
                if (toolbar) toolbar.style.setProperty('--selected-color', input.value);
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
                e.preventDefault();
                input.value = hex;
                color = hex;
                const toolbar = input.closest('.exp-toolbar');
                if (toolbar) toolbar.style.setProperty('--selected-color', hex);
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


    function open() {
        if (overlay) close();

        const resized = resizePlotsWrapperForTarget();

        setTimeout(() => {
            try {
                if (!buildComposite()) {
                    restoreLayout();
                    if (typeof window.showNotification === 'function') {
                        window.showNotification('Aucun graphe à exporter dans cet onglet.', 'warning');
                    }
                    return;
                }

            const maxW = window.innerWidth * 0.96 - 30 - REPORT_PANE_W - 12;
            const maxH = window.innerHeight * 0.94 - 92;
            displayScale = Math.min(1, maxW / contentW, maxH / contentH);
            const dispW = Math.round(contentW * displayScale);
            const dispH = Math.round(contentH * displayScale);

            overlay = document.createElement('div');
            overlay.className = 'exp-overlay';

            const panel = document.createElement('div');
            panel.className = 'exp-panel';

            // Barre d'outils
            const toolbar = document.createElement('div');
            toolbar.className = 'exp-toolbar';

            const colorInput = document.createElement('input');
            colorInput.type = 'color';
            colorInput.className = 'exp-color';
            colorInput.value = '#e83e3e';
            colorInput.title = 'Couleur';
            toolbar.style.setProperty('--selected-color', '#e83e3e');
            color = '#e83e3e';
            colorInput.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                openColorPopover(colorInput);
            });

            toolbar.appendChild(colorInput);

            const tools = [
                ['text', 'Texte'], 
                ['arrow', 'Fleche'], 
                ['rect', 'Rectangle'], 
                ['pen', 'Dessin libre']
            ];

            const toolBtns = tools.map(([id, label]) => makeToolButton(id, label));
            toolBtns.forEach(b => {
                b.addEventListener('click', () => {
                    tool = b.dataset.tool;
                    toolBtns.forEach(x => x.classList.toggle('active', x.dataset.tool === tool));
                });
                toolbar.appendChild(b);
            });

            const divider = document.createElement('span');
            divider.className = 'toolbar-divider';
            toolbar.appendChild(divider);

            const undoBtn = document.createElement('button');
            undoBtn.className = 'exp-tool';
            undoBtn.textContent = 'Annuler';
            undoBtn.title = 'Annuler (Ctrl+Z)';
            undoBtn.addEventListener('click', undo);
            toolbar.appendChild(undoBtn);

            const redoBtn = document.createElement('button');
            redoBtn.className = 'exp-tool';
            redoBtn.textContent = 'Refaire';
            redoBtn.title = 'Refaire (Ctrl+Y)';
            redoBtn.addEventListener('click', redo);
            toolbar.appendChild(redoBtn);

            const clearBtn = document.createElement('button');
            clearBtn.className = 'exp-tool';
            clearBtn.textContent = 'Effacer';
            clearBtn.addEventListener('click', () => {
                annotations = [];
                floatingTexts.forEach(ft => { if (ft._el && ft._el.remove) ft._el.remove(); });
                floatingTexts = [];
                redraw();
            });
            toolbar.appendChild(clearBtn);

            const divider2 = document.createElement('span');
            divider2.className = 'toolbar-divider';
            toolbar.appendChild(divider2);

            const legendToggleBtn = document.createElement('button');
            legendToggleBtn.className = 'exp-tool keep-color';
            legendToggleBtn.title = 'Légende à droite';
            legendToggleBtn.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <rect x="3" y="3" width="18" height="18" rx="2"/>
                    <line x1="15" y1="3" x2="15" y2="21"/>
                </svg>`;
            legendToggleBtn.addEventListener('click', () => {
                legendPosition = legendPosition === 'top' ? 'right' : 'top';
                legendToggleBtn.title = legendPosition === 'top' ? 'Légende à droite' : 'Légende en haut';

                resizePlotsForLegendPosition();

                // Reconstruit le composite avec la nouvelle position de la légende
                setTimeout(() => {
                    const newComposite = buildComposite();
                if (!newComposite) return;

                    const stage = overlay.querySelector('.exp-stage');
                    const existingCanvas = stage.querySelector('.exp-snapshot');

                    if (existingCanvas) {
                        const ctx = existingCanvas.getContext('2d');
                        existingCanvas.width = newComposite.width;
                        existingCanvas.height = newComposite.height;
                        ctx.drawImage(newComposite, 0, 0);
                    }

                    composite = newComposite;

                    redraw();
                }, 50);
            });

            toolbar.appendChild(legendToggleBtn);

            const closeBtn = document.createElement('button');
            closeBtn.className = 'exp-close';
            closeBtn.textContent = '\u00d7';
            closeBtn.title = 'Fermer (Echap)';
            closeBtn.addEventListener('click', close);
            panel.appendChild(closeBtn);

            // Zone de dessin: capture (dessous) + couche d'annotation (dessus)
            const stage = document.createElement('div');
            stage.className = 'exp-stage';
            stage.style.width = dispW + 'px';
            stage.style.height = dispH + 'px';

            composite.style.width = dispW + 'px';
            composite.style.height = dispH + 'px';
            composite.className = 'exp-snapshot';

            const annCanvas = document.createElement('canvas');
            annCanvas.className = 'exp-annlayer';
            annCanvas.width = composite.width;
            annCanvas.height = composite.height;
            annCanvas.style.width = dispW + 'px';
            annCanvas.style.height = dispH + 'px';
            annCtx = annCanvas.getContext('2d');
            annCtx.scale(dpr, dpr);

            stage.appendChild(composite);
            stage.appendChild(annCanvas);

            const stageActions = document.createElement('div');
            stageActions.className = 'exp-stage-actions';

            const addToReportBtn = document.createElement('button');
            addToReportBtn.className = 'exp-tool exp-primary keep-color';
            addToReportBtn.type = 'button';
            addToReportBtn.title = 'Ajouter la capture au rapport';
            addToReportBtn.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <line x1="5" y1="12" x2="19" y2="12"/>
                    <polyline points="12 5 19 12 12 19"/>
                </svg>`;
            addToReportBtn.addEventListener('click', addCaptureToReport);
            stageActions.appendChild(addToReportBtn);

            const dlBtn = document.createElement('button');
            dlBtn.className = 'exp-tool exp-primary keep-color';
            dlBtn.type = 'button';
            dlBtn.title = 'Télécharger PNG';
            dlBtn.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                    <polyline points="17 8 12 3 7 8"/>
                    <line x1="12" y1="3" x2="12" y2="15"/>
                </svg>`;
            dlBtn.addEventListener('click', download);
            stageActions.appendChild(dlBtn);

            const copyBtn = document.createElement('button');
            copyBtn.className = 'exp-tool exp-primary keep-color';
            copyBtn.type = 'button';
            copyBtn.title = 'Copier PNG';
            copyBtn.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                </svg>`;
            copyBtn.addEventListener('click', async () => {
                try {
                    await copyImageToClipboard();
                } catch (e) {
                    console.error('Copy failed', e);
                }
            });
            stageActions.appendChild(copyBtn);

            const stageWrapper = document.createElement('div');
            stageWrapper.className = 'exp-stage-wrapper';
            stageWrapper.appendChild(stage);
            stageWrapper.appendChild(stageActions);

            const body = document.createElement('div');
            body.className = 'exp-body';
            const left = document.createElement('div');
            left.className = 'exp-left';
            const leftTitle = document.createElement('div');
            leftTitle.className = 'exp-section-title';
            leftTitle.textContent = 'Capture et annotations';
            left.appendChild(leftTitle);
            left.appendChild(toolbar);
            left.appendChild(stageWrapper);
            body.appendChild(left);
            body.appendChild(buildReportPane());
            panel.appendChild(body);
            overlay.appendChild(panel);
            document.body.appendChild(overlay);
            // Interactions de dessin
            let textInput = null;
            annCanvas.addEventListener('mousedown', (e) => {
                if (e.button !== 0) return;
                const p = toCanvasPos(e, annCanvas);
                if (tool === 'text') {
                    if (textInput) return;
                    e.preventDefault(); // empeche le canvas de reprendre le focus a l'input
                    textInput = document.createElement('input');
                    textInput.className = 'exp-textinput';
                    textInput.style.left = (e.clientX) + 'px';
                    textInput.style.top = (e.clientY) + 'px';
                    textInput.style.color = color;
                    document.body.appendChild(textInput);
                    setTimeout(() => { if (textInput) textInput.focus(); }, 0);
                    const commit = () => {
                        if (!textInput) return;
                        const val = textInput.value;
                        textInput.remove();
                        textInput = null;
                        commitText(p.x, p.y, val);
                    };
                    textInput.addEventListener('keydown', (ev) => {
                        ev.stopPropagation();
                        if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
                        else if (ev.key === 'Escape') { textInput.remove(); textInput = null; }
                    });
                    textInput.addEventListener('blur', commit);
                    return;
                }
                if (tool === 'pen') {
                    draft = { type: 'pen', color, width: 2.5, points: [{ x: p.x, y: p.y }] };
                } else if (tool === 'arrow') {
                    draft = { type: 'arrow', color, width: 2.5, x1: p.x, y1: p.y, x2: p.x, y2: p.y };
                } else if (tool === 'rect') {
                    draft = { type: 'rect', color, width: 2.5, x: p.x, y: p.y, w: 0, h: 0, _sx: p.x, _sy: p.y };
                }
            });

            annCanvas.addEventListener('mousemove', (e) => {
                if (!draft) return;
                const p = toCanvasPos(e, annCanvas);
                if (draft.type === 'pen') draft.points.push({ x: p.x, y: p.y });
                else if (draft.type === 'arrow') { draft.x2 = p.x; draft.y2 = p.y; }
                else if (draft.type === 'rect') {
                    draft.x = Math.min(draft._sx, p.x);
                    draft.y = Math.min(draft._sy, p.y);
                    draft.w = Math.abs(p.x - draft._sx);
                    draft.h = Math.abs(p.y - draft._sy);
                }
                redraw();
            });

            const endDraft = () => {
                if (!draft) return;
                const a = draft;
                draft = null;
                const tiny = (a.type === 'rect' && a.w < 3 && a.h < 3)
                    || (a.type === 'arrow' && Math.hypot(a.x2 - a.x1, a.y2 - a.y1) < 3)
                    || (a.type === 'pen' && a.points.length < 2);
                if (!tiny) { delete a._sx; delete a._sy; pushAnnotation(a); }
                redraw();
            };
            annCanvas.addEventListener('mouseup', endDraft);
            annCanvas.addEventListener('mouseleave', endDraft);

            overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
            document.addEventListener('keydown', onKey, true);
        } catch (error) {
            console.error('Error in open function:', error);
            restoreLayout();
        }
        }, 100);
    }

    function wireButton() {
        // Delegation au niveau document: robuste quel que soit le moment ou la vue EDA
        // (et son bouton) est injectee dans le DOM.
        if (document._expPngWired) return;
        document.addEventListener('click', (e) => {
            if (e.target.closest && e.target.closest('#exportPngBtn')) open();
        });
        document._expPngWired = true;
    }

    wireButton();
    window.openExportAnnotate = open;
})();
