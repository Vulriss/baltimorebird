import { describe, it, expect } from 'vitest';
import { rasterizeColumns, rasterError, sceneErrors } from '@/eda/raster-error.js';

// Grille 4x4: t, y dans [0, 4] -> 1 unite = 1 pixel. Pixel = col * height + row.
const V = { width: 4, height: 4, tMin: 0, tMax: 4, yMin: 0, yMax: 4 };
const sorted = (set) => [...set].sort((a, b) => a - b);

describe('rasterizeColumns', () => {
    it('allume un seul pixel pour un point isole', () => {
        expect(sorted(rasterizeColumns({ t: [0.5], y: [0.5] }, V))).toEqual([0]);
    });

    it('trace une ligne horizontale colonne par colonne', () => {
        const px = rasterizeColumns({ t: [0, 4], y: [2, 2] }, V);
        expect(sorted(px)).toEqual([2, 6, 10, 14]);
    });

    it('remplit la colonne du min au max des y', () => {
        const px = rasterizeColumns({ t: [0.5, 0.6], y: [0.5, 3.5] }, V);
        expect(sorted(px)).toEqual([0, 1, 2, 3]);
    });

    it('inclut les segments reliant deux points consecutifs (colonnes sautees)', () => {
        const px = rasterizeColumns({ t: [0, 4], y: [0, 4] }, V);
        expect(sorted(px)).toEqual([0, 1, 5, 6, 10, 11, 15]);
    });

    it('clippe les segments a la fenetre temporelle', () => {
        expect(rasterizeColumns({ t: [-10, -5], y: [2, 2] }, V).size).toBe(0);
        const px = rasterizeColumns({ t: [-2, 1.5], y: [2, 2] }, V);
        expect(sorted(px)).toEqual([2, 6]);
    });

    it('ramene les y hors plage sur les lignes extremes', () => {
        const px = rasterizeColumns({ t: [0.5], y: [100] }, V);
        expect(sorted(px)).toEqual([3]);
    });

    it('accepte Float64Array et tableaux, et ignore les valeurs non finies', () => {
        const a = rasterizeColumns({ t: new Float64Array([0, 4]), y: new Float64Array([2, 2]) }, V);
        expect(sorted(a)).toEqual([2, 6, 10, 14]);
        const b = rasterizeColumns({ t: [0.5, 1.5, 2.5], y: [1, NaN, 1] }, V);
        expect(sorted(b)).toEqual([1, 9]);
    });

    it('retourne un ensemble vide sans points', () => {
        expect(rasterizeColumns({ t: [], y: [] }, V).size).toBe(0);
    });
});

describe('rasterError', () => {
    it('vaut 0 pour deux ensembles identiques ou deux ensembles vides', () => {
        expect(rasterError(new Set([1, 2, 3]), new Set([1, 2, 3]))).toBe(0);
        expect(rasterError(new Set(), new Set())).toBe(0);
    });

    it('vaut 1 pour des ensembles disjoints ou un ensemble vide face a un non vide', () => {
        expect(rasterError(new Set([1, 2]), new Set([5, 6]))).toBe(1);
        expect(rasterError(new Set([1]), new Set())).toBe(1);
    });

    it('calcule 1 - |inter| / |union| (Jaccard)', () => {
        // inter = {2,3} (2), union = {1,2,3,4} (4) -> 0.5
        expect(rasterError(new Set([1, 2, 3]), new Set([2, 3, 4]))).toBeCloseTo(0.5, 12);
    });

    it('tolerance 1 px verticale: un decalage d\'une ligne n\'est plus une erreur', () => {
        const full = new Set([2, 6, 10]);
        const sub = new Set([3, 7, 11]);
        expect(rasterError(full, sub)).toBe(1);
        expect(rasterError(full, sub, { tolerance: 1, height: 4 })).toBe(0);
        expect(rasterError(full, new Set([4, 8, 12]), { tolerance: 1, height: 4 })).toBe(1);
    });

    it('la tolerance ne franchit pas les bords de colonne quand height est fourni', () => {
        // 3 = (col 0, row 3), 4 = (col 1, row 0): voisins en indice mais pas en pixel
        expect(rasterError(new Set([3]), new Set([4]), { tolerance: 1, height: 4 })).toBe(1);
    });

    it('la tolerance reste dans [0,1] et ne depasse jamais l\'erreur stricte', () => {
        const full = new Set([0, 1, 5, 9, 12]);
        const sub = new Set([1, 6, 9, 13]);
        const strict = rasterError(full, sub);
        const tol = rasterError(full, sub, { tolerance: 1, height: 4 });
        expect(tol).toBeGreaterThanOrEqual(0);
        expect(tol).toBeLessThanOrEqual(strict);
    });
});

describe('sceneErrors', () => {
    it('retourne erreur par panneau, moyenne et pire panneau', () => {
        const panels = [
            { full: new Set([1, 2]), sub: new Set([1, 2]) },       // 0
            { full: new Set([1, 2, 3]), sub: new Set([2, 3, 4]) }, // 0.5
            { full: new Set([1]), sub: new Set() },                // 1
        ];
        const r = sceneErrors(panels);
        expect(r.perPanel).toEqual([0, 0.5, 1]);
        expect(r.mean).toBeCloseTo(0.5, 12);
        expect(r.worst).toBe(1);
    });

    it('gere une scene vide', () => {
        expect(sceneErrors([])).toEqual({ perPanel: [], mean: 0, worst: 0 });
    });

    it('applique la tolerance du panneau', () => {
        const r = sceneErrors([{ full: new Set([2]), sub: new Set([3]), tolerance: 1, height: 4 }]);
        expect(r.perPanel).toEqual([0]);
    });
});

