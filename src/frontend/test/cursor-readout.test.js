import { describe, it, expect, beforeEach, vi } from 'vitest';
import { S } from '../src/core/state.js';
import { updateCursorReadout } from '../src/eda/cursors.js';

// Table de mesure A / B / delta de la legende: les cellules sont resolues une fois par
// table (cursors.js: readoutCellsOf) et les largeurs de colonnes deduites des textes
// ecrits. Ces tests figent le resultat visible: memes textes et memes largeurs qu'une
// relecture complete du DOM.

function cell(cls, text, attrs = {}) {
    const el = document.createElement('span');
    el.className = cls;
    el.textContent = text;
    Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
    return el;
}

function buildTable(signals, withTimeRow) {
    const table = document.createElement('div');
    table.className = 'legend-table';
    if (withTimeRow) {
        table.append(cell('ct-val ct-a', '-', { 'data-time': 'a' }), cell('ct-val ct-b', '-', { 'data-time': 'b' }),
            cell('ct-val ct-d', '-', { 'data-time': 'd' }), cell('ct-unit', 's'));
    }
    signals.forEach(({ idx, unit }) => {
        const row = document.createElement('div');
        row.className = 'legend-row';
        row.append(cell('ct-val ct-a', '-', { 'data-sig': idx, 'data-col': 'a' }),
            cell('ct-val ct-b', '-', { 'data-sig': idx, 'data-col': 'b' }),
            cell('ct-val ct-d', '-', { 'data-sig': idx, 'data-col': 'd' }), cell('ct-unit', unit));
        table.appendChild(row);
    });
    return table;
}

function buildPlot(id, signals, withTimeRow) {
    const element = document.createElement('div');
    const legend = document.createElement('div');
    legend.className = 'plot-legend';
    legend.appendChild(buildTable(signals, withTimeRow));
    element.appendChild(legend);
    const cachedData = {};
    signals.forEach(({ idx, scale }) => {
        cachedData[idx] = {
            timestamps: Float64Array.from([0, 1, 2, 3, 4]),
            values: Float32Array.from([0, 1, 2, 3, 4].map(v => v * scale)),
            unit: 'x',
        };
    });
    return { id, element, signals: signals.map(s => s.idx), cachedData, chart: { posToVal: x => x * 0.01 } };
}

// Largeurs de colonnes recalculees par relecture complete du DOM (l'ancienne methode).
function columnsFromDom(wrapper) {
    const max = (selector, min) => String(Math.max(min,
        ...[...wrapper.querySelectorAll(`.legend-table.cursors-active ${selector}`)].map(c => c.textContent.length)));
    return {
        a: max('.ct-val.ct-a', 1), b: max('.ct-val.ct-b', 1), d: max('.ct-val.ct-d', 1), unit: max('.ct-unit', 4),
    };
}

function columnsFromStyle(wrapper) {
    const read = prop => wrapper.style.getPropertyValue(prop);
    return { a: read('--lt-a-ch'), b: read('--lt-b-ch'), d: read('--lt-d-ch'), unit: read('--lt-unit-ch') };
}

describe('table de mesure des curseurs', () => {
    let wrapper;
    let frames;
    const flush = () => { while (frames.length) frames.shift()(); };
    const text = (plot, sel) => plot.element.querySelector(sel).textContent;

    beforeEach(() => {
        frames = [];
        vi.stubGlobal('requestAnimationFrame', cb => frames.push(cb));
        document.body.innerHTML = '<div class="plots-wrapper"></div>';
        wrapper = document.querySelector('.plots-wrapper');
        S.signalsInfo = [];
        S.runs = [];
        S.cursorLock = false;
        S.plots = [
            buildPlot(1, [{ idx: 3, unit: 'km/h', scale: 1 }, { idx: 12, unit: 'rpm', scale: 1500 }], true),
            buildPlot(2, [{ idx: 7, unit: 'bar_abs', scale: 0.001 }], false),
        ];
        S.plots.forEach(p => wrapper.appendChild(p.element));
    });

    it('ecrit temps, valeurs et ecarts dans les cellules de chaque signal', () => {
        S.cursor1 = 1;
        S.cursor2 = 3;
        S.plots.forEach(updateCursorReadout);
        const [first, second] = S.plots;
        expect(text(first, '[data-time="a"]')).toBe('1.000');
        expect(text(first, '[data-time="d"]')).toBe('2.000');
        expect(text(first, '[data-sig="3"][data-col="a"]')).toBe('1.00');
        expect(text(first, '[data-sig="12"][data-col="b"]')).toBe('4500.00');
        expect(text(first, '[data-sig="12"][data-col="d"]')).toBe('3000.0');
        expect(text(second, '[data-sig="7"][data-col="d"]')).toBe('0.0020');
    });

    it('donne aux colonnes la largeur de leur plus long texte, tous panneaux confondus', () => {
        S.cursor1 = 1;
        S.cursor2 = 3;
        S.plots.forEach(updateCursorReadout);
        flush();
        expect(columnsFromStyle(wrapper)).toEqual(columnsFromDom(wrapper));
        expect(columnsFromStyle(wrapper)).toEqual({ a: '7', b: '7', d: '6', unit: '7' });
    });

    it('suit les textes qui raccourcissent quand un curseur est retire', () => {
        S.cursor1 = 1;
        S.cursor2 = 3;
        S.plots.forEach(updateCursorReadout);
        flush();
        S.cursor2 = null;
        S.plots.forEach(updateCursorReadout);
        flush();
        expect(text(S.plots[0], '[data-sig="12"][data-col="b"]')).toBe('-');
        expect(columnsFromStyle(wrapper)).toEqual(columnsFromDom(wrapper));
        expect(columnsFromStyle(wrapper).b).toBe('1');
    });

    it('retrouve les cellules d\'une legende reconstruite', () => {
        S.cursor1 = 1;
        S.cursor2 = 3;
        S.plots.forEach(updateCursorReadout);
        // plot-legend.js remplace la table entiere a chaque rendu de la legende.
        const plot = S.plots[1];
        const legend = plot.element.querySelector('.plot-legend');
        legend.innerHTML = '';
        legend.appendChild(buildTable([{ idx: 7, unit: 'bar_abs' }], false));
        updateCursorReadout(plot);
        expect(text(plot, '[data-sig="7"][data-col="a"]')).toBe('0.00');
        flush();
        expect(columnsFromStyle(wrapper)).toEqual(columnsFromDom(wrapper));
    });

    it('retrouve les cellules d\'une ligne ajoutee en place', () => {
        S.cursor1 = 1;
        S.cursor2 = 3;
        const plot = S.plots[1];
        updateCursorReadout(plot);
        const table = plot.element.querySelector('.legend-table');
        const extra = buildTable([{ idx: 9, unit: 'V' }], false).firstElementChild;
        table.appendChild(extra);
        plot.signals.push(9);
        plot.cachedData[9] = plot.cachedData[7];
        updateCursorReadout(plot);
        expect(text(plot, '[data-sig="9"][data-col="a"]')).toBe('0.00');
    });
});
