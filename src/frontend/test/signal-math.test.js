import { describe, it, expect } from 'vitest';
import { derivative, gaussianKde, fftMagnitude, savitzkyGolay } from '../src/eda/signal-math.js';

describe('derivative', () => {
  it('dérivée exacte d\'une rampe linéaire = pente constante', () => {
    // y = 3t sur pas régulier -> dérivée 3 partout (schéma exact au 2nd ordre)
    const t = [0, 1, 2, 3, 4];
    const y = t.map((x) => 3 * x);
    const d = derivative(t, y);
    for (const v of d) expect(v).toBeCloseTo(3, 10);
  });

  it('gère un pas irrégulier', () => {
    const t = [0, 0.5, 2];
    const y = [0, 1, 4];   // y = 2t -> pente 2
    const d = derivative(t, y);
    expect(d[0]).toBeCloseTo(2, 10);
    expect(d[2]).toBeCloseTo(2, 10);
  });

  it('renvoie des zéros pour moins de 2 points', () => {
    expect(Array.from(derivative([0], [5]))).toEqual([0]);
  });
});

describe('gaussianKde', () => {
  it('produit une densité normalisée (cdf finit à ~1)', () => {
    const rng = mulberry32(1);
    const values = Array.from({ length: 500 }, () => gauss(rng));
    const { x, density, cdf } = gaussianKde(values);
    expect(x.length).toBeGreaterThan(0);
    expect(density.length).toBe(x.length);
    expect(cdf[cdf.length - 1]).toBeCloseTo(1, 2);
  });

  it('stats exactes : médiane d\'une distribution symétrique proche de la moyenne', () => {
    const values = Array.from({ length: 1001 }, (_, i) => (i - 500) / 100); // -5..5
    const { stats } = gaussianKde(values);
    expect(stats.mean).toBeCloseTo(0, 6);
    expect(stats.median).toBeCloseTo(0, 6);
  });
});

describe('fftMagnitude', () => {
  it('détecte la fréquence dominante d\'une sinusoïde pure', () => {
    // 10 Hz échantillonné à 256 Hz sur 1 s
    const fs = 256, f0 = 10;
    const t = Array.from({ length: fs }, (_, i) => i / fs);
    const y = t.map((x) => Math.sin(2 * Math.PI * f0 * x));
    const { freq, magnitude } = fftMagnitude(t, y);
    let peak = 0;
    for (let i = 1; i < magnitude.length; i++) if (magnitude[i] > magnitude[peak]) peak = i;
    expect(freq[peak]).toBeCloseTo(f0, 0);
  });
});

describe('savitzkyGolay', () => {
  it('préserve une droite (le lissage polynomial ne la déforme pas)', () => {
    const y = Array.from({ length: 100 }, (_, i) => 2 * i + 1);
    const sm = savitzkyGolay(y, 11, 3);
    // Loin des bords, le lissage d'ordre 3 reproduit la droite exactement
    for (let i = 20; i < 80; i++) expect(sm[i]).toBeCloseTo(y[i], 6);
  });
});

// --- utilitaires de test (générateur déterministe) ---
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(rng) {
  // Box-Muller
  return Math.sqrt(-2 * Math.log(rng() || 1e-12)) * Math.cos(2 * Math.PI * rng());
}
