// Baltimore Bird - pyramide min/max adaptative pour le rendu multi-resolution cote client.
//
// Structure: apres le full-send, chaque signal complet recoit une pyramide de niveaux de
// buckets en index (taille factor^k echantillons). Chaque bucket memorise les indices bruts
// de son minimum et de son maximum (Uint32Array), plus une erreur structurelle cumulee
// (Float32Array): la somme, sur tout son sous-arbre, des resserrements d'enveloppe des
// enfants par rapport a leur parent. Cette metrique mesure exactement ce que l'emission M4
// perd a une granularite donnee - les extrema secondaires intra-bucket: une zone plate vaut
// 0, une oscillation dense pleine amplitude vaut ~0 (la bande est identique), un pic isole
// dans un coin du bucket vaut fort.
//
// Requete: allocation adaptative d'un budget de points. Un niveau initial couvre la fenetre
// avec une fraction du budget en buckets uniformes, puis un tas max raffine gloutonnement
// les buckets a plus forte erreur cumulee jusqu'a epuisement du budget - une zone plate de
// 200 s reste un seul bucket emis en 2 points, le budget libere va aux zones structurees.
// Le raffinement est borne a la taille d'un slot d'affichage (nVisible/maxPts), proxy du
// screen-space error: maxPts derive deja de la largeur pixel du panneau. Les bords partiels
// sont raffines par descente exacte jusqu'au brut (decomposition type segment-tree).
//
// Garantie inchangee: chaque feuille emise contribue son premier point, son argmin, son
// argmax et son dernier point (schema M4) - l'enveloppe est strictement exacte sur la plage
// demandee quelle que soit l'allocation, et la ligne reste continue.
//
// Hypothese: valeurs finies (le serveur interpole les NaN avant mise en cache). Les buckets
// sont en index et non en temps: pour un raster tres non uniforme, la correspondance
// bucket <-> colonne de pixels n'est pas garantie, mais les extrema restent captures.

const DEFAULT_FACTOR = 4;
const MIN_SAMPLES = 65536;
const TOP_LEVEL_MAX_BUCKETS = 64;
const POINTS_PER_BUCKET = 4;
// Part du budget posee en buckets uniformes au niveau initial; le reste est alloue par
// raffinement adaptatif la ou l'erreur structurelle cumulee est la plus forte.
const INITIAL_BUDGET_SHARE = 4;

/**
 * Construit la pyramide min/max d'un signal, avec l'erreur structurelle cumulee par bucket.
 * Retourne null si le signal est trop court pour en tirer un benefice ou n'est pas un
 * typed array (donnees decimees de /view: le repli subarray suffit).
 */
export function buildMinMaxPyramid(values, factor = DEFAULT_FACTOR, minSamples = MIN_SAMPLES) {
    const n = values.length;
    if (n < minSamples || typeof values.subarray !== 'function') return null;

    const levels = [null];  // niveau 0 = donnees brutes, implicite
    const sizes = [1];

    // Niveau 1: argmin/argmax par bucket de `factor` echantillons bruts. L'erreur cumulee
    // y est nulle: un bucket de `factor` echantillons emis en M4 ne perd rien.
    let count = Math.ceil(n / factor);
    let idxMin = new Uint32Array(count);
    let idxMax = new Uint32Array(count);
    let errSum = new Float32Array(count);
    for (let b = 0; b < count; b++) {
        const s = b * factor;
        const e = Math.min(n, s + factor);
        let im = s, ix = s, vm = values[s], vx = values[s];
        for (let i = s + 1; i < e; i++) {
            const v = values[i];
            if (v < vm) { vm = v; im = i; }
            if (v > vx) { vx = v; ix = i; }
        }
        idxMin[b] = im;
        idxMax[b] = ix;
    }
    levels.push({ idxMin, idxMax, errSum });
    sizes.push(factor);

    // Niveaux superieurs: combinaison des buckets enfants, indices toujours bruts.
    // L'erreur cumulee d'un bucket = resserrement d'enveloppe de ses enfants (ce que M4
    // masque a ce niveau) + erreurs cumulees des enfants (structure plus profonde).
    while (count > TOP_LEVEL_MAX_BUCKETS) {
        const childMin = idxMin, childMax = idxMax, childErr = errSum, childCount = count;
        count = Math.ceil(childCount / factor);
        idxMin = new Uint32Array(count);
        idxMax = new Uint32Array(count);
        errSum = new Float32Array(count);
        for (let b = 0; b < count; b++) {
            const s = b * factor;
            const e = Math.min(childCount, s + factor);
            let im = childMin[s], ix = childMax[s], vm = values[im], vx = values[ix];
            for (let c = s + 1; c < e; c++) {
                const cm = childMin[c], cx = childMax[c];
                if (values[cm] < vm) { vm = values[cm]; im = cm; }
                if (values[cx] > vx) { vx = values[cx]; ix = cx; }
            }
            let acc = 0;
            for (let c = s; c < e; c++) {
                acc += (vx - values[childMax[c]]) + (values[childMin[c]] - vm) + childErr[c];
            }
            idxMin[b] = im;
            idxMax[b] = ix;
            errSum[b] = acc;
        }
        levels.push({ idxMin, idxMax, errSum });
        sizes.push(sizes[sizes.length - 1] * factor);
    }

    return { factor, sizes, levels, n };
}

