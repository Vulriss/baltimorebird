// Baltimore Bird - Graphes X/Y: appariement des echantillons, decimation ecran, cadrage
// Fonctions pures (aucun DOM): voir xy-plots.js pour les panneaux.

// Premier indice i tel que ts[i] >= t.
function lowerBound(ts, t) {
    let lo = 0;
    let hi = ts.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (ts[mid] < t) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

// Premier indice i tel que ts[i] > t.
function upperBound(ts, t) {
    let lo = 0;
    let hi = ts.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (ts[mid] <= t) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

// Indices [i0, i1] des echantillons strictement dans la fenetre temporelle. Contrairement a
// windowBounds (data-views.js), aucun echantillon voisin n'est ajoute: en X/Y un point hors
// fenetre n'est pas clippe par un axe du temps, il se verrait.
export function windowIndexRange(ts, tMin, tMax) {
    return { i0: lowerBound(ts, tMin), i1: upperBound(ts, tMax) - 1 };
}

// Indice de l'echantillon le plus proche de l'instant t, -1 si la serie est vide.
export function indexAtTime(ts, t) {
    const n = ts.length;
    if (n === 0) return -1;
    const i = lowerBound(ts, t);
    if (i <= 0) return 0;
    if (i >= n) return n - 1;
    return (t - ts[i - 1]) <= (ts[i] - t) ? i - 1 : i;
}

// Meme grille de temps: longueur et trois echantillons temoins (meme heuristique que
// sameRaster dans transforms.js, fiable sur des grilles d'acquisition completes).
export function sameRaster(a, b) {
    const n = a.length;
    if (b.length !== n || n === 0) return false;
    const mid = n >> 1;
    return a[0] === b[0] && a[n - 1] === b[n - 1] && a[mid] === b[mid];
}

// Valeurs de la serie (tsY, valsY) aux instants tsX. Interpolation lineaire, ou maintien
// de la derniere valeur pour un signal d'etat (held). NaN hors de la plage de tsY: un
// point X/Y n'existe que la ou les deux signaux sont mesures. Meme grille: aucune copie.
export function resampleOnto(tsX, tsY, valsY, held = false) {
    if (sameRaster(tsX, tsY)) return valsY;
    const n = tsX.length;
    const m = tsY.length;
    const out = new Float32Array(n);
    if (m === 0) return out.fill(NaN);
    let j = 0;
    for (let i = 0; i < n; i++) {
        const t = tsX[i];
        if (t < tsY[0] || t > tsY[m - 1]) {
            out[i] = NaN;
            continue;
        }
        while (j < m - 2 && tsY[j + 1] <= t) j++;
        const next = j + 1 < m ? tsY[j + 1] : Infinity;
        if (next <= t) {
            out[i] = valsY[j + 1];
        } else if (held || m === 1) {
            out[i] = valsY[j];
        } else {
            const span = tsY[j + 1] - tsY[j];
            out[i] = span > 0 ? valsY[j] + (valsY[j + 1] - valsY[j]) * (t - tsY[j]) / span : valsY[j];
        }
    }
    return out;
}

// Etendue des points (xs[i], ys[i]) de [i0, i1], pas `stride`. null si aucun point fini.
export function xyBounds(xs, ys, i0, i1, stride = 1) {
    let xMin = Infinity;
    let xMax = -Infinity;
    let yMin = Infinity;
    let yMax = -Infinity;
    for (let i = i0; i <= i1; i += stride) {
        const x = xs[i];
        const y = ys[i];
        if (x !== x || y !== y) continue;
        if (x < xMin) xMin = x;
        if (x > xMax) xMax = x;
        if (y < yMin) yMin = y;
        if (y > yMax) yMax = y;
    }
    return xMin <= xMax ? { xMin, xMax, yMin, yMax } : null;
}

// Reunit des etendues (une par serie Y); null si toutes le sont.
export function mergeBounds(list) {
    let out = null;
    for (const b of list) {
        if (!b) continue;
        if (!out) {
            out = { ...b };
            continue;
        }
        out.xMin = Math.min(out.xMin, b.xMin);
        out.xMax = Math.max(out.xMax, b.xMax);
        out.yMin = Math.min(out.yMin, b.yMin);
        out.yMax = Math.max(out.yMax, b.yMax);
    }
    return out;
}

function paddedSpan(min, max, pad) {
    if (min === max) {
        const p = Math.abs(min) * pad || 1;
        return [min - p, max + p];
    }
    const p = (max - min) * pad;
    return [min - p, max + p];
}

// Fenetre d'affichage qui cadre une etendue, avec marge. equal: meme echelle sur les deux
// axes (une unite X occupe autant de pixels qu'une unite Y), l'axe le moins contraint est
// elargi autour de son centre. width/height: dimensions de la zone de trace.
export function fitView(bounds, { pad = 0.06, equal = false, width = 1, height = 1 } = {}) {
    if (!bounds) return { x: { min: 0, max: 1 }, y: { min: 0, max: 1 } };
    let [x0, x1] = paddedSpan(bounds.xMin, bounds.xMax, pad);
    let [y0, y1] = paddedSpan(bounds.yMin, bounds.yMax, pad);
    if (equal && width > 0 && height > 0) {
        const perPx = Math.max((x1 - x0) / width, (y1 - y0) / height);
        const cx = (x0 + x1) / 2;
        const cy = (y0 + y1) / 2;
        x0 = cx - perPx * width / 2;
        x1 = cx + perPx * width / 2;
        y0 = cy - perPx * height / 2;
        y1 = cy + perPx * height / 2;
    }
    return { x: { min: x0, max: x1 }, y: { min: y0, max: y1 } };
}

// Decimation ecran d'une trajectoire: indices des points a tracer parmi [i0, i1].
// Un point est garde quand il change de cellule (cols x rows cellules sur la vue), avec le
// dernier point de la cellule quittee: le trait qui franchit une frontiere part du bon
// endroit, et l'erreur reste sous une cellule. Les points hors vue sont rabattus sur une
// couronne d'une cellule autour d'elle, ou ils se confondent. -1 marque une rupture (NaN).
// La pyramide min-max des graphes temporels ne convient pas ici: elle preserve l'enveloppe
// d'un signal contre le temps, pas la forme d'une courbe dans le plan.
// Au-dela de maxPoints, le pas d'echantillonnage double jusqu'a tenir le budget: `stride`
// retourne > 1 signale un trace approche.
export function decimateXY(xs, ys, i0, i1, view, cols, rows, { maxPoints = 120000, stride = 1 } = {}) {
    const out = new Int32Array(maxPoints + 4);
    if (i1 < i0) return { indices: out.subarray(0, 0), stride };
    const sx = cols / (view.x.max - view.x.min);
    const sy = rows / (view.y.max - view.y.min);
    const x0 = view.x.min;
    const y0 = view.y.min;
    const wide = rows + 2;

    for (let step = Math.max(1, stride); ; step *= 2) {
        let count = 0;
        let lastCell = -1;
        let lastIdx = -1;
        let lastOut = -1;
        let overflow = false;
        for (let i = i0; i <= i1; i += step) {
            const x = xs[i];
            const y = ys[i];
            if (x !== x || y !== y) {
                if (lastIdx !== lastOut && lastIdx >= 0) out[count++] = lastIdx;
                if (count > 0 && out[count - 1] !== -1) out[count++] = -1;
                lastCell = -1;
                lastIdx = -1;
                lastOut = -1;
            } else {
                let cx = Math.floor((x - x0) * sx);
                let cy = Math.floor((y - y0) * sy);
                cx = cx < 0 ? 0 : (cx >= cols ? cols + 1 : cx + 1);
                cy = cy < 0 ? 0 : (cy >= rows ? rows + 1 : cy + 1);
                const cell = cx * wide + cy;
                if (cell !== lastCell) {
                    if (lastIdx !== lastOut && lastIdx >= 0) out[count++] = lastIdx;
                    out[count++] = i;
                    lastOut = i;
                    lastCell = cell;
                }
                lastIdx = i;
            }
            if (count > maxPoints) {
                overflow = true;
                break;
            }
        }
        if (overflow) continue;
        if (lastIdx !== lastOut && lastIdx >= 0) out[count++] = lastIdx;
        return { indices: out.subarray(0, count), stride: step };
    }
}

// Carte de densite des points de [i0, i1]: nombre d'echantillons par cellule de la vue
// (cols x rows, ligne 0 en haut). Les echantillons etant regulierement espaces dans le
// temps, la densite se lit comme le temps passe dans chaque cellule. Une grille passee
// dans counts est completee sans etre remise a zero: plusieurs series s'y additionnent.
// Retourne { counts, max }, max etant le plus grand compte des cellules touchees.
export function densityGrid(xs, ys, i0, i1, view, cols, rows, { stride = 1, counts = null } = {}) {
    const size = cols * rows;
    const grid = counts && counts.length === size ? counts : new Uint32Array(size);
    const sx = cols / (view.x.max - view.x.min);
    const sy = rows / (view.y.max - view.y.min);
    const x0 = view.x.min;
    const y1 = view.y.max;
    let max = 0;
    for (let i = i0; i <= i1; i += stride) {
        const cx = Math.floor((xs[i] - x0) * sx);
        const cy = Math.floor((y1 - ys[i]) * sy);
        // NaN echoue aux deux comparaisons: un point sans valeur n'est pas compte.
        if (!(cx >= 0 && cx < cols && cy >= 0 && cy < rows)) continue;
        const count = ++grid[cy * cols + cx];
        if (count > max) max = count;
    }
    return { counts: grid, max };
}

// Point trace le plus proche de (px, py), en pixels, parmi les indices decimes. toPx/toPy
// convertissent une valeur en pixel. Retourne { index, dist } ou null au-dela de maxDist.
export function nearestPoint(xs, ys, indices, toPx, toPy, px, py, maxDist = 24) {
    let best = -1;
    let bestD2 = maxDist * maxDist;
    for (let k = 0; k < indices.length; k++) {
        const i = indices[k];
        if (i < 0) continue;
        const dx = toPx(xs[i]) - px;
        const dy = toPy(ys[i]) - py;
        const d2 = dx * dx + dy * dy;
        if (d2 <= bestD2) {
            bestD2 = d2;
            best = i;
        }
    }
    return best < 0 ? null : { index: best, dist: Math.sqrt(bestD2) };
}

// Sous-plage [k0, k1) des indices decimes (croissants, -1 mis a part) couvrant [a, b].
export function indexSpan(indices, a, b) {
    const n = indices.length;
    const firstAtLeast = target => {
        let lo = 0;
        let hi = n;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            // Une rupture (-1) se compare par son voisin de droite.
            let m = mid;
            while (m < hi && indices[m] < 0) m++;
            if (m === hi) hi = mid;
            else if (indices[m] < target) lo = m + 1;
            else hi = mid;
        }
        return lo;
    };
    return { k0: firstAtLeast(a), k1: firstAtLeast(b + 1) };
}

// Nombre compact pour une mesure (curseurs, infobulle): 4 chiffres utiles environ.
export function formatValue(v) {
    if (!Number.isFinite(v)) return '-';
    const abs = Math.abs(v);
    if (abs !== 0 && (abs >= 1e6 || abs < 1e-3)) return v.toExponential(2);
    if (abs >= 1000) return v.toFixed(1);
    if (abs >= 1) return v.toFixed(3);
    return v.toFixed(4);
}
