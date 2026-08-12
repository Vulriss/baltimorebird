// Baltimore Bird - transformations mathematiques de signaux pour les mutateurs rapides.
//
// Module pur et testable: lissage Savitzky-Golay (convolution par coefficients de
// moindres carres, propriete definissante: preserve exactement les polynomes de degre
// <= ordre), derivee par differences centrees sur grille non uniforme, estimation de
// densite par noyau gaussien (bande passante de Silverman), et spectre d'amplitude par
// FFT radix-2 avec fenetre de Hann sur un reechantillonnage uniforme.

const KDE_GRID_SIZE = 256;
const KDE_MAX_SAMPLES = 40000;
const FFT_SIZE = 4096;

// Resout A x = b par elimination de Gauss avec pivot partiel (petits systemes:
// les equations normales du Savitzky-Golay, taille ordre+1).
function solveLinearSystem(matrix, rhs) {
    const n = rhs.length;
    const a = matrix.map((row, i) => [...row, rhs[i]]);

    for (let col = 0; col < n; col++) {
        let pivot = col;
        for (let r = col + 1; r < n; r++) {
            if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
        }
        [a[col], a[pivot]] = [a[pivot], a[col]];
        for (let r = col + 1; r < n; r++) {
            const factor = a[r][col] / a[col][col];
            for (let c = col; c <= n; c++) a[r][c] -= factor * a[col][c];
        }
    }
    const x = new Float64Array(n);
    for (let r = n - 1; r >= 0; r--) {
        let sum = a[r][n];
        for (let c = r + 1; c < n; c++) sum -= a[r][c] * x[c];
        x[r] = sum / a[r][r];
    }
    return x;
}

// Coefficients de convolution Savitzky-Golay: h tel que lisse[i] = somme h[j] y[i+j-demi].
// Premiere ligne de (At A)^-1 At pour la base polynomiale centree.
function savgolCoefficients(window, order) {
    const half = window >> 1;
    const normal = Array.from({ length: order + 1 }, () => new Float64Array(order + 1));
    for (let j = -half; j <= half; j++) {
        for (let r = 0; r <= order; r++) {
            for (let c = 0; c <= order; c++) normal[r][c] += Math.pow(j, r + c);
        }
    }
    const coeffs = new Float64Array(window);
    for (let j = -half; j <= half; j++) {
        const rhs = new Float64Array(order + 1);
        for (let r = 0; r <= order; r++) rhs[r] = Math.pow(j, r);
        coeffs[j + half] = solveLinearSystem(normal.map(row => Array.from(row)), rhs)[0];
    }
    return coeffs;
}

/**
 * Lissage Savitzky-Golay. Fenetre impaire, ordre < fenetre. Bords en reflexion.
 */
export function savitzkyGolay(values, window = 25, order = 3) {
    const n = values.length;
    if (window % 2 === 0) window += 1;
    if (n < window) return Float64Array.from(values);

    const half = window >> 1;
    const h = savgolCoefficients(window, order);
    const out = new Float64Array(n);

    // Les coefficients de lissage sont symetriques (h[j] == h[-j]): la convolution se
    // fait en half multiplications par point au lieu de window - le cout du mode fort
    // (fenetre 151) reste sous la seconde sur 5M de points.
    const interiorStart = half;
    const interiorEnd = n - half;
    for (let i = interiorStart; i < interiorEnd; i++) {
        let acc = h[half] * values[i];
        for (let j = 1; j <= half; j++) {
            acc += h[half + j] * (values[i - j] + values[i + j]);
        }
        out[i] = acc;
    }
    for (const i of [...Array(Math.min(half, n)).keys(),
                     ...Array.from({ length: Math.min(half, n) }, (_, k) => n - 1 - k)]) {
        let acc = 0;
        for (let j = -half; j <= half; j++) {
            let k = i + j;
            if (k < 0) k = -k;                       // reflexion au bord gauche
            else if (k >= n) k = 2 * n - 2 - k;      // reflexion au bord droit
            acc += h[j + half] * values[k];
        }
        out[i] = acc;
    }
    return out;
}

/**
 * Derivee temporelle sur grille non uniforme: differences centrees ponderees du second
 * ordre a l'interieur (la formule symetrique simple n'est que du premier ordre des que
 * les pas different), differences avant/arriere aux bords.
 */
export function derivative(timestamps, values) {
    const n = values.length;
    const out = new Float64Array(n);
    if (n < 2) return out;

    out[0] = (values[1] - values[0]) / (timestamps[1] - timestamps[0] || 1);
    out[n - 1] = (values[n - 1] - values[n - 2]) / (timestamps[n - 1] - timestamps[n - 2] || 1);
    for (let i = 1; i < n - 1; i++) {
        const hm = timestamps[i] - timestamps[i - 1];
        const hp = timestamps[i + 1] - timestamps[i];
        const denom = hp * hm * (hp + hm);
        out[i] = denom !== 0
            ? (hm * hm * values[i + 1] + (hp * hp - hm * hm) * values[i] - hp * hp * values[i - 1]) / denom
            : 0;
    }
    return out;
}

// Quantile exact par interpolation lineaire sur un tableau trie.
function sortedQuantile(sorted, q) {
    const pos = q * (sorted.length - 1);
    const lo = Math.floor(pos);
    const hi = Math.min(sorted.length - 1, lo + 1);
    return sorted[lo] + (pos - lo) * (sorted[hi] - sorted[lo]);
}

