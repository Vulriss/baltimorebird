import { describe, it, expect, beforeEach } from 'vitest';
import { S } from '../src/core/state.js';
import { layoutRow, mountTimeRuler, updateRulerCursors } from '../src/eda/time-ruler.js';

// Ligne des curseurs de la regle de temps: temps A/B et delta sur une meme ligne, chacun
// au plus pres de sa position, sans chevauchement et sans sortir de la regle.

const GAP = 6;

function item(center, w) {
    return { center, w };
}

function overlaps(row) {
    return row.some((it, i) => i > 0 && row[i - 1].start + row[i - 1].w + GAP > it.start + 1e-9);
}

describe('layoutRow', () => {
    it('laisse chaque etiquette centree sur sa position quand elles ne se touchent pas', () => {
        const row = [item(100, 60), item(400, 80), item(700, 60)];
        layoutRow(row, 0, 1000);
        expect(row.map(it => it.start)).toEqual([70, 360, 670]);
    });

    it('ecarte des etiquettes qui se chevauchent, dans l\'ordre, centrees sur leur ensemble', () => {
        const row = [item(200, 70), item(215, 80), item(230, 70)];
        layoutRow(row, 0, 1000);
        expect(overlaps(row)).toBe(false);
        expect(row[0].start < row[1].start && row[1].start < row[2].start).toBe(true);
        // Le bloc reste centre sur la moyenne des positions souhaitees (215).
        const blockCenter = (row[0].start + row[2].start + row[2].w) / 2;
        expect(blockCenter).toBeCloseTo(215);
    });

    it('ne fait pas sortir le bloc de la regle', () => {
        const row = [item(5, 70), item(15, 80), item(25, 70)];
        layoutRow(row, 0, 1000);
        expect(row[0].start).toBe(0);
        expect(overlaps(row)).toBe(false);

        const right = [item(990, 70), item(995, 80)];
        layoutRow(right, 0, 1000);
        expect(right[1].start + right[1].w).toBeCloseTo(1000);
        expect(overlaps(right)).toBe(false);
    });
});

describe('curseurs de la regle de temps', () => {
    const fakeChart = { valToPos: v => v, posToVal: x => x };
    const ruler = () => document.querySelector('.time-ruler')._ruler;

    beforeEach(() => {
        document.body.innerHTML = '<div class="plots-wrapper" id="plotsWrapper-t1"></div>';
        S.activeTabId = 't1';
        S.plots = [];
        S.cursor1 = null;
        S.cursor2 = null;
        mountTimeRuler(document.getElementById('plotsWrapper-t1'));
        ruler().chart = fakeChart;
        ruler().left = 50;
        Object.defineProperty(ruler().el, 'clientWidth', { value: 1200 });
    });

    it('monte une seule regle par onglet', () => {
        mountTimeRuler(document.getElementById('plotsWrapper-t1'));
        expect(document.querySelectorAll('.time-ruler')).toHaveLength(1);
    });

    it('ajoute la ligne des curseurs des le premier curseur', () => {
        updateRulerCursors();
        expect(ruler().el.classList.contains('has-cursor')).toBe(false);
        S.cursor1 = 300;
        updateRulerCursors();
        expect(ruler().el.classList.contains('has-cursor')).toBe(true);
        expect(ruler().deltaPill.style.display).toBe('none');
    });

    it('affiche les deux temps et le delta sur la meme ligne', () => {
        S.cursor1 = 200;
        S.cursor2 = 230;
        updateRulerCursors();
        const pills = document.querySelectorAll('.ruler-cursor-pill');
        expect(pills[0].textContent).toBe('200.000s');
        expect(pills[1].textContent).toBe('230.000s');
        expect(ruler().deltaPill.style.display).toBe('block');
        expect(ruler().deltaPill.textContent).toBe('Δ 30.000s');
        expect(ruler().deltaLine.style.width).toBe('30px');
    });
});
