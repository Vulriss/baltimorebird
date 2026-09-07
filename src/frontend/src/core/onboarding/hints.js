// Indices contextuels, independants de la visite guidee. Premier scenario: un
// utilisateur qui travaille longtemps avec le menu lateral deploye n'a
// probablement pas vu qu'il peut le replier. L'indice se declenche une fois,
// s'efface au premier clic, et ne revient jamais une fois compris.

const SVG_NS = 'http://www.w3.org/2000/svg';
const STORAGE_KEY = 'bb.hints.navCollapse';
const DELAY_MS = 90000;
const VISIBLE_MS = 12000;

function hasBeenLearned() {
    try {
        return window.localStorage.getItem(STORAGE_KEY) === 'done'
            || window.localStorage.getItem('navCollapsed') === 'true';
    } catch (e) {
        return true;
    }
}

function markLearned() {
    try {
        window.localStorage.setItem(STORAGE_KEY, 'done');
    } catch (e) {
        // Sans stockage, l'indice se represente a la prochaine session.
    }
}

function buildHint(label) {
    const root = document.createElement('div');
    root.className = 'bb-hint';
    root.setAttribute('aria-hidden', 'true');

    const arrow = document.createElementNS(SVG_NS, 'svg');
    arrow.setAttribute('class', 'bb-hint-arrow');
    arrow.setAttribute('viewBox', '0 0 64 40');
    arrow.setAttribute('width', '64');
    arrow.setAttribute('height', '40');
    const shaft = document.createElementNS(SVG_NS, 'path');
    shaft.setAttribute('d', 'M60 34C44 34 26 30 12 18');
    const head = document.createElementNS(SVG_NS, 'path');
    head.setAttribute('d', 'M22 20L11 17L14 28');
    arrow.appendChild(shaft);
    arrow.appendChild(head);

    const text = document.createElement('span');
    text.className = 'bb-hint-label';
    text.textContent = label;

    root.appendChild(text);
    root.appendChild(arrow);
    return root;
}

export function createNavCollapseHint(options) {
    const settings = options || {};
    const delay = settings.delay || DELAY_MS;
    const label = settings.label || 'Repliez le menu';
    let timer = 0;
    let hideTimer = 0;
    let node = null;

    function dismiss(learned) {
        window.clearTimeout(hideTimer);
        if (node && node.parentNode) node.parentNode.removeChild(node);
        node = null;
        if (learned) markLearned();
    }

    function show(toggle, nav) {
        if (nav.classList.contains('collapsed')) return;
        node = buildHint(label);
        const rect = toggle.getBoundingClientRect();
        node.style.top = `${Math.round(rect.top + rect.height / 2)}px`;
        node.style.left = `${Math.round(rect.right + 12)}px`;
        document.body.appendChild(node);
        hideTimer = window.setTimeout(() => dismiss(false), VISIBLE_MS);
    }

    return {
        start() {
            const toggle = document.getElementById('navToggle');
            const nav = document.getElementById('navMenu');
            if (!toggle || !nav || hasBeenLearned()) return;

            toggle.addEventListener('click', () => {
                window.clearTimeout(timer);
                dismiss(true);
            }, { once: true });

            timer = window.setTimeout(() => show(toggle, nav), delay);
        },

        stop() {
            window.clearTimeout(timer);
            dismiss(false);
        },
    };
}
