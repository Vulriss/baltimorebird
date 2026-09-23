// Baltimore Bird - Palette d'acces rapide (popovers de couleur) et couleur par defaut au depot
//
// Sequence Petroff 8 (M. A. Petroff, "Accessible Color Sequences for Data Visualization",
// arXiv:2107.02270, 2021; reprise par matplotlib), distincte deux a deux y compris sous
// protanopie, deuteranopie et tritanopie simulees.
//
// Theme clair: Petroff 8 tel que publie (concu pour fond blanc). Theme sombre: bleu,
// rouge et gris eclaircis a teinte constante jusqu'a un contraste >= 3.1 sur ctp-base.
// Seuils verifies par test/color-presets.test.js.
//
// Valeurs concretes (pas des var(--ctp-*)): la couleur est stockee en hex dans le layout.
// Une couleur egale a une case de la palette garde sa case au changement de theme
// (themedPresetColor); toute autre couleur n'est jamais modifiee.

export const PRESET_COLORS_DARK = [
    '#275aff', '#ff5e02', '#d0291e', '#c849a9', '#adad7d', '#86c8dd', '#578dff', '#6e6c6d',
];

export const PRESET_COLORS_LIGHT = [
    '#1845fb', '#ff5e02', '#c91f16', '#c849a9', '#adad7d', '#86c8dd', '#578dff', '#656364',
];

function isLightTheme() {
    return document.documentElement.getAttribute('data-theme') === 'light';
}

/**
 * Couleurs d'acces rapide du theme courant.
 *
 * @returns {string[]} 8 couleurs hex minuscules, dans l'ordre de la sequence.
 */
export function presetColors() {
    return isLightTheme() ? PRESET_COLORS_LIGHT : PRESET_COLORS_DARK;
}

/**
 * Case de la palette occupee par une couleur, quel que soit le theme.
 *
 * @param {string} color Couleur hex.
 * @returns {number} Index 0-7, ou -1 hors palette.
 */
export function presetSlot(color) {
    if (typeof color !== 'string') return -1;
    const c = color.toLowerCase();
    const i = PRESET_COLORS_DARK.indexOf(c);
    return i !== -1 ? i : PRESET_COLORS_LIGHT.indexOf(c);
}

/**
 * Transpose une couleur de palette vers la meme case du theme demande.
 *
 * @param {string} color Couleur hex.
 * @param {boolean} light Theme cible clair.
 * @returns {string} Couleur de la case dans le theme cible, ou `color` inchangee hors palette.
 */
export function themedPresetColor(color, light) {
    const slot = presetSlot(color);
    if (slot === -1) return color;
    return (light ? PRESET_COLORS_LIGHT : PRESET_COLORS_DARK)[slot];
}

/**
 * Couleur par defaut d'un signal depose: premiere case de la palette absente des
 * couleurs deja utilisees, sinon la case la moins utilisee (la premiere a egalite).
 *
 * @param {Iterable<string>} usedColors Couleurs des autres signaux de l'onglet.
 * @param {boolean} [light] Theme clair; par defaut le theme courant.
 * @returns {string} Couleur hex de la palette du theme.
 */
export function nextPresetColor(usedColors, light = isLightTheme()) {
    const palette = light ? PRESET_COLORS_LIGHT : PRESET_COLORS_DARK;
    const counts = new Array(palette.length).fill(0);
    for (const c of usedColors) {
        const slot = presetSlot(c);
        if (slot !== -1) counts[slot]++;
    }
    let best = 0;
    for (let i = 1; i < counts.length; i++) {
        if (counts[i] < counts[best]) best = i;
    }
    return palette[best];
}

// Couleurs portees par les signaux de l'onglet (tous graphes), hors le signal `idx`
// lui-meme ou qu'il soit trace.
function tabColorsExcept(plots, idx) {
    const colors = [];
    for (const p of plots) {
        for (const i of p.signals || []) {
            const color = i !== idx ? p.signalStyles?.[i]?.color : null;
            if (color) colors.push(color);
        }
    }
    return colors;
}

/**
 * Couleur a attribuer a un signal depose sur un graphe de l'onglet. Un signal deja trace
 * dans un autre graphe de l'onglet garde sa couleur; sinon, case de palette libre sur
 * l'ensemble de l'onglet, pour que des signaux repartis sur plusieurs graphes restent
 * distincts.
 *
 * @param {Array<Object>} plots Graphes de l'onglet ({signals, signalStyles}).
 * @param {Object} plot Graphe destinataire.
 * @param {number} idx Index du signal.
 * @param {boolean} [light] Theme clair; par defaut le theme courant.
 * @returns {string} Couleur hex.
 */
export function presetColorForSignal(plots, plot, idx, light = isLightTheme()) {
    for (const p of plots) {
        const color = p !== plot && (p.signals || []).includes(idx) ? p.signalStyles?.[idx]?.color : null;
        if (color) return color;
    }
    return nextPresetColor(tabColorsExcept(plots, idx), light);
}

/**
 * Vrai si `color` est une case de palette deja portee par un autre signal de l'onglet.
 *
 * @param {Array<Object>} plots Graphes de l'onglet.
 * @param {number} idx Signal concerne (ses propres occurrences ne comptent pas).
 * @param {string} color Couleur a tester.
 * @returns {boolean} Case deja prise.
 */
export function presetColorTaken(plots, idx, color) {
    const slot = presetSlot(color);
    return slot !== -1 && tabColorsExcept(plots, idx).some(c => presetSlot(c) === slot);
}
