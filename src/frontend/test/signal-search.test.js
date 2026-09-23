import { describe, it, expect } from 'vitest';
import {
  appendHighlighted, buildEntry, matchRanges, parseQuery, rankEntries, scoreEntry, syncSearchIndex, tokenize,
} from '../src/eda/signal-search.js';

const NAMES = [
  'EngSpd_rpm',
  'VehSpd_kph',
  'VehSpdFlt',
  'WhlSpdFL',
  'BrkPedSpdReq',
  'Crankspd',
  'VehicleSpeedDisplay',
  'VSpdLim',
  'Spd',
  'SpdLimit',
  'CoolantTemp',
  'Wheel.Speed[0]',
];

function search(names, query, pinned) {
  const index = syncSearchIndex(null, names.map((name) => ({ name })));
  const order = rankEntries(index, parseQuery(query), pinned);
  return order.map((i) => names[i]);
}

describe('tokenize', () => {
  it('découpe camelCase et underscore', () => {
    expect(tokenize('VehSpd_kph')).toEqual(['veh', 'spd', 'kph']);
  });

  it('isole un sigle suivi d\'un mot', () => {
    expect(tokenize('ABSSpdFL')).toEqual(['abs', 'spd', 'fl']);
  });

  it('découpe sur point, crochets et frontière chiffres/lettres', () => {
    expect(tokenize('Wheel.Speed[0]')).toEqual(['wheel', 'speed', '0']);
    expect(tokenize('EngT2Cool')).toEqual(['eng', 't', '2', 'cool']);
    expect(tokenize('CAN1_Msg12')).toEqual(['can', '1', 'msg', '12']);
  });

  it('gère nom vide, null et séparateurs seuls', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize(null)).toEqual([]);
    expect(tokenize('__..')).toEqual([]);
  });
});

describe('classement', () => {
  it('vspd place VehSpd* dans les 3 premiers', () => {
    const top3 = search(NAMES, 'vspd').slice(0, 3);
    expect(top3.some((n) => n.startsWith('VehSpd'))).toBe(true);
  });

  it('spd classe VehSpd avant un nom qui contient spd en milieu de token', () => {
    const res = search(NAMES, 'spd');
    expect(res.indexOf('VehSpd_kph')).toBeLessThan(res.indexOf('Crankspd'));
    expect(res.indexOf('VehSpdFlt')).toBeLessThan(res.indexOf('Crankspd'));
  });

  it('exact avant préfixe, préfixe avant début de token', () => {
    const res = search(NAMES, 'spd');
    expect(res[0]).toBe('Spd');
    expect(res[1]).toBe('SpdLimit');
    expect(res.indexOf('SpdLimit')).toBeLessThan(res.indexOf('EngSpd_rpm'));
  });

  it('paliers: sous-chaîne > sous-séquence > faute', () => {
    const q = (s) => parseQuery(s);
    const sub = scoreEntry(buildEntry('Crankspd'), q('spd'));
    const seq = scoreEntry(buildEntry('VehSpd'), q('vspd'));
    const typo = scoreEntry(buildEntry('VehSpd'), q('vhespd'));
    expect(sub).toBeGreaterThan(seq);
    expect(seq).toBeGreaterThan(typo);
    expect(typo).toBeGreaterThan(0);
  });

  it('bonus nom court à palier égal', () => {
    const res = search(['VehSpdDisplayFiltered', 'VehSpd'], 'veh');
    expect(res).toEqual(['VehSpd', 'VehSpdDisplayFiltered']);
  });

  it('multi-termes en ET', () => {
    const res = search(NAMES, 'veh flt');
    expect(res).toEqual(['VehSpdFlt']);
  });

  it('variables épinglées (calculées) toujours en tête', () => {
    const names = ['VehSpd', 'MyVehSpdCalc'];
    const res = search(names, 'vehspd', (i) => i === 1);
    expect(res).toEqual(['MyVehSpdCalc', 'VehSpd']);
  });
});

describe('exclusion', () => {
  it('-terme retire les noms qui le contiennent', () => {
    const res = search(NAMES, 'spd -veh');
    expect(res).not.toContain('VehSpd_kph');
    expect(res).not.toContain('VehSpdFlt');
    expect(res).toContain('EngSpd_rpm');
  });

  it('exclusion seule: tout sauf les exclus, ordre d\'origine', () => {
    const res = search(NAMES, '-spd');
    expect(res).toEqual(NAMES.filter((n) => !n.toLowerCase().includes('spd')));
  });

  it('un tiret isolé est ignoré', () => {
    expect(parseQuery('-').empty).toBe(true);
  });
});

describe('faute de frappe', () => {
  it('tolère transposition, substitution, insertion et omission sur 4+ caractères', () => {
    for (const q of ['vhespd', 'vehspf', 'vehsppd', 'wehspd']) {
      expect(search(['VehSpd_kph', 'CoolantTemp'], q)).toEqual(['VehSpd_kph']);
    }
  });

  it('aucune tolérance sous 4 caractères', () => {
    expect(search(['VehSpd_kph', 'CoolantTemp'], 'spx')).toEqual([]);
  });
});

describe('requête vide et caractères spéciaux', () => {
  it('requête vide ou jokers seuls: liste complète dans l\'ordre', () => {
    for (const q of ['', '   ', '*', ' * ']) {
      const parsed = parseQuery(q);
      expect(parsed.empty).toBe(true);
      expect(search(NAMES, q)).toEqual(NAMES);
    }
  });

  it('* et espaces séparent les termes (usage historique)', () => {
    expect(parseQuery('veh*spd  kph').include).toEqual(['veh', 'spd', 'kph']);
  });

  it('crochets et points recherchés littéralement', () => {
    expect(search(NAMES, 'speed[0]')).toEqual(['Wheel.Speed[0]']);
    expect(search(NAMES, 'wheel.speed')).toEqual(['Wheel.Speed[0]']);
  });

  it('caractères de regex sans erreur', () => {
    expect(() => search(NAMES, '(.*+?^$|\\')).not.toThrow();
  });
});

describe('surlignage', () => {
  it('plages de la correspondance', () => {
    expect(matchRanges(buildEntry('VehSpd_kph'), parseQuery('spd'))).toEqual([3, 6]);
    expect(matchRanges(buildEntry('VehSpd_kph'), parseQuery('vspd'))).toEqual([0, 1, 3, 6]);
  });

  it('fusionne les plages de plusieurs termes', () => {
    expect(matchRanges(buildEntry('VehSpd_kph'), parseQuery('veh spd'))).toEqual([0, 6]);
  });

  it('construit des <mark> sans interpréter de HTML', () => {
    const el = document.createElement('span');
    const name = '<img src=x>Spd';
    const ranges = matchRanges(buildEntry(name), parseQuery('spd'));
    appendHighlighted(el, name, ranges);
    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toBe(name);
    expect(el.querySelector('mark.signal-match').textContent).toBe('Spd');
  });
});

describe('syncSearchIndex', () => {
  it('réutilise les entrées inchangées et recalcule les renommées', () => {
    const signals = [{ name: 'A' }, { name: 'B' }];
    const index = syncSearchIndex(null, signals);
    const first = index[0];
    signals[1].name = 'C';
    const next = syncSearchIndex(index, signals);
    expect(next[0]).toBe(first);
    expect(next[1].name).toBe('C');
  });
});
