// Placement de la carte. Elle reste centree tant qu'elle ne gene rien, et se
// decale du minimum necessaire des qu'elle recouvre une zone que l'utilisateur
// doit manipuler. Geometrie pure: aucune requete DOM, donc testable seul.

const VIEWPORT_MARGIN = 24;
const OBSTACLE_MARGIN = 16;

// Grille de positions candidates. Une poignee d'ancrages extremes envoyait la
// carte dans un coin des que le centre etait pris; une grille fine permet de ne
// la deplacer que du strict necessaire.
const GRID_STEPS = 8;

function overlapArea(a, b) {
    const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    if (width <= 0 || height <= 0) return 0;
    return width * height;
}

function candidateRect(anchor, size, viewport) {
    const freeX = Math.max(0, viewport.width - size.width - VIEWPORT_MARGIN * 2);
    const freeY = Math.max(0, viewport.height - size.height - VIEWPORT_MARGIN * 2);
    const left = VIEWPORT_MARGIN + freeX * anchor.x;
    const top = VIEWPORT_MARGIN + freeY * anchor.y;
    return { left, top, right: left + size.width, bottom: top + size.height };
}

function inflate(rect, margin) {
    return {
        left: rect.left - margin,
        top: rect.top - margin,
        right: rect.right + margin,
        bottom: rect.bottom + margin,
    };
}

// Retourne le decalage a appliquer a la carte centree, en pixels. A recouvrement
// egal, la position la plus proche du centre gagne: la carte s'ecarte du minimum
// necessaire au lieu de sauter au bord.
export function computeCardOffset(cardRect, obstacles, viewport) {
    const size = { width: cardRect.width, height: cardRect.height };
    const blockers = (obstacles || [])
        .filter((rect) => rect)
        .map((rect) => inflate(rect, OBSTACLE_MARGIN));

    if (blockers.length === 0) return { x: 0, y: 0 };

    const centered = candidateRect({ x: 0.5, y: 0.5 }, size, viewport);
    let best = null;

    for (let ix = 0; ix <= GRID_STEPS; ix += 1) {
        for (let iy = 0; iy <= GRID_STEPS; iy += 1) {
            const candidate = candidateRect({ x: ix / GRID_STEPS, y: iy / GRID_STEPS }, size, viewport);
            const overlap = blockers.reduce((total, blocker) => total + overlapArea(candidate, blocker), 0);
            const travel = Math.hypot(candidate.left - centered.left, candidate.top - centered.top);
            if (best === null || overlap < best.overlap
                    || (overlap === best.overlap && travel < best.travel)) {
                best = { candidate, overlap, travel };
            }
        }
    }

    return {
        x: Math.round(best.candidate.left - cardRect.left),
        y: Math.round(best.candidate.top - cardRect.top),
    };
}
