// Baltimore Bird - Largeur partagee des legendes de panneaux (splitter)
// Module extrait de app.js (refactoring): voir src/eda/ARCHITECTURE.md

import { resizeAllChartsNow } from './plots.js';
import { beginGhostResize } from './shared-dom.js';

// =========================================================================
// Largeur partagee des legendes (plot-legend)
// =========================================================================
// Toutes les legendes partagent une meme largeur, reglable via un splitter entre
// le graphe et sa legende. Permet d'afficher les noms complets des signaux.
const LEGEND_WIDTH_KEY = 'bb_legend_width';

const LEGEND_MIN_WIDTH = 120;

const LEGEND_MAX_WIDTH = 700;

let legendWidth = null;

// null => largeur par defaut du CSS

export function loadLegendWidth() {
    const saved = parseInt(localStorage.getItem(LEGEND_WIDTH_KEY), 10);
    if (Number.isFinite(saved) && saved >= LEGEND_MIN_WIDTH && saved <= LEGEND_MAX_WIDTH) {
        legendWidth = saved;
    }
}

// Applique la largeur partagee a une legende (transition coupee pour eviter un
// decalage avec le redimensionnement du graphe).
export function applyLegendWidthTo(el) {
    if (legendWidth == null || !el) return;
    el.style.transition = 'none';
    el.style.width = legendWidth + 'px';
}

// Applique la largeur partagee a toutes les legendes existantes.
function applyLegendWidth() {
    if (legendWidth == null) return;
    document.querySelectorAll('.plot-legend').forEach(applyLegendWidthTo);
}

// Demarre le redimensionnement (lie) des legendes depuis le splitter d'un plot.
export function startLegendResize(e, plotMain, splitter) {
    e.preventDefault();
    const mainRight = plotMain.getBoundingClientRect().right;
    const clamp = (x) => Math.min(
        mainRight - LEGEND_MIN_WIDTH,
        Math.max(mainRight - LEGEND_MAX_WIDTH, x)
    );
    splitter.style.background = 'rgba(255,255,255,0.15)';
    beginGhostResize(e.clientX, clamp, (ghostX) => {
        splitter.style.background = 'rgba(255,255,255,0.04)';
        legendWidth = Math.round(mainRight - ghostX);
        try {
            localStorage.setItem(LEGEND_WIDTH_KEY, String(legendWidth));
        } catch (err) { /* stockage indisponible */ }
        applyLegendWidth();
        requestAnimationFrame(resizeAllChartsNow);
    });
}

