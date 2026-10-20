import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildMinMaxPyramid, pyramidSelect } from '../../src/eda/minmax-pyramid.js';
import { rasterizeColumns, rasterError } from '../../src/eda/raster-error.js';
import { screenSelect } from '../../src/eda/screen-decimation.js';

// Real-data bench of the screen-space selector against the index pyramid it replaces, at the
// app budget (one point per pixel column and per trace, targetPointsForPlot). Skipped unless
// BB_BENCH_DIR points to a directory produced by scripts/bench/extract_mf4.py. The files stay
// out of the repository.

const DIR = process.env.BB_BENCH_DIR;
const ENABLED = Boolean(DIR && existsSync(join(DIR || '', 'manifest.json')));
const WIDTHS = [900, 1600];
const ZOOMS = [1, 0.1, 0.01, 0.001];
const POSITIONS = 6;
const HEIGHT = 200;

function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), a | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function lowerBound(t, x) {
    let lo = 0, hi = t.length;
    while (lo < hi) {
        const m = (lo + hi) >>> 1;
        if (t[m] < x) lo = m + 1;
        else hi = m;
    }
    return lo;
}

function loadFiles() {
    const manifest = JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf8'));
    return manifest.map(entry => {
        const tb = readFileSync(join(DIR, `${entry.key}.t.f64`));
        const T = new Float64Array(tb.buffer, tb.byteOffset, tb.byteLength / 8);
        const channels = entry.channels.map(c => {
            const vb = readFileSync(join(DIR, c.file));
            const Y = new Float32Array(vb.buffer, vb.byteOffset, vb.byteLength / 4);
            return { name: c.name, Y, pyramid: buildMinMaxPyramid(Y) };
        });
        return { key: entry.key, T, channels };
    });
}

const median = (a) => {
    const s = [...a].sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function scoreTrace(T, Y, s, e, idx, grid, ref) {
    if (idx === null) return { err: 0, points: e - s + 1 };
    const t = Float64Array.from(idx, i => T[i]);
    const y = Float64Array.from(idx, i => Y[i]);
    return { err: rasterError(ref, rasterizeColumns({ t, y }, grid)), points: idx.length };
}

describe.skipIf(!ENABLED)('screen-space selector on real files', () => {
    const rows = [];

    it('replays every scene and keeps the selector invariants', () => {
        for (const file of loadFiles()) {
            const { T } = file;
            const span = T[T.length - 1] - T[0];
            for (const W of WIDTHS) {
                for (const zoom of ZOOMS) {
                    const rng = mulberry32(1000 + Math.round(zoom * 1e6) + W);
                    const positions = zoom >= 1 ? [0] : Array.from({ length: POSITIONS }, () => rng());
                    for (const pos of positions) {
                        const t0 = T[0] + pos * (span - span * zoom);
                        const s = Math.min(T.length - 1, lowerBound(T, t0));
                        const e = Math.max(s, Math.min(T.length - 1, lowerBound(T, t0 + span * zoom) - 1));
                        const scene = { file: file.key, W, zoom, pyr: [], scr: [], msPyr: 0, msScr: 0 };
                        for (const ch of file.channels) {
                            const ys = ch.Y.subarray(s, e + 1);
                            let yMin = Infinity, yMax = -Infinity;
                            for (let i = 0; i < ys.length; i++) {
                                if (ys[i] < yMin) yMin = ys[i];
                                if (ys[i] > yMax) yMax = ys[i];
                            }
                            const grid = { width: W, height: HEIGHT, tMin: T[s], tMax: T[e], yMin, yMax };
                            const ref = rasterizeColumns({ t: T.subarray(s, e + 1), y: ys }, grid);

                            let c0 = performance.now();
                            const pyr = pyramidSelect(ch.pyramid, ch.Y, s, e, W);
                            scene.msPyr += performance.now() - c0;
                            c0 = performance.now();
                            const scr = screenSelect(ch.pyramid, T, ch.Y, s, e,
                                { budget: W, cols: W, heightPx: HEIGHT, tMin: T[s], tMax: T[e] });
                            scene.msScr += performance.now() - c0;

                            if (scr !== null) {
                                expect(scr.length).toBeLessThanOrEqual(W);
                                expect(scr[0]).toBe(s);
                                expect(scr[scr.length - 1]).toBe(e);
                            }
                            scene.pyr.push(scoreTrace(T, ch.Y, s, e, pyr, grid, ref));
                            scene.scr.push(scoreTrace(T, ch.Y, s, e, scr, grid, ref));
                        }
                        rows.push(scene);
                    }
                }
            }
        }
        expect(rows.length).toBeGreaterThan(0);
    }, 900000);

    it('reports error, worst trace, points and time per scene against the index pyramid', () => {
        const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
        const summarise = (label, sel) => {
            const errP = sel.map(r => mean(r.pyr.map(p => p.err)));
            const errS = sel.map(r => mean(r.scr.map(p => p.err)));
            const worstP = sel.map(r => Math.max(...r.pyr.map(p => p.err)));
            const worstS = sel.map(r => Math.max(...r.scr.map(p => p.err)));
            const gains = errP.map((p, i) => (p > 0 ? (p - errS[i]) / p : 0));
            const wins = errS.filter((v, i) => v < errP[i] - 1e-12).length;
            const losses = errS.filter((v, i) => v > errP[i] + 1e-12).length;
            const worstWorse = worstS.filter((v, i) => v > worstP[i] + 1e-12).length;
            const pts = (key) => median(sel.map(r => r[key].reduce((s, p) => s + p.points, 0)));
            const pct = v => `${(v * 100).toFixed(1)}%`;
            return `${label.padEnd(10)} scenes ${String(sel.length).padStart(3)} | err ${pct(median(errP))} -> ${pct(median(errS))}`
                + ` (gain med ${pct(median(gains))}, wins/losses ${wins}/${losses})`
                + ` | worst ${pct(median(worstP))} -> ${pct(median(worstS))} (worse in ${worstWorse})`
                + ` | pts ${pts('pyr')} -> ${pts('scr')}`
                + ` | ms/scene ${median(sel.map(r => r.msPyr)).toFixed(2)} -> ${median(sel.map(r => r.msScr)).toFixed(2)}`
                + ` (max ${Math.max(...sel.map(r => r.msScr)).toFixed(1)})`;
        };
        const lines = [summarise('all', rows)];
        for (const zoom of ZOOMS) lines.push(summarise(`zoom ${zoom}`, rows.filter(r => r.zoom === zoom)));
        for (const key of [...new Set(rows.map(r => r.file))]) lines.push(summarise(key, rows.filter(r => r.file === key)));
        console.log(`[bench screen-decimation, 12 traces per scene, H=${HEIGHT}px]\n${lines.join('\n')}`);

        const errP = rows.map(r => mean(r.pyr.map(p => p.err)));
        const errS = rows.map(r => mean(r.scr.map(p => p.err)));
        expect(errS.filter((v, i) => v > errP[i] + 1e-12)).toHaveLength(0);
    });
});
