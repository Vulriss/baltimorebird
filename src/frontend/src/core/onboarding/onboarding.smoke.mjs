import assert from 'node:assert';
import { JSDOM } from 'jsdom';

// Geometrie approchee de la vue EDA sur un ecran 1366x768: sidebar a gauche,
// zone de graphiques a droite, bande Nouveau graphique en bas.
const VIEWPORT = { width: 1366, height: 768 };
const CARD = { width: 440, height: 320 };
const PAD = 32;

const RECTS = {
    uploadBtnAuth: { left: 12, top: 60, width: 28, height: 28 },
    search: { left: 12, top: 320, width: 260, height: 26 },
    signalList: { left: 8, top: 356, width: 304, height: 264 },
    createVariableBtn: { left: 12, top: 640, width: 260, height: 30 },
    'drop-zone': { left: 320, top: 700, width: 900, height: 40 },
    'plot-legend': { left: 1180, top: 100, width: 140, height: 200 },
};

// La carte reste centree quelle que soit l'etape.
const CARD_ORIGIN = {
    left: (VIEWPORT.width - CARD.width) / 2,
    top: (VIEWPORT.height - CARD.height) / 2,
};

const dom = new JSDOM(`<!DOCTYPE html><html><body>
  <button id="uploadBtnAuth">up</button>
  <input id="search">
  <div class="signal-list" id="signalList"></div>
  <button id="createVariableBtn">var</button>
  <div class="tab-content active"><div class="plots-wrapper"></div><div class="drop-zone"></div></div>
</body></html>`, { pretendToBeVisual: true });

global.window = dom.window;
global.document = dom.window.document;
global.MutationObserver = dom.window.MutationObserver;
Object.defineProperty(dom.window, 'innerWidth', { value: VIEWPORT.width, configurable: true });
Object.defineProperty(dom.window, 'innerHeight', { value: VIEWPORT.height, configurable: true });

function withEdges(rect) {
    return { ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height };
}

function rectFor(el) {
    if (el.classList && el.classList.contains('bb-onb-card')) {
        return withEdges({ ...CARD_ORIGIN, ...CARD });
    }
    const key = el.id || Array.from(el.classList || []).find((c) => RECTS[c]);
    if (!key || !RECTS[key]) return withEdges({ left: 0, top: 0, width: 0, height: 0 });
    return withEdges(RECTS[key]);
}

dom.window.Element.prototype.getBoundingClientRect = function () { return rectFor(this); };
dom.window.HTMLElement.prototype.focus = function () { this.ownerDocument.__active = this; };

const base = '../baltimorebird/src/frontend/src/core/onboarding';
const { createOnboardingStore } = await import(`${base}/store.js`);
const { createOnboardingOverlay } = await import(`${base}/overlay.js`);
const { createOnboardingPanel } = await import(`${base}/panel.js`);
const { createOnboardingTour } = await import(`${base}/tour.js`);
const { TOUR_STEPS } = await import(`${base}/steps.js`);

const memory = new Map();
const storage = {
    getItem: (k) => (memory.has(k) ? memory.get(k) : null),
    setItem: (k, v) => memory.set(k, String(v)),
    removeItem: (k) => memory.delete(k),
};
const store = createOnboardingStore({ storage });
const overlay = createOnboardingOverlay();
const panel = createOnboardingPanel();
const tour = createOnboardingTour({ store, overlay, panel });

assert.strictEqual(store.hasSeen(), false, 'etat initial vierge');

tour.start();
const root = document.querySelector('.bb-onb-root');
assert.ok(root, 'racine montee');
assert.strictEqual(document.querySelectorAll('.bb-onb-outline-item').length, 4, 'sommaire en quatre points');
assert.strictEqual(overlay.element.querySelectorAll('.bb-onb-arrow-shaft').length, 0, 'pas de fleche sur l accueil');

function click(action) {
    const btn = root.querySelector(`.bb-onb-content [data-action="${action}"]`);
    assert.ok(btn, `bouton ${action} present`);
    btn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    dom.window.dispatchEvent(new dom.window.Event('resize'));
}

const shafts = () => overlay.element.querySelectorAll('.bb-onb-arrow-shaft');
const hints = () => Array.from(overlay.element.querySelectorAll('.bb-onb-hint')).map((n) => n.textContent);
const rings = () => overlay.element.querySelectorAll('.bb-onb-ring').length;
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

