import { describe, it, expect } from 'vitest';
import {
    decimateXY, densityGrid, fitView, indexAtTime, indexSpan, mergeBounds, nearestPoint, resampleOnto, windowIndexRange,
    xyBounds,
} from '../src/eda/xy-data.js';

// Graphes X/Y: appariement des echantillons sur la grille du signal X, decimation ecran
// de la trajectoire, cadrage. Fonctions pures de xy-data.js.

const f64 = values => Float64Array.from(values);
const f32 = values => Float32Array.from(values);

describe('windowIndexRange', () => {
    const ts = f64([0, 1, 2, 3, 4, 5]);

    it('ne garde que les echantillons dans la fenetre, bornes comprises', () => {
        expect(windowIndexRange(ts, 1, 3)).toEqual({ i0: 1, i1: 3 });
        expect(windowIndexRange(ts, 0.5, 3.5)).toEqual({ i0: 1, i1: 3 });
    });

    it('rend une plage vide quand aucun echantillon ne tombe dans la fenetre', () => {
        const { i0, i1 } = windowIndexRange(ts, 2.2, 2.8);
        expect(i1).toBeLessThan(i0);
    });
});

describe('indexAtTime', () => {
    it('donne l\'echantillon le plus proche, borne aux extremites', () => {
        const ts = f64([0, 1, 2, 4]);
        expect(indexAtTime(ts, -5)).toBe(0);
        expect(indexAtTime(ts, 1.4)).toBe(1);
        expect(indexAtTime(ts, 3.1)).toBe(3);
        expect(indexAtTime(ts, 99)).toBe(3);
        expect(indexAtTime(f64([]), 1)).toBe(-1);
    });
});

describe('resampleOnto', () => {
    it('rend les valeurs telles quelles sur une grille identique, sans copie', () => {
        const ts = f64([0, 1, 2, 3]);
        const values = f32([5, 6, 7, 8]);
        expect(resampleOnto(ts, f64([0, 1, 2, 3]), values)).toBe(values);
    });

    it('interpole lineairement entre deux echantillons de Y', () => {
        const out = resampleOnto(f64([0, 0.5, 1, 1.5, 2]), f64([0, 1, 2]), f32([0, 10, 30]));
        expect(Array.from(out)).toEqual([0, 5, 10, 20, 30]);
    });

    it('tient la derniere valeur d\'un signal d\'etat', () => {
        const out = resampleOnto(f64([0, 0.5, 1, 1.5, 2]), f64([0, 1, 2]), f32([0, 10, 30]), true);
        expect(Array.from(out)).toEqual([0, 0, 10, 10, 30]);
    });

    it('ne cree pas de point hors de la plage mesuree de Y', () => {
        const out = resampleOnto(f64([0, 1, 2, 3, 4]), f64([1, 3]), f32([10, 30]));
        expect(Number.isNaN(out[0])).toBe(true);
        expect(Array.from(out.subarray(1, 4))).toEqual([10, 20, 30]);
        expect(Number.isNaN(out[4])).toBe(true);
    });

    it('accepte une grille Y bien plus fine que X', () => {
        const tsY = f64(Array.from({ length: 101 }, (_, i) => i / 100));
        const valsY = f32(Array.from({ length: 101 }, (_, i) => i));
        const out = resampleOnto(f64([0, 0.25, 0.5, 1]), tsY, valsY);
        expect(Array.from(out)).toEqual([0, 25, 50, 100]);
    });
});

