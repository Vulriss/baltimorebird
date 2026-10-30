import { describe, it, expect } from 'vitest';
import { layoutToLxf, lxfToLayout } from '../src/eda/lxf.js';

const doc = {
  tabs: [{
    name: 'Moteur',
    plots: [
      { flex: 1, signals: [{ name: 'Rpm', style: { color: '#89b4fa', width: 1.5, dash: '', path: '', fill: '' } }] },
      {
        flex: 2,
        signals: [{
          name: 'Rpm',
          style: { color: '#fab387', width: 2, dash: '2,6', path: 'step', fill: 'zero' },
          transform: { mode: 'integral', window: 75 },
        }],
      },
    ],
  }],
  computed_variables: [
    { name: 'Power', unit: 'W', description: 'a ?> b', formula: 'A * B', source_signals: ['Torque', 'Rpm'], mapping: { A: 'Torque', B: 'Rpm' } },
  ],
};

describe('LXF extension', () => {
  it('round-trips computed variables, mutators and full styles', () => {
    const back = lxfToLayout(layoutToLxf(doc));
    expect(back.computed_variables).toEqual(doc.computed_variables);
    const [raw, integral] = back.tabs[0].plots;
    expect(raw.signals[0]).toEqual({ name: 'Rpm', style: doc.tabs[0].plots[0].signals[0].style });
    expect(integral.signals[0]).toEqual(doc.tabs[0].plots[1].signals[0]);
    expect(integral.flex).toBe(2);
  });

  it('keeps the document a plain LXF for other readers', () => {
    const xml = layoutToLxf(doc);
    const dom = new DOMParser().parseFromString(xml, 'application/xml');
    expect(dom.getElementsByTagName('parsererror').length).toBe(0);
    expect(dom.documentElement.localName).toBe('Layout');
    const curve = dom.getElementsByTagName('LineCurve')[1];
    expect(Array.from(curve.children).map((el) => el.localName)).toEqual(['XInput', 'YInput', 'Line']);
  });

  it('reads legacy LXF files and ignores a malformed extension', () => {
    const legacy = layoutToLxf({ tabs: doc.tabs.map((t) => ({ ...t, plots: [doc.tabs[0].plots[0]] })) });
    expect(legacy).not.toContain('<?baltimorebird');
    expect(lxfToLayout(legacy).computed_variables).toEqual([]);
    const broken = layoutToLxf(doc).replace(/<\?baltimorebird-layout [\s\S]*?\?>/, '<?baltimorebird-layout {oops?>');
    expect(broken).toContain('{oops');
    expect(lxfToLayout(broken).computed_variables).toEqual([]);
  });
});
