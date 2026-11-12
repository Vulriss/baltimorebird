// Baltimore Bird - Table d'interpolation d'une variable calculee (fonction interp1d)
//
// La table s'ecrit dans la formule meme: interp1d(A, [x0, x1], [y0, y1]). Elle est donc
// enregistree et exportee avec elle (layout, espace de travail, LXF) sans champ a part.
// Module pur: lecture d'un tableau colle, ecriture et relecture de l'appel.

// Meme borne que le serveur (INTERP_MAX_POINTS, api/computed.py).
export const INTERP_MAX_POINTS = 500;

function parseNumber(cell) {
    const text = cell.trim().replace(/\s/g, '').replace(',', '.');
    if (text === '' || !/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) return NaN;
    return Number(text);
}

// Cellules d'une ligne. Tabulation ou point-virgule (tableur, CSV francais): la virgule
// reste un separateur decimal. Sinon des espaces, et a defaut seulement la virgule.
function splitCells(line) {
    if (/[\t;]/.test(line)) return line.split(/[\t;]/);
    const bySpace = line.trim().split(/\s+/);
    if (bySpace.length >= 2) return bySpace;
    return line.split(',');
}

/**
 * Lit une table collee, deux colonnes x et y, une ligne par point.
 * Une premiere ligne d'en-tete est ignoree; les points sont tries par x.
 *
 * @param {string} text Texte colle.
 * @returns {{x: number[], y: number[], error: string|null}} error en francais si invalide.
 */
export function parseInterpTable(text) {
    const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const points = [];
    for (let i = 0; i < lines.length; i++) {
        const cells = splitCells(lines[i]).map(c => c.trim()).filter(c => c !== '');
        const x = cells.length >= 2 ? parseNumber(cells[0]) : NaN;
        const y = cells.length >= 2 ? parseNumber(cells[1]) : NaN;
        if (Number.isNaN(x) || Number.isNaN(y) || cells.length > 2) {
            // En-tete de colonnes en premiere ligne.
            if (i === 0 && cells.length === 2 && Number.isNaN(x) && Number.isNaN(y)) continue;
            return { x: [], y: [], error: `Ligne ${i + 1} : deux nombres attendus (x puis y)` };
        }
        points.push([x, y]);
    }
    if (points.length < 2) return { x: [], y: [], error: 'Au moins 2 points sont nécessaires' };
    if (points.length > INTERP_MAX_POINTS) {
        return { x: [], y: [], error: `Table trop longue (max ${INTERP_MAX_POINTS} points)` };
    }
    points.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < points.length; i++) {
        if (points[i][0] === points[i - 1][0]) {
            return { x: [], y: [], error: `La valeur x = ${points[i][0]} apparaît deux fois` };
        }
    }
    return { x: points.map(p => p[0]), y: points.map(p => p[1]), error: null };
}

// Appel a inserer dans la formule.
export function formatInterpCall(input, x, y) {
    return `interp1d(${String(input).trim()}, [${x.join(', ')}], [${y.join(', ')}])`;
}

/**
 * Premier appel interp1d d'une formule, pour le rouvrir dans l'editeur de table.
 *
 * @param {string} formula Formule.
 * @returns {{text: string, input: string, x: number[], y: number[]}|null} null si absent.
 */
export function findInterpCall(formula) {
    const match = /interp1d\(\s*([^,[\]]+?)\s*,\s*[[(]([^\])]*)[\])]\s*,\s*[[(]([^\])]*)[\])]\s*\)/.exec(String(formula || ''));
    if (!match) return null;
    const numbers = list => list.split(',').map(v => v.trim()).filter(Boolean).map(Number);
    const x = numbers(match[2]);
    const y = numbers(match[3]);
    if (x.some(Number.isNaN) || y.some(Number.isNaN) || x.length !== y.length) return null;
    return { text: match[0], input: match[1], x, y };
}

// Texte de l'editeur pour une table: une ligne "x<TAB>y" par point.
export function tableToText(x, y) {
    return x.map((value, i) => `${value}\t${y[i]}`).join('\n');
}
