import { describe, it, expect, beforeEach } from 'vitest';
import { S } from '../src/core/state.js';
import { ectx } from '../src/eda/context.js';
import {
    applyBoolZoneLayoutState, boolZoneLayoutState, boolZonesPlugin, clearBoolZones,
    restoreBoolZones, snapshotBoolZones,
} from '../src/eda/bool-zones.js';

// Conservation des zones booleennes etendues: etat on/off porte par le layout, plages
// photographiees avec l'espace de travail d'un fichier pour le retour sur ce fichier.

const SIGNALS = [
    { index: 0, name: 'Moteur.Tournant' },
    { index: 1, name: 'Frein.Actif' },
    { index: 2, name: 'Regime' },
];

function fakeChart() {
    const rects = [];
    return {
        rects,
        ctx: { fillStyle: '', fillRect: (...args) => rects.push(args) },
        bbox: { left: 0, top: 0, width: 100, height: 50 },
        valToPos: value => value,
    };
}

describe('zones booleennes et layouts', () => {
    beforeEach(() => {
        clearBoolZones();
        S.plots = [];
        S.tabs = [];
        S.signalsInfo = SIGNALS;
    });

    it('exporte l\'etat explicite et rien pour le defaut', () => {
        ectx.extendedBoolZones.set(0, { color: '#f00', plotId: 'p1', ranges: [[1, 2]] });
        ectx.disabledBoolZones.add(1);

        expect(boolZoneLayoutState(0)).toBe(true);
        expect(boolZoneLayoutState(1)).toBe(false);
        expect(boolZoneLayoutState(2)).toBe(null);
    });

    it('met en attente une zone demandee et applique une desactivation', () => {
        ectx.extendedBoolZones.set(1, { color: '#f00', plotId: 'p1', ranges: [] });

        applyBoolZoneLayoutState(0, true);
        applyBoolZoneLayoutState(1, false);
        applyBoolZoneLayoutState(2, undefined);

        expect(ectx.pendingBoolZones.has(0)).toBe(true);
        expect(ectx.extendedBoolZones.has(1)).toBe(false);
        expect(ectx.disabledBoolZones.has(1)).toBe(true);
        expect(ectx.pendingBoolZones.has(2)).toBe(false);
        expect(ectx.disabledBoolZones.has(2)).toBe(false);
    });

    it('ne remet pas en attente une zone deja etendue', () => {
        ectx.extendedBoolZones.set(0, { color: '#f00', plotId: 'p1', ranges: [] });

        applyBoolZoneLayoutState(0, true);

        expect(ectx.pendingBoolZones.has(0)).toBe(false);
    });

    it('fait l\'aller-retour d\'un fichier a l\'autre par nom, plages comprises', () => {
        ectx.extendedBoolZones.set(1, { color: '#0f0', plotId: 'p1', ranges: [[10, 20], [30, 40]] });
        const snapshot = snapshotBoolZones(SIGNALS);

        clearBoolZones();
        // Au retour, la liste du fichier peut avoir change d'ordre: on resout par nom.
        const reordered = [{ index: 5, name: 'Frein.Actif' }, { index: 6, name: 'Regime' }];
        restoreBoolZones(snapshot, reordered);

        expect(ectx.extendedBoolZones.get(5)).toEqual({ color: '#0f0', ranges: [[10, 20], [30, 40]], plotId: null });
    });

    it('ne restaure ni un signal absent ni une zone desactivee', () => {
        ectx.disabledBoolZones.add(0);

        restoreBoolZones([
            { name: 'Moteur.Tournant', color: '#f00', ranges: [[0, 1]] },
            { name: 'Inconnu', color: '#f00', ranges: [[0, 1]] },
        ], SIGNALS);

        expect(ectx.extendedBoolZones.size).toBe(0);
    });

    it('dessine la zone d\'un booleen d\'un onglet pas encore construit', () => {
        ectx.extendedBoolZones.set(1, { color: '#fff', plotId: null, ranges: [[10, 20]] });
        S.plots = [{ id: 'p2', signals: [2] }];
        S.tabs = [
            { id: 't1', plots: S.plots, _hydrated: true },
            { id: 't2', plots: [], _hydrated: false, _pendingLayout: [{ signals: [{ name: 'Frein.Actif' }] }] },
        ];
        const chart = fakeChart();

        boolZonesPlugin().hooks.drawClear(chart);

        expect(chart.rects).toEqual([[10, 0, 10, 50]]);
    });
});
