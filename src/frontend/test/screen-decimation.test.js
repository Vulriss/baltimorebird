import { describe, it, expect } from 'vitest';
import { buildMinMaxPyramid, pyramidSelect } from '../src/eda/minmax-pyramid.js';
import { rasterizeColumns, rasterError } from '../src/eda/raster-error.js';
import {
    buildChangeIndex, buildScreenTree, emitFrontier, rangeExtrema, screenSelect, selectFrontier, stepFronts,
} from '../src/eda/screen-decimation.js';

function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), a | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Acquisition-like trace: long flat stretches, steps, a noisy burst and isolated spikes, on a
// slightly irregular time base (columns are cut in time, not in index).
function makeTrace(n = 200000, seed = 7) {
    const rng = mulberry32(seed);
    const t = new Float64Array(n);
    const y = new Float32Array(n);
    let clock = 0;
    for (let i = 0; i < n; i++) {
        clock += 0.01 * (0.9 + 0.2 * rng());
        t[i] = clock;
        const phase = i / n;
        let v = phase < 0.3 ? 0 : phase < 0.5 ? 2 + Math.floor(phase * 40) % 3 : Math.sin(i / 900);
        if (phase > 0.7 && phase < 0.8) v += (rng() - 0.5) * 1.5;
        if (i % 37001 === 0) v += 6;
        y[i] = v;
    }
    return { t, y, pyramid: buildMinMaxPyramid(y) };
}

const TRACE = makeTrace();
const VIEW = { cols: 1600, heightPx: 400 };

function opts(trace, startIdx, endIdx, budget) {
    return { budget, ...VIEW, tMin: trace.t[startIdx], tMax: trace.t[endIdx] };
}

function windowEnvelope(y, s, e) {
    let min = Infinity, max = -Infinity;
    for (let i = s; i <= e; i++) {
        if (y[i] < min) min = y[i];
        if (y[i] > max) max = y[i];
    }
    return [min, max];
}

function pixelError(trace, s, e, indices) {
    const [yMin, yMax] = windowEnvelope(trace.y, s, e);
    const grid = { width: VIEW.cols, height: VIEW.heightPx, tMin: trace.t[s], tMax: trace.t[e], yMin, yMax };
    const ref = rasterizeColumns({ t: trace.t.subarray(s, e + 1), y: trace.y.subarray(s, e + 1) }, grid);
    const t = Float64Array.from(indices, i => trace.t[i]);
    const y = Float64Array.from(indices, i => trace.y[i]);
    return rasterError(ref, rasterizeColumns({ t, y }, grid));
}

describe('rangeExtrema', () => {
    it('matches a brute force scan on random ranges, including partial buckets', () => {
        const rng = mulberry32(3);
        const out = [0, 0];
        for (let k = 0; k < 500; k++) {
            const lo = Math.floor(rng() * (TRACE.y.length - 1));
            const hi = lo + 1 + Math.floor(rng() * Math.min(50000, TRACE.y.length - lo - 1));
            rangeExtrema(TRACE.pyramid, TRACE.y, lo, hi, out);
            const [min, max] = windowEnvelope(TRACE.y, lo, hi - 1);
            expect(TRACE.y[out[0]]).toBe(min);
            expect(TRACE.y[out[1]]).toBe(max);
            expect(out[0]).toBeGreaterThanOrEqual(lo);
            expect(out[1]).toBeLessThan(hi);
        }
    });
});

