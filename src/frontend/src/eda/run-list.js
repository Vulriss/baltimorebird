/**
 * Run List - Onglets fichiers de la vue EDA (barre du haut + roster de comparaison)
 *
 * Mono-fichier: un onglet par fichier ouvert (demo ou upload), l'onglet actif est la
 * source courante. Chaque onglet est une instance distincte de l'EDA: ses onglets de
 * layout, graphes, fenetre et curseurs lui sont propres (espaces de travail par
 * fichier, sessions.js). Le <select id="sourceSelector">, cache, reste le pont de selection:
 * les onglets et le menu "Ajouter un fichier" le pilotent, les autres modules le lisent.
 * La croix d'un onglet ferme le fichier (session supprimee pour un upload, simple
 * fermeture pour une demo). Le dernier onglet ne se ferme pas.
 *
 * Comparaison (opt-in, >= 2 runs): les onglets deviennent le roster des runs compares
 * (pastille, numero, reference, details, retrait de la comparaison), avec la bascule
 * Comparaison / Sequentiel au bout de la barre.
 */

import { renderFileInfo } from './file-info.js';

(function () {
    'use strict';

    const RUN_COLORS = ['#94e2d5', '#fab387', '#a6e3a1', '#89b4fa', '#f5c2e7', '#f9e2af', '#cba6f7', '#eba0ac'];
    const RUN_COLORS_LIGHT = ['#179299', '#fe640b', '#40a02b', '#1e66f5', '#ea76cb', '#df8e1d', '#8839ef', '#e64553'];

    let activePopover = null;
    let addMenu = null;

    // Fichiers ouverts, dans l'ordre d'ouverture (valeurs du <select>: id de source demo
    // ou "session_<id>"). Les runs y entrent d'office; une demo y entre quand elle devient
    // la source courante et en sort a la fermeture de son onglet.
    let openValues = [];

    const SOURCE_SUFFIXES = [' (exemple)', ' (temporaire)', ' (non disponible)'];

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str == null ? '' : String(str);
        return div.innerHTML;
    }

    // Source unique: app.js detient l'etat des runs (et donc l'index de palette
    // attribue a chacun). Le repli local ne sert que si run-list est charge avant
    // app.js, ou pour un identifiant inconnu du roster.
    function colorForId(id) {
        if (typeof window.runColorFor === 'function') return window.runColorFor(id);
        let hash = 0;
        const s = String(id);
        for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) | 0;
        const light = document.documentElement.getAttribute('data-theme') === 'light';
        return (light ? RUN_COLORS_LIGHT : RUN_COLORS)[Math.abs(hash) % RUN_COLORS.length];
    }

    // Selecteur de couleur ouvert au clic sur une pastille. Les teintes deja prises
    // par un autre fichier sont marquees: on peut quand meme les choisir, les deux
    // runs echangent alors leur couleur (aucun doublon possible).
    function openColorPicker(anchor, sessionId) {
        closePopover();
        if (!sessionId || typeof window.getRunPalette !== 'function') return;

        const pop = document.createElement('div');
        pop.className = 'run-popover run-color-popover';

        const title = document.createElement('div');
        title.className = 'run-popover-title';
        title.textContent = 'Couleur du fichier';
        pop.appendChild(title);

        const grid = document.createElement('div');
        grid.className = 'run-color-grid';

        const current = (typeof window.getRuns === 'function' ? window.getRuns() : [])
            .find(r => r.sessionId === sessionId);

        window.getRunPalette().forEach(entry => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'run-color-dot'
                + (current && current.colorIndex === entry.index ? ' is-current' : '')
                + (entry.takenBy && !(current && current.colorIndex === entry.index) ? ' is-taken' : '');
            btn.style.background = entry.color;
            btn.title = entry.takenBy && !(current && current.colorIndex === entry.index)
                ? `Utilisée par ${entry.takenBy} — échanger`
                : 'Choisir cette couleur';
            btn.setAttribute('aria-label', btn.title);
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (typeof window.setRunColorIndex === 'function') {
                    window.setRunColorIndex(sessionId, entry.index);
                }
                closePopover();
            });
            grid.appendChild(btn);
        });

        pop.appendChild(grid);
        document.body.appendChild(pop);
        positionPopover(pop, anchor);
        activePopover = pop;
        document.addEventListener('mousedown', onDocMouseDown, true);
        document.addEventListener('keydown', onKeyDown, true);
        window.addEventListener('resize', closePopover);
    }

    function getSelector() {
        return document.getElementById('sourceSelector');
    }

    function getRuns() {
        return (typeof window.getRuns === 'function' && window.getRuns()) || [];
    }

    function activeRunId() {
        return window.S ? window.S.activeRunId : null;
    }

    // Libelle d'option sans les suffixes d'etat, qui passent en classes / tooltip.
    function plainLabel(text) {
        let label = String(text || '').trim();
        SOURCE_SUFFIXES.forEach(suffix => { label = label.replace(suffix, ''); });
        return label;
    }

    function optionFor(value) {
        const sel = getSelector();
        if (!sel) return null;
        return Array.from(sel.options).find(o => o.value === value) || null;
    }

    function closeSvg() {
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">'
            + '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    }
    function uploadSvg() {
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
            + '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/>'
            + '<line x1="12" y1="3" x2="12" y2="15"/></svg>';
    }
    function compareSvg() {
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
            + '<rect x="3" y="4" width="8" height="16" rx="1"/><rect x="13" y="4" width="8" height="16" rx="1"/></svg>';
    }

    function detailsSvg() {
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
            + '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>';
    }
    function minusSvg() {
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
            + '<line x1="5" y1="12" x2="19" y2="12"/></svg>';
    }
    function pinSvg() {
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
            + '<path d="M12 21s-6-5.3-6-10a6 6 0 0 1 12 0c0 4.7-6 10-6 10z"/><circle cx="12" cy="11" r="2"/></svg>';
    }

    // =====================================================================
    // Popover de detail (stats + bloc offset / resync, inactif en tranche 1)
    // =====================================================================
    function buildPopover(run) {
        const pop = document.createElement('div');
        pop.className = 'run-popover';

        const duration = run.active ? (document.getElementById('statDuration')?.textContent || '-') : '-';
        const server = run.active ? (document.getElementById('statServer')?.textContent || '-') : '-';

        const sid = run.sessionId || null;
        const comparison = getRuns().length >= 2;
        const canOffset = !!sid && comparison && typeof window.setRunOffset === 'function';
        const isRef = sid && typeof window.isRefRun === 'function' && window.isRefRun(sid);
        const dt = (sid && typeof window.getRunOffset === 'function') ? window.getRunOffset(sid) : 0;

        let offsetBlock = '';
        if (canOffset && isRef) {
            offsetBlock = ''
                + '<div class="run-offset-block">'
                + '<div class="run-offset-block-header">'
                + '<span class="run-offset-block-title">Decalage temporel</span>'
                + '<span class="run-offset-badge">reference</span>'
                + '</div>'
                + '<div class="run-offset-note">Run de reference: &Delta;t = 0, les autres se calent dessus.</div>'
                + '</div>';
        } else if (canOffset) {
            offsetBlock = ''
                + '<div class="run-offset-block">'
                + '<div class="run-offset-block-header">'
                + '<span class="run-offset-block-title">Decalage temporel</span>'
                + '</div>'
                + '<div class="run-offset-controls">'
                + '<span class="run-offset-dt">&Delta;t</span>'
                + '<button class="run-offset-step" type="button" data-step="-1" aria-label="Diminuer">&minus;</button>'
                + `<input class="run-offset-input" type="number" step="0.1" value="${dt.toFixed(2)}">`
                + '<span class="run-offset-unit">s</span>'
                + '<button class="run-offset-step" type="button" data-step="1" aria-label="Augmenter">+</button>'
                + '<button class="run-offset-auto" type="button"'
                + ' title="Aligner automatiquement sur le run de reference (correlation croisee'
                + " d'un signal commun trace)\">Auto</button>"
                + '</div>'
                + '</div>';
        }

        pop.innerHTML = ''
            + '<div class="run-popover-header">'
            + `<span class="run-swatch" style="background:${colorForId(run.colorId)}"></span>`
            + `<span class="run-popover-name">${escapeHtml(run.name)}</span>`
            + '</div>'
            + '<div class="run-popover-stats">'
            + `<div class="stat-cell"><div class="stat-cell-label">duree</div><div class="stat-cell-value">${escapeHtml(duration)}</div></div>`
            + `<div class="stat-cell"><div class="stat-cell-label">serveur</div><div class="stat-cell-value">${escapeHtml(server)}</div></div>`
            + '</div>'
            + offsetBlock
            + (sid ? '<button class="run-delete-btn" type="button">Supprimer le fichier</button>' : '');

        if (canOffset && !isRef) {
            const input = pop.querySelector('.run-offset-input');
            const apply = (v) => {
                const val = parseFloat(v);
                const next = Number.isFinite(val) ? val : 0;
                input.value = next.toFixed(2);
                window.setRunOffset(sid, next);
            };
            input.addEventListener('change', () => apply(input.value));
            input.addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(input.value); });
            pop.querySelectorAll('.run-offset-step').forEach(btn => {
                btn.addEventListener('click', () => {
                    const step = parseFloat(btn.dataset.step) * 0.1;
                    apply((parseFloat(input.value) || 0) + step);
                });
            });
            const autoBtn = pop.querySelector('.run-offset-auto');
            if (autoBtn && typeof window.autoAlignRun === 'function') {
                autoBtn.addEventListener('click', async () => {
                    autoBtn.disabled = true;
                    autoBtn.textContent = '...';
                    try {
                        const result = await window.autoAlignRun(sid);
                        if (result) input.value = result.offset.toFixed(2);
                    } finally {
                        autoBtn.disabled = false;
                        autoBtn.textContent = 'Auto';
                    }
                });
            }
        }

        if (sid) {
            pop.querySelector('.run-delete-btn')?.addEventListener('click', () => {
                closePopover();
                if (typeof window.deleteRun === 'function') window.deleteRun(sid);
            });
        }

        return pop;
    }

    // Sous l'ancre, aligne a gauche: les ancres sont des onglets de la barre du haut.
    function positionPopover(pop, anchor) {
        const r = anchor.getBoundingClientRect();
        const margin = 8;
        const width = pop.offsetWidth;
        const height = pop.offsetHeight;
        let left = r.left;
        if (left + width > window.innerWidth - margin) left = Math.max(margin, window.innerWidth - width - margin);
        let top = r.bottom + 6;
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

    function togglePopover(anchor, run) {
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

    // =====================================================================
    // Onglets fichiers (mode mono)
    // =====================================================================
    // Met a jour la liste des fichiers ouverts: chaque run y figure, la source courante
    // aussi; une valeur dont l'option a disparu du <select> (run supprime) en sort.
    function syncOpenValues() {
        const sel = getSelector();
        if (!sel) return;
        const known = new Set(Array.from(sel.options).map(o => o.value).filter(Boolean));
        openValues = openValues.filter(v => known.has(v));
        getRuns().forEach(r => {
            const v = 'session_' + r.sessionId;
            if (known.has(v) && !openValues.includes(v)) openValues.push(v);
        });
        if (sel.value && known.has(sel.value) && !openValues.includes(sel.value)) openValues.push(sel.value);
    }

    // Bascule de fichier: chaque onglet est une instance distincte de l'EDA. Le passage
    // par le <select> (evenement change -> changeSource) photographie l'espace de
    // travail du fichier quitte et restaure celui du fichier ouvert (sessions.js), et
    // notifie l'onboarding. activateRun, qui garde les graphes et ne change que la
    // liste de signaux, reste reserve aux onglets de comparaison (buildChip).
    function activateValue(value) {
        const sel = getSelector();
        if (!sel || !value || value === sel.value) return;
        sel.value = value;
        sel.dispatchEvent(new Event('change'));
    }

    // Fermeture d'un onglet. Un upload est supprime (deleteRun rebascule si besoin et
    // oublie son espace de travail); une demo quitte la liste avec son espace de
    // travail, et l'onglet voisin prend le relais si elle etait active.
    function closeValue(value) {
        if (openValues.length <= 1) return;
        if (value.startsWith('session_')) {
            if (typeof window.deleteRun === 'function') window.deleteRun(value.slice('session_'.length));
            return;
        }
        const idx = openValues.indexOf(value);
        const sel = getSelector();
        const wasActive = sel && sel.value === value;
        openValues = openValues.filter(v => v !== value);
        // La bascule photographie l'onglet ferme de facon synchrone (avant tout await
        // de changeSource): on peut donc l'oublier juste apres.
        if (wasActive) activateValue(openValues[Math.min(idx, openValues.length - 1)]);
        if (typeof window.discardWorkspace === 'function') window.discardWorkspace(value);
        if (!wasActive) refresh();
    }

    function buildFileTab(value) {
        const sel = getSelector();
        const opt = optionFor(value);
        const run = value.startsWith('session_')
            ? getRuns().find(r => 'session_' + r.sessionId === value) : null;
        const label = run ? run.filename : plainLabel(opt ? opt.textContent : value);
        const active = sel && sel.value === value;

        const el = document.createElement('div');
        el.className = 'file-tab' + (active ? ' active' : '')
            + (run && run.ephemeral ? ' is-ephemeral' : '');
        el.setAttribute('role', 'tab');
        el.setAttribute('aria-selected', active ? 'true' : 'false');
        el.tabIndex = active ? 0 : -1;
        el.title = opt ? opt.textContent.trim() : label;

        if (run) {
            const swatch = document.createElement('span');
            swatch.className = 'run-swatch is-clickable';
            swatch.style.background = run.color || colorForId(run.sessionId);
            swatch.title = 'Changer la couleur de ce fichier';
            swatch.addEventListener('click', (e) => {
                e.stopPropagation();
                openColorPicker(swatch, run.sessionId);
            });
            el.appendChild(swatch);
        }

        const name = document.createElement('span');
        name.className = 'file-tab-name';
        name.textContent = label;
        el.appendChild(name);

        if (openValues.length > 1) {
            const close = document.createElement('button');
            close.type = 'button';
            close.className = 'file-tab-close';
            close.title = run ? 'Fermer ce fichier' : 'Fermer cet onglet';
            close.setAttribute('aria-label', close.title);
            close.innerHTML = closeSvg();
            close.addEventListener('click', (e) => {
                e.stopPropagation();
                closeValue(value);
            });
            el.appendChild(close);
        }

        el.addEventListener('click', () => activateValue(value));
        el.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                activateValue(value);
            }
        });
        return el;
    }

    // =====================================================================
    // Menu "Ajouter un fichier": upload, puis exemples et fichiers recents non ouverts
    // =====================================================================
    function closeAddMenu() {
        if (!addMenu) return;
        document.removeEventListener('mousedown', onAddMenuMouseDown, true);
        document.removeEventListener('keydown', onAddMenuKeyDown, true);
        addMenu.remove();
        addMenu = null;
        document.getElementById('fileAddBtn')?.setAttribute('aria-expanded', 'false');
    }

    function onAddMenuMouseDown(e) {
        if (addMenu && !addMenu.contains(e.target) && !e.target.closest('#fileAddBtn')) closeAddMenu();
    }

    function onAddMenuKeyDown(e) {
        if (e.key === 'Escape') closeAddMenu();
    }

    function menuItem(text, onSelect, opts = {}) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'file-add-item' + (opts.primary ? ' is-primary' : '');
        item.setAttribute('role', 'menuitem');
        item.disabled = !!opts.disabled;
        if (opts.icon) item.insertAdjacentHTML('beforeend', opts.icon);
        const span = document.createElement('span');
        span.textContent = text;
        item.appendChild(span);
        if (opts.title) item.title = opts.title;
        item.addEventListener('click', () => {
            closeAddMenu();
            onSelect();
        });
        return item;
    }

    function toggleAddMenu() {
        if (addMenu) {
            closeAddMenu();
            return;
        }
        closePopover();
        const btn = document.getElementById('fileAddBtn');
        const sel = getSelector();
        if (!btn || !sel) return;

        const menu = document.createElement('div');
        menu.className = 'file-add-menu';
        menu.setAttribute('role', 'menu');
        menu.appendChild(menuItem("Charger depuis l'ordinateur...", () => {
            if (typeof window.requestUpload === 'function') window.requestUpload();
        }, { primary: true, icon: uploadSvg() }));

        const title = document.createElement('div');
        title.className = 'file-add-menu-title';
        title.textContent = 'Exemples et fichiers récents';
        menu.appendChild(title);

        const candidates = Array.from(sel.options).filter(o => o.value && !openValues.includes(o.value));
        if (candidates.length) {
            candidates.forEach(o => {
                menu.appendChild(menuItem(plainLabel(o.textContent), () => {
                    sel.value = o.value;
                    sel.dispatchEvent(new Event('change'));
                }, { disabled: o.disabled, title: o.textContent.trim() }));
            });
        } else {
            const empty = document.createElement('div');
            empty.className = 'file-add-menu-empty';
            empty.textContent = 'Tous les fichiers sont déjà ouverts';
            menu.appendChild(empty);
        }

        btn.parentElement.appendChild(menu);
        btn.setAttribute('aria-expanded', 'true');
        addMenu = menu;
        document.addEventListener('mousedown', onAddMenuMouseDown, true);
        document.addEventListener('keydown', onAddMenuKeyDown, true);
    }

    function wireAddButton() {
        const btn = document.getElementById('fileAddBtn');
        if (!btn || btn._wired) return;
        btn.addEventListener('click', toggleAddMenu);
        btn._wired = true;
    }

    // =====================================================================
    // Roster (mode comparaison)
    // =====================================================================
    // Bascule du mode multi-fichiers: superposition (comparaison) ou mise bout a bout
    // (sequentiel, une seule serie continue par nom de signal).
    function buildModeToggle() {
        const row = document.createElement('div');
        row.className = 'run-mode-toggle';
        const current = typeof window.getRunsMode === 'function' ? window.getRunsMode() : 'compare';
        [
            { value: 'compare', text: 'Comparaison', title: 'Runs superposes sur le meme axe temps' },
            { value: 'sequential', text: 'Sequentiel', title: 'Runs mis bout a bout, une serie continue par signal' },
        ].forEach(({ value, text, title }) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'run-mode-btn' + (current === value ? ' active' : '');
            btn.textContent = text;
            btn.title = title;
            btn.addEventListener('click', () => {
                if (typeof window.setRunsMode === 'function') window.setRunsMode(value);
            });
            row.appendChild(btn);
        });
        return row;
    }

    // Onglet de run compare: memes gestes que l'ancien chip du roster, au format onglet.
    function buildChip(run) {
        const active = run.sessionId === activeRunId();
        const el = document.createElement('div');
        el.className = 'file-tab run-chip' + (active ? ' active' : '');
        el.dataset.id = run.sessionId;
        el.setAttribute('role', 'tab');
        el.setAttribute('aria-selected', active ? 'true' : 'false');
        el.innerHTML = ''
            + `<span class="run-swatch" style="background:${run.color || colorForId(run.sessionId)}"></span>`
            // Numero repris dans la legende des graphes, a la place du nom de fichier.
            + (run.number ? `<span class="run-num" title="Fichier n°${Number(run.number)}">${Number(run.number)}</span>` : '')
            + `<span class="file-tab-name" title="${escapeHtml(run.filename)}">${escapeHtml(run.filename)}</span>`
            + (run.ref ? `<span class="run-ref" title="Reference temporelle">${pinSvg()}</span>` : '')
            + `<button class="run-details-btn" type="button" title="Details du run" aria-label="Details du run">${detailsSvg()}</button>`
            + `<button class="run-chip-remove" type="button" title="Retirer de la comparaison" aria-label="Retirer de la comparaison">${minusSvg()}</button>`;

        el.addEventListener('click', (e) => {
            if (e.target.closest('.run-details-btn') || e.target.closest('.run-chip-remove')) return;
            if (e.target.closest('.run-swatch')) return; // gere ci-dessous
            if (typeof window.activateRun === 'function') window.activateRun(run.sessionId);
        });
        // La pastille ouvre le selecteur de couleur au lieu d'activer le run: c'est
        // l'element qui porte visuellement la couleur, donc l'endroit ou on la cherche.
        const swatch = el.querySelector('.run-swatch');
        if (swatch) {
            swatch.classList.add('is-clickable');
            swatch.title = 'Changer la couleur de ce fichier';
            swatch.addEventListener('click', (e) => {
                e.stopPropagation();
                openColorPicker(swatch, run.sessionId);
            });
        }
        el.querySelector('.run-details-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            togglePopover(el, { colorId: run.sessionId, name: run.filename, active, sessionId: run.sessionId });
        });
        el.querySelector('.run-chip-remove').addEventListener('click', (e) => {
            e.stopPropagation();
            if (typeof window.removeFromComparison === 'function') window.removeFromComparison(run.sessionId);
        });
        return el;
    }

    // Entree / sortie de la comparaison, au bout de la barre. Visible des deux fichiers
    // uploades, la comparaison reste opt-in et ne s'active jamais automatiquement.
    function buildCompareControls(runs, comparing) {
        const frag = document.createDocumentFragment();
        if (!comparing && runs.length < 2) return frag;

        if (comparing) frag.appendChild(buildModeToggle());

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'file-compare-btn' + (comparing ? ' active' : '');
        btn.innerHTML = compareSvg();
        const label = document.createElement('span');
        label.textContent = comparing ? 'Quitter la comparaison' : 'Comparer';
        btn.appendChild(label);
        btn.title = comparing ? 'Revenir au mode mono-fichier' : 'Superposer les fichiers uploades';
        btn.addEventListener('click', () => {
            if (comparing && typeof window.exitComparison === 'function') window.exitComparison();
            else if (!comparing && typeof window.enterComparison === 'function') window.enterComparison();
        });
        frag.appendChild(btn);
        return frag;
    }

    function refresh() {
        closePopover();
        closeAddMenu();
        const tabs = document.getElementById('fileTabs');
        if (!tabs) return;
        const runs = getRuns();
        const comparing = !!(window.S && window.S.comparing);

        syncOpenValues();
        const frag = document.createDocumentFragment();
        if (comparing) {
            runs.filter(r => r.compared).forEach(r => frag.appendChild(buildChip(r)));
        } else {
            openValues.forEach(v => frag.appendChild(buildFileTab(v)));
        }
        tabs.replaceChildren(frag);
        tabs.querySelector('.file-tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });

        document.getElementById('fileBarCompare')?.replaceChildren(buildCompareControls(runs, comparing));
        wireAddButton();
        renderActiveFileInfo(runs, comparing);
    }

    // Fiche sous l'onglet actif (file-info.js): format, nom complet, statut temporaire.
    // En comparaison, la fiche couvre l'ensemble des runs compares.
    function renderActiveFileInfo(runs, comparing) {
        if (comparing) {
            renderFileInfo({ name: `Comparaison de ${runs.filter(r => r.compared).length} fichiers` });
            return;
        }
        const value = getSelector()?.value || '';
        const run = value.startsWith('session_') ? runs.find(r => 'session_' + r.sessionId === value) : null;
        if (run) {
            // L'extension passe dans le badge; le nom complet reste en infobulle.
            const filename = run.filename || '';
            const ext = /\.([a-z0-9]+)$/i.exec(filename);
            renderFileInfo({
                name: ext ? filename.slice(0, ext.index) : filename,
                title: filename,
                format: ext ? ext[1].toUpperCase() : '',
                ephemeral: !!run.ephemeral,
            });
            return;
        }
        const opt = optionFor(value);
        renderFileInfo({ name: opt ? plainLabel(opt.textContent) : '', format: opt ? 'DÉMO' : '' });
    }

    window.refreshRunList = refresh;
})();
