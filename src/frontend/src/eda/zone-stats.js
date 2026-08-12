// Baltimore Bird - Statistiques par zone booleenne
// Deux surfaces d'affichage sur les zones etendues (fond colore des booleens):
// - tooltip au survol d'une zone dans un panneau analogique: duree de la zone +
//   min/moy/max de chaque signal du panneau, calcules cote serveur sur les
//   donnees pleine resolution (le cache pyramide du front est decime: bon pour
//   l'affichage, pas pour des chiffres);
// - popover recapitulatif depuis les reglages du booleen: agregat sur la
//   fenetre visible (occurrences, duree cumulee, couverture, stats par signal)
//   + liste des zones cliquables pour zoomer dessus.

import { S } from '../core/state.js';
import { API, ectx } from './context.js';
import { isBoolSignalIndex } from './plots.js';
import { recordViewChange, refreshAllPlots } from './view-nav.js';

// =========================================================================
// Format
// =========================================================================
function fmtNum(v) {
    if (v === null || v === undefined || !isFinite(v)) return '-';
    const a = Math.abs(v);
    if (a >= 1000) return v.toFixed(0);
    if (a >= 100) return v.toFixed(1);
    if (a >= 1) return v.toFixed(2);
    return v.toFixed(3);
}

function fmtDur(s) {
    if (s >= 60) {
        const m = Math.floor(s / 60);
        return `${m} min ${(s - m * 60).toFixed(1)} s`;
    }
    return `${s.toFixed(2)} s`;
}

function fmtT(t) {
    return `${t.toFixed(2)}`;
}

function signalColor(idx) {
    for (const p of S.plots) {
        const c = p.signalStyles?.[idx]?.color || p.cachedData?.[idx]?.color;
        if (c) return c;
    }
    return S.signalsInfo[idx]?.color || '#888';
}

function signalName(idx) {
    return S.signalsInfo[idx]?.name || `#${idx}`;
}

// Signaux analogiques affiches dans un panneau (cibles des stats), borne a 8.
function plotTargets(plot, boolIdx) {
    return (plot.signals || [])
        .filter(i => i !== boolIdx && !isBoolSignalIndex(i))
        .slice(0, 8);
}

// Fenetre de visualisation courante
function currentWindow() {
    const v = ectx.globalView || ectx.acquisitionView;
    return v ? [v.min, v.max] : [null, null];
}

// =========================================================================
// Fetch + caches
// =========================================================================
// Tooltip: les stats d'une zone entiere ne dependent pas de la fenetre -> cache
// par (session, bool, zone, cibles), tres stable pendant la navigation.
const zoneCache = new Map();

async function fetchZoneAt(boolIdx, t, targets) {
    const res = await fetch(`${API}/eda/zone-stats/${ectx.currentLazySessionId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bool_index: boolIdx, target_indices: targets, at: t }),
    });
    if (!res.ok) throw new Error('zone-stats failed');
    return res.json();
}

async function fetchZonesWindow(boolIdx, targets, t0, t1) {
    const res = await fetch(`${API}/eda/zone-stats/${ectx.currentLazySessionId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bool_index: boolIdx, target_indices: targets, t0, t1 }),
    });
    if (!res.ok) throw new Error('zone-stats failed');
    return res.json();
}

// =========================================================================
// Tooltip au survol des zones
// =========================================================================
let tooltipEl = null;
let tooltipKey = null;      // (session|bool|debutZoneFront|cibles): identite de la zone survolee
let pointerDown = false;

function hideZoneTooltip() {
    if (tooltipEl) {
        tooltipEl.remove();
        tooltipEl = null;
        tooltipKey = null;
    }
}

function statsTable(stats, targets) {
    const table = document.createElement('div');
    table.className = 'zone-stats-table';
    const head = document.createElement('div');
    head.className = 'zone-stats-row zone-stats-head';
    ['', 'min', 'moy', 'max'].forEach(h => {
        const c = document.createElement('span');
        c.textContent = h;
        head.appendChild(c);
    });
    table.appendChild(head);
    targets.forEach(idx => {
        const s = stats ? stats[String(idx)] : undefined;
        const row = document.createElement('div');
        row.className = 'zone-stats-row';
        const name = document.createElement('span');
        name.className = 'zone-stats-name';
        const sw = document.createElement('i');
        sw.className = 'zone-stats-swatch';
        sw.style.background = signalColor(idx);
        name.appendChild(sw);
        name.appendChild(document.createTextNode(signalName(idx)));
        name.title = signalName(idx);
        row.appendChild(name);
        [s?.min, s?.mean, s?.max].forEach(v => {
            const c = document.createElement('span');
            c.textContent = stats === null ? '…' : fmtNum(v ?? NaN);
            row.appendChild(c);
        });
        table.appendChild(row);
    });
    return table;
}

