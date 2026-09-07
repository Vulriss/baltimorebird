// Feu d'artifice de fin de visite. Isole dans son module: c'est le seul point
// qui depend de canvas-confetti, et la visite reste fonctionnelle si le paquet
// est absent ou si l'utilisateur a demande des animations reduites.

import confetti from 'canvas-confetti';

const DURATION_MS = 4000;
const TICK_MS = 250;
const BURST_BASE = 40;
const DEFAULTS = { startVelocity: 30, spread: 360, ticks: 60, zIndex: 6100, disableForReducedMotion: true };

function randomInRange(min, max) {
    return Math.random() * (max - min) + min;
}

export function celebrate(durationMs) {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return () => {};

    const duration = durationMs || DURATION_MS;
    const end = Date.now() + duration;

    const interval = window.setInterval(() => {
        const remaining = end - Date.now();
        if (remaining <= 0) {
            window.clearInterval(interval);
            return;
        }
        // Densite decroissante: la salve initiale porte l'effet, la fin s'efface.
        const particleCount = BURST_BASE * (remaining / duration);
        confetti({ ...DEFAULTS, particleCount, origin: { x: randomInRange(0.1, 0.3), y: Math.random() - 0.2 } });
        confetti({ ...DEFAULTS, particleCount, origin: { x: randomInRange(0.7, 0.9), y: Math.random() - 0.2 } });
    }, TICK_MS);

    return () => {
        window.clearInterval(interval);
        confetti.reset();
    };
}
