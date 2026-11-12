// Baltimore Bird - Toolbar EDA: repli / depli des libelles, hauteur partagee avec la sidebar

import { resizeAllChartsNow } from './plots.js';
import { renderVirtualList } from './signal-list.js';

const TOOLBAR_EXPANDED_KEY = 'bb_toolbar_expanded';

// Repliee par defaut (icones seules), comme la toolbar historique: le depli ajoute
// titres de groupe et libelles, au prix de la hauteur disponible pour les graphes.
export function setupToolbar() {
    const toolbar = document.getElementById('edaToolbar');
    const btn = document.getElementById('toolbarCollapseBtn');
    if (!toolbar || !btn || btn._listenerAdded) return;

    const apply = (expanded) => {
        toolbar.classList.toggle('is-expanded', expanded);
        btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        btn.title = expanded ? 'Masquer les libellés' : 'Afficher les libellés';
    };

    let expanded = false;
    try {
        expanded = localStorage.getItem(TOOLBAR_EXPANDED_KEY) === 'true';
    } catch (e) { /* stockage indisponible: repliee */ }
    apply(expanded);

    btn.addEventListener('click', () => {
        expanded = !expanded;
        apply(expanded);
        try {
            localStorage.setItem(TOOLBAR_EXPANDED_KEY, expanded ? 'true' : 'false');
        } catch (e) { /* stockage indisponible */ }
    });
    btn._listenerAdded = true;

    // La zone infos de la sidebar prend la hauteur de la toolbar, pour que la zone
    // signaux demarre a la hauteur de la rangee des onglets de layout. Observee plutot
    // que deduite de l'etat replie: un retour a la ligne sur ecran etroit change aussi
    // la hauteur. Graphes et liste virtualisee sont redimensionnes en consequence.
    const body = toolbar.closest('.app-body');
    if (!body || typeof ResizeObserver !== 'function') return;
    let lastHeight = null;
    new ResizeObserver(() => {
        const height = toolbar.offsetHeight;
        if (height === lastHeight) return;
        const first = lastHeight === null;
        lastHeight = height;
        body.style.setProperty('--eda-toolbar-height', height + 'px');
        if (!first) {
            requestAnimationFrame(() => {
                resizeAllChartsNow();
                renderVirtualList(true);
            });
        }
    }).observe(toolbar);
}
