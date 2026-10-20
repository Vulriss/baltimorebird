import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildMinMaxPyramid } from '../src/eda/minmax-pyramid.js';
import { screenSelect } from '../src/eda/screen-decimation.js';

// Client / server parity of the screen-space selection. The server computes the first view
// (src/backend/core/screen_decimation.py), the client every later render: both must select
// the same indices or the plot changes when the full resolution data arrives. The reference
// cases live in tests/fixtures/screen_decimation_parity.json and are checked by this file and
// by src/backend/core/test_screen_decimation.py. The signals are rebuilt on both sides from a
// generator that only uses exact IEEE operations (mulberry32, + - * /, floor), so they are
// bit-identical in JavaScript and Python. UPDATE_PARITY=1 rewrites the fixture from the client.

const FIXTURE = resolve(__dirname, '../../../tests/fixtures/screen_decimation_parity.json');

const SPECS = [
    { name: 'steps and noise, full window', n: 20000, seed: 1, jitter: 0.2, steps: 1, ramp: 0, noise: 0.3, spikeEvery: 0, quant: 0, a: 0, b: 1, cols: 600, height: 200, budget: 600 },
    { name: 'spikes on a ramp, zoomed', n: 50000, seed: 2, jitter: 0, steps: 0, ramp: 1, noise: 0.05, spikeEvery: 4999, quant: 0, a: 0.2, b: 0.55, cols: 900, height: 300, budget: 900 },
    { name: 'quantized noise, many ties', n: 30000, seed: 3, jitter: 0.5, steps: 0, ramp: 0, noise: 1, spikeEvery: 0, quant: 4, a: 0.1, b: 0.9, cols: 512, height: 160, budget: 512 },
    { name: 'flat with rare spikes', n: 40000, seed: 4, jitter: 0, steps: 0, ramp: 0, noise: 0, spikeEvery: 9973, quant: 0, a: 0, b: 1, cols: 800, height: 400, budget: 800 },
    { name: 'tight budget below the width', n: 25000, seed: 5, jitter: 0.1, steps: 1, ramp: 1, noise: 0.2, spikeEvery: 3001, quant: 0, a: 0.05, b: 0.95, cols: 1600, height: 731, budget: 400 },
    { name: 'window falling between samples', n: 6000, seed: 6, jitter: 0.9, steps: 1, ramp: 0, noise: 0.4, spikeEvery: 0, quant: 8, a: 0.3337, b: 0.3391, cols: 300, height: 120, budget: 10 },
    { name: 'narrow plot, tall', n: 15000, seed: 7, jitter: 0.3, steps: 0, ramp: 1, noise: 0.6, spikeEvery: 1499, quant: 0, a: 0, b: 1, cols: 100, height: 2000, budget: 100 },
    { name: 'window fits the budget', n: 3000, seed: 8, jitter: 0, steps: 1, ramp: 0, noise: 0.1, spikeEvery: 0, quant: 0, a: 0.4, b: 0.6, cols: 1000, height: 200, budget: 1000 },
];

function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), a | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function makeSignal(spec) {
    const rng = mulberry32(spec.seed);
    const t = new Float64Array(spec.n);
    const y = new Float32Array(spec.n);
    let clock = 0;
    for (let i = 0; i < spec.n; i++) {
        clock += 0.01 * (1 + spec.jitter * (rng() - 0.5));
        t[i] = clock;
        const phase = i / spec.n;
        let v = spec.steps * (Math.floor(phase * 8) % 3) + spec.ramp * phase * 5 + spec.noise * (rng() - 0.5);
        if (spec.spikeEvery > 0 && i % spec.spikeEvery === 0) v += 4;
        if (spec.quant > 0) v = Math.floor(v * spec.quant + 0.5) / spec.quant;
        y[i] = v;
    }
    return { t, y };
}

// windowBounds of data-views.js: one sample before and after the view.
function windowOf(t, viewMin, viewMax) {
    let lo = 0, hi = t.length;
    while (lo < hi) { const m = (lo + hi) >>> 1; if (t[m] < viewMin) lo = m + 1; else hi = m; }
    const first = lo;
    lo = 0; hi = t.length;
    while (lo < hi) { const m = (lo + hi) >>> 1; if (t[m] <= viewMax) lo = m + 1; else hi = m; }
    const last = lo - 1;
    return { s: first > 0 ? first - 1 : 0, e: last < t.length - 1 ? last + 1 : t.length - 1 };
}

function runCase(spec, pyramid) {
    const { t, y } = makeSignal(spec);
    const span = t[spec.n - 1] - t[0];
    const viewMin = t[0] + spec.a * span;
    const viewMax = t[0] + spec.b * span;
    const { s, e } = windowOf(t, viewMin, viewMax);
    const opts = { budget: spec.budget, cols: spec.cols, heightPx: spec.height, tMin: viewMin, tMax: viewMax };
    return screenSelect(pyramid ? buildMinMaxPyramid(y, 4, 1024) : null, t, y, s, e, opts);
}

describe('screen-space selection, client / server parity cases', () => {
    if (process.env.UPDATE_PARITY === '1') {
        const cases = SPECS.map(spec => ({ ...spec, expected: runCase(spec, false) }));
        writeFileSync(FIXTURE, `${JSON.stringify({ cases }, null, 1)}\n`);
    }

    it('has a reference fixture for every case', () => {
        expect(existsSync(FIXTURE)).toBe(true);
        const { cases } = JSON.parse(readFileSync(FIXTURE, 'utf8'));
        expect(cases.map(c => c.name)).toEqual(SPECS.map(s => s.name));
    });

    it('selects the reference indices, with and without the pyramid', () => {
        const { cases } = JSON.parse(readFileSync(FIXTURE, 'utf8'));
        for (const ref of cases) {
            const spec = SPECS.find(s => s.name === ref.name);
            expect(runCase(spec, false), ref.name).toEqual(ref.expected);
            expect(runCase(spec, true), ref.name).toEqual(ref.expected);
        }
    });
});
