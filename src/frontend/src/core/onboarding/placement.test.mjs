import assert from 'node:assert';
import { computeCardOffset } from '../baltimorebird/src/frontend/src/core/onboarding/placement.js';

const VIEWPORT = { width: 1366, height: 768 };
const CARD = { width: 460, height: 380 };
const centered = () => ({
    left: (VIEWPORT.width - CARD.width) / 2,
    top: (VIEWPORT.height - CARD.height) / 2,
    right: (VIEWPORT.width + CARD.width) / 2,
    bottom: (VIEWPORT.height + CARD.height) / 2,
    ...CARD,
});
const rect = (left, top, width, height) => ({
    left, top, width, height, right: left + width, bottom: top + height,
});

// Sans obstacle, la carte ne bouge pas.
assert.deepStrictEqual(computeCardOffset(centered(), [], VIEWPORT), { x: 0, y: 0 },
    'aucun obstacle: reste centree');

// Un obstacle loin du centre ne la deplace pas non plus.
assert.deepStrictEqual(computeCardOffset(centered(), [rect(8, 40, 40, 40)], VIEWPORT), { x: 0, y: 0 },
    'obstacle distant: reste centree');

// Un obstacle au centre la deplace, et la nouvelle position ne le recouvre plus.
const blocker = rect(560, 300, 300, 200);
const offset = computeCardOffset(centered(), [blocker], VIEWPORT);
assert.ok(offset.x !== 0 || offset.y !== 0, 'obstacle central: la carte se decale');

const moved = {
    left: centered().left + offset.x,
    top: centered().top + offset.y,
    right: centered().right + offset.x,
    bottom: centered().bottom + offset.y,
};
const overlaps = moved.left < blocker.right && moved.right > blocker.left
    && moved.top < blocker.bottom && moved.bottom > blocker.top;
assert.ok(!overlaps, 'la position retenue ne recouvre plus l obstacle');

// Elle reste dans le viewport.
assert.ok(moved.left >= 0 && moved.top >= 0, 'bornes hautes respectees');
assert.ok(moved.right <= VIEWPORT.width && moved.bottom <= VIEWPORT.height, 'bornes basses respectees');

// Ecran sature: aucun ancrage libre, la carte se pose quand meme sans sortir.
const everywhere = [rect(0, 0, VIEWPORT.width, VIEWPORT.height)];
const fallback = computeCardOffset(centered(), everywhere, VIEWPORT);
assert.ok(Number.isFinite(fallback.x) && Number.isFinite(fallback.y), 'repli numerique valide');

console.log('placement: OK');

// Deplacement minimal: un obstacle qui mord legerement sur la carte ne doit pas
// l'envoyer au bord de l'ecran.
const grazing = rect(430, 180, 120, 120);
const small = computeCardOffset(centered(), [grazing], VIEWPORT);
assert.ok(Math.hypot(small.x, small.y) < 260,
    `deplacement minimal attendu, obtenu ${small.x},${small.y}`);

// Sans obstacle, aucun decalage meme avec une carte tres haute.
const tall = { ...centered(), height: 700, bottom: centered().top + 700 };
assert.deepStrictEqual(computeCardOffset(tall, [], VIEWPORT), { x: 0, y: 0 },
    'carte haute sans obstacle: reste centree');

console.log('placement (minimalite): OK');