describe('screenSelect', () => {
    const N = TRACE.y.length;

    it('returns null when the window already fits the budget', () => {
        expect(screenSelect(TRACE.pyramid, TRACE.t, TRACE.y, 1000, 1999, opts(TRACE, 1000, 1999, 1600))).toBeNull();
    });

    it('emits increasing indices inside the window, with its first and last samples', () => {
        const s = 12345, e = N - 4321;
        const idx = screenSelect(TRACE.pyramid, TRACE.t, TRACE.y, s, e, opts(TRACE, s, e, 1600));
        expect(idx[0]).toBe(s);
        expect(idx[idx.length - 1]).toBe(e);
        for (let i = 1; i < idx.length; i++) expect(idx[i]).toBeGreaterThan(idx[i - 1]);
    });

    it('keeps the exact envelope of the window and never exceeds the budget', () => {
        const rng = mulberry32(11);
        for (let k = 0; k < 40; k++) {
            const s = Math.floor(rng() * N * 0.8);
            const e = Math.min(N - 1, s + 5000 + Math.floor(rng() * (N - s)));
            const budget = 300 + Math.floor(rng() * 3000);
            const idx = screenSelect(TRACE.pyramid, TRACE.t, TRACE.y, s, e, opts(TRACE, s, e, budget));
            if (idx === null) continue;
            expect(idx.length).toBeLessThanOrEqual(budget);
            const values = idx.map(i => TRACE.y[i]);
            expect([Math.min(...values), Math.max(...values)]).toEqual(windowEnvelope(TRACE.y, s, e));
        }
    });

    it('renders a flat window with two points whatever its length', () => {
        const flat = new Float32Array(100000).fill(1.5);
        const t = Float64Array.from(flat, (_, i) => i * 0.01);
        const idx = screenSelect(buildMinMaxPyramid(flat), t, flat, 0, flat.length - 1,
            { budget: 1600, ...VIEW, tMin: 0, tMax: t[t.length - 1] });
        expect(idx).toEqual([0, flat.length - 1]);
    });

    it('is pixel exact (within 0.5 %) once the budget allows the column aligned M4', () => {
        const s = 0, e = N - 1;
        const idx = screenSelect(TRACE.pyramid, TRACE.t, TRACE.y, s, e, opts(TRACE, s, e, 4 * VIEW.cols));
        expect(pixelError(TRACE, s, e, idx)).toBeLessThan(0.005);
    });

    it('beats the index pyramid at equal budget on the reference trace', () => {
        for (const [s, e] of [[0, N - 1], [40000, 120000], [130000, 170000]]) {
            const pyr = pyramidSelect(TRACE.pyramid, TRACE.y, s, e, 1600);
            const scr = screenSelect(TRACE.pyramid, TRACE.t, TRACE.y, s, e, opts(TRACE, s, e, 1600));
            expect(scr.length).toBeLessThanOrEqual(1600);
            expect(pixelError(TRACE, s, e, scr)).toBeLessThan(pixelError(TRACE, s, e, pyr));
        }
    });

    it('splits nothing below a node whose pixel error is zero', () => {
        const s = 1, e = 37000;  // between the spikes at 0 and 37001, inside the flat stretch
        const tree = buildScreenTree(TRACE.pyramid, TRACE.t, TRACE.y, s, e, opts(TRACE, s, e, 1600));
        const split = selectFrontier(tree, 1600);
        expect(split.every(v => v === 0)).toBe(true);
        expect(emitFrontier(tree, split)).toEqual([s, e]);
    });

    it('selects exactly the same indices with or without the pyramid', () => {
        const rng = mulberry32(5);
        for (let k = 0; k < 30; k++) {
            const s = Math.floor(rng() * N * 0.9);
            const e = Math.min(N - 1, s + 3000 + Math.floor(rng() * (N - s)));
            const o = opts(TRACE, s, e, 300 + Math.floor(rng() * 3000));
            expect(screenSelect(null, TRACE.t, TRACE.y, s, e, o))
                .toEqual(screenSelect(TRACE.pyramid, TRACE.t, TRACE.y, s, e, o));
        }
    });
});

describe('rangeExtrema ties', () => {
    it('returns the earliest index of a repeated extremum, pyramid or scan', () => {
        const y = new Float32Array(70000);
        for (let i = 0; i < y.length; i++) y[i] = i % 7 === 3 ? 5 : i % 11 === 2 ? -5 : 0;
        const pyramid = buildMinMaxPyramid(y);
        const out = [0, 0];
        for (const [lo, hi] of [[0, 70000], [5, 64003], [1234, 1250], [40001, 69999]]) {
            const firstMax = y.findIndex((v, i) => i >= lo && v === 5);
            const firstMin = y.findIndex((v, i) => i >= lo && v === -5);
            expect(rangeExtrema(pyramid, y, lo, hi, out)).toEqual([firstMin, firstMax]);
            expect(rangeExtrema(null, y, lo, hi, out)).toEqual([firstMin, firstMax]);
        }
    });
});

// Reference: the keep mask of state_change_points (data_management/sessions.py) on the window.
function serverFronts(values, s, e) {
    const keep = new Uint8Array(e - s + 1);
    for (let i = s + 1; i <= e; i++) {
        if (values[i] !== values[i - 1]) {
            keep[i - s] = 1;
            keep[i - 1 - s] = 1;
        }
    }
    keep[0] = 1;
    keep[e - s] = 1;
    const out = [];
    keep.forEach((k, j) => { if (k) out.push(s + j); });
    return out;
}

describe('stepFronts', () => {
    it('returns the server fronts of any window, with or without the change index', () => {
        const rng = mulberry32(9);
        const values = new Float32Array(30000);
        let state = 0;
        for (let i = 0; i < values.length; i++) {
            if (rng() < 0.002) state = Math.floor(rng() * 5);
            values[i] = state;
        }
        const changes = buildChangeIndex(values);
        for (let k = 0; k < 200; k++) {
            const s = Math.floor(rng() * values.length);
            const e = Math.min(values.length - 1, s + Math.floor(rng() * 8000));
            const expected = serverFronts(values, s, e);
            expect(stepFronts(values, changes, s, e)).toEqual(expected);
            expect(stepFronts(values, null, s, e)).toEqual(expected);
        }
    });
});
