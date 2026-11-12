import { describe, it, expect } from 'vitest';
import { findInterpCall, formatInterpCall, parseInterpTable, tableToText } from '../src/eda/interp-table.js';

// Table d'interpolation d'une variable calculee: lecture d'un tableau colle, ecriture de
// l'appel interp1d dans la formule et relecture pour le corriger.

describe('parseInterpTable', () => {
    it('lit deux colonnes separees par des tabulations (collage d\'un tableur)', () => {
        expect(parseInterpTable('0\t0\n1000\t12.5\n3000\t48'))
            .toEqual({ x: [0, 1000, 3000], y: [0, 12.5, 48], error: null });
    });

    it('accepte la virgule decimale avec un point-virgule ou une tabulation', () => {
        expect(parseInterpTable('0,5;1,25\n2,5;-3').x).toEqual([0.5, 2.5]);
        expect(parseInterpTable('0,5;1,25\n2,5;-3').y).toEqual([1.25, -3]);
        expect(parseInterpTable('0,5\t1e3\n1,5\t2e3').y).toEqual([1000, 2000]);
    });

    it('accepte des espaces ou une virgule comme separateur', () => {
        expect(parseInterpTable('0 1\n2   3').y).toEqual([1, 3]);
        expect(parseInterpTable('0,1\n2,3').x).toEqual([0, 2]);
    });

    it('ignore une ligne d\'en-tete et les lignes vides, et trie par x', () => {
        const parsed = parseInterpTable('regime\tcouple\n\n3000\t48\n0\t0\n1000\t12.5\n');
        expect(parsed.error).toBe(null);
        expect(parsed.x).toEqual([0, 1000, 3000]);
        expect(parsed.y).toEqual([0, 12.5, 48]);
    });

    it('refuse une table mal formee, en disant pourquoi', () => {
        expect(parseInterpTable('1\t2').error).toMatch(/2 points/);
        expect(parseInterpTable('1\t2\nabc\t3').error).toMatch(/Ligne 2/);
        expect(parseInterpTable('1\t2\n1\t3').error).toMatch(/deux fois/);
        expect(parseInterpTable('1\t2\t3\n4\t5\t6').error).toMatch(/Ligne 1/);
        const long = Array.from({ length: 501 }, (_, i) => `${i}\t${i}`).join('\n');
        expect(parseInterpTable(long).error).toMatch(/max 500/);
    });
});

describe('appel interp1d dans la formule', () => {
    it('ecrit un appel que le serveur sait evaluer', () => {
        expect(formatInterpCall(' A ', [0, 1000], [0, 12.5])).toBe('interp1d(A, [0, 1000], [0, 12.5])');
    });

    it('relit la table d\'une formule pour la rouvrir dans l\'editeur', () => {
        const formula = 'B * interp1d(A * 2, [0, 1000, 3000], [0, 12.5, -48]) + 1';
        const found = findInterpCall(formula);
        expect(found.text).toBe('interp1d(A * 2, [0, 1000, 3000], [0, 12.5, -48])');
        expect(found.input).toBe('A * 2');
        expect(found.x).toEqual([0, 1000, 3000]);
        expect(found.y).toEqual([0, 12.5, -48]);
        expect(parseInterpTable(tableToText(found.x, found.y))).toEqual({ x: found.x, y: found.y, error: null });
    });

    it('ne trouve rien sans appel bien forme', () => {
        expect(findInterpCall('A + B')).toBe(null);
        expect(findInterpCall('interp1d(A, [0, 1], [0])')).toBe(null);
    });
});
