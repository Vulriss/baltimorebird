import { describe, it, expect, beforeEach } from 'vitest';
import { S } from '../src/core/state.js';
import { analysisRange } from '../src/eda/analysis.js';
import { ectx } from '../src/eda/context.js';

// Plage analysee par le panneau KDE/FFT: tout le signal, la fenetre visible, ou
// l'intervalle entre les deux curseurs.

describe('analysisRange', () => {
    const timestamps = Float64Array.from([2, 4, 6, 8, 10]);

    beforeEach(() => {
        ectx.globalView = { min: 3, max: 7 };
        S.cursor1 = null;
        S.cursor2 = null;
    });

    it('couvre tout le signal en cache', () => {
        expect(analysisRange('full', timestamps)).toEqual({ min: 2, max: 10 });
    });

    it('suit la fenetre visible', () => {
        expect(analysisRange('visible', timestamps)).toEqual({ min: 3, max: 7 });
    });

    it('prend l\'intervalle des curseurs, dans l\'ordre du temps', () => {
        S.cursor1 = 9;
        S.cursor2 = 5;
        expect(analysisRange('cursors', timestamps)).toEqual({ min: 5, max: 9 });
    });

    it('retombe sur la fenetre visible sans deux curseurs', () => {
        S.cursor1 = 5;
        expect(analysisRange('cursors', timestamps)).toEqual({ min: 3, max: 7 });
    });
});
