import { describe, it, expect, afterEach } from 'vitest';
import {
  PRESET_COLORS_DARK, PRESET_COLORS_LIGHT, nextPresetColor, presetColorForSignal, presetColorTaken, presetColors,
  presetSlot, themedPresetColor,
} from '../src/eda/color-presets.js';

// Garde-fous de la palette d'acces rapide: ecart perceptuel minimal (OKLab x100) entre
// couleurs de la palette, en vision normale et sous daltonisme simule
// (Machado et al. 2009, severite 1.0), et contraste WCAG sur le fond des graphes.
// Les seuils sont les valeurs mesurees a l'adoption, arrondies vers le bas.

const BG_DARK = '#1e1e2e';
const BG_LIGHT = '#fdfdfd';

const CVD = {
  normal: null,
  protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
  tritanopia: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.303900]],
};

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearRgb = (hex) => [1, 3, 5].map((i) => toLinear(parseInt(hex.slice(i, i + 2), 16) / 255));
const simulate = (rgb, m) => (m ? m.map((r) => Math.min(1, Math.max(0, r[0] * rgb[0] + r[1] * rgb[1] + r[2] * rgb[2]))) : rgb);

function oklab([r, g, b]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function deltaE(a, b, m) {
  const x = oklab(simulate(linearRgb(a), m));
  const y = oklab(simulate(linearRgb(b), m));
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) * 100;
}

function minDeltaE(colors, m) {
  let min = Infinity;
  for (let i = 0; i < colors.length; i++) {
    for (let j = i + 1; j < colors.length; j++) min = Math.min(min, deltaE(colors[i], colors[j], m));
  }
  return min;
}