/**
 * Estimation de densite par noyau gaussien (bande passante de Silverman), avec
 * sous-echantillonnage borne. Retourne { x, density, cdf, stats } sur une grille
 * reguliere: cdf est l'integrale trapezoidale de la densite renormalisee a 1, et
 * stats (moyenne, mediane, p5, p95) est calcule exactement sur les echantillons,
 * pas sur la grille lissee.
 */
export function gaussianKde(values, gridSize = KDE_GRID_SIZE) {
    const n = values.length;
    if (n === 0) return null;

    const stride = Math.max(1, Math.ceil(n / KDE_MAX_SAMPLES));
    const samples = [];
    for (let i = 0; i < n; i += stride) samples.push(values[i]);
    const m = samples.length;

    let mean = 0;
    for (const v of samples) mean += v;
    mean /= m;
    let variance = 0;
    for (const v of samples) variance += (v - mean) * (v - mean);
    const sigma = Math.sqrt(variance / Math.max(1, m - 1));
    if (sigma === 0) return null;

    const bandwidth = 1.06 * sigma * Math.pow(m, -0.2);
    let lo = Infinity, hi = -Infinity;
    for (const v of samples) {
        if (v < lo) lo = v;
        if (v > hi) hi = v;
    }
    lo -= 3 * bandwidth;
    hi += 3 * bandwidth;

    const x = new Float64Array(gridSize);
    const density = new Float64Array(gridSize);
    const step = (hi - lo) / (gridSize - 1);
    const norm = 1 / (m * bandwidth * Math.sqrt(2 * Math.PI));

    for (let g = 0; g < gridSize; g++) {
        const xg = lo + g * step;
        let acc = 0;
        for (let i = 0; i < m; i++) {
            const u = (xg - samples[i]) / bandwidth;
            acc += Math.exp(-0.5 * u * u);
        }
        x[g] = xg;
        density[g] = acc * norm;
    }

    // Cumul par trapezes, renormalise pour absorber la troncature de la grille a ±3h.
    const cdf = new Float64Array(gridSize);
    for (let g = 1; g < gridSize; g++) {
        cdf[g] = cdf[g - 1] + ((density[g - 1] + density[g]) * step) / 2;
    }
    const total = cdf[gridSize - 1];
    if (total > 0) {
        for (let g = 0; g < gridSize; g++) cdf[g] /= total;
    }

    const sorted = Float64Array.from(samples).sort();
    const stats = {
        mean,
        median: sortedQuantile(sorted, 0.5),
        p5: sortedQuantile(sorted, 0.05),
        p95: sortedQuantile(sorted, 0.95),
    };
    return { x, density, cdf, stats, bandwidth };
}

// FFT radix-2 iterative en place (re/im).
function fftInPlace(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            [re[i], re[j]] = [re[j], re[i]];
            [im[i], im[j]] = [im[j], im[i]];
        }
    }
    for (let len = 2; len <= n; len <<= 1) {
        const angle = (-2 * Math.PI) / len;
        const wRe = Math.cos(angle), wIm = Math.sin(angle);
        for (let i = 0; i < n; i += len) {
            let curRe = 1, curIm = 0;
            for (let k = 0; k < len / 2; k++) {
                const uRe = re[i + k], uIm = im[i + k];
                const vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
                const vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
                re[i + k] = uRe + vRe;
                im[i + k] = uIm + vIm;
                re[i + k + len / 2] = uRe - vRe;
                im[i + k + len / 2] = uIm - vIm;
                const nextRe = curRe * wRe - curIm * wIm;
                curIm = curRe * wIm + curIm * wRe;
                curRe = nextRe;
            }
        }
    }
}

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
    return span === 0 ? vs[lo] : vs[lo] + ((t - ts[lo]) / span) * (vs[hi] - vs[lo]);
}

/**
 * Spectre d'amplitude: reechantillonnage uniforme de la plage, retrait de la moyenne,
 * fenetre de Hann, FFT, amplitudes normalisees (compensation du gain de fenetre).
 * Retourne { freq, magnitude } jusqu'a Nyquist (DC exclu) et la resolution df.
 */
export function fftMagnitude(timestamps, values, size = FFT_SIZE) {
    const n = values.length;
    if (n < 16) return null;
    const t0 = timestamps[0];
    const t1 = timestamps[n - 1];
    const span = t1 - t0;
    if (span <= 0) return null;

    const re = new Float64Array(size);
    const im = new Float64Array(size);
    let mean = 0;
    for (let i = 0; i < size; i++) {
        re[i] = interpolateAt(timestamps, values, t0 + (span * i) / (size - 1));
        mean += re[i];
    }
    mean /= size;

    let windowGain = 0;
    for (let i = 0; i < size; i++) {
        const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
        re[i] = (re[i] - mean) * w;
        windowGain += w;
    }

    fftInPlace(re, im);

    const dt = span / (size - 1);
    const df = 1 / (size * dt);
    const bins = size >> 1;
    const freq = new Float64Array(bins - 1);
    const magnitude = new Float64Array(bins - 1);
    for (let k = 1; k < bins; k++) {
        freq[k - 1] = k * df;
        magnitude[k - 1] = (2 / windowGain) * Math.hypot(re[k], im[k]);
    }
    return { freq, magnitude, df };
}
