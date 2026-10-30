import { describe, it, expect } from 'vitest';
import {
  exportComputedVariables, formatRestoreFailures, resolveComputedMapping, restoreComputedVariables,
} from '../src/eda/layout-computed.js';

const raw = (...names) => names.map((name) => ({ name }));

// Simule /api/create-variable: enregistre les appels, refuse les noms listes dans `reject`.
function fakeCreate(reject = {}) {
  const calls = [];
  const create = async (cv, mapping) => {
    calls.push({ name: cv.name, mapping });
    return reject[cv.name] ? { ok: false, error: reject[cv.name] } : { ok: true };
  };
  return { calls, create };
}

describe('resolveComputedMapping', () => {
  it('binds each letter to its saved source, whatever the order of creation', () => {
    const cv = { name: 'P', formula: 'A * B', mapping: { A: 'Torque', B: 'Rpm' }, source_signals: ['Rpm', 'Torque'] };
    const { mapping } = resolveComputedMapping(cv, new Set(['Torque', 'Rpm']));
    expect(mapping).toEqual({ A: 'Torque', B: 'Rpm' });
  });

  it('keeps the positional heuristic for legacy layouts', () => {
    const cv = { name: 'P', formula: 'B - A', source_signals: ['Torque', 'Rpm'] };
    expect(resolveComputedMapping(cv, new Set(['Torque', 'Rpm'])).mapping).toEqual({ A: 'Torque', B: 'Rpm' });
  });

  it('reports missing sources', () => {
    const cv = { name: 'P', formula: 'A + B', mapping: { A: 'Torque', B: 'Rpm' } };
    expect(resolveComputedMapping(cv, new Set(['Torque']))).toEqual({ mapping: null, missing: ['Rpm'] });
  });
});

describe('restoreComputedVariables', () => {
  it('creates dependent variables in dependency order', async () => {
    const vars = [
      { name: 'Energy', formula: 'A * 2', mapping: { A: 'Power' } },
      { name: 'Power', formula: 'A * B', mapping: { A: 'Torque', B: 'Rpm' } },
    ];
    const { calls, create } = fakeCreate();
    const result = await restoreComputedVariables(vars, raw('Torque', 'Rpm'), create);
    expect(calls.map((c) => c.name)).toEqual(['Power', 'Energy']);
    expect(result).toEqual({ created: ['Power', 'Energy'], failed: [] });
  });

  it('skips variables already present as computed variables', async () => {
    const { calls, create } = fakeCreate();
    const signals = [...raw('Torque'), { name: 'Double', computed: true }];
    const result = await restoreComputedVariables([{ name: 'Double', formula: 'A * 2', mapping: { A: 'Torque' } }],
      signals, create);
    expect(calls).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  it('reports missing sources, rejected formulas and name conflicts, and keeps their definitions', async () => {
    const missing = { name: 'Missing', formula: 'A', mapping: { A: 'Absent' } };
    const dependent = { name: 'Dependent', formula: 'A + 1', mapping: { A: 'Rejected' } };
    const rejected = { name: 'Rejected', formula: 'A / 0', mapping: { A: 'Torque' } };
    const conflict = { name: 'Torque', formula: 'A', mapping: { A: 'Rpm' } };
    const ok = { name: 'Ok', formula: 'A', mapping: { A: 'Rpm' } };
    const { create } = fakeCreate({ Rejected: 'Formule invalide' });
    const { created, failed } = await restoreComputedVariables([missing, dependent, rejected, conflict, ok],
      raw('Torque', 'Rpm'), create);
    expect(created).toEqual(['Ok']);
    const byName = Object.fromEntries(failed.map((f) => [f.name, f]));
    expect(byName.Torque.reason).toMatch(/nom déjà utilisé/);
    expect(byName.Rejected.reason).toBe('Formule invalide');
    expect(byName.Missing.reason).toBe('signaux absents: Absent');
    expect(byName.Dependent.reason).toBe('signaux absents: Rejected');
    expect(byName.Missing.definition).toBe(missing);
  });
});

describe('exportComputedVariables', () => {
  it('exports the explicit mapping and the unresolved definitions (A to B to A round trip)', async () => {
    const signals = [
      ...raw('Torque'),
      { name: 'Double', computed: true, formula: 'A * 2', unit: 'Nm', mapping: { A: 'Torque' }, source_signals: ['Torque'] },
    ];
    const unresolved = { name: 'Power', formula: 'A * B', mapping: { A: 'Torque', B: 'Rpm' } };
    const exported = exportComputedVariables(signals, [unresolved, { name: 'Double', formula: 'A' }]);
    expect(exported).toEqual([
      { name: 'Double', unit: 'Nm', description: '', formula: 'A * 2', source_signals: ['Torque'], mapping: { A: 'Torque' } },
      unresolved,
    ]);

    const { create } = fakeCreate();
    const onB = await restoreComputedVariables(exported, [...raw('Torque'), signals[1]], create);
    const reExported = exportComputedVariables(signals, onB.failed.map((f) => f.definition));
    expect(reExported.map((cv) => cv.name)).toEqual(['Double', 'Power']);
    expect(reExported[1]).toBe(unresolved);
  });

  it('omits an empty mapping (legacy variable)', () => {
    const [cv] = exportComputedVariables([{ name: 'X', computed: true, formula: 'A', source_signals: ['S'] }], []);
    expect('mapping' in cv).toBe(false);
  });
});

describe('formatRestoreFailures', () => {
  it('lists the affected variables with their reason', () => {
    const msg = formatRestoreFailures([
      { name: 'A1', reason: 'r1' }, { name: 'A2', reason: 'r2' }, { name: 'A3', reason: 'r3' }, { name: 'A4', reason: 'r4' },
    ]);
    expect(msg).toBe('4 variable(s) calculée(s) non recréée(s): A1 (r1); A2 (r2); A3 (r3) (+1)');
    expect(formatRestoreFailures([])).toBe('');
  });
});
