import { describe, it, expect, beforeEach } from 'vitest';
import { S } from '../src/core/state.js';
import { ectx } from '../src/eda/context.js';
import { boolZonesPlugin, purgeExtendedZonesForPlots, refreshBoolZoneRanges } from '../src/eda/bool-zones.js';

// Le decoupage lui-meme est fige dans bool-zones.test.js. Ici on verrouille la gestion
// d'etat autour: les plages suivent le cache du panneau quand il est rafraichi, et une
// entree dont le signal n'est plus affiche ne se dessine pas.

function plotWith(signals) {
    return { id: 'p1', signals };
}

function fakeChart() {
    const rects = [];
    return {
        rects,
        ctx: { fillStyle: '', fillRect: (...args) => rects.push(args) },
        bbox: { left: 0, top: 0, width: 100, height: 50 },
        valToPos: value => value,
    };
}

describe('etat des zones booleennes', () => {
    beforeEach(() => {
        ectx.extendedBoolZones.clear();
        ectx.disabledBoolZones.clear();
        S.plots = [];
        S.tabs = [];
    });

    it('recalcule les plages depuis le cache rafraichi', () => {
        ectx.extendedBoolZones.set(7, { color: '#fff', plotId: 'p1', ranges: [[0, 1]] });

        refreshBoolZoneRanges(7, { timestamps: [0, 1, 2, 3], values: [0, 1, 1, 0] });

        expect(ectx.extendedBoolZones.get(7).ranges).toEqual([[1, 3]]);
    });

    it('ignore un signal dont les zones ne sont pas activees', () => {
        refreshBoolZoneRanges(9, { timestamps: [0, 1], values: [1, 1] });

        expect(ectx.extendedBoolZones.has(9)).toBe(false);
    });

    it('purge les zones et les desactivations des panneaux detruits', () => {
        ectx.extendedBoolZones.set(1, { color: '#fff', plotId: 'p1', ranges: [] });
        ectx.disabledBoolZones.add(2);

        purgeExtendedZonesForPlots([plotWith([1, 2])]);

        expect(ectx.extendedBoolZones.has(1)).toBe(false);
        expect(ectx.disabledBoolZones.has(2)).toBe(false);
    });

    it('supporte un panneau sans signaux', () => {
        expect(() => purgeExtendedZonesForPlots([{ id: 'p2' }, null])).not.toThrow();
    });

    it('dessine la zone d\'un signal encore affiche', () => {
        ectx.extendedBoolZones.set(3, { color: '#fff', plotId: 'p1', ranges: [[10, 20]] });
        S.plots = [plotWith([3])];
        const chart = fakeChart();

        boolZonesPlugin().hooks.drawClear(chart);

        expect(chart.rects).toEqual([[10, 0, 10, 50]]);
    });

    it('dessine la zone d\'un signal porte par un autre onglet', () => {
        ectx.extendedBoolZones.set(3, { color: '#fff', plotId: 'p1', ranges: [[10, 20]] });
        S.plots = [plotWith([4])];
        S.tabs = [{ id: 't1', plots: [plotWith([3])] }, { id: 't2', plots: S.plots }];
        const chart = fakeChart();

        boolZonesPlugin().hooks.drawClear(chart);

        expect(chart.rects).toEqual([[10, 0, 10, 50]]);
    });

    it('ne dessine pas la zone d\'un signal retire de tous les onglets', () => {
        ectx.extendedBoolZones.set(3, { color: '#fff', plotId: 'p1', ranges: [[10, 20]] });
        S.plots = [plotWith([4])];
        S.tabs = [{ id: 't1', plots: S.plots }];
        const chart = fakeChart();

        boolZonesPlugin().hooks.drawClear(chart);

        expect(chart.rects).toEqual([]);
    });
});