function renderTooltip(boolIdx, zone, targets, clientX, clientY) {
    hideZoneTooltip();
    const tip = document.createElement('div');
    tip.className = 'zone-stats-tooltip';

    const title = document.createElement('div');
    title.className = 'zone-stats-title';
    const sw = document.createElement('i');
    sw.className = 'zone-stats-swatch';
    sw.style.background = signalColor(boolIdx);
    title.appendChild(sw);
    title.appendChild(document.createTextNode(
        zone.index !== undefined
            ? `${signalName(boolIdx)} · zone ${zone.index + 1}/${zone.total_zones}`
            : signalName(boolIdx)
    ));
    tip.appendChild(title);

    const sub = document.createElement('div');
    sub.className = 'zone-stats-sub';
    sub.textContent = `${fmtT(zone.start)} → ${fmtT(zone.end)} s · ${fmtDur(zone.duration)}`;
    tip.appendChild(sub);

    if (zone.stats === 'error') {
        const err = document.createElement('div');
        err.className = 'zone-stats-sub';
        err.textContent = 'Stats indisponibles (backend non joignable ou non rechargé ?)';
        tip.appendChild(err);
    } else if (targets.length) {
        tip.appendChild(statsTable(zone.stats, targets));
    }

    document.body.appendChild(tip);
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let left = clientX + 14;
    if (left + tw > window.innerWidth - 8) left = clientX - tw - 14;
    let top = clientY + 14;
    if (top + th > window.innerHeight - 8) top = clientY - th - 14;
    tip.style.left = `${Math.max(8, left)}px`;
    tip.style.top = `${Math.max(8, top)}px`;
    tooltipEl = tip;
}

// Survol au repos ("dwell"): le tooltip n'apparait qu'apres DWELL_MS de souris
// immobile a l'interieur d'une zone - comme un tooltip d'OS - et disparait au
// moindre mouvement franc. Consequence directe: AUCUNE requete ne part tant que
// le tooltip n'est pas sur le point de s'afficher, la navigation au-dessus des
// zones reste totalement silencieuse. Le hit-test utilise les bornes front
// (cache eventuellement decime), l'affichage les bornes serveur (pleine
// resolution): difference invisible au pixel pres, chiffres exacts.
const DWELL_MS = 500;
const MOVE_TOLERANCE = 4;       // px: en-deca, on considere la souris immobile
const FAIL_RETRY_MS = 30000;    // memorisation des echecs: pas de martelage serveur

// Preference persistante: le tooltip est activable/desactivable depuis la
// toolbar (bouton #zoneTooltipToggle, cable dans bootstrap.js). Actif par
// defaut, meme cle de persistance que les autres bascules (bb_*).
const TOOLTIP_PREF_KEY = 'bb_zone_tooltip';
let tooltipEnabled = (() => {
    const saved = localStorage.getItem(TOOLTIP_PREF_KEY);
    return saved === null ? true : saved === 'true';
})();

export function isZoneTooltipEnabled() {
    return tooltipEnabled;
}

export function setZoneTooltipEnabled(on) {
    tooltipEnabled = !!on;
    localStorage.setItem(TOOLTIP_PREF_KEY, tooltipEnabled ? 'true' : 'false');
    if (!tooltipEnabled) {
        hideZoneTooltip();
        clearDwell();
    }
}

let dwellTimer = null;
let dwellAnchor = null;         // {x, y} de la derniere position armee
let shownAt = null;             // {x, y} au moment de l'affichage du tooltip

function clearDwell() {
    if (dwellTimer) {
        clearTimeout(dwellTimer);
        dwellTimer = null;
    }
    dwellAnchor = null;
}

function hitTestZone(e) {
    const over = e.target.closest?.('.u-over');
    if (!over) return null;
    const plot = S.plots.find(p => p.element && p.element.contains(over) && p.chart);
    if (!plot) return null;
    const rect = over.getBoundingClientRect();
    const t = plot.chart.posToVal(e.clientX - rect.left, 'x');
    for (const [sigIdx, zoneData] of ectx.extendedBoolZones) {
        for (const [start, end] of zoneData.ranges) {
            if (t >= start && t <= end) return { plot, boolIdx: sigIdx, start, end };
        }
    }
    return null;
}

