import { describe, it, expect } from 'vitest';
import { flexWeight, isFixedFlex } from '../src/eda/plots.js';

// Hauteur des panneaux apres un glisser de splitter: des poids flex, jamais des pixels.
// Une hauteur figee en pixels ne suit plus la zone des graphes et la fait deborder
// (ascenseur) des qu'elle perd de la hauteur.

describe('flexWeight', () => {
    it('donne un poids proportionnel a la hauteur, 1 pour la hauteur moyenne', () => {
        expect(flexWeight(300, 300)).toBe('1 1 0px');
        expect(flexWeight(450, 300)).toBe('1.5 1 0px');
        expect(flexWeight(150, 300)).toBe('0.5 1 0px');
    });

    it('laisse le panneau retrecir et repart d\'une base nulle', () => {
        const [, shrink, basis] = flexWeight(123.66, 232.9).split(' ');
        expect(shrink).toBe('1');
        expect(basis).toBe('0px');
    });

    it('conserve les proportions de hauteurs fractionnaires', () => {
        const heights = [123.66, 342.14];
        const mean = (heights[0] + heights[1]) / 2;
        const weights = heights.map(h => parseFloat(flexWeight(h, mean)));
        expect(weights[0] / weights[1]).toBeCloseTo(heights[0] / heights[1], 3);
        expect(weights[0] + weights[1]).toBeCloseTo(2, 3);
    });

    it('se lit comme un ratio a l\'enregistrement du layout (parseFloat)', () => {
        expect(parseFloat(flexWeight(450, 300))).toBe(1.5);
    });

    it('retombe sur le poids par defaut sans hauteur moyenne', () => {
        expect(flexWeight(200, 0)).toBe('1 1 0px');
    });
});

describe('isFixedFlex', () => {
    const el = flex => {
        const div = document.createElement('div');
        div.style.flex = flex;
        return div;
    };

    it('reconnait la hauteur fixe des strips booleen et commentaires', () => {
        expect(isFixedFlex(el('0 0 88px'))).toBe(true);
        expect(isFixedFlex(el('0 0 64px'))).toBe(true);
    });

    it('laisse les panneaux a hauteur libre dans la repartition', () => {
        expect(isFixedFlex(el('1'))).toBe(false);
        expect(isFixedFlex(el('1.5 1 0px'))).toBe(false);
    });
});
