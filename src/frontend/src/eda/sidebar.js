// Baltimore Bird - Splitter de largeur de la sidebar
// Module extrait de app.js (refactoring): voir src/eda/ARCHITECTURE.md

import { resizeAllChartsNow } from './plots.js';
import { beginGhostResize } from './shared-dom.js';

// =========================================================================
// Sidebar Resize Splitter
// =========================================================================
const SIDEBAR_WIDTH_KEY = 'bb_sidebar_width';

const SIDEBAR_MIN_WIDTH = 180;

const SIDEBAR_MAX_WIDTH = 600;

// Ajoute un splitter vertical apres la sidebar pour la redimensionner (utile
// pour les noms de signaux longs). La largeur est persistee dans localStorage.
export function setupSidebarSplitter() {
    const sidebar = document.querySelector('.sidebar');
    if (!sidebar) return;
    if (sidebar.nextElementSibling?.classList.contains('sidebar-splitter')) return;

    const saved = parseInt(localStorage.getItem(SIDEBAR_WIDTH_KEY), 10);
    if (Number.isFinite(saved) && saved >= SIDEBAR_MIN_WIDTH && saved <= SIDEBAR_MAX_WIDTH) {
        sidebar.style.width = saved + 'px';
    }
    sidebar.style.flexShrink = '0';

    const splitter = document.createElement('div');
    splitter.className = 'sidebar-splitter';
    splitter.style.cssText = 'flex:0 0 5px;cursor:col-resize;'
        + 'background:rgba(255,255,255,0.04);align-self:stretch;';
    sidebar.insertAdjacentElement('afterend', splitter);

    splitter.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const left = sidebar.getBoundingClientRect().left;
        const clamp = (x) => Math.min(left + SIDEBAR_MAX_WIDTH, Math.max(left + SIDEBAR_MIN_WIDTH, x));
        splitter.style.background = 'rgba(255,255,255,0.15)';
        beginGhostResize(e.clientX, clamp, (ghostX) => {
            splitter.style.background = 'rgba(255,255,255,0.04)';
            const width = Math.round(ghostX - left);
            sidebar.style.width = width + 'px';
            try {
                localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
            } catch (err) { /* stockage indisponible */ }
            requestAnimationFrame(resizeAllChartsNow);
        });
    });
}

