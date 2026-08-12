import { describe, it, expect } from 'vitest';
import { extractBoolHighRanges } from '../src/eda/bool-zones.js';

// Cette fonction est la source de vérité du front pour découper un booléen en
// zones HIGH ; le backend zone-stats en fait un portage numpy vérifié identique.
// On la fige ici pour que toute modification casse un test plutôt que le rendu.
describe('extractBoolHighRanges', () => {
  const ts = (n) => Array.from({ length: n }, (_, i) => i / 10);

  it('extrait deux zones distinctes', () => {
    const v = [0, 0, 1, 1, 0, 0, 1, 1, 1, 0];
    expect(extractBoolHighRanges(ts(10), v)).toEqual([[0.2, 0.4], [0.6, 0.9]]);
  });

  it('gère une zone qui commence à t0', () => {
    const v = [1, 1, 0, 0, 1];
    // commence high (0 -> 0.2) et finit high (0.4 -> dernier ts 0.4)
    expect(extractBoolHighRanges(ts(5), v)).toEqual([[0, 0.2], [0.4, 0.4]]);
  });

  it('tout high = une seule zone couvrant tout', () => {
    expect(extractBoolHighRanges(ts(3), [1, 1, 1])).toEqual([[0, 0.2]]);
  });

  it('tout low = aucune zone', () => {
    expect(extractBoolHighRanges(ts(3), [0, 0, 0])).toEqual([]);
  });

  it('respecte un seuil personnalisé', () => {
    const v = [0, 0.3, 0.7, 0.3, 0];
    expect(extractBoolHighRanges(ts(5), v, 0.5)).toEqual([[0.2, 0.3]]);
    expect(extractBoolHighRanges(ts(5), v, 0.2)).toEqual([[0.1, 0.4]]);
  });

  it('séquence vide', () => {
    expect(extractBoolHighRanges([], [])).toEqual([]);
  });
});
