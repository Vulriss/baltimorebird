import { describe, it, expect } from 'vitest';
import { buildMinMaxPyramid, pyramidSelect, scanSelect } from '../src/eda/minmax-pyramid.js';

// Signal de reference: porteuse lente + oscillation dense, plus un pic isole. Le pic est ce
// qu'une decimation par pas regulier perdrait et qu'une emission M4 doit conserver.
const N = 300000;
const SPIKE = 231457;

function buildSignal() {
    const values = new Float32Array(N);
    for (let i = 0; i < N; i++) values[i] = Math.sin(i / 5000) * 100 + Math.sin(i / 7) * 2;
    values[SPIKE] = 10000;
    return values;
}

function envelope(values, indices) {
    let min = Infinity, max = -Infinity;
    for (const i of indices) {
        const v = values[i];
        if (v < min) min = v;
        if (v > max) max = v;
    }
    return [min, max];
}

function windowEnvelope(values, start, end) {
    let min = Infinity, max = -Infinity;
    for (let i = start; i <= end; i++) {
        const v = values[i];
        if (v < min) min = v;
        if (v > max) max = v;
    }
    return [min, max];
}

describe('scanSelect', () => {
    const values = buildSignal();
    const maxPts = 2048;

    it('rend la main quand la fenêtre tient déjà dans le budget', () => {
        expect(scanSelect(values, 0, maxPts - 1, maxPts)).toBeNull();
    });

    it('respecte le budget de points sur une fenêtre de plusieurs centaines de milliers de points', () => {
        const selection = scanSelect(values, 0, N - 1, maxPts);
        expect(selection.length).toBeLessThanOrEqual(maxPts);
    });

    it('émet des indices strictement croissants et bornés à la fenêtre', () => {
        const start = 1000, end = N - 5000;
        const selection = scanSelect(values, start, end, maxPts);
        expect(selection[0]).toBeGreaterThanOrEqual(start);
        expect(selection[selection.length - 1]).toBeLessThanOrEqual(end);
        for (let i = 1; i < selection.length; i++) {
            expect(selection[i]).toBeGreaterThan(selection[i - 1]);
        }
    });

    it('conserve exactement l\'enveloppe de la fenêtre', () => {
        const selection = scanSelect(values, 0, N - 1, maxPts);
        expect(envelope(values, selection)).toEqual(windowEnvelope(values, 0, N - 1));
    });

    it('conserve un pic isolé', () => {
        const selection = scanSelect(values, 0, N - 1, maxPts);
        expect(selection).toContain(SPIKE);
    });

    it('donne la même enveloppe que la pyramide', () => {
        const pyramid = buildMinMaxPyramid(values);
        const viaScan = envelope(values, scanSelect(values, 0, N - 1, maxPts));
        const viaPyramid = envelope(values, pyramidSelect(pyramid, values, 0, N - 1, maxPts));
        expect(viaScan).toEqual(viaPyramid);
    });
});
