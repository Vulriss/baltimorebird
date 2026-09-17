// Baltimore Bird - Enveloppe Y de la trace reellement dessinee dans la fenetre X
//
// uPlot calcule dataMin/dataMax sur les seuls echantillons visibles, mais trace le chemin
// jusqu'aux voisins hors vue (getOuterIdxs). Cadrer Y sur dataMin/dataMax laisse donc sortir
// du cadre la portion de trace comprise entre un bord et le premier echantillon visible:
// en escalier la valeur tenue au bord gauche, en lineaire les valeurs aux deux bords. A fort
// zoom, avec quelques echantillons visibles, la trace parait coupee aux extremites.

// Premier indice i tel que xs[i] >= t.
function lowerBound(xs, t) {
    let lo = 0;
    let hi = xs.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (xs[mid] < t) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

// Premier indice i tel que xs[i] > t.
function upperBound(xs, t) {
    let lo = 0;
    let hi = xs.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (xs[mid] <= t) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

function isValue(v) {
    return v != null && Number.isFinite(v);
}

// Dernier indice <= from portant une valeur (trous null de l'union X), -1 sinon.
function lastValueAt(ys, from) {
    for (let i = Math.min(from, ys.length - 1); i >= 0; i--) if (isValue(ys[i])) return i;
    return -1;
}

// Premier indice >= from portant une valeur, -1 sinon.
function firstValueAt(ys, from) {
    for (let i = Math.max(from, 0); i < ys.length; i++) if (isValue(ys[i])) return i;
    return -1;
}

function interpolateAt(xs, ys, i, j, t) {
    const span = xs[j] - xs[i];
    return span > 0 ? ys[i] + (ys[j] - ys[i]) * (t - xs[i]) / span : ys[i];
}

function include(acc, v) {
    if (v < acc.min) acc.min = v;
    if (v > acc.max) acc.max = v;
}

// Contribution d'une serie: echantillons visibles, puis les bords selon le mode de trace.
// Escalier (align 1): la valeur du voisin gauche est tenue jusqu'au premier echantillon
// suivant; a droite, la valeur tenue est celle du dernier echantillon <= viewMax, deja
// comptee. Lineaire et spline: valeur interpolee a chaque bord (approximation lineaire pour
// la spline). Points seuls: rien n'est trace hors des echantillons.
function accumulateSeries(acc, xs, ys, mode, viewMin, viewMax) {
    const lo = lowerBound(xs, viewMin);
    const hi = upperBound(xs, viewMax) - 1;
    for (let i = lo; i <= hi; i++) if (isValue(ys[i])) include(acc, ys[i]);
    if (mode === 'none') return;

    const left = lastValueAt(ys, lo - 1);
    const afterLeft = firstValueAt(ys, lo);
    if (left >= 0 && afterLeft >= 0) {
        include(acc, mode === 'stepped' ? ys[left] : interpolateAt(xs, ys, left, afterLeft, viewMin));
    }
    if (mode === 'stepped') return;

    const right = firstValueAt(ys, hi + 1);
    const beforeRight = lastValueAt(ys, hi);
    if (right >= 0 && beforeRight >= 0) {
        include(acc, interpolateAt(xs, ys, beforeRight, right, viewMax));
    }
}

// Enveloppe {min, max} des series affichees sur [viewMin, viewMax], ou null si rien n'est
// trace dans la fenetre. traces: [{ ys, mode, show }], xs trie croissant.
export function traceEnvelope(xs, traces, viewMin, viewMax) {
    if (!xs || xs.length === 0 || !(viewMax >= viewMin)) return null;
    const acc = { min: Infinity, max: -Infinity };
    for (const trace of traces) {
        if (trace.show === false || !trace.ys) continue;
        accumulateSeries(acc, xs, trace.ys, trace.mode, viewMin, viewMax);
    }
    return acc.min <= acc.max ? acc : null;
}
