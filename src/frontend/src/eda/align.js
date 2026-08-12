// Baltimore Bird - estimation du decalage temporel entre deux runs par correlation croisee.
//
// Convention de signe, alignee sur setRunOffset/shiftFor: le run cible est affiche a
// t + offset. L'offset retourne est donc celui qui superpose la cible a la reference:
// un evenement a t=100 dans la reference et t=130 dans la cible donne offset = -30.
//
// Methode: les deux series sont reechantillonnees lineairement sur des grilles uniformes,
// centrees-reduites, puis correlees (NCC) en deux passes - balayage grossier sur toute la
// plage de retards admissible, puis raffinement local a pas fin autour du meilleur retard.
// La normalisation rend l'estimation invariante au gain et a l'offset d'amplitude entre
// runs (capteurs recalibres, unites converties).

const COARSE_GRID = 4096;
const COARSE_LAGS = 512;
const FINE_STEPS = 64;
const MIN_OVERLAP_RATIO = 0.25;

function interpolateAt(ts, vs, t) {
    if (t <= ts[0]) return vs[0];
    const n = ts.length;
    if (t >= ts[n - 1]) return vs[n - 1];

    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (ts[mid] <= t) lo = mid;
        else hi = mid;
    }
    const span = ts[hi] - ts[lo];
    if (span === 0) return vs[lo];
    return vs[lo] + ((t - ts[lo]) / span) * (vs[hi] - vs[lo]);
}

function resampleUniform(ts, vs, t0, t1, count) {
    const out = new Float64Array(count);
    const step = (t1 - t0) / (count - 1);
    for (let i = 0; i < count; i++) out[i] = interpolateAt(ts, vs, t0 + i * step);
    return out;
}

function normalizeInPlace(arr) {
    const n = arr.length;
    let mean = 0;
    for (let i = 0; i < n; i++) mean += arr[i];
    mean /= n;
    let norm = 0;
    for (let i = 0; i < n; i++) {
        arr[i] -= mean;
        norm += arr[i] * arr[i];
    }
    norm = Math.sqrt(norm);
    if (norm > 0) {
        for (let i = 0; i < n; i++) arr[i] /= norm;
    }
    return norm > 0;
}

// Correlation normalisee de la reference avec la cible retardee de `lag` secondes:
// ref(t) compare a tgt(t - lag). Les deux signaux sont echantillonnes a la volee sur
// la fenetre de recouvrement effective pour ce retard.
function correlationAtLag(ref, tgt, lag, samples) {
    const lo = Math.max(ref.t0, tgt.t0 + lag);
    const hi = Math.min(ref.t1, tgt.t1 + lag);
    if (hi - lo < (ref.t1 - ref.t0) * MIN_OVERLAP_RATIO) return null;

    const a = resampleUniform(ref.ts, ref.vs, lo, hi, samples);
    const b = new Float64Array(samples);
    const step = (hi - lo) / (samples - 1);
    for (let i = 0; i < samples; i++) {
        b[i] = interpolateAt(tgt.ts, tgt.vs, lo + i * step - lag);
    }

    if (!normalizeInPlace(a) || !normalizeInPlace(b)) return null;
    let score = 0;
    for (let i = 0; i < samples; i++) score += a[i] * b[i];
    return score;
}

// A scores quasi egaux (contenu periodique: pics de correlation aux multiples de la
// periode), prefere le plus petit decalage - les runs d'une meme campagne sont
// grossierement alignes. L'ambiguite residuelle reste visible via le score retourne.
const TIE_EPSILON = 5e-4;

function scanLags(ref, tgt, lags, samples) {
    let bestLag = 0, bestScore = -Infinity;
    for (const lag of lags) {
        const score = correlationAtLag(ref, tgt, lag, samples);
        if (score === null) continue;
        const better = score > bestScore + TIE_EPSILON;
        const tiedButCloser = score > bestScore - TIE_EPSILON && Math.abs(lag) < Math.abs(bestLag);
        if (better || tiedButCloser) {
            bestScore = Math.max(bestScore, score);
            bestLag = lag;
        }
    }
    return { bestLag, bestScore };
}

/**
 * Estime l'offset a passer a setRunOffset pour superposer la cible a la reference.
 * Retourne { offset, score } (score = correlation normalisee dans [-1, 1]) ou null si
 * les series sont inexploitables (constantes, recouvrement insuffisant).
 */
export function estimateOffset(refTs, refVs, tgtTs, tgtVs, options = {}) {
    if (refTs.length < 8 || tgtTs.length < 8) return null;

    const ref = { ts: refTs, vs: refVs, t0: refTs[0], t1: refTs[refTs.length - 1] };
    const tgt = { ts: tgtTs, vs: tgtVs, t0: tgtTs[0], t1: tgtTs[tgtTs.length - 1] };
    const spanRef = ref.t1 - ref.t0;
    const spanTgt = tgt.t1 - tgt.t0;
    if (spanRef <= 0 || spanTgt <= 0) return null;

    // Le lag compare ref(t) a tgt(t - lag): l'egalite est atteinte quand lag vaut
    // exactement l'offset d'affichage recherche (t_ref_evenement - t_cible_evenement).
    // La plage est centree sur le desalignement des origines, plus une derive admissible.
    const baseLag = ref.t0 - tgt.t0;
    const maxDrift = options.maxDrift ?? Math.min(spanRef, spanTgt) * 0.5;

    const coarseLags = [];
    for (let i = 0; i <= COARSE_LAGS; i++) {
        coarseLags.push(baseLag - maxDrift + (2 * maxDrift * i) / COARSE_LAGS);
    }
    const coarse = scanLags(ref, tgt, coarseLags, COARSE_GRID);
    if (coarse.bestScore === -Infinity) return null;

    const coarseStep = (2 * maxDrift) / COARSE_LAGS;
    const fineLags = [];
    for (let i = -FINE_STEPS; i <= FINE_STEPS; i++) {
        fineLags.push(coarse.bestLag + (i * 2 * coarseStep) / FINE_STEPS);
    }
    const fine = scanLags(ref, tgt, fineLags, COARSE_GRID);

    return { offset: fine.bestLag, score: fine.bestScore };
}