function assertPathsValid(context) {
    shafts().forEach((node) => {
        const d = node.getAttribute('d');
        assert.ok(!d.includes('NaN'), `${context}: aucune coordonnee NaN`);
        assert.ok(
            /^M [\d.-]+ [\d.-]+( C [\d.-]+ [\d.-]+ [\d.-]+ [\d.-]+ [\d.-]+ [\d.-]+)+$/.test(d),
            `${context}: path cubique continu (${d})`,
        );
    });
    Array.from(overlay.element.querySelectorAll('.bb-onb-hint')).forEach((node) => {
        const x = Number(node.getAttribute('x'));
        const y = Number(node.getAttribute('y'));
        assert.ok(x >= 0 && x <= VIEWPORT.width, `${context}: libelle dans le viewport (x=${x})`);
        assert.ok(y >= 0 && y <= VIEWPORT.height, `${context}: libelle dans le viewport (y=${y})`);
    });
}

click('next');
await settle();
assert.strictEqual(document.querySelector('.bb-onb-title').textContent, TOUR_STEPS[0].title, 'etape 1');
assert.strictEqual(document.querySelector('.bb-onb-counter').textContent, 'Etape 1 sur 4', 'compteur');
assert.strictEqual(document.querySelectorAll('.bb-onb-dot.is-current').length, 1, 'un seul point actif');
assert.strictEqual(shafts().length, 1, 'une fleche a l etape 1');
assert.deepStrictEqual(hints(), ['Commencez ici'], 'libelle etape 1');
assertPathsValid('etape 1');

click('next');
await settle();
assert.strictEqual(shafts().length, 1, 'une fleche a l etape 2');
assert.deepStrictEqual(hints(), ['Filtrez ici'], 'libelle etape 2');
assertPathsValid('etape 2');

click('next');
await settle();
assert.strictEqual(shafts().length, 2, 'deux fleches a l etape 3');
assert.deepStrictEqual(hints().sort(), ['Glissez depuis ici', 'Nouveau graphique'], 'libelles etape 3');
assert.strictEqual(document.querySelector('.bb-onb-content [data-action="skip"]'), null, 'pas de bouton passer hors accueil');
assert.strictEqual(rings(), 2, 'deux spotlights a l etape 3');
assertPathsValid('etape 3');

click('next');
await settle();
assert.strictEqual(shafts().length, 1, 'etape 4 degradee sans legende');
assert.deepStrictEqual(hints(), ['Creez ici'], 'seule la cible presente est flechee');

const legend = document.createElement('div');
legend.className = 'plot-legend';
document.querySelector('.tab-content.active').appendChild(legend);
click('previous');
click('next');
await settle();
assert.strictEqual(shafts().length, 2, 'deux fleches a l etape 4');
assert.deepStrictEqual(hints().sort(), ['Creez ici', 'Reglez ici'], 'libelles etape 4');
assert.strictEqual(rings(), 2, 'deux spotlights a l etape 4');
assertPathsValid('etape 4');

assert.strictEqual(root.querySelector('[data-action="next"]').textContent, 'Voir le bilan', 'bouton de bilan');

click('next');
await settle();
assert.strictEqual(document.querySelector('.bb-onb-card').getAttribute('data-kind'), 'finish', 'ecran final');
assert.strictEqual(shafts().length, 0, 'aucune fleche sur l ecran final');
assert.ok(document.querySelector('.bb-onb-root'), 'la visite reste ouverte sur le bilan');

click('next');
assert.strictEqual(document.querySelector('.bb-onb-root'), null, 'racine demontee apres le bilan');
assert.strictEqual(store.hasSeen(), true, 'etat persiste');
assert.strictEqual(JSON.parse(memory.get('bb.onboarding')).status, 'completed', 'statut complete');
assert.strictEqual(createOnboardingStore({ storage }).hasSeen(), true, 'visite vue une seule fois');
assert.strictEqual(createOnboardingStore({ storage, version: 2 }).hasSeen(), false, 'nouvelle version reproposee');

memory.clear();
createOnboardingTour({ store, overlay, panel }).start();
document.querySelector('.bb-onb-close').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
assert.strictEqual(document.querySelector('.bb-onb-root'), null, 'fermeture par la croix');
assert.strictEqual(JSON.parse(memory.get('bb.onboarding')).status, 'skipped', 'statut passe');
assert.strictEqual(store.hasSeen(), true, 'visite passee = visite vue');

console.log('smoke test: OK');
