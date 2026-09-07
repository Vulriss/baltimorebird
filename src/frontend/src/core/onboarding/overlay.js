// Calque SVG de la visite: voile assombri perce au niveau des cibles, et fleche
// manuscrite tracee depuis la carte vers chaque cible. Le module ne recoit que
// des rectangles en coordonnees viewport: aucune requete DOM, ce qui le rend
// testable et independant du contenu de la visite.

const SVG_NS = 'http://www.w3.org/2000/svg';
const MASK_ID = 'bb-onb-spotlight';

const CARD_CLEARANCE = 20;
const TARGET_CLEARANCE = 16;
const MIN_ARROW_LENGTH = 56;
const MAX_ARROW_LENGTH = 180;
const CURVATURE = 0.22;
const HEAD_LENGTH = 18;
const HEAD_SPREAD = 0.42;
const LABEL_OFFSET = 30;
const LABEL_ALONG = 0.28;
const LABEL_MARGIN = 96;
const LABEL_FONT_SIZE = 22;
const LABEL_CHAR_WIDTH = 0.58;
const LABEL_PUSH_STEP = 14;
const LABEL_PUSH_TRIES = 6;
const SKETCH_SEGMENTS = 9;
const SKETCH_JITTER = 1.6;
const DEFAULT_PADDING = 8;
const REVEAL_PADDING = 4;
const DEFAULT_RADIUS = 10;

function svg(tag, attributes) {
    const node = document.createElementNS(SVG_NS, tag);
    if (attributes) {
        Object.keys(attributes).forEach((name) => node.setAttribute(name, attributes[name]));
    }
    return node;
}

