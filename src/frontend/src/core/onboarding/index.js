// Composition de la visite guidee et declenchement au premier passage.
// Expose window.baltimoreOnboarding pour un relancement manuel (Settings, aide).

import { createOnboardingStore } from './store.js';
import { createOnboardingOverlay } from './overlay.js';
import { createOnboardingPanel } from './panel.js';
import { createOnboardingTour } from './tour.js';
import { celebrate } from './celebrate.js';
import { createNavCollapseHint } from './hints.js';
import { waitForElement } from './anchors.js';

// La vue EDA est chargee de maniere asynchrone par core/init.js: on attend que
// la liste des signaux existe avant d'ancrer les fleches.
const READY_SELECTORS = ['#search', '.sidebar-signals'];
const READY_TIMEOUT_MS = 15000;

const store = createOnboardingStore();
const navHint = createNavCollapseHint();
let tour = null;

function getTour() {
    if (!tour) {
        tour = createOnboardingTour({
            store,
            overlay: createOnboardingOverlay(),
            panel: createOnboardingPanel(),
            celebrate,
            track: (event) => {
                if (typeof window.bbTrack === 'function') window.bbTrack(event);
            },
        });
    }
    return tour;
}

export function startOnboarding() {
    navHint.stop();
    getTour().start();
}

function bindWizardButton() {
    const trigger = document.getElementById('navWizardBtn');
    if (!trigger) return;
    trigger.addEventListener('click', (event) => {
        event.preventDefault();
        startOnboarding();
    });
}

export function resetOnboarding() {
    store.reset();
}

export async function initOnboarding(options) {
    const settings = options || {};
    if (!settings.force && store.hasSeen()) return false;

    const ready = await waitForElement(READY_SELECTORS, READY_TIMEOUT_MS);
    if (!ready) {
        // Abandon silencieux cote utilisateur, mais tracable: sans cela, une
        // visite qui ne demarre pas est indiscernable d'une visite deja vue.
        console.debug('[onboarding] vue EDA introuvable, visite non demarree');
        return false;
    }

    startOnboarding();
    return true;
}

function bootstrap() {
    bindWizardButton();
    initOnboarding().then((started) => {
        // L'indice de repli n'a de sens qu'une fois l'utilisateur seul aux commandes.
        if (!started) navHint.start();
    });
}

window.baltimoreOnboarding = {
    start: startOnboarding,
    reset: resetOnboarding,
    hasSeen: () => store.hasSeen(),
    status: () => ({
        seen: store.hasSeen(),
        ready: READY_SELECTORS.some((selector) => document.querySelector(selector) !== null),
        running: Boolean(tour) && tour.isRunning(),
    }),
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
} else {
    bootstrap();
}
