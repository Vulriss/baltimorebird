// Baltimore Bird - metrique d'erreur de rasterisation (R1, papier §3.1/§6.3).
//
// Rasterisation par remplissage de colonnes: pour chaque colonne de pixels, on allume tous
// les pixels du min au max des y qui la traversent (points et segments reliant deux points
// consecutifs). Erreur: E = |R(S) xor R(Q)| / |R(S) union R(Q)| (Jaccard), avec une variante
// a tolerance verticale. Module pur, sans DOM. Pixel encode: col * height + row.

/**
 * Rasterise une polyligne {t, y} sur une grille width x height couvrant [tMin,tMax]x[yMin,yMax].
 * Les valeurs non finies sont ignorees; les y hors plage sont ramenes sur les lignes extremes.
 * @returns {Set<number>}
 */
export function rasterizeColumns(points, { width, height, tMin, tMax, yMin, yMax }) {
    const { t, y } = points;
    const n = Math.min(t.length, y.length);
    const colLo = new Int32Array(width).fill(height);
    const colHi = new Int32Array(width).fill(-1);
    const xScale = tMax > tMin ? width / (tMax - tMin) : 0;
    const yScale = yMax > yMin ? height / (yMax - yMin) : 0;

    const rowOf = (v) => Math.min(height - 1, Math.max(0, Math.floor((v - yMin) * yScale)));
    const colOf = (x) => Math.min(width - 1, Math.max(0, Math.floor(x)));
    const touch = (c, v) => {
        const r = rowOf(v);
        if (r < colLo[c]) colLo[c] = r;
        if (r > colHi[c]) colHi[c] = r;
    };

    // Segment en coordonnees pixel, x0 <= x1.
    const segment = (x0, y0, x1, y1) => {
        if (x1 < 0 || x0 > width) return;
        if (x0 < 0) { y0 += (y1 - y0) * (0 - x0) / (x1 - x0); x0 = 0; }
        if (x1 > width) { y1 = y0 + (y1 - y0) * (width - x0) / (x1 - x0); x1 = width; }
        if (x1 === x0) {
            touch(colOf(x0), y0);
            touch(colOf(x0), y1);
            return;
        }
        const last = colOf(x1);
        for (let c = colOf(x0); c <= last; c++) {
            const xa = Math.max(x0, c), xb = Math.min(x1, c + 1);
            touch(c, y0 + (y1 - y0) * (xa - x0) / (x1 - x0));
            touch(c, y0 + (y1 - y0) * (xb - x0) / (x1 - x0));
        }
    };

    for (let i = 0; i < n; i++) {
        const xi = (t[i] - tMin) * xScale, yi = y[i];
        if (!Number.isFinite(xi) || !Number.isFinite(yi)) continue;
        segment(xi, yi, xi, yi);  // le point seul
        if (i + 1 < n) {
            const xj = (t[i + 1] - tMin) * xScale, yj = y[i + 1];
            if (!Number.isFinite(xj) || !Number.isFinite(yj)) continue;
            if (xi <= xj) segment(xi, yi, xj, yj);
            else segment(xj, yj, xi, yi);
        }
    }

    const out = new Set();
    for (let c = 0; c < width; c++) {
        for (let r = colLo[c]; r <= colHi[c]; r++) out.add(c * height + r);
    }
    return out;
}

// p est-il a moins de `tolerance` lignes d'un pixel de `set`, dans la meme colonne?
// Sans `height`, la colonne n'est pas connue: le voisinage est pris en indice brut.
function hasNear(set, p, tolerance, height) {
    for (let d = -tolerance; d <= tolerance; d++) {
        const q = p + d;
        if (q < 0) continue;
        if (height && Math.floor(q / height) !== Math.floor(p / height)) continue;
        if (set.has(q)) return true;
    }
    return false;
}

/**
 * Erreur de rasterisation dans [0,1] entre pixels de reference et pixels approches.
 * tolerance (px verticaux, defaut 0): un pixel est apparie s'il a un voisin de l'autre
 * ensemble a +-tolerance lignes. `height` (optionnel) empeche d'apparier a travers deux colonnes.
 */
export function rasterError(fullPixels, subPixels, { tolerance = 0, height } = {}) {
    let inter;
    if (tolerance <= 0) {
        inter = 0;
        const [small, big] = fullPixels.size <= subPixels.size ? [fullPixels, subPixels] : [subPixels, fullPixels];
        for (const p of small) if (big.has(p)) inter++;
    } else {
        let a = 0, b = 0;
        for (const p of fullPixels) if (hasNear(subPixels, p, tolerance, height)) a++;
        for (const p of subPixels) if (hasNear(fullPixels, p, tolerance, height)) b++;
        inter = (a + b) / 2;
    }
    const union = fullPixels.size + subPixels.size - inter;
    return union === 0 ? 0 : 1 - inter / union;
}

/**
 * Erreurs d'une scene. panels = [{ full: Set, sub: Set, tolerance?, height? }].
 * @returns {{perPanel:number[], mean:number, worst:number}}
 */
export function sceneErrors(panels) {
    const perPanel = panels.map(({ full, sub, tolerance = 0, height }) =>
        rasterError(full, sub, { tolerance, height }));
    if (perPanel.length === 0) return { perPanel, mean: 0, worst: 0 };
    const mean = perPanel.reduce((s, e) => s + e, 0) / perPanel.length;
    return { perPanel, mean, worst: Math.max(...perPanel) };
}
