/**
 * Run List - Zone fichiers de la vue EDA (roster de comparaison multi-fichiers)
 *
 * Mono-fichier (0 ou 1 run): le slot avec son <select id="sourceSelector"> est le
 * controle natif de selection de source (demo + uploads). Le swatch prend la couleur
 * du fichier courant.
 *
 * Comparaison (>= 2 runs): le slot se masque et le roster affiche un chip par run
 * uploade. Cliquer un chip l'active, son bouton - ferme la session. Le tracé reste
 * mono-actif (overlay branche en tranche suivante). Le bloc offset / resync du popover
 * reste inactif (tranche offset a venir).
 */

(function () {
    'use strict';

    const RUN_COLORS = ['#94e2d5', '#fab387', '#a6e3a1', '#89b4fa', '#f5c2e7', '#f9e2af', '#cba6f7', '#eba0ac'];
    const RUN_COLORS_LIGHT = ['#179299', '#fe640b', '#40a02b', '#1e66f5', '#ea76cb', '#df8e1d', '#8839ef', '#e64553'];

    let activePopover = null;

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

    // Cle de couleur stable: l'identifiant nu de session, sans le prefixe "session_"
    // du <select>, pour que mono et comparaison donnent la meme couleur a un fichier.
    function colorKey(value) {
        return value && value.startsWith('session_') ? value.slice('session_'.length) : value;
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

    function activeSelectFile() {
        const sel = getSelector();
        if (!sel || !sel.value) return null;
        const opt = sel.options[sel.selectedIndex];
        return { id: sel.value, name: opt ? opt.textContent.trim() : sel.value };
    }

    function syncSwatch() {
        const swatch = document.querySelector('.run-slot .run-swatch');
        if (!swatch) return;
        const file = activeSelectFile();
        swatch.style.background = file ? colorForId(colorKey(file.id)) : 'transparent';

        // Meme geste qu'en comparaison: la pastille du selecteur ouvre le choix de
        // couleur, tant que le fichier correspond a un run enregistre.
        const sid = file && file.id.startsWith('session_')
            ? file.id.slice('session_'.length) : null;
        swatch.classList.toggle('is-clickable', Boolean(sid));
        swatch.title = sid ? 'Changer la couleur de ce fichier' : '';
        if (!swatch._colorWired) {
            swatch.addEventListener('click', (e) => {
                e.stopPropagation();
                const f = activeSelectFile();
                const id = f && f.id.startsWith('session_')
                    ? f.id.slice('session_'.length) : null;
                if (id) openColorPicker(swatch, id);
            });
            swatch._colorWired = true;
        }
    }

    function detailsSvg() {
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
            + '<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>';
    }
    function minusSvg() {
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
            + '<line x1="5" y1="12" x2="19" y2="12"/></svg>';
    }
    function pinSvg() {
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
            + '<path d="M12 21s-6-5.3-6-10a6 6 0 0 1 12 0c0 4.7-6 10-6 10z"/><circle cx="12" cy="11" r="2"/></svg>';
    }
    function trashSvg() {
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
            + '<polyline points="3 6 5 6 21 6"/>'
            + '<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>'
            + '<line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';
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

        // Mode mono: le popover du slot est le seul acces aux autres fichiers charges
        // (le roster n'existe qu'en comparaison). On les liste ici avec chacun leur
        // bouton de suppression, pour fermer une session SANS basculer dessus - la
        // suppression d'un run non actif ne touche ni la liste de signaux ni les
        // graphes du fichier courant (deleteRun ne rebascule que si wasActive).
        if (run.slot) {
            const others = getRuns().filter(r => r.sessionId && r.sessionId !== sid);
            if (others.length) {
                const section = document.createElement('div');
                section.className = 'run-popover-files';

                const title = document.createElement('div');
                title.className = 'run-popover-files-title';
                title.textContent = 'Autres fichiers chargés';
                section.appendChild(title);

                others.forEach(r => {
                    const row = document.createElement('div');
                    row.className = 'run-file-row';

                    const sw = document.createElement('span');
                    sw.className = 'run-swatch';
                    sw.style.background = colorForId(r.sessionId);

                    const name = document.createElement('span');
                    name.className = 'run-file-name';
                    name.textContent = r.filename;
                    name.title = r.filename;

                    const del = document.createElement('button');
                    del.type = 'button';
                    del.className = 'run-file-del';
                    del.title = 'Supprimer ce fichier (sans basculer dessus)';
                    del.setAttribute('aria-label', del.title);
                    del.innerHTML = trashSvg();
                    del.addEventListener('click', (e) => {
                        e.stopPropagation();
                        row.remove();
                        if (!section.querySelector('.run-file-row')) section.remove();
                        if (typeof window.deleteRun === 'function') window.deleteRun(r.sessionId);
                    });

                    row.appendChild(sw);
                    row.appendChild(name);
                    row.appendChild(del);
                    section.appendChild(row);
                });

                pop.appendChild(section);
            }
        }

        return pop;
    }

    function positionPopover(pop, anchor) {        const r = anchor.getBoundingClientRect();
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

    function buildChip(run) {
        const active = run.sessionId === activeRunId();
        const el = document.createElement('div');
        el.className = 'run-chip' + (active ? ' active' : '');
        el.dataset.id = run.sessionId;
        el.innerHTML = ''
            + `<span class="run-swatch" style="background:${run.color || colorForId(run.sessionId)}"></span>`
            + `<span class="run-name" title="${escapeHtml(run.filename)}">${escapeHtml(run.filename)}</span>`
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

    function wireSlotDetails() {
        const btn = document.querySelector('.run-slot .run-details-btn');
        if (btn && !btn._wired) {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const file = activeSelectFile();
                if (file) {
                    const sid = file.id.startsWith('session_') ? file.id.slice('session_'.length) : null;
                    togglePopover(btn.closest('.run-slot'), { colorId: colorKey(file.id), name: file.name, active: true, sessionId: sid, slot: true });
                }
            });
            btn._wired = true;
        }
    }

    // Bouton d'entree / sortie de la comparaison. Visible des deux fichiers uploades,
    // il bascule vers le roster (comparaison opt-in) et jamais automatiquement.
    function updateCompareButton(runs, comparing) {
        const btn = document.getElementById('runCompareBtn');
        if (!btn) return;
        const label = btn.querySelector('span');
        if (comparing) {
            btn.style.display = '';
            if (label) label.textContent = 'Quitter la comparaison';
            btn.title = 'Revenir au mode mono-fichier';
        } else if (runs.length >= 2) {
            btn.style.display = '';
            if (label) label.textContent = 'Comparer les fichiers';
            btn.title = 'Superposer les fichiers uploades';
        } else {
            btn.style.display = 'none';
        }
        if (!btn._wired) {
            btn.addEventListener('click', () => {
                const on = !!(window.S && window.S.comparing);
                if (on && typeof window.exitComparison === 'function') window.exitComparison();
                else if (!on && typeof window.enterComparison === 'function') window.enterComparison();
            });
            btn._wired = true;
        }
    }

    function refresh() {
        closePopover();
        const runs = getRuns();
        const comparing = !!(window.S && window.S.comparing);
        const compared = runs.filter(r => r.compared);
        const slots = document.getElementById('runSlots');
        const roster = document.getElementById('runRoster');

        if (slots) slots.style.display = comparing ? 'none' : '';
        if (roster) {
            roster.style.display = comparing ? '' : 'none';
            if (comparing) {
                const frag = document.createDocumentFragment();
                frag.appendChild(buildModeToggle());
                compared.forEach(r => frag.appendChild(buildChip(r)));
                roster.replaceChildren(frag);
            } else {
                roster.replaceChildren();
            }
        }

        if (!comparing) {
            syncSwatch();
            wireSlotDetails();
        }
        updateCompareButton(runs, comparing);
    }

    window.refreshRunList = refresh;
})();
