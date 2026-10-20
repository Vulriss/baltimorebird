// Baltimore Bird - screen-space point selection for the EDA plots.
//
// The leaves of the selection tree are the pixel columns of the plot over the visible time
// window, with a balanced binary tree above them. Every node renders as the M4 of its range
// {first, argmin, argmax, last}: any frontier keeps the exact envelope, and the frontier made
// of the leaves themselves is the column aligned M4, pixel exact under column fill.
//
// A node is scored by its pixel error: summed over its columns, the symmetric difference
// between the rows its samples cover and the rows its M4 polyline covers. Refinement splits
// the node with the largest error per added point until the budget is spent. A node whose
// error is already zero is never split, so a flat stretch stays at two points whatever its
// length. Column extrema are range queries on the min/max pyramid, so the cost follows the
// pixel width of the plot, not the sample count of the window. Before the pyramid is built
// they come from a scan of the window, with the same result: the selection never changes
// when the pyramid arrives. The server computes the same selection for the first view
// (src/backend/core/screen_decimation.py); both sides must stay in step.
//
// Pure module, no DOM. Assumes finite values (the server interpolates NaN before caching);
// a non-finite value is mapped to the bottom row rather than poisoning the heap.

import { emitBucket } from './minmax-pyramid.js';

// Running argmin / argmax of the current range query, in module scope to avoid an allocation
// per column (the query runs once per pixel column and per frame). On equal values the
// earliest index wins, whatever the visiting order: the selection is then the same with or
// without a pyramid, and the same as the server's (core/screen_decimation.py).
let foldMin = 0;
let foldMax = 0;

function takeIndex(values, i) {
    const v = values[i];
    if (v < values[foldMin] || (v === values[foldMin] && i < foldMin)) foldMin = i;
    if (v > values[foldMax] || (v === values[foldMax] && i < foldMax)) foldMax = i;
}

function takeBucket(values, idxMin, idxMax, b) {
    const iMin = idxMin[b];
    const iMax = idxMax[b];
    if (values[iMin] < values[foldMin] || (values[iMin] === values[foldMin] && iMin < foldMin)) foldMin = iMin;
    if (values[iMax] > values[foldMax] || (values[iMax] === values[foldMax] && iMax < foldMax)) foldMax = iMax;
}

/**
 * Raw indices of the minimum and maximum of values[lo, hi), earliest index on ties. With a
 * pyramid, bottom-up decomposition: raw samples up to the first bucket boundary on each side,
 * then at every level the buckets up to the next boundary of the level above, so at most
 * factor - 1 buckets per side and per level. Without one (not built yet), a linear scan.
 * `out` receives [iMin, iMax].
 */
export function rangeExtrema(pyramid, values, lo, hi, out) {
    if (!pyramid) {
        // Left to right with strict comparisons: the earliest index wins by construction.
        let iMin = lo;
        let iMax = lo;
        let vMin = values[lo];
        let vMax = vMin;
        for (let i = lo + 1; i < hi; i++) {
            const v = values[i];
            if (v < vMin) { vMin = v; iMin = i; }
            if (v > vMax) { vMax = v; iMax = i; }
        }
        out[0] = iMin;
        out[1] = iMax;
        return out;
    }
    const f = pyramid.factor;
    const top = pyramid.levels.length - 1;
    foldMin = lo;
    foldMax = lo;
    let a = lo;
    let b = hi;
    while (a < b && a % f !== 0) takeIndex(values, a++);
    while (a < b && b % f !== 0) takeIndex(values, --b);
    a /= f;
    b /= f;
    for (let level = 1; a < b; level++) {
        const { idxMin, idxMax } = pyramid.levels[level];
        if (level === top) {
            while (a < b) takeBucket(values, idxMin, idxMax, a++);
            break;
        }
        while (a < b && a % f !== 0) takeBucket(values, idxMin, idxMax, a++);
        while (a < b && b % f !== 0) takeBucket(values, idxMin, idxMax, --b);
        a /= f;
        b /= f;
    }
    out[0] = foldMin;
    out[1] = foldMax;
    return out;
}