// Emet dans `out` les indices {first, argmin, argmax, last} d'un bucket, tries et dedupliques.
// Les buckets etant traites de gauche a droite sur des plages disjointes, la sortie globale
// reste strictement croissante. Un bucket plat se deduplique naturellement a 2 points.
function emitBucket(first, last, iMin, iMax, out) {
    const a = Math.min(iMin, iMax);
    const b = Math.max(iMin, iMax);
    if (out.length === 0 || out[out.length - 1] !== first) out.push(first);
    if (a > first && a < last) out.push(a);
    if (b > first && b < last && b !== a) out.push(b);
    if (last !== first) out.push(last);
}

// Balayage brut d'un segment court (bords residuels, < factor echantillons au niveau 0).
function emitRawScan(values, lo, hi, out) {
    let im = lo, ix = lo, vm = values[lo], vx = values[lo];
    for (let i = lo + 1; i < hi; i++) {
        const v = values[i];
        if (v < vm) { vm = v; im = i; }
        if (v > vx) { vx = v; ix = i; }
    }
    emitBucket(lo, hi - 1, im, ix, out);
}

// Decompose [lo, hi) en buckets pleins du niveau demande, et raffine les bords partiels en
// descendant d'un niveau (jusqu'au balayage brut). Garantit l'exactitude de l'enveloppe.
function emitSegment(pyramid, values, lo, hi, level, out) {
    if (hi <= lo) return;
    if (level === 0) {
        emitRawScan(values, lo, hi, out);
        return;
    }

    const size = pyramid.sizes[level];
    const bFirst = Math.ceil(lo / size);
    const bLast = Math.floor(hi / size);

    if (bFirst >= bLast) {
        emitSegment(pyramid, values, lo, hi, level - 1, out);
        return;
    }

    if (lo < bFirst * size) {
        emitSegment(pyramid, values, lo, bFirst * size, level - 1, out);
    }
    const { idxMin, idxMax } = pyramid.levels[level];
    for (let b = bFirst; b < bLast; b++) {
        emitBucket(b * size, (b + 1) * size - 1, idxMin[b], idxMax[b], out);
    }
    if (bLast * size < hi) {
        emitSegment(pyramid, values, bLast * size, hi, level - 1, out);
    }
}

// Tas max minimal (cle numerique, charge utile opaque) pour le raffinement glouton.
class MaxHeap {
    constructor() {
        this.keys = [];
        this.items = [];
    }

    get size() {
        return this.keys.length;
    }

    push(key, item) {
        const keys = this.keys, items = this.items;
        let i = keys.length;
        keys.push(key);
        items.push(item);
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (keys[parent] >= keys[i]) break;
            [keys[parent], keys[i]] = [keys[i], keys[parent]];
            [items[parent], items[i]] = [items[i], items[parent]];
            i = parent;
        }
    }

    pop() {
        const keys = this.keys, items = this.items;
        const top = items[0];
        const lastKey = keys.pop();
        const lastItem = items.pop();
        if (keys.length) {
            keys[0] = lastKey;
            items[0] = lastItem;
            let i = 0;
            for (;;) {
                const left = 2 * i + 1, right = left + 1;
                let largest = i;
                if (left < keys.length && keys[left] > keys[largest]) largest = left;
                if (right < keys.length && keys[right] > keys[largest]) largest = right;
                if (largest === i) break;
                [keys[largest], keys[i]] = [keys[i], keys[largest]];
                [items[largest], items[i]] = [items[i], items[largest]];
                i = largest;
            }
        }
        return top;
    }
}