describe('xyBounds et fitView', () => {
    it('ignore les points sans valeur', () => {
        const b = xyBounds(f32([1, NaN, 3, 5]), f32([10, 20, NaN, 40]), 0, 3);
        expect(b).toEqual({ xMin: 1, xMax: 5, yMin: 10, yMax: 40 });
        expect(xyBounds(f32([NaN]), f32([NaN]), 0, 0)).toBe(null);
    });

    it('reunit les etendues de plusieurs series', () => {
        const merged = mergeBounds([null, { xMin: 0, xMax: 2, yMin: 5, yMax: 6 }, { xMin: 1, xMax: 4, yMin: -1, yMax: 5 }]);
        expect(merged).toEqual({ xMin: 0, xMax: 4, yMin: -1, yMax: 6 });
        expect(mergeBounds([null, null])).toBe(null);
    });

    it('ajoute une marge autour des donnees', () => {
        const view = fitView({ xMin: 0, xMax: 10, yMin: 0, yMax: 100 }, { pad: 0.1 });
        expect(view.x).toEqual({ min: -1, max: 11 });
        expect(view.y).toEqual({ min: -10, max: 110 });
    });

    it('garde une fenetre non nulle pour une valeur constante', () => {
        const view = fitView({ xMin: 5, xMax: 5, yMin: 0, yMax: 0 });
        expect(view.x.max).toBeGreaterThan(view.x.min);
        expect(view.y.max).toBeGreaterThan(view.y.min);
    });

    it('donne la meme echelle aux deux axes en mode 1:1', () => {
        const view = fitView({ xMin: 0, xMax: 10, yMin: 0, yMax: 100 }, { pad: 0, equal: true, width: 400, height: 200 });
        const perPxX = (view.x.max - view.x.min) / 400;
        const perPxY = (view.y.max - view.y.min) / 200;
        expect(perPxX).toBeCloseTo(perPxY);
        // L'axe elargi reste centre sur ses donnees, l'autre n'est pas rogne.
        expect((view.x.min + view.x.max) / 2).toBeCloseTo(5);
        expect(view.y).toEqual({ min: 0, max: 100 });
    });
});

describe('decimateXY', () => {
    const view = { x: { min: 0, max: 100 }, y: { min: 0, max: 100 } };

    it('garde tous les points quand chacun occupe sa cellule', () => {
        const xs = f32([5, 15, 25, 35]);
        const ys = f32([5, 15, 25, 35]);
        const { indices, stride } = decimateXY(xs, ys, 0, 3, view, 10, 10);
        expect(Array.from(indices)).toEqual([0, 1, 2, 3]);
        expect(stride).toBe(1);
    });

    it('reduit un amas a son premier et son dernier point', () => {
        const xs = f32([5, 5.1, 5.2, 5.3, 5.4, 55]);
        const ys = f32([5, 5.1, 5.2, 5.3, 5.4, 55]);
        const { indices } = decimateXY(xs, ys, 0, 5, view, 10, 10);
        expect(Array.from(indices)).toEqual([0, 4, 5]);
    });

    it('reste sous une cellule d\'erreur sur une trajectoire dense', () => {
        const n = 200000;
        const xs = new Float32Array(n);
        const ys = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            const a = (i / n) * Math.PI * 8;
            xs[i] = 50 + 40 * Math.cos(a) * (i / n);
            ys[i] = 50 + 40 * Math.sin(a) * (i / n);
        }
        const cols = 400;
        const { indices } = decimateXY(xs, ys, 0, n - 1, view, cols, cols);
        expect(indices.length).toBeLessThan(n / 10);
        expect(indices[0]).toBe(0);
        expect(indices[indices.length - 1]).toBe(n - 1);
        // Chaque point ecarte est a moins d'une cellule (en X et en Y) du point garde qui
        // le precede: la polyligne decimee ne s'ecarte pas du trace complet de plus que ca.
        const cell = 100 / cols;
        let k = 0;
        let worst = 0;
        for (let i = 0; i < n; i++) {
            while (k + 1 < indices.length && indices[k + 1] <= i) k++;
            const j = indices[k];
            worst = Math.max(worst, Math.abs(xs[i] - xs[j]), Math.abs(ys[i] - ys[j]));
        }
        expect(worst).toBeLessThanOrEqual(cell);
    });

    it('leve le crayon sur un trou de donnees', () => {
        const xs = f32([5, 15, NaN, 45, 55]);
        const ys = f32([5, 15, 25, 45, 55]);
        const { indices } = decimateXY(xs, ys, 0, 4, view, 10, 10);
        expect(Array.from(indices)).toEqual([0, 1, -1, 3, 4]);
    });

    it('confond les points hors de la vue d\'un meme cote', () => {
        const xs = f32([150, 160, 170, 180, 50]);
        const ys = f32([50, 50.5, 51, 51.5, 50]);
        const { indices } = decimateXY(xs, ys, 0, 4, view, 10, 10);
        expect(Array.from(indices)).toEqual([0, 3, 4]);
    });

    it('double le pas d\'echantillonnage plutot que de depasser le budget de points', () => {
        const n = 4096;
        const xs = new Float32Array(n);
        const ys = new Float32Array(n);
        // Bruit: chaque point change de cellule, la decimation seule ne reduit rien.
        for (let i = 0; i < n; i++) {
            xs[i] = (i * 37) % 100;
            ys[i] = (i * 61) % 100;
        }
        const { indices, stride } = decimateXY(xs, ys, 0, n - 1, view, 100, 100, { maxPoints: 500 });
        expect(indices.length).toBeLessThanOrEqual(500 + 4);
        expect(stride).toBeGreaterThan(1);
    });

    it('rend une liste vide pour une fenetre sans echantillon', () => {
        expect(decimateXY(f32([1]), f32([1]), 3, 2, view, 10, 10).indices.length).toBe(0);
    });
});

