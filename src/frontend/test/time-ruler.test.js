import { describe, it, expect, beforeEach } from 'vitest';
import { S } from '../src/core/state.js';
import { moveCursorTo, removeCursor, setCursorPair, toggleCursorLock } from '../src/eda/cursors.js';
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
        ruler().width = 1000;
        Object.defineProperty(ruler().el, 'clientWidth', { value: 1200 });
    });

    it('monte une seule regle par onglet', () => {
        mountTimeRuler(document.getElementById('plotsWrapper-t1'));
        expect(document.querySelectorAll('.time-ruler')).toHaveLength(1);
    });

    it('remplace l\'indication de la ligne vide des le premier curseur', () => {
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
        expect(ruler().deltaPill.style.display).toBe('inline-flex');
        expect(ruler().deltaPill.textContent).toBe('Δ 30.000s');
        // Plage et filet: fraction de la piste (30px sur 1000), sans ecrire de largeur.
        expect(ruler().deltaLine.style.transform).toBe('translate3d(200px, 0, 0) scaleX(0.03)');
        expect(ruler().delta.style.transform).toBe('translate3d(200px, 0, 0) scaleX(0.03)');
        expect(ruler().deltaLine.style.width).toBe('');
    });

    it('n\'affiche pas la plage tant que la piste n\'est pas mesuree', () => {
        ruler().width = 0;
        S.cursor1 = 200;
        S.cursor2 = 230;
        updateRulerCursors();
        expect(ruler().delta.style.display).toBe('none');
        expect(ruler().deltaLine.style.display).toBe('none');
    });

    it('garde les pastilles a gauche des boutons de la regle', () => {
        ruler().toolsWidth = 140;
        S.cursor1 = 990;
        updateRulerCursors();
        const pill = document.querySelector('.ruler-cursor-pill');
        // Bord droit utile: 1200 (regle) - 140 (boutons) - 50 (decalage de la piste) - 2 (marge).
        const start = 990 + Number(/translateX\((-?[\d.]+)px\)/.exec(pill.style.transform)[1]);
        const width = pill.textContent.length * 7.3 + 14;
        expect(start + width).toBeCloseTo(1008);
    });

    it('place le cadenas a droite de la valeur du delta', () => {
        const pill = ruler().deltaPill;
        expect(pill.firstElementChild).toBe(ruler().deltaText);
        expect(pill.lastElementChild.tagName.toLowerCase()).toBe('svg');
    });

    it('cale la pastille d\'un curseur hors fenetre contre le bord de la piste', () => {
        const startOf = pill => Number(/translateX\((-?[\d.]+)px\)/.exec(pill.style.transform)[1]);
        const widthOf = pill => pill.textContent.length * 7.3 + 14;
        const pills = document.querySelectorAll('.ruler-cursor-pill');

        // Sorti a droite (piste de 1000px): bord droit de la pastille sur le bord de la piste.
        S.cursor1 = 500;
        S.cursor2 = 1400;
        updateRulerCursors();
        expect(1400 + startOf(pills[1]) + widthOf(pills[1])).toBeCloseTo(1000);

        // Sorti a gauche: bord gauche de la pastille sur le debut de la piste.
        S.cursor2 = -250;
        updateRulerCursors();
        expect(-250 + startOf(pills[1])).toBeCloseTo(0);
    });

    it('borne la plage a la piste et retire le trait d\'un curseur hors fenetre', () => {
        S.cursor1 = -50;
        S.cursor2 = 400;
        updateRulerCursors();
        const cursors = document.querySelectorAll('.ruler-cursor');
        expect(cursors[0].classList.contains('is-offscreen')).toBe(true);
        expect(cursors[1].classList.contains('is-offscreen')).toBe(false);
        expect(ruler().delta.style.transform).toBe('translate3d(0px, 0, 0) scaleX(0.4)');
    });
});

describe('verrou de l\'ecart entre curseurs', () => {
    const ruler = () => document.querySelector('.time-ruler')._ruler;

    beforeEach(() => {
        document.body.innerHTML = '<div class="plots-wrapper" id="plotsWrapper-t1"></div>';
        S.activeTabId = 't1';
        S.plots = [];
        S.syncCursors = false;
        S.cursor1 = 100;
        S.cursor2 = 130;
        S.cursorLock = false;
        mountTimeRuler(document.getElementById('plotsWrapper-t1'));
        ruler().chart = { valToPos: v => v, posToVal: x => x };
        ruler().left = 50;
    });

    it('ne se pose qu\'avec deux curseurs', () => {
        S.cursor2 = null;
        expect(toggleCursorLock()).toBe(false);
        expect(S.cursorLock).toBe(false);
    });

    it('deplace un curseur seul tant que le verrou est ouvert', () => {
        moveCursorTo(1, 110);
        expect([S.cursor1, S.cursor2]).toEqual([110, 130]);
    });

    it('entraine l\'autre curseur et conserve l\'ecart, quel que soit le curseur deplace', () => {
        toggleCursorLock();
        moveCursorTo(1, 250);
        expect([S.cursor1, S.cursor2]).toEqual([250, 280]);
        moveCursorTo(2, 40);
        expect([S.cursor1, S.cursor2]).toEqual([10, 40]);
    });

    it('conserve un ecart negatif (curseur B a gauche de A)', () => {
        S.cursor2 = 70;
        toggleCursorLock();
        moveCursorTo(1, 200);
        expect([S.cursor1, S.cursor2]).toEqual([200, 170]);
    });

    it('reflete l\'etat sur la pastille de delta', () => {
        ruler().deltaPill.click();
        expect(S.cursorLock).toBe(true);
        expect(ruler().deltaPill.classList.contains('is-locked')).toBe(true);
        expect(ruler().deltaPill.getAttribute('aria-pressed')).toBe('true');
        ruler().deltaPill.click();
        expect(ruler().deltaPill.getAttribute('aria-pressed')).toBe('false');
    });

    it('tombe des qu\'un curseur est retire', () => {
        toggleCursorLock();
        removeCursor(2);
        expect(S.cursorLock).toBe(false);
        expect(ruler().deltaPill.classList.contains('is-locked')).toBe(false);
    });

    it('translate la paire sans changer l\'ecart', () => {
        setCursorPair(105, 135);
        expect(S.cursor2 - S.cursor1).toBe(30);
    });
});

describe('saisie d\'un temps de curseur', () => {
    it('lit un nombre, avec virgule decimale ou suffixe s', async () => {
        const { parseTimeInput } = await import('../src/eda/time-ruler.js');
        expect(parseTimeInput('12.5')).toBe(12.5);
        expect(parseTimeInput(' 12,5 s ')).toBe(12.5);
        expect(parseTimeInput('-3e-3')).toBe(-0.003);
        expect(parseTimeInput('abc')).toBe(null);
        expect(parseTimeInput('')).toBe(null);
        expect(parseTimeInput('1.2.3')).toBe(null);
    });
});
