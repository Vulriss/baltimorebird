import { describe, it, expect } from 'vitest';
import { traceEnvelope } from '../src/eda/trace-envelope.js';

// Echantillons a 0, 1, 2, 3, 4 s. La vue [1.2, 3.5] contient 2 et 3; 1 et 4 sont les voisins hors vue.
const XS = [0, 1, 2, 3, 4];
const YS = [0, -10, 5, 6, 20];

function envelope(mode, viewMin = 1.2, viewMax = 3.5, ys = YS) {
    return traceEnvelope(XS, [{ ys, mode, show: true }], viewMin, viewMax);
}

describe('traceEnvelope', () => {
    it('stepped: includes the value held at the left edge, not the right neighbour', () => {
        expect(envelope('stepped')).toEqual({ min: -10, max: 6 });
    });

    it('linear: includes the values interpolated at both edges', () => {
        const env = envelope('linear');
        expect(env.min).toBeCloseTo(-7, 9);
        expect(env.max).toBeCloseTo(13, 9);
    });

    it('points only: visible samples only', () => {
        expect(envelope('none')).toEqual({ min: 5, max: 6 });
    });

    it('handles a view falling between two samples', () => {
        expect(envelope('stepped', 1.2, 1.8)).toEqual({ min: -10, max: -10 });
        const env = envelope('linear', 1.2, 1.8);
        expect(env.min).toBeCloseTo(-7, 9);
        expect(env.max).toBeCloseTo(2, 9);
    });

    it('skips null gaps of the union X grid', () => {
        const ys = [0, -10, null, 6, null];
        expect(envelope('stepped', 1.2, 3.5, ys)).toEqual({ min: -10, max: 6 });
    });

    it('ignores hidden series and returns null when nothing is drawn', () => {
        expect(traceEnvelope(XS, [{ ys: YS, mode: 'linear', show: false }], 1.2, 3.5)).toBeNull();
        expect(traceEnvelope(XS, [{ ys: YS, mode: 'stepped', show: true }], 10, 20)).toBeNull();
        expect(traceEnvelope([], [], 0, 1)).toBeNull();
    });

    it('matches visible samples when the view covers the whole series', () => {
        expect(envelope('linear', -1, 5)).toEqual({ min: -10, max: 20 });
    });
});
