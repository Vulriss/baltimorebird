import { describe, it, expect } from 'vitest';
import { parseQuery, rankEntries, syncSearchIndex } from '../src/eda/signal-search.js';

// Benchmark: 20 000 noms synthetiques au format auto, chemin complet d'une frappe
// (resynchronisation de l'index + analyse + classement). Budget: 16 ms.
const PARTS = [
  'Veh', 'Eng', 'Whl', 'Brk', 'Ped', 'Spd', 'Trq', 'Temp', 'Cool', 'Oil', 'Press', 'Gear', 'Clutch',
  'Batt', 'Volt', 'Curr', 'Soc', 'Acc', 'Yaw', 'Rate', 'Lat', 'Long', 'Steer', 'Ang', 'Req', 'Act',
  'Flt', 'Raw', 'Stat', 'Cnt', 'Crc', 'Mode', 'Lim', 'Max', 'Min', 'Des', 'Tgt', 'Inv', 'Mot', 'Hv',
];
const UNITS = ['kph', 'rpm', 'nm', 'degc', 'bar', 'v', 'a', 'pct', 'deg', 'ms'];
const SEPS = ['_', '.', ''];

function makeNames(count) {
  let seed = 12345;
  const rnd = (n) => {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
    return (seed >>> 16) % n;
  };
  const names = [];
  for (let i = 0; i < count; i++) {
    const k = 2 + rnd(4);
    let name = '';
    for (let j = 0; j < k; j++) name += PARTS[rnd(PARTS.length)];
    if (rnd(3)) name += SEPS[rnd(SEPS.length)] + UNITS[rnd(UNITS.length)];
    if (!rnd(5)) name = `CAN${rnd(4)}.${name}[${rnd(8)}]`;
    names.push(name);
  }
  return names;
}

const QUERIES = ['v', 've', 'veh', 'vehs', 'vehsp', 'vehspd', 'vspd', 'spd', 'spd -veh', 'eng trq', 'vhespd',
  'whlspdfl', 'zzzq', 'can1 temp'];

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

describe('performance', () => {
  it('moins de 16 ms par frappe sur 20 000 signaux', () => {
    const signals = makeNames(20000).map((name, index) => ({ name, index }));
    expect(new Set(signals.map((s) => s.name)).size).toBeGreaterThan(19000);

    let t0 = performance.now();
    let index = syncSearchIndex(null, signals);
    const buildMs = performance.now() - t0;

    const results = [];
    for (const q of QUERIES) {
      const times = [];
      let count = 0;
      for (let r = 0; r < 15; r++) {
        t0 = performance.now();
        index = syncSearchIndex(index, signals);
        count = rankEntries(index, parseQuery(q), (i) => i % 500 === 0).length;
        times.push(performance.now() - t0);
      }
      results.push({ q, count, medianMs: +median(times.slice(3)).toFixed(2), maxMs: +Math.max(...times.slice(3)).toFixed(2) });
    }
    console.log(`index initial: ${buildMs.toFixed(1)} ms`);
    console.table(results);
    for (const r of results) expect(r.medianMs).toBeLessThan(16);
  });
});
