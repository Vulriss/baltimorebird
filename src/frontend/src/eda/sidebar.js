// Baltimore Bird - Splitters de la sidebar (largeur, zone fichiers/signaux)
// Module extrait de app.js (refactoring): voir src/eda/ARCHITECTURE.md

import { resizeAllChartsNow } from './plots.js';
import { beginGhostResize, beginGhostResizeY } from './shared-dom.js';
import { renderVirtualList } from './signal-list.js';

// =========================================================================
// Sidebar Resize Splitter
// =========================================================================
const SIDEBAR_WIDTH_KEY = 'bb_sidebar_width';

const SIDEBAR_MIN_WIDTH = 180;

const SIDEBAR_MAX_WIDTH = 600;

// Splitter horizontal interne a la sidebar (hauteur de la zone fichiers). Le reste
// revient a la zone signaux, dont la liste virtualisee est re-rendue apres resize.
const SIDEBAR_FILES_HEIGHT_KEY = 'bb_sidebar_files_height';

const SIDEBAR_FILES_MIN_HEIGHT = 60;

const SIDEBAR_FILES_MAX_HEIGHT = 400;

const SIDEBAR_SIGNALS_MIN_HEIGHT = 160;

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

// Splitter interne a la sidebar: ajuste la hauteur de la zone fichiers, la zone
// signaux occupant le reste. La hauteur est persistee et la liste virtualisee est
// re-rendue (force) apres resize, sa hauteur visible ayant change.
export function setupSidebarVSplitter() {
    const files = document.getElementById('sidebarFiles');
    const splitter = document.getElementById('sidebarVSplitter');
    const sidebar = document.querySelector('.sidebar');
    if (!files || !splitter || !sidebar || splitter._listenerAdded) return;

    const clampHeight = (h) => Math.min(SIDEBAR_FILES_MAX_HEIGHT, Math.max(SIDEBAR_FILES_MIN_HEIGHT, h));
    const saved = parseInt(localStorage.getItem(SIDEBAR_FILES_HEIGHT_KEY), 10);
    if (Number.isFinite(saved)) files.style.height = clampHeight(saved) + 'px';

    splitter.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const top = files.getBoundingClientRect().top;
        const sidebarBottom = sidebar.getBoundingClientRect().bottom;
        const maxByLayout = Math.min(top + SIDEBAR_FILES_MAX_HEIGHT, sidebarBottom - SIDEBAR_SIGNALS_MIN_HEIGHT);
        const clampY = (y) => Math.min(maxByLayout, Math.max(top + SIDEBAR_FILES_MIN_HEIGHT, y));
        beginGhostResizeY(e.clientY, clampY, (ghostY) => {
            const height = Math.round(ghostY - top);
            files.style.height = height + 'px';
            try {
                localStorage.setItem(SIDEBAR_FILES_HEIGHT_KEY, String(height));
            } catch (err) { /* stockage indisponible */ }
            renderVirtualList(true);
        });
    });
    splitter._listenerAdded = true;
}