// Raffinement glouton sous budget: partant des buckets pleins [bFirst, bLast) du niveau
// initial, subdivise en priorite les buckets a plus forte erreur structurelle cumulee,
// tant que le budget de points le permet et que les enfants restent au-dessus de la
// taille d'un slot d'affichage. Retourne les feuilles retenues, triees par position.
function refineByErrorBudget(pyramid, level, bFirst, bLast, nVisible, maxPts) {
    const minChildSize = Math.max(1, Math.floor(nVisible / maxPts));
    const heap = new MaxHeap();
    const leaves = [];
    let estimate = (bLast - bFirst + 2) * POINTS_PER_BUCKET;  // + bords partiels

    const addLeaf = (lvl, bucket) => {
        const node = { level: lvl, bucket, split: false };
        leaves.push(node);
        if (lvl >= 2 && pyramid.sizes[lvl - 1] >= minChildSize) {
            const err = pyramid.levels[lvl].errSum[bucket];
            if (err > 0) heap.push(err, node);
        }
    };

    for (let b = bFirst; b < bLast; b++) addLeaf(level, b);

    const worstSplitCost = (pyramid.factor - 1) * POINTS_PER_BUCKET;
    while (heap.size && estimate + worstSplitCost <= maxPts) {
        const node = heap.pop();
        node.split = true;

        const childLevel = node.level - 1;
        const childCount = pyramid.levels[childLevel].idxMin.length;
        const cFirst = node.bucket * pyramid.factor;
        const cLast = Math.min(childCount, cFirst + pyramid.factor);
        for (let c = cFirst; c < cLast; c++) addLeaf(childLevel, c);
        estimate += (cLast - cFirst - 1) * POINTS_PER_BUCKET;
    }

    return leaves
        .filter(node => !node.split)
        .sort((a, b) => a.bucket * pyramid.sizes[a.level] - b.bucket * pyramid.sizes[b.level]);
}

/**
 * Selectionne les indices bruts a rendre pour la plage inclusive [startIdx, endIdx],
 * en visant au plus ~maxPts points, alloues adaptativement selon l'erreur structurelle.
 * Retourne null si la plage tient deja dans maxPts (le repli subarray zero-copie est
 * alors preferable).
 */
export function pyramidSelect(pyramid, values, startIdx, endIdx, maxPts) {
    const nVisible = endIdx - startIdx + 1;
    if (nVisible <= maxPts) return null;

    const targetBuckets = Math.max(1, Math.floor(maxPts / POINTS_PER_BUCKET));
    const initialBuckets = Math.max(1, Math.floor(targetBuckets / INITIAL_BUDGET_SHARE));
    const maxLevel = pyramid.levels.length - 1;

    let level = Math.min(maxLevel, Math.max(
        1, Math.ceil(Math.log(nVisible / initialBuckets) / Math.log(pyramid.factor))
    ));
    let size = pyramid.sizes[level];
    let bFirst = Math.ceil(startIdx / size);
    let bLast = Math.floor((endIdx + 1) / size);
    while (level > 1 && bFirst >= bLast) {
        level -= 1;
        size = pyramid.sizes[level];
        bFirst = Math.ceil(startIdx / size);
        bLast = Math.floor((endIdx + 1) / size);
    }

    const out = [];
    if (bFirst >= bLast) {
        emitSegment(pyramid, values, startIdx, endIdx + 1, level, out);
        return out;
    }

    const leaves = refineByErrorBudget(pyramid, level, bFirst, bLast, nVisible, maxPts);

    if (startIdx < bFirst * size) {
        emitSegment(pyramid, values, startIdx, bFirst * size, level, out);
    }
    for (const leaf of leaves) {
        const leafSize = pyramid.sizes[leaf.level];
        const first = leaf.bucket * leafSize;
        const last = Math.min(pyramid.n, (leaf.bucket + 1) * leafSize) - 1;
        const { idxMin, idxMax } = pyramid.levels[leaf.level];
        emitBucket(first, last, idxMin[leaf.bucket], idxMax[leaf.bucket], out);
    }
    if (bLast * size < endIdx + 1) {
        emitSegment(pyramid, values, bLast * size, endIdx + 1, level, out);
    }
    return out;
}

/**
 * Fusionne des ensembles d'indices tries croissants en un seul, deduplique.
 * Sert a la decimation conjointe de signaux partageant le meme raster: l'union des
 * selections par signal est materialisee pour tous, ce qui conserve un axe X partage
 * (aucun trou a combler) tout en gardant l'enveloppe exacte de chaque signal.
 */
export function mergeIndexSets(sets) {
    if (sets.length === 1) return sets[0];
    const ptrs = new Array(sets.length).fill(0);
    const out = [];
    for (;;) {
        let best = -1;
        for (let s = 0; s < sets.length; s++) {
            const p = ptrs[s];
            if (p < sets[s].length) {
                const v = sets[s][p];
                if (best === -1 || v < best) best = v;
            }
        }
        if (best === -1) break;
        out.push(best);
        for (let s = 0; s < sets.length; s++) {
            if (ptrs[s] < sets[s].length && sets[s][ptrs[s]] === best) ptrs[s]++;
        }
    }
    return out;
}

/**
 * Materialise une vue decimee {timestamps, values} depuis les indices selectionnes.
 */
export function pyramidView(pyramid, timestamps, values, startIdx, endIdx, maxPts) {
    const indices = pyramidSelect(pyramid, values, startIdx, endIdx, maxPts);
    if (indices === null) return null;

    const m = indices.length;
    const ts = new Float64Array(m);
    const vs = new Float32Array(m);
    for (let i = 0; i < m; i++) {
        const idx = indices[i];
        ts[i] = timestamps[idx];
        vs[i] = values[idx];
    }
    return { timestamps: ts, values: vs };
}