function contrast(a, b) {
  const lum = (hex) => {
    const [r, g, b2] = linearRgb(hex);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b2;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const THEMES = {
  sombre: {
    colors: PRESET_COLORS_DARK, bg: BG_DARK,
    minDelta: { normal: 12.9, protanopia: 10.2, deuteranopia: 9.1, tritanopia: 6.9 },
    lowContrastAllowed: [],
  },
  clair: {
    colors: PRESET_COLORS_LIGHT, bg: BG_LIGHT,
    minDelta: { normal: 12.9, protanopia: 10.9, deuteranopia: 9.1, tritanopia: 8.6 },
    // Olive et cyan Petroff d'origine: clairs par construction (discrimination par la
    // luminosite), gardes tels quels au profit de la distinction sous daltonisme.
    lowContrastAllowed: ['#adad7d', '#86c8dd'],
  },
};

describe.each(Object.entries(THEMES))('palette %s', (_, theme) => {
  it('8 couleurs hex minuscules, sans doublon', () => {
    expect(theme.colors).toHaveLength(8);
    for (const c of theme.colors) expect(c).toMatch(/^#[0-9a-f]{6}$/);
    expect(new Set(theme.colors).size).toBe(8);
  });

  it.each(Object.keys(CVD))('couleurs distinctes en vision %s', (mode) => {
    expect(minDeltaE(theme.colors, CVD[mode])).toBeGreaterThanOrEqual(theme.minDelta[mode]);
  });

  it('contraste >= 3 sur le fond des graphes (hors exceptions documentées)', () => {
    for (const c of theme.colors) {
      if (theme.lowContrastAllowed.includes(c)) continue;
      expect(contrast(c, theme.bg), c).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('presetColors', () => {
  afterEach(() => document.documentElement.removeAttribute('data-theme'));

  it('suit le thème courant', () => {
    expect(presetColors()).toBe(PRESET_COLORS_DARK);
    document.documentElement.setAttribute('data-theme', 'light');
    expect(presetColors()).toBe(PRESET_COLORS_LIGHT);
  });
});

describe('presetSlot et themedPresetColor', () => {
  it('retrouve la case quel que soit le thème et la casse', () => {
    expect(presetSlot('#275aff')).toBe(0);
    expect(presetSlot('#1845FB')).toBe(0);
    expect(presetSlot('#656364')).toBe(7);
    expect(presetSlot('#123456')).toBe(-1);
    expect(presetSlot(undefined)).toBe(-1);
  });

  it('transpose une couleur de palette vers la même case de l\'autre thème', () => {
    PRESET_COLORS_DARK.forEach((c, i) => {
      expect(themedPresetColor(c, true)).toBe(PRESET_COLORS_LIGHT[i]);
      expect(themedPresetColor(PRESET_COLORS_LIGHT[i], false)).toBe(c);
    });
  });

  it('laisse intactes les couleurs hors palette', () => {
    expect(themedPresetColor('#123456', true)).toBe('#123456');
    expect(themedPresetColor('hsl(120, 70%, 55%)', false)).toBe('hsl(120, 70%, 55%)');
  });
});

describe('nextPresetColor', () => {
  it('graphe vide: première couleur de la séquence', () => {
    expect(nextPresetColor([], false)).toBe(PRESET_COLORS_DARK[0]);
    expect(nextPresetColor([], true)).toBe(PRESET_COLORS_LIGHT[0]);
  });

  it('huit dépôts successifs donnent les 8 couleurs dans l\'ordre', () => {
    const used = [];
    for (let i = 0; i < 8; i++) used.push(nextPresetColor(used, false));
    expect(used).toEqual(PRESET_COLORS_DARK);
  });

  it('une case libérée est reprise en premier', () => {
    const used = PRESET_COLORS_DARK.filter((_, i) => i !== 3);
    expect(nextPresetColor(used, false)).toBe(PRESET_COLORS_DARK[3]);
  });

  it('au-delà de 8: la case la moins utilisée, la première à égalité', () => {
    const used = [...PRESET_COLORS_DARK, PRESET_COLORS_DARK[0], PRESET_COLORS_DARK[1]];
    expect(nextPresetColor(used, false)).toBe(PRESET_COLORS_DARK[2]);
  });

  it('compte une couleur de l\'autre thème dans sa case, ignore les couleurs hors palette', () => {
    expect(nextPresetColor([PRESET_COLORS_LIGHT[0], '#123456'], false)).toBe(PRESET_COLORS_DARK[1]);
  });
});

describe('presetColorForSignal (portée onglet)', () => {
  const [c0, c1, c2, c3] = PRESET_COLORS_DARK;
  const plot = (styles) => ({
    signals: Object.keys(styles).map(Number),
    signalStyles: Object.fromEntries(Object.entries(styles).map(([k, color]) => [k, { color }])),
  });

  it('4 signaux dans 4 graphes: 4 couleurs différentes', () => {
    const plots = [];
    for (let idx = 0; idx < 4; idx++) {
      const p = { signals: [], signalStyles: {} };
      plots.push(p);
      p.signalStyles[idx] = { color: presetColorForSignal(plots, p, idx, false) };
      p.signals.push(idx);
    }
    expect(plots.map((p, i) => p.signalStyles[i].color)).toEqual([c0, c1, c2, c3]);
  });

  it('compte les couleurs de tous les graphes de l\'onglet', () => {
    const a = plot({ 10: c0, 11: c1 });
    const b = plot({ 12: c2 });
    const dest = plot({});
    expect(presetColorForSignal([a, b, dest], dest, 20, false)).toBe(c3);
  });

  it('un signal déjà tracé ailleurs dans l\'onglet garde sa couleur', () => {
    const a = plot({ 10: c0, 11: c2 });
    const dest = plot({ 12: c1 });
    expect(presetColorForSignal([a, dest], dest, 11, false)).toBe(c2);
  });

  it('couleur prise: un autre signal oui, le même signal dans un autre graphe non', () => {
    const a = plot({ 10: c0 });
    const b = plot({ 11: c1 });
    expect(presetColorTaken([a, b], 11, c0)).toBe(true);
    expect(presetColorTaken([a, b], 10, c0)).toBe(false);
    expect(presetColorTaken([a, b], 11, '#123456')).toBe(false);
  });
});
