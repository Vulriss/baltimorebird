import { describe, it, expect } from 'vitest';
import { hexToRgb, rgbToHsv, hsvToHex } from '../src/eda/color-utils.js';

describe('color-utils', () => {
  // Couleurs couvrant les deux palettes (Mocha + Latte) + primaires + extrêmes
  const colors = [
    '#f38ba8', '#89b4fa', '#a6e3a1', '#cba6f7',   // Mocha
    '#d20f39', '#1e66f5', '#40a02b', '#8839ef',   // Latte
    '#ff0000', '#00ff00', '#0000ff',              // primaires
    '#ffffff', '#000000', '#808080',              // gris
    '#123456', '#fedcba',                         // arbitraires
  ];

  it('fait un aller-retour hex -> HSV -> hex exact', () => {
    for (const hex of colors) {
      const { r, g, b } = hexToRgb(hex);
      const { h, s, v } = rgbToHsv(r, g, b);
      expect(hsvToHex(h, s, v)).toBe(hex);
    }
  });

  it('accepte la forme courte #abc', () => {
    expect(hexToRgb('#abc')).toEqual({ r: 170, g: 187, b: 204 });
  });

  it('tolère l\'absence de # et les espaces', () => {
    expect(hexToRgb('  ff0000 ')).toEqual({ r: 255, g: 0, b: 0 });
  });

  it('retourne null sur une entrée invalide', () => {
    expect(hexToRgb('zzz')).toBeNull();
    expect(hexToRgb('#12345')).toBeNull();
    expect(hexToRgb('')).toBeNull();
    expect(hexToRgb(null)).toBeNull();
  });

  it('rgbToHsv : rouge pur = teinte 0, saturation 1', () => {
    expect(rgbToHsv(255, 0, 0)).toMatchObject({ h: 0, s: 1, v: 1 });
  });

  it('rgbToHsv : gris = saturation 0', () => {
    expect(rgbToHsv(128, 128, 128).s).toBe(0);
  });

  it('hsvToHex : borne haute de teinte (359.999) reste rouge', () => {
    expect(hsvToHex(359.999, 1, 1)).toBe('#ff0000');
  });

  it('hsvToHex : valeur 0 = noir quelle que soit la teinte', () => {
    expect(hsvToHex(200, 0.5, 0)).toBe('#000000');
  });
});
