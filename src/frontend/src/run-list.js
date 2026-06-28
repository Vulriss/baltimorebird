/**
 * Run List - Zone fichiers de la vue EDA (slots de comparaison)
 *
 * Chaque slot porte un selecteur de fichier. En v1 il y a un seul slot, dont le
 * <select id="sourceSelector"> est le controle natif (son listener change appelle
 * changeSource). Ce module ne gere que l'habillage du slot: pastille de couleur du
 * fichier courant et popover de detail (stats + bloc offset / resync, inactif en v1).
 * Le + et le - de la zone preparent le multi-fichiers et sont inactifs pour l'instant.
 */

(function () {
    'use strict';

    // Palette de couleurs de run (alignee sur les accents Catppuccin), assignee de
    // facon stable par identifiant de fichier.
    const RUN_COLORS = ['#94e2d5', '#fab387', '#a6e3a1', '#89b4fa', '#f5c2e7', '#f9e2af', '#cba6f7', '#eba0ac'];

    let activePopover = null;

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str == null ? '' : String(str);
        return div.innerHTML;
    }

    function colorForId(id) {
        let hash = 0;
        for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
        return RUN_COLORS[Math.abs(hash) % RUN_COLORS.length];
    }

    function getSelector() {
        return document.getElementById('sourceSelector');
    }

    function currentRun() {
        const sel = getSelector();
        if (!sel || !sel.value) return null;
        const opt = sel.options[sel.selectedIndex];
        return { id: sel.value, name: opt ? opt.textContent.trim() : sel.value };
    }

    function syncSwatch() {
        const swatch = document.querySelector('.run-slot .run-swatch');
        if (!swatch) return;
        const run = currentRun();
        swatch.style.background = run ? colorForId(run.id) : 'transparent';
    }

    // =====================================================================
    // Popover de detail du fichier (stats + bloc offset / resync inactif en v1)
    // =====================================================================
    function resyncMethodsMarkup() {
        return ''
            + '<div class="resync-methods">'
            + '<div class="resync-methods-title">Methodes de resync</div>'
            + '<label class="resync-method"><input type="radio" name="resync-method" disabled>'
            + '<span><span class="resync-method-name">Manuel</span>'
            + '<span class="resync-method-desc">decalage numerique ou drag horizontal de la trace</span></span></label>'
            + '<label class="resync-method"><input type="radio" name="resync-method" disabled>'
            + '<span><span class="resync-method-name">Sur evenement</span>'
            + '<span class="resync-method-desc">cale t=0 sur un trigger (seuil de vitesse, key-on)</span></span></label>'
            + '<label class="resync-method"><input type="radio" name="resync-method" disabled>'
            + '<span><span class="resync-method-name">Correlation croisee</span>'
            + '<span class="resync-method-desc">lag auto qui aligne un signal de reference</span>'
            + '<input type="text" class="resync-ref-search" placeholder="Rechercher un signal de reference..." disabled>'
            + '</span></label>'
            + '</div>';
    }

    function buildPopover(run) {
        const pop = document.createElement('div');
        pop.className = 'run-popover';

        const duration = document.getElementById('statDuration')?.textContent || '-';
        const server = document.getElementById('statServer')?.textContent || '-';

        pop.innerHTML = ''
            + '<div class="run-popover-header">'
            + `<span class="run-swatch" style="background:${colorForId(run.id)}"></span>`
            + `<span class="run-popover-name">${escapeHtml(run.name)}</span>`
            + '</div>'
            + '<div class="run-popover-stats">'
            + `<div class="stat-cell"><div class="stat-cell-label">duree</div><div class="stat-cell-value">${escapeHtml(duration)}</div></div>`
            + `<div class="stat-cell"><div class="stat-cell-label">serveur</div><div class="stat-cell-value">${escapeHtml(server)}</div></div>`
            + '</div>'
            + '<div class="run-offset-block" aria-disabled="true">'
            + '<div class="run-offset-block-header">'
            + '<span class="run-offset-block-title">Decalage temporel</span>'
            + '<span class="run-offset-badge">inactif en v1</span>'
            + '</div>'
            + '<div class="run-offset-controls">'
            + '<span class="run-offset-dt">&Delta;t</span>'
            + '<button class="run-offset-step" type="button" disabled aria-label="Diminuer">&minus;</button>'
            + '<span class="run-offset-value">+0.00 s</span>'
            + '<button class="run-offset-step" type="button" disabled aria-label="Augmenter">+</button>'
            + '<button class="run-offset-resync" type="button" disabled>Resynchroniser</button>'
            + '</div>'
            + resyncMethodsMarkup()
            + '</div>';
        return pop;
    }

    function positionPopover(pop, anchor) {
        const r = anchor.getBoundingClientRect();
        const margin = 8;
        const width = pop.offsetWidth;
        const height = pop.offsetHeight;
        let left = r.right + margin;
        if (left + width > window.innerWidth - margin) left = Math.max(margin, r.left - width - margin);
        let top = r.top;
        if (top + height > window.innerHeight - margin) top = Math.max(margin, window.innerHeight - height - margin);
        pop.style.left = Math.round(left) + 'px';
        pop.style.top = Math.round(top) + 'px';
    }

    function closePopover() {
        if (!activePopover) return;
        document.removeEventListener('mousedown', onDocMouseDown, true);
        document.removeEventListener('keydown', onKeyDown, true);
        window.removeEventListener('resize', closePopover);
        activePopover.remove();
        activePopover = null;
    }

    function onDocMouseDown(e) {
        if (activePopover && !activePopover.contains(e.target) && !e.target.closest('.run-details-btn')) {
            closePopover();
        }
    }

    function onKeyDown(e) {
        if (e.key === 'Escape') closePopover();
    }

    function togglePopover(anchor) {
        const run = currentRun();
        const wasOpen = !!activePopover;
        closePopover();
        if (wasOpen || !run) return;

        const pop = buildPopover(run);
        document.body.appendChild(pop);
        positionPopover(pop, anchor);
        activePopover = pop;
        document.addEventListener('mousedown', onDocMouseDown, true);
        document.addEventListener('keydown', onKeyDown, true);
        window.addEventListener('resize', closePopover);
    }

    function wireSlot() {
        const btn = document.querySelector('.run-slot .run-details-btn');
        if (btn && !btn._wired) {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                togglePopover(btn.closest('.run-slot'));
            });
            btn._wired = true;
        }
    }

    function refresh() {
        closePopover();
        syncSwatch();
        wireSlot();
    }

    window.refreshRunList = refresh;
})();