function center(rect) {
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

// Generateur deterministe: la meme cible produit toujours le meme tremble, sinon
// la fleche fremit a chaque redimensionnement.
function createRandom(seed) {
    let state = seed >>> 0;
    return () => {
        state += 0x6d2b79f5;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

function hashText(text) {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function quadraticPoint(start, control, tip, t) {
    const inverse = 1 - t;
    return {
        x: inverse * inverse * start.x + 2 * inverse * t * control.x + t * t * tip.x,
        y: inverse * inverse * start.y + 2 * inverse * t * control.y + t * t * tip.y,
    };
}

function quadraticTangent(start, control, tip, t) {
    const x = 2 * (1 - t) * (control.x - start.x) + 2 * t * (tip.x - control.x);
    const y = 2 * (1 - t) * (control.y - start.y) + 2 * t * (tip.y - control.y);
    const length = Math.hypot(x, y) || 1;
    return { x: x / length, y: y / length };
}

// Le trace manuscrit est echantillonne puis bruite le long de la normale, avec
// une amplitude qui s'annule aux extremites pour que la pointe reste precise.
// Un filtre feDisplacementMap donnerait le meme effet mais rasterise le trait et
// produit les discontinuites visibles sur les bords.
function sketchPoints(start, control, tip, seed) {
    const random = createRandom(seed);
    const points = [];
    for (let i = 0; i <= SKETCH_SEGMENTS; i += 1) {
        const t = i / SKETCH_SEGMENTS;
        const point = quadraticPoint(start, control, tip, t);
        const tangent = quadraticTangent(start, control, tip, t);
        const taper = Math.sin(Math.PI * t);
        const noise = (random() * 2 - 1) * SKETCH_JITTER * taper;
        points.push({ x: point.x - tangent.y * noise, y: point.y + tangent.x * noise });
    }
    return points;
}

// Catmull-Rom converti en cubiques: courbe continue en tangente, donc aucune
// cassure visible entre deux segments.
function smoothPath(points) {
    let path = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
    for (let i = 0; i < points.length - 1; i += 1) {
        const p0 = points[i === 0 ? 0 : i - 1];
        const p1 = points[i];
        const p2 = points[i + 1];
        const p3 = points[i + 2] || p2;
        const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
        const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
        path += ` C ${c1.x.toFixed(2)} ${c1.y.toFixed(2)} ${c2.x.toFixed(2)} ${c2.y.toFixed(2)}`
            + ` ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
    }
    return path;
}

function edgePoint(rect, target, margin) {
    const origin = center(rect);
    const dx = target.x - origin.x;
    const dy = target.y - origin.y;
    if (Math.abs(dx) < 1e-3 && Math.abs(dy) < 1e-3) return origin;

    const halfWidth = rect.width / 2 + margin;
    const halfHeight = rect.height / 2 + margin;
    const scaleX = Math.abs(dx) > 1e-3 ? halfWidth / Math.abs(dx) : Number.POSITIVE_INFINITY;
    const scaleY = Math.abs(dy) > 1e-3 ? halfHeight / Math.abs(dy) : Number.POSITIVE_INFINITY;
    const scale = Math.min(scaleX, scaleY);

    return { x: origin.x + dx * scale, y: origin.y + dy * scale };
}

function overlaps(cardRect, targetRect, margin) {
    return cardRect.left - margin < targetRect.right
        && cardRect.right + margin > targetRect.left
        && cardRect.top - margin < targetRect.bottom
        && cardRect.bottom + margin > targetRect.top;
}

function buildArrowGeometry(cardRect, targetRect, seed) {
    if (overlaps(cardRect, targetRect, CARD_CLEARANCE)) return null;

    const origin = edgePoint(cardRect, center(targetRect), CARD_CLEARANCE);
    const tip = edgePoint(targetRect, center(cardRect), TARGET_CLEARANCE);
    const span = Math.hypot(tip.x - origin.x, tip.y - origin.y);
    if (span < MIN_ARROW_LENGTH) return null;

    // La fleche garde l'orientation carte vers cible mais reste courte: un trait
    // qui traverse tout l'ecran designe moins bien qu'un trait pose a cote.
    const reach = Math.min(MAX_ARROW_LENGTH, span);
    const start = {
        x: tip.x - ((tip.x - origin.x) / span) * reach,
        y: tip.y - ((tip.y - origin.y) / span) * reach,
    };
    const dx = tip.x - start.x;
    const dy = tip.y - start.y;
    const length = Math.hypot(dx, dy);

    const bend = tip.x >= start.x ? -1 : 1;
    const normal = { x: -dy / length, y: dx / length };
    const bulge = CURVATURE * length * bend;
    const control = {
        x: (start.x + tip.x) / 2 + normal.x * bulge,
        y: (start.y + tip.y) / 2 + normal.y * bulge,
    };

    const angle = Math.atan2(tip.y - control.y, tip.x - control.x);
    const head = [
        {
            x: tip.x - HEAD_LENGTH * Math.cos(angle - HEAD_SPREAD),
            y: tip.y - HEAD_LENGTH * Math.sin(angle - HEAD_SPREAD),
        },
        {
            x: tip.x - HEAD_LENGTH * Math.cos(angle + HEAD_SPREAD),
            y: tip.y - HEAD_LENGTH * Math.sin(angle + HEAD_SPREAD),
        },
    ];

    // Le libelle se pose a la base du trait, decale le long de la normale. Il ne
    // recule jamais vers la carte, qui est juste derriere, et s'etend dans le
    // sens de la fleche. Sur un trait vertical, ou la direction ne donne aucun
    // sens horizontal, c'est la normale qui decide de l'ancrage.
    // Cote oppose au bombement: la courbe etant entierement d'un cote de sa corde,
    // un libelle pose de l'autre cote ne peut pas la croiser. L'ancrage depend du
    // sens du decalage et non de celui de la fleche: sur un trait vertical, le
    // decalage est horizontal et un texte centre reviendrait sur la courbe.
    const direction = { x: dx / length, y: dy / length };
    const offset = { x: -normal.x * bend, y: -normal.y * bend };
    const along = length * LABEL_ALONG;
    const label = {
        x: start.x + direction.x * along + offset.x * LABEL_OFFSET,
        y: start.y + direction.y * along + offset.y * LABEL_OFFSET,
        anchor: Math.abs(offset.x) > 0.35 ? (offset.x > 0 ? 'start' : 'end') : 'middle',
        offset,
    };

    return { start, control, tip, head, label, seed };
}

// Boite approchee du texte: le SVG n'est pas encore dans le document au moment
// du calcul, donc getBBox n'est pas disponible. La largeur par caractere est
// mesuree sur la fonte manuscrite en capitales.
function labelBox(point, text, anchor) {
    const width = text.length * LABEL_FONT_SIZE * LABEL_CHAR_WIDTH;
    const height = LABEL_FONT_SIZE;
    let left = point.x - width / 2;
    if (anchor === 'start') left = point.x;
    if (anchor === 'end') left = point.x - width;
    return { left, right: left + width, top: point.y - height / 2, bottom: point.y + height / 2 };
}

function intersects(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

// La carte est dessinee par-dessus le calque: un libelle qui tombe dessous
// disparait. On l'ecarte le long de la normale jusqu'a le degager.
function pushOutOfCard(point, text, anchor, offset, cardRect) {
    if (!cardRect) return point;
    let current = point;
    for (let i = 0; i < LABEL_PUSH_TRIES; i += 1) {
        if (!intersects(labelBox(current, text, anchor), cardRect)) return current;
        current = { x: current.x + offset.x * LABEL_PUSH_STEP, y: current.y + offset.y * LABEL_PUSH_STEP };
    }
    return current;
}

function clampLabel(point) {
    const maxX = Math.max(LABEL_MARGIN, window.innerWidth - LABEL_MARGIN);
    return {
        x: Math.min(Math.max(point.x, LABEL_MARGIN), maxX),
        y: Math.min(Math.max(point.y, 28), window.innerHeight - 20),
    };
}

function buildDefs() {
    const defs = svg('defs');
    const mask = svg('mask', { id: MASK_ID, maskUnits: 'userSpaceOnUse' });
    mask.appendChild(svg('rect', { x: '0', y: '0', width: '100%', height: '100%', fill: '#ffffff' }));
    const holes = svg('g');
    mask.appendChild(holes);
    defs.appendChild(mask);
    return { defs, holes };
}

export function createOnboardingOverlay() {
    const root = svg('svg', { class: 'bb-onb-overlay', 'aria-hidden': 'true', focusable: 'false' });
    const { defs, holes } = buildDefs();
    const dim = svg('rect', {
        class: 'bb-onb-dim', x: '0', y: '0', width: '100%', height: '100%', mask: `url(#${MASK_ID})`,
    });
    const rings = svg('g', { class: 'bb-onb-rings' });
    const arrows = svg('g', { class: 'bb-onb-arrows' });
    const labels = svg('g', { class: 'bb-onb-labels' });

    root.appendChild(defs);
    root.appendChild(dim);
    root.appendChild(rings);
    root.appendChild(arrows);
    root.appendChild(labels);

    function clearChildren(node) {
        while (node.firstChild) node.removeChild(node.firstChild);
    }

    function drawSpotlight(rect, padding, radius) {
        const geometry = {
            x: rect.left - padding,
            y: rect.top - padding,
            width: rect.width + padding * 2,
            height: rect.height + padding * 2,
            rx: radius,
        };
        holes.appendChild(svg('rect', { ...geometry, fill: '#000000' }));
        rings.appendChild(svg('rect', { ...geometry, class: 'bb-onb-ring' }));
    }

    function drawArrow(geometry, label, cardRect) {
        const group = svg('g', { class: 'bb-onb-arrow' });
        const stroke = sketchPoints(geometry.start, geometry.control, geometry.tip, geometry.seed);
        group.appendChild(svg('path', { class: 'bb-onb-arrow-shaft', d: smoothPath(stroke) }));
        group.appendChild(svg('path', {
            class: 'bb-onb-arrow-head',
            d: `M ${geometry.head[0].x.toFixed(2)} ${geometry.head[0].y.toFixed(2)}`
                + ` L ${geometry.tip.x.toFixed(2)} ${geometry.tip.y.toFixed(2)}`
                + ` L ${geometry.head[1].x.toFixed(2)} ${geometry.head[1].y.toFixed(2)}`,
        }));
        arrows.appendChild(group);

        if (!label) return;
        const position = clampLabel(pushOutOfCard(
            geometry.label, label, geometry.label.anchor, geometry.label.offset, cardRect,
        ));
        const text = svg('text', {
            class: 'bb-onb-hint',
            x: position.x,
            y: position.y,
            'text-anchor': geometry.label.anchor,
            transform: `rotate(-4 ${position.x} ${position.y})`,
        });
        text.textContent = label;
        labels.appendChild(text);
    }

    return {
        element: root,

        // targets: [{ rect, label, padding, radius }], cardRect et reveals optionnels.
        // Les zones revelees sont percees dans le voile sans anneau ni fleche:
        // elles doivent rester lisibles, pas attirer le regard.
        update(targets, cardRect, reveals) {
            clearChildren(holes);
            clearChildren(rings);
            clearChildren(arrows);
            clearChildren(labels);

            (reveals || []).forEach((rect) => {
                if (!rect) return;
                holes.appendChild(svg('rect', {
                    x: rect.left - REVEAL_PADDING,
                    y: rect.top - REVEAL_PADDING,
                    width: rect.width + REVEAL_PADDING * 2,
                    height: rect.height + REVEAL_PADDING * 2,
                    rx: DEFAULT_RADIUS,
                    fill: '#000000',
                }));
            });

            (targets || []).forEach((target, position) => {
                if (!target.rect) return;
                drawSpotlight(
                    target.rect,
                    target.padding === undefined ? DEFAULT_PADDING : target.padding,
                    target.radius === undefined ? DEFAULT_RADIUS : target.radius,
                );
                if (!cardRect) return;
                const seed = hashText(`${target.label || ''}#${position}`);
                const geometry = buildArrowGeometry(cardRect, target.rect, seed);
                if (geometry) drawArrow(geometry, target.label, cardRect);
            });
        },

        clear() {
            clearChildren(holes);
            clearChildren(rings);
            clearChildren(arrows);
            clearChildren(labels);
        },
    };
}