function showTooltipFor(hit, clientX, clientY) {
    const targets = plotTargets(hit.plot, hit.boolIdx);
    const key = `${ectx.currentLazySessionId}|${hit.boolIdx}|${hit.start}|${targets.join(',')}`;

    const cached = zoneCache.get(key);
    if (cached && cached.error && Date.now() < cached.until) {
        renderTooltip(hit.boolIdx, { start: hit.start, end: hit.end, duration: hit.end - hit.start, stats: 'error' }, targets, clientX, clientY);
        tooltipKey = key;
        shownAt = { x: clientX, y: clientY };
        return;
    }
    if (cached && !cached.error) {
        renderTooltip(hit.boolIdx, cached, targets, clientX, clientY);
        tooltipKey = key;
        shownAt = { x: clientX, y: clientY };
        return;
    }

    // Squelette immediat (bornes front, stats en attente), remplace au retour.
    renderTooltip(hit.boolIdx, { start: hit.start, end: hit.end, duration: hit.end - hit.start, stats: null }, targets, clientX, clientY);
    tooltipKey = key;
    shownAt = { x: clientX, y: clientY };

    fetchZoneAt(hit.boolIdx, (hit.start + hit.end) / 2, targets).then(data => {
        if (!data.zone) {
            zoneCache.set(key, { error: true, until: Date.now() + FAIL_RETRY_MS });
            return;
        }
        zoneCache.set(key, data.zone);
        if (tooltipKey === key && tooltipEl) {
            const { left, top } = tooltipEl.getBoundingClientRect();
            renderTooltip(hit.boolIdx, data.zone, targets, left, top);
            tooltipEl.style.left = `${left}px`;
            tooltipEl.style.top = `${top}px`;
            tooltipKey = key;
        }
    }).catch(() => {
        // Echec memorise (backend absent / non recharge / erreur): pas de retry
        // immediat, et le tooltip le dit au lieu de rester muet.
        zoneCache.set(key, { error: true, until: Date.now() + FAIL_RETRY_MS });
        if (tooltipKey === key && tooltipEl) {
            const { left, top } = tooltipEl.getBoundingClientRect();
            renderTooltip(hit.boolIdx, { start: hit.start, end: hit.end, duration: hit.end - hit.start, stats: 'error' }, [], left, top);
            tooltipEl.style.left = `${left}px`;
            tooltipEl.style.top = `${top}px`;
            tooltipKey = key;
        }
    });
}

document.addEventListener('mousemove', (e) => {
    if (!tooltipEnabled || pointerDown || ectx.extendedBoolZones.size === 0 || !ectx.currentLazySessionId) {
        if (tooltipEl) hideZoneTooltip();
        clearDwell();
        return;
    }

    // Tooltip affiche: tolere les micro-mouvements de lecture, disparait au-dela.
    if (tooltipEl) {
        const moved = Math.hypot(e.clientX - shownAt.x, e.clientY - shownAt.y);
        if (moved <= MOVE_TOLERANCE) return;
        hideZoneTooltip();
        // et on retombe dans le rearmement ci-dessous
    }

    const hit = hitTestZone(e);
    if (!hit) {
        clearDwell();
        return;
    }

    // (Re)armement du dwell: tout mouvement franc repart de zero.
    if (dwellAnchor && Math.hypot(e.clientX - dwellAnchor.x, e.clientY - dwellAnchor.y) <= MOVE_TOLERANCE) {
        return; // immobile: laisser le timer courir
    }
    clearDwell();
    dwellAnchor = { x: e.clientX, y: e.clientY };
    const { clientX, clientY } = e;
    dwellTimer = setTimeout(() => {
        dwellTimer = null;
        if (pointerDown) return;
        showTooltipFor(hit, clientX, clientY);
    }, DWELL_MS);
});

document.addEventListener('pointerdown', () => { pointerDown = true; hideZoneTooltip(); clearDwell(); });
document.addEventListener('pointerup', () => { pointerDown = false; });
document.addEventListener('scroll', () => { hideZoneTooltip(); clearDwell(); }, true);
document.addEventListener('wheel', () => { hideZoneTooltip(); clearDwell(); }, { passive: true, capture: true });