// First index in [lo, hi) whose timestamp is >= t, hi if none.
function lowerBound(timestamps, t, lo, hi) {
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (timestamps[mid] < t) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

/**
 * Builds the selection tree of one trace over a time window.
 *
 * @param pyramid    min/max pyramid of `values` (buildMinMaxPyramid), or null to scan
 * @param timestamps sorted timestamps, same indexing as values
 * @param startIdx   first raw index of the window (inclusive)
 * @param endIdx     last raw index of the window (inclusive)
 * @param opts.cols     pixel columns of the plot (physical pixels)
 * @param opts.heightPx plot height in physical pixels
 * @param opts.tMin     time at the left edge of the plot
 * @param opts.tMax     time at the right edge of the plot
 * @returns tree descriptor, consumed by selectFrontier and emitFrontier
 */
export function buildScreenTree(pyramid, timestamps, values, startIdx, endIdx, opts) {
    const cols = Math.max(1, Math.floor(opts.cols));
    const height = Math.max(1, Math.floor(opts.heightPx));
    const span = opts.tMax - opts.tMin;
    const end = endIdx + 1;

    const xScale = span > 0 ? cols / span : 0;
    const tMin = opts.tMin;

    // Leaves: the non empty pixel columns, in order. Column c covers [tMin + c*w, tMin + (c+1)*w).
    const leafLo = new Int32Array(cols);
    const leafHi = new Int32Array(cols);
    const leafMin = new Int32Array(cols);
    const leafMax = new Int32Array(cols);
    const leafCol = new Int32Array(cols);
    const ext = [0, 0];
    let leaves = 0;
    let lo = startIdx;
    for (let c = 0; c < cols && lo < end; c++) {
        const hi = c === cols - 1 ? end : lowerBound(timestamps, tMin + (span * (c + 1)) / cols, lo, end);
        if (hi <= lo) continue;
        rangeExtrema(pyramid, values, lo, hi, ext);
        leafLo[leaves] = lo;
        leafHi[leaves] = hi;
        leafMin[leaves] = ext[0];
        leafMax[leaves] = ext[1];
        leafCol[leaves] = c;
        leaves++;
        lo = hi;
    }

    let yMin = Infinity;
    let yMax = -Infinity;
    for (let k = 0; k < leaves; k++) {
        if (values[leafMin[k]] < yMin) yMin = values[leafMin[k]];
        if (values[leafMax[k]] > yMax) yMax = values[leafMax[k]];
    }
    const rowScale = yMax > yMin ? height / (yMax - yMin) : 0;

    const trueLo = new Int32Array(leaves);
    const trueHi = new Int32Array(leaves);
    for (let k = 0; k < leaves; k++) {
        trueLo[k] = Math.floor(rowOf(values[leafMin[k]], yMin, rowScale, height));
        trueHi[k] = Math.floor(rowOf(values[leafMax[k]], yMin, rowScale, height));
    }

    // Balanced binary tree over the leaves, children before parents. Node n covers leaves
    // [nodeA[n], nodeB[n]); its error is computed lazily (NaN until the heap needs it).
    const capacity = Math.max(1, 2 * leaves - 1);
    const nodeA = new Int32Array(capacity);
    const nodeB = new Int32Array(capacity);
    const left = new Int32Array(capacity).fill(-1);
    const right = new Int32Array(capacity).fill(-1);
    const nodeMin = new Int32Array(capacity);
    const nodeMax = new Int32Array(capacity);
    const nodeErr = new Float64Array(capacity).fill(NaN);
    let count = 0;
    const build = (a, b) => {
        let id;
        if (b - a === 1) {
            id = count++;
            nodeMin[id] = leafMin[a];
            nodeMax[id] = leafMax[a];
            nodeErr[id] = 0;
        } else {
            const mid = (a + b) >> 1;
            const l = build(a, mid);
            const r = build(mid, b);
            id = count++;
            left[id] = l;
            right[id] = r;
            nodeMin[id] = values[nodeMin[r]] < values[nodeMin[l]] ? nodeMin[r] : nodeMin[l];
            nodeMax[id] = values[nodeMax[r]] > values[nodeMax[l]] ? nodeMax[r] : nodeMax[l];
        }
        nodeA[id] = a;
        nodeB[id] = b;
        return id;
    };
    const root = leaves > 0 ? build(0, leaves) : -1;

    return {
        timestamps, values, tMin, xScale, yMin, rowScale, height,
        leafLo, leafHi, leafCol, trueLo, trueHi,
        root, nodeA, nodeB, left, right, nodeMin, nodeMax, nodeErr,
    };
}

// Fractional row of a value, clamped to the plot; non finite values land on row 0.
function rowOf(v, yMin, rowScale, height) {
    const r = (v - yMin) * rowScale;
    if (!(r > 0)) return 0;
    return r < height - 1 ? r : height - 1;
}

const knotIdx = new Int32Array(4);
const knotX = new Float64Array(4);
const knotY = new Float64Array(4);

// Sorted, deduplicated M4 indices of node n into knotIdx; returns their count, which is also
// the number of points the node emits.
function nodeKnots(tree, n) {
    const first = tree.leafLo[tree.nodeA[n]];
    const last = tree.leafHi[tree.nodeB[n] - 1] - 1;
    const a = Math.min(tree.nodeMin[n], tree.nodeMax[n]);
    const b = Math.max(tree.nodeMin[n], tree.nodeMax[n]);
    let k = 0;
    knotIdx[k++] = first;
    if (a > first && a < last) knotIdx[k++] = a;
    if (b > first && b < last && b !== a) knotIdx[k++] = b;
    if (last !== first) knotIdx[k++] = last;
    return k;
}

// Value at x of the knot segment `seg` (knotX / knotY), clamped to the segment.
function segmentAt(seg, x) {
    const x0 = knotX[seg];
    const x1 = knotX[seg + 1];
    if (!(x1 > x0)) return knotY[seg + 1];
    const f = (x - x0) / (x1 - x0);
    return knotY[seg] + (knotY[seg + 1] - knotY[seg]) * (f < 0 ? 0 : f > 1 ? 1 : f);
}

// Pixel error of rendering node n by its own M4 polyline instead of its samples: per column,
// |rows covered by the samples XOR rows covered by the polyline|. Cached in tree.nodeErr.
function nodeError(tree, n) {
    const cached = tree.nodeErr[n];
    if (!Number.isNaN(cached)) return cached;

    const { timestamps, values, tMin, xScale, yMin, rowScale, height, leafCol, trueLo, trueHi } = tree;
    const k = nodeKnots(tree, n);
    for (let j = 0; j < k; j++) {
        knotX[j] = (timestamps[knotIdx[j]] - tMin) * xScale;
        knotY[j] = rowOf(values[knotIdx[j]], yMin, rowScale, height);
    }
    const xFirst = knotX[0];
    const xLast = knotX[k - 1];

    // Columns, and the points evaluated inside a column, come in increasing x: the segment
    // cursor only moves forward. An internal node has at least two knots.
    let seg = 0;
    let err = 0;
    for (let leaf = tree.nodeA[n]; leaf < tree.nodeB[n]; leaf++) {
        const c = leafCol[leaf];
        const tl = trueLo[leaf];
        const th = trueHi[leaf];
        const xa = c > xFirst ? c : xFirst;
        const xb = c + 1 < xLast ? c + 1 : xLast;
        if (xb < xa) {
            err += th - tl + 1;
            continue;
        }
        while (seg < k - 2 && knotX[seg + 1] < xa) seg++;
        let lo = segmentAt(seg, xa);
        let hi = lo;
        for (let j = seg + 1; j < k && knotX[j] < xb; j++) {
            if (knotX[j] > xa) {
                if (knotY[j] < lo) lo = knotY[j];
                if (knotY[j] > hi) hi = knotY[j];
            }
        }
        while (seg < k - 2 && knotX[seg + 1] < xb) seg++;
        const yb = segmentAt(seg, xb);
        if (yb < lo) lo = yb;
        if (yb > hi) hi = yb;
        const al = Math.floor(lo);
        const ah = Math.floor(hi);
        const inter = Math.max(0, Math.min(th, ah) - Math.max(tl, al) + 1);
        err += (th - tl + 1) + (ah - al + 1) - 2 * inter;
    }
    tree.nodeErr[n] = err;
    return err;
}

// Max heap of node ids keyed by priority, on typed arrays sized to the tree: sifting moves a
// hole instead of swapping, and nothing is allocated per operation.
function createHeap(capacity) {
    return { keys: new Float64Array(capacity), ids: new Int32Array(capacity), size: 0 };
}

function heapPush(heap, key, id) {
    const { keys, ids } = heap;
    let i = heap.size++;
    while (i > 0) {
        const parent = (i - 1) >> 1;
        if (keys[parent] >= key) break;
        keys[i] = keys[parent];
        ids[i] = ids[parent];
        i = parent;
    }
    keys[i] = key;
    ids[i] = id;
}

function heapPop(heap) {
    const { keys, ids } = heap;
    const top = ids[0];
    const size = --heap.size;
    if (size > 0) {
        const key = keys[size];
        const id = ids[size];
        let i = 0;
        for (;;) {
            let child = 2 * i + 1;
            if (child >= size) break;
            if (child + 1 < size && keys[child + 1] > keys[child]) child++;
            if (keys[child] <= key) break;
            keys[i] = keys[child];
            ids[i] = ids[child];
            i = child;
        }
        keys[i] = key;
        ids[i] = id;
    }
    return top;
}

// Points added by splitting node n into its two children.
function splitCost(tree, n) {
    return Math.max(1, nodeKnots(tree, tree.left[n]) + nodeKnots(tree, tree.right[n]) - nodeKnots(tree, n));
}

/**
 * Refines the tree under a point budget: the node with the largest pixel error per added
 * point is split first; nodes with zero error are never split.
 * @returns Uint8Array, 1 for every split node (the frontier is the set of unsplit nodes
 *          whose ancestors are all split)
 */
export function selectFrontier(tree, budget) {
    const split = new Uint8Array(tree.nodeA.length);
    if (tree.root < 0) return split;

    const heap = createHeap(tree.nodeA.length);
    const offer = (n) => {
        if (tree.left[n] < 0) return;
        const err = nodeError(tree, n);
        if (err > 0) heapPush(heap, err / splitCost(tree, n), n);
    };

    let used = nodeKnots(tree, tree.root);
    offer(tree.root);
    while (heap.size) {
        const n = heapPop(heap);
        const delta = splitCost(tree, n);
        if (used + delta > budget) continue;
        split[n] = 1;
        used += delta;
        offer(tree.left[n]);
        offer(tree.right[n]);
    }
    return split;
}

/** Raw indices of the frontier, strictly increasing, covering the whole window. */
export function emitFrontier(tree, split, out = []) {
    if (tree.root < 0) return out;
    const walk = (n) => {
        if (split[n]) {
            walk(tree.left[n]);
            walk(tree.right[n]);
            return;
        }
        const first = tree.leafLo[tree.nodeA[n]];
        const last = tree.leafHi[tree.nodeB[n] - 1] - 1;
        emitBucket(first, last, tree.nodeMin[n], tree.nodeMax[n], out);
    };
    walk(tree.root);
    return out;
}

/**
 * Screen-space selection of the raw indices to render for [startIdx, endIdx].
 * Same contract as pyramidSelect: null when the window already fits the budget (the zero
 * copy subarray is then preferable), otherwise increasing raw indices, at most `budget`.
 *
 * @param opts { budget, cols, heightPx, tMin, tMax } (see buildScreenTree)
 */
export function screenSelect(pyramid, timestamps, values, startIdx, endIdx, opts) {
    if (endIdx - startIdx + 1 <= opts.budget) return null;
    const tree = buildScreenTree(pyramid, timestamps, values, startIdx, endIdx, opts);
    return emitFrontier(tree, selectFrontier(tree, opts.budget));
}

// Step signals (booleans, states) are not decimated by pixel error: their fronts are exact
// under stepped rendering and usually few. Same rule as state_change_points on the server
// (data_management/sessions.py), with the same fallback to screenSelect when a window holds
// more than stepFrontsLimit(budget) fronts.

/** Most fronts a step window may return before falling back to screenSelect. */
export function stepFrontsLimit(budget) {
    return Math.max(2 * budget, 4000);
}

/**
 * Indices i >= 1 where values[i] differs from values[i - 1]. Built once per step signal, so
 * the fronts of any window are then found by binary search instead of a scan.
 */
export function buildChangeIndex(values) {
    let count = 0;
    for (let i = 1; i < values.length; i++) if (values[i] !== values[i - 1]) count++;
    const changes = new Uint32Array(count);
    let k = 0;
    for (let i = 1; i < values.length; i++) if (values[i] !== values[i - 1]) changes[k++] = i;
    return changes;
}

/**
 * Fronts of a step signal over [startIdx, endIdx]: the two samples around every change inside
 * the window, plus its first and last samples, strictly increasing.
 * @param changes buildChangeIndex(values), or null to scan the window
 */
export function stepFronts(values, changes, startIdx, endIdx) {
    const out = [startIdx];
    const push = (i) => {
        if (out[out.length - 1] < i) out.push(i);
    };
    if (changes) {
        let lo = 0;
        let hi = changes.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (changes[mid] <= startIdx) lo = mid + 1;
            else hi = mid;
        }
        for (let k = lo; k < changes.length && changes[k] <= endIdx; k++) {
            push(changes[k] - 1);
            push(changes[k]);
        }
    } else {
        for (let i = startIdx + 1; i <= endIdx; i++) {
            if (values[i] !== values[i - 1]) {
                push(i - 1);
                push(i);
            }
        }
    }
    push(endIdx);
    return out;
}
