// Baltimore Bird - Libelles de l'axe temporel X
//
// Deux niveaux, sur le modele des references (d3 tickFormat, matplotlib ScalarFormatter,
// Perfetto):
// - Absolu: chaque graduation en secondes, avec exactement les decimales du pas choisi
//   par uPlot (0,025 -> 3 decimales), memes decimales sur toutes les graduations.
// - Relatif: quand le libelle absolu depasse MAX_ABSOLUTE_DIGITS chiffres et que le
//   decalage en economise au moins OFFSET_THRESHOLD (seuil par defaut de matplotlib),
//   les graduations deviennent des ecarts "+500 µs" a une ancre ronde, avec un prefixe
//   SI commun, et l'ancre absolue est affichee une fois dans le coin bas-gauche.

const MAX_ABSOLUTE_DIGITS = 7;
const OFFSET_THRESHOLD = 4;
// Borne de maximumFractionDigits pour Intl.NumberFormat.
const MAX_DECIMALS = 20;
// Espacement minimal par defaut d'uPlot entre graduations X (px).
const DEFAULT_SPACE = 50;
// Largeur estimee d'un caractere de libelle d'axe (12px system-ui, chiffres) et marge.
const LABEL_CHAR_PX = 7;
const LABEL_GAP_PX = 16;
const NICE_MULTIPLES = [1, 2, 2.5, 5, 10];
const SI_UNITS = new Map([[0, 's'], [-3, 'ms'], [-6, 'µs'], [-9, 'ns']]);
const OFFSET_LABEL_CLASS = 'x-axis-offset';

const LOCALE = typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'en-US';
const formatters = new Map();

function numberFormat(decimals) {
    let fmt = formatters.get(decimals);
    if (!fmt) {
        fmt = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
        formatters.set(decimals, fmt);
    }
    return fmt;
}

// Nombre de chiffres de la partie entiere (au moins 1).
function intDigits(value) {
    return String(Math.floor(Math.abs(value))).length;
}

// Decimales exactes d'un pas de graduation: 50 -> 0, 0.025 -> 3, 5e-5 -> 5.
export function stepDecimals(step) {
    if (!(step > 0) || !Number.isFinite(step)) return 0;
    for (let dec = 0; dec < MAX_DECIMALS; dec++) {
        const scaled = step * 10 ** dec;
        if (scaled >= 0.5 && Math.abs(scaled - Math.round(scaled)) < 1e-6 * scaled) return dec;
    }
    return MAX_DECIMALS;
}

// Exposant SI (0, -3, -6, -9) adapte a une duree positive.
function siExponent(value) {
    if (!(value > 0)) return 0;
    const exp = Math.floor(Math.log10(value) / 3) * 3;
    return Math.min(0, Math.max(-9, exp));
}

// Choisit le mode d'affichage pour la plage [min, max] graduee au pas step.
// Retour: { offset: null, decimals } en absolu, ou
// { offset, offsetDecimals, unitExp, decimals } en relatif.
export function timeAxisLayout(min, max, step) {
    const decimals = Math.min(MAX_DECIMALS, stepDecimals(step));
    const span = max - min;
    const absDigits = intDigits(Math.max(Math.abs(min), Math.abs(max))) + decimals;
    if (absDigits <= MAX_ABSOLUTE_DIGITS || !(span > 0)) return { offset: null, decimals };

    // Ancre ronde a la puissance de 10 superieure a l'etendue: les ecarts des graduations
    // restent des multiples ronds du pas, et l'ancre ne bouge qu'au franchissement d'un bloc.
    // La tolerance absorbe le bruit de max - min (1e-6 lu 1.00000000003e-6 vers t = 1234 s).
    const offsetExp = Math.ceil(Math.log10(span) - 1e-6);
    const offsetStep = 10 ** offsetExp;
    const offset = Math.floor(min / offsetStep) * offsetStep;
    const maxRel = max - offset;
    const unitExp = siExponent(maxRel);
    const relDecimals = Math.min(MAX_DECIMALS, Math.max(0, decimals + unitExp));
    const relDigits = intDigits(maxRel / 10 ** unitExp) + relDecimals;
    if (absDigits - relDigits < OFFSET_THRESHOLD) return { offset: null, decimals };

    return { offset, offsetDecimals: Math.max(0, -offsetExp), unitExp, decimals: relDecimals };
}