describe('nearestPoint et indexSpan', () => {
    const xs = f32([0, 10, 20, 30]);
    const ys = f32([0, 10, 20, 30]);
    const identity = v => v;

    it('trouve le point trace le plus proche du pointeur', () => {
        const hit = nearestPoint(xs, ys, Int32Array.from([0, 1, -1, 2, 3]), identity, identity, 19, 22);
        expect(hit.index).toBe(2);
    });

    it('ne rend rien au-dela de la distance maximale', () => {
        expect(nearestPoint(xs, ys, Int32Array.from([0, 1, 2, 3]), identity, identity, 200, 200, 24)).toBe(null);
    });

    it('delimite la plage des indices traces entre deux echantillons', () => {
        const indices = Int32Array.from([0, 4, 9, 15, 22, 30]);
        const { k0, k1 } = indexSpan(indices, 5, 22);
        expect(Array.from(indices.subarray(k0, k1))).toEqual([9, 15, 22]);
    });

    it('delimite la plage malgre des ruptures', () => {
        const indices = Int32Array.from([0, 4, -1, 9, 15, -1, 22, 30]);
        const { k0, k1 } = indexSpan(indices, 5, 22);
        expect(Array.from(indices.subarray(k0, k1)).filter(i => i >= 0)).toEqual([9, 15, 22]);
        const all = indexSpan(indices, 0, 99);
        expect(all.k0).toBe(0);
        expect(all.k1).toBe(indices.length);
    });
});

describe('densityGrid', () => {
    const view = { x: { min: 0, max: 10 }, y: { min: 0, max: 10 } };

    it('compte les echantillons par cellule, ligne 0 en haut', () => {
        const xs = f32([1, 1.5, 9, NaN, 50]);
        const ys = f32([9, 9.5, 1, 5, 5]);
        const { counts, max } = densityGrid(xs, ys, 0, 4, view, 2, 2);
        // Haut gauche: deux points; bas droite: un; point sans valeur et point hors vue: aucun.
        expect(Array.from(counts)).toEqual([2, 0, 0, 1]);
        expect(max).toBe(2);
    });

    it('additionne plusieurs series dans la meme grille', () => {
        const xs = f32([1, 9]);
        const first = densityGrid(xs, f32([9, 1]), 0, 1, view, 2, 2);
        const second = densityGrid(xs, f32([9, 9]), 0, 1, view, 2, 2, { counts: first.counts });
        expect(Array.from(second.counts)).toEqual([2, 1, 0, 1]);
        expect(second.max).toBe(2);
    });
});