// Session changee: le cache de zones ne vaut plus rien (indices re-attribues).
// La cle inclut la session, donc pas de collision - on purge juste pour la memoire.
setInterval(() => { if (zoneCache.size > 500) zoneCache.clear(); }, 60000);

// =========================================================================
// Popover recapitulatif (depuis les reglages du booleen)
// =========================================================================
let statsPopoverEl = null;

export function closeZoneStatsPopover() {
    if (statsPopoverEl) {
        statsPopoverEl.remove();
        statsPopoverEl = null;
    }
}

export function openZoneStatsPopover(anchor, boolIdx) {
    closeZoneStatsPopover();

    // Cibles: tous les signaux analogiques affiches dans les panneaux courants
    const targets = [...new Set(S.plots.flatMap(p => plotTargets(p, boolIdx)))].slice(0, 8);
    const [t0, t1] = currentWindow();

    const pop = document.createElement('div');
    pop.className = 'zone-stats-popover';

    const title = document.createElement('div');
    title.className = 'zone-stats-title';
    const sw = document.createElement('i');
    sw.className = 'zone-stats-swatch';
    sw.style.background = signalColor(boolIdx);
    title.appendChild(sw);
    title.appendChild(document.createTextNode(`Stats des zones · ${signalName(boolIdx)}`));
    pop.appendChild(title);

    const sub = document.createElement('div');
    sub.className = 'zone-stats-sub';
    sub.textContent = t0 !== null ? `Fenêtre visible: ${fmtT(t0)} → ${fmtT(t1)} s` : 'Acquisition complète';
    pop.appendChild(sub);

    const body = document.createElement('div');
    body.className = 'zone-stats-body';
    body.textContent = 'Calcul…';
    pop.appendChild(body);

    document.body.appendChild(pop);
    const r = anchor.getBoundingClientRect();
    let left = Math.min(r.left, window.innerWidth - pop.offsetWidth - 8);
    let top = r.bottom + 6;
    pop.style.left = `${Math.max(8, left)}px`;
    pop.style.top = `${top}px`;
    statsPopoverEl = pop;

    fetchZonesWindow(boolIdx, targets, t0, t1).then(data => {
        if (statsPopoverEl !== pop) return;
        body.textContent = '';

        const agg = data.aggregate;
        if (!agg || agg.count === 0) {
            body.textContent = 'Aucune zone dans la fenêtre visible.';
            return;
        }

        const aggLine = document.createElement('div');
        aggLine.className = 'zone-stats-agg';
        aggLine.textContent =
            `${agg.count} zone${agg.count > 1 ? 's' : ''} · ${fmtDur(agg.total_duration)} cumulés` +
            ` · ${(agg.coverage * 100).toFixed(1)} % du temps`;
        body.appendChild(aggLine);

        if (targets.length) {
            const aggTable = statsTable(agg.stats, targets);
            body.appendChild(aggTable);
        }

        const listTitle = document.createElement('div');
        listTitle.className = 'zone-stats-list-title';
        listTitle.textContent = data.zones_truncated
            ? `Zones (${data.zones.length} premières affichées, cliquer pour zoomer)`
            : 'Zones (cliquer pour zoomer)';
        body.appendChild(listTitle);

        const list = document.createElement('div');
        list.className = 'zone-stats-list';
        data.zones.forEach((z, k) => {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'zone-stats-zone-row';
            row.textContent =
                `${k + 1} · ${fmtT(z.start)} → ${fmtT(z.end)} s · ${fmtDur(z.duration)}${z.partial ? ' (partielle)' : ''}`;
            row.addEventListener('click', (e) => {
                e.stopPropagation();
                // Zoom sur la zone avec 10% de marge de part et d'autre
                const m = Math.max(z.duration * 0.1, 0.01);
                recordViewChange();
                ectx.globalView = { min: z.start - m, max: z.end + m };
                refreshAllPlots();
            });
            list.appendChild(row);
        });
        body.appendChild(list);

        // La position peut deborder en bas maintenant que le contenu est la
        const ph = pop.offsetHeight;
        if (top + ph > window.innerHeight - 8) {
            pop.style.top = `${Math.max(8, window.innerHeight - ph - 8)}px`;
        }
    }).catch(() => {
        if (statsPopoverEl === pop) body.textContent = 'Erreur de calcul des stats.';
    });
}

document.addEventListener('pointerdown', (e) => {
    if (statsPopoverEl && !statsPopoverEl.contains(e.target)) closeZoneStatsPopover();
});
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeZoneStatsPopover();
});