// Libelles des graduations selon le mode retenu par timeAxisLayout.
export function formatTimeTicks(splits, layout) {
    const fmt = numberFormat(layout.decimals);
    if (layout.offset === null) {
        return splits.map(v => (v == null ? '' : fmt.format(v)));
    }
    const scale = 10 ** -layout.unitExp;
    const unit = SI_UNITS.get(layout.unitExp);
    return splits.map(v => {
        if (v == null) return '';
        // Arrondi avant le signe: un ecart de -1e-13 (bruit flottant) s'affiche "+0".
        const rel = Number(((v - layout.offset) * scale).toFixed(layout.decimals));
        return `${rel < 0 ? '−' : '+'}${fmt.format(Math.abs(rel))} ${unit}`;
    });
}

// Texte de l'ancre absolue en mode relatif ("1 234,000 s +").
export function formatTimeOffset(layout) {
    return `${numberFormat(layout.offsetDecimals).format(layout.offset)} s +`;
}

// Duree avec prefixe SI ("34ms", "18µs", "1.234s"), a la precision de decimals
// exprimee en secondes. Arrondi en secondes avant le choix de l'unite: 999.6 µs a 3
// decimales donne "1ms", pas "1000µs". Separateur '.', comme les temps curseurs
// (toFixed). Pas d'espace avant l'unite: coherent avec le repere minutes/secondes
// de formatDurationWithMinutes ("2m 4s"), colle au nombre de la meme facon.
export function formatDuration(seconds, decimals) {
    const rounded = Number(seconds.toFixed(decimals));
    const unitExp = siExponent(rounded === 0 ? 10 ** -decimals : Math.abs(rounded));
    const unitDecimals = Math.max(0, decimals + unitExp);
    const magnitude = Math.abs(rounded * 10 ** -unitExp).toFixed(unitDecimals);
    return `${rounded < 0 ? '−' : ''}${magnitude}${SI_UNITS.get(unitExp)}`;
}

// Repere minutes/secondes en plus du delta SI au-dela de 60s ("124.000 s (2m 4s)"):
// une duree de curseur a curseur se lit comme un intervalle de lecture (podcast,
// trajet), pas comme une mesure scientifique - sans lui, "124.000 s" demande un
// calcul mental que la parenthese evite, sans faire perdre la precision du nombre
// principal (deja a la resolution du zoom courant, cf. cursorTimeDecimals).
export function formatDurationWithMinutes(seconds, decimals) {
    const base = formatDuration(seconds, decimals);
    const abs = Math.abs(seconds);
    if (abs < 60) return base;
    const totalSeconds = Math.round(abs);
    const minutes = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${base} (${minutes}m ${secs}s)`;
}

// Pas "rond" (1, 2, 2.5, 5 x 10^k) immediatement superieur ou egal a raw, comme uPlot.
function niceStep(raw) {
    const mag = 10 ** Math.floor(Math.log10(raw));
    return mag * NICE_MULTIPLES.find(mult => raw <= mult * mag);
}

// Option axis.space d'uPlot: espacement minimal elargi a la largeur estimee des libelles,
// pour qu'ils ne se chevauchent pas quand les decimales augmentent. A appliquer aussi aux
// axes masques: meme espacement -> memes graduations -> grilles alignees entre panneaux.
export function timeAxisSpace(u, axisIdx, scaleMin, scaleMax, plotDim) {
    const span = scaleMax - scaleMin;
    if (!(span > 0) || !(plotDim > 0)) return DEFAULT_SPACE;
    const layout = timeAxisLayout(scaleMin, scaleMax, niceStep(span * DEFAULT_SPACE / plotDim));
    const chars = Math.max(...formatTimeTicks([scaleMin, scaleMax], layout).map(label => label.length));
    return Math.max(DEFAULT_SPACE, chars * LABEL_CHAR_PX + LABEL_GAP_PX);
}

// Affiche ou masque l'ancre absolue dans la zone de trace du chart.
function syncOffsetLabel(u, text) {
    if (!u.over) return;
    let label = u.over.querySelector(`:scope > .${OFFSET_LABEL_CLASS}`);
    if (text === null) {
        if (label) label.style.display = 'none';
        return;
    }
    if (!label) {
        label = document.createElement('div');
        label.className = OFFSET_LABEL_CLASS;
        u.over.appendChild(label);
    }
    if (label.textContent !== text) label.textContent = text;
    label.style.display = 'block';
}

// Option axis.values d'uPlot pour l'axe temporel visible. Met aussi a jour l'ancre: c'est
// le seul point ou le pas retenu (incr) est connu, et l'appel est idempotent.
export function timeAxisValues(u, splits, axisIdx, space, incr) {
    const { min, max } = u.scales.x;
    const layout = timeAxisLayout(min, max, incr);
    syncOffsetLabel(u, layout.offset === null ? null : formatTimeOffset(layout));
    return formatTimeTicks(splits, layout);
}
