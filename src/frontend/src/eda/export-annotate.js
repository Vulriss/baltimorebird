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

(function () {
    'use strict';

    const PAD = 16;
    const TITLE_H = 30;
    const LEGEND_ROW_H = 20;
    const PLOT_GAP = 14;
    const DEFAULT_COLORS = ['#f38ba8', '#94e2d5', '#fab387', '#89b4fa', '#a6e3a1', '#f9e2af', '#cba6f7'];

    let overlay = null;
    let composite = null;       // canvas de capture (backing = contentW*dpr)
    let contentW = 0;
    let contentH = 0;
    let displayScale = 1;
    let dpr = 1;

    let annotations = [];
    let undone = [];
    let tool = 'text';
    let color = '#f38ba8';
    let draft = null;           // annotation en cours (drag)
    let annCtx = null;          // contexte de la couche d'annotation (affichage)

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
        undone.push(annotations.pop());
        redraw();
    }

    function redo() {
        if (!undone.length) return;
        annotations.push(undone.pop());
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

    // Construit le canvas de capture (snapshot) de l'onglet actif.
    function buildComposite() {
        const { plots } = activeTabPlots();
        if (!plots.length) return null;

        dpr = window.devicePixelRatio || 1;
        const colors = themeColors();

        // Largeur de contenu: largeur CSS du plus large canvas de graphe.
        let chartW = 0;
        plots.forEach(({ plot }) => {
            const cnv = plot.chart.ctx.canvas;
            chartW = Math.max(chartW, Math.round(cnv.width / dpr));
        });
        contentW = chartW + PAD * 2;

        // Mesure (legende + graphe) par plot a l'aide d'un contexte temporaire.
        const meas = document.createElement('canvas').getContext('2d');
        let y = PAD + TITLE_H;
        const layout = [];
        plots.forEach(({ plot, container }) => {
            const cnv = plot.chart.ctx.canvas;
            const cw = Math.round(cnv.width / dpr);
            const ch = Math.round(cnv.height / dpr);
            const entries = legendEntries(container);
            const legH = legendHeight(meas, entries, chartW);
            layout.push({ cnv, cw, ch, entries, legH, y, container });
            y += legH + ch + PLOT_GAP;
        });
        contentH = y - PLOT_GAP + PAD;

        composite = document.createElement('canvas');
        composite.width = Math.round(contentW * dpr);
        composite.height = Math.round(contentH * dpr);
        const ctx = composite.getContext('2d');
        ctx.scale(dpr, dpr);

        // Fond + titre (fichier - onglet) + horodatage.
        ctx.fillStyle = colors.bg;
        ctx.fillRect(0, 0, contentW, contentH);
        ctx.textBaseline = 'middle';
        ctx.font = '11px sans-serif';
        const stamp = new Date().toLocaleString();
        const sw = ctx.measureText(stamp).width;
        ctx.fillStyle = colors.muted;
        ctx.fillText(stamp, contentW - PAD - sw, PAD + TITLE_H / 2 - 2);

        ctx.fillStyle = colors.fg;
        ctx.font = '600 15px sans-serif';
        let heading = exportHeading();
        const maxTitleW = contentW - PAD * 2 - sw - 16;
        if (ctx.measureText(heading).width > maxTitleW) {
            while (heading.length > 1 && ctx.measureText(heading + '...').width > maxTitleW) {
                heading = heading.slice(0, -1);
            }
            heading += '...';
        }
        ctx.fillText(heading, PAD, PAD + TITLE_H / 2 - 2);

        // Graphes + legendes + curseurs/valeurs visibles.
        layout.forEach(item => {
            drawLegend(ctx, item.entries, PAD, item.y, chartW);
            const ox = PAD;
            const oy = item.y + item.legH;
            ctx.drawImage(item.cnv, ox, oy, item.cw, item.ch);
            drawCursors(ctx, item.container, item.cnv, ox, oy);
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
        annotations.forEach(a => drawAnnotation(annCtx, a));
        if (draft) drawAnnotation(annCtx, draft);
    }

    // ---------------------------------------------------------------------
    // Modale
    // ---------------------------------------------------------------------
    function close() {
        if (overlay) { overlay.remove(); overlay = null; }
        annotations = [];
        draft = null;
        annCtx = null;
        composite = null;
        reportListEl = null;
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
            pushAnnotation({ type: 'text', x, y, text: value.trim(), color, size: 16 });
            redraw();
        }
    }

    function makeToolButton(id, label) {
        const b = document.createElement('button');
        b.className = 'exp-tool' + (tool === id ? ' active' : '');
        b.dataset.tool = id;
        b.textContent = label;
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
            empty.textContent = 'Rapport vide. Capturez la vue annotee ou ajoutez un bloc de texte.';
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
        const body = report.blocks.map(block => {
            if (block.type === 'image') {
                const caption = block.caption.trim()
                    ? `<figcaption class="caption">${multiline(block.caption)}</figcaption>` : '';
                return `<figure>
<img src="${block.dataUrl}" alt="Capture annotee">
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
figure { margin: 0 0 28px; page-break-inside: avoid; }
figure img { width: 100%; border: 1px solid #ddd; border-radius: 4px; }
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
        titleInput.placeholder = `Rapport - ${new Date().toLocaleDateString()}`;
        titleInput.value = report.title;
        titleInput.addEventListener('input', () => { report.title = titleInput.value; });
        pane.appendChild(titleInput);

        const actions = document.createElement('div');
        actions.className = 'exp-rep-actions';

        const captureBtn = document.createElement('button');
        captureBtn.className = 'exp-tool exp-primary';
        captureBtn.textContent = 'Capturer vers le rapport';
        captureBtn.addEventListener('click', addCaptureToReport);
        actions.appendChild(captureBtn);

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

    function open() {
        if (overlay) close();
        if (!buildComposite()) {
            if (typeof window.showNotification === 'function') {
                window.showNotification('Aucun graphe a exporter dans cet onglet.', 'warning');
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
        const tools = [['text', 'Texte'], ['arrow', 'Fleche'], ['rect', 'Rectangle'], ['pen', 'Trait libre']];
        const toolBtns = tools.map(([id, label]) => makeToolButton(id, label));
        toolBtns.forEach(b => {
            b.addEventListener('click', () => {
                tool = b.dataset.tool;
                toolBtns.forEach(x => x.classList.toggle('active', x.dataset.tool === tool));
            });
            toolbar.appendChild(b);
        });

        const colorInput = document.createElement('input');
        colorInput.type = 'color';
        colorInput.className = 'exp-color';
        colorInput.value = color;
        colorInput.title = 'Couleur';
        colorInput.addEventListener('input', () => { color = colorInput.value; });
        toolbar.appendChild(colorInput);

        const spacer = document.createElement('span');
        spacer.className = 'exp-spacer';
        toolbar.appendChild(spacer);

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
        clearBtn.addEventListener('click', () => { annotations = []; redraw(); });
        toolbar.appendChild(clearBtn);

        const divider = document.createElement('span');
        divider.className = 'toolbar-divider';
        toolbar.appendChild(divider);

        const dlBtn = document.createElement('button');
        dlBtn.className = 'exp-tool exp-primary';
        dlBtn.type = 'button';
        dlBtn.title = 'Télécharger PNG';
        dlBtn.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="17 8 12 3 7 8"/>
                <line x1="12" y1="3" x2="12" y2="15"/>
            </svg>`;
        dlBtn.addEventListener('click', download);
        toolbar.appendChild(dlBtn);

        const copyBtn = document.createElement('button');
        copyBtn.className = 'exp-tool exp-primary';
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
        toolbar.appendChild(copyBtn);

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

        const body = document.createElement('div');
        body.className = 'exp-body';
        const left = document.createElement('div');
        left.className = 'exp-left';
        const leftTitle = document.createElement('div');
        leftTitle.className = 'exp-section-title';
        leftTitle.textContent = 'Capture et annotations';
        left.appendChild(leftTitle);
        left.appendChild(toolbar);
        left.appendChild(stage);
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
