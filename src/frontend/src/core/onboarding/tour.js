// Orchestration de la visite: enchainement des etapes, synchronisation du
// calque avec la geometrie courante et cloture. Toutes les collaborations sont
// injectees, ce qui permet de tester le parcours sans DOM reel.

import { FINISH_STEP, LABELS, TOUR_STEPS, WELCOME_STEP } from './steps.js';
import { resolveTargets } from './anchors.js';

const WELCOME_INDEX = -1;

function noop() {}

function noopCleanup() {
    return () => {};
}

export function createOnboardingTour(dependencies) {
    const deps = dependencies || {};
    const store = deps.store;
    const overlay = deps.overlay;
    const panel = deps.panel;
    const steps = deps.steps || TOUR_STEPS;
    const welcome = deps.welcome || WELCOME_STEP;
    const finish = deps.finish || FINISH_STEP;
    const resolve = deps.resolveTargets || resolveTargets;
    const track = deps.track || noop;
    const celebrate = deps.celebrate || noopCleanup;

    let index = WELCOME_INDEX;
    let running = false;
    let frame = 0;
    let currentTargets = [];
    let stopCelebration = null;

    const finishIndex = () => steps.length;

    function currentStep() {
        if (index === WELCOME_INDEX) return welcome;
        return index >= steps.length ? finish : steps[index];
    }

    function kindFor(position) {
        if (position === WELCOME_INDEX) return 'welcome';
        return position >= steps.length ? 'finish' : 'step';
    }

    function paint() {
        frame = 0;
        if (!running) return;
        const targets = currentTargets
            .map((target) => ({ ...target, rect: target.element.getBoundingClientRect() }));
        overlay.update(targets, currentTargets.length ? panel.cardRect() : null);
    }

    function schedule() {
        if (frame || !running) return;
        frame = window.requestAnimationFrame(paint);
    }

    function onKeydown(event) {
        if (event.key === 'Escape') {
            event.preventDefault();
            stop(index >= finishIndex() ? 'completed' : 'skipped');
        } else if (event.key === 'ArrowRight') {
            goTo(index + 1);
        } else if (event.key === 'ArrowLeft' && index > WELCOME_INDEX) {
            goTo(index - 1);
        }
    }

    function bindViewportListeners(bind) {
        const method = bind ? 'addEventListener' : 'removeEventListener';
        window[method]('resize', schedule);
        window[method]('scroll', schedule, true);
        document[method]('keydown', onKeydown, true);
    }

    function nextLabel() {
        const upcoming = steps[index + 1];
        return upcoming ? LABELS.next(upcoming.shortTitle) : LABELS.finish;
    }

    function goTo(target) {
        if (!running) return;
        if (target > finishIndex()) {
            stop('completed');
            return;
        }

        index = Math.max(WELCOME_INDEX, target);
        const step = currentStep();
        const kind = kindFor(index);
        currentTargets = kind === 'step' ? resolve(step) : [];

        if (kind === 'finish' && !stopCelebration) stopCelebration = celebrate();

        panel.render({
            step,
            kind,
            index,
            total: steps.length,
            canGoBack: index > WELCOME_INDEX,
            nextLabel: kind === 'step' ? nextLabel() : step.primaryLabel,
        });

        // La carte change de place selon l'etape: le calque est recalcule apres
        // la mise en page, pas pendant.
        schedule();
    }

    function stop(status) {
        if (!running) return;
        running = false;
        if (frame) {
            window.cancelAnimationFrame(frame);
            frame = 0;
        }
        bindViewportListeners(false);
        if (stopCelebration) {
            stopCelebration();
            stopCelebration = null;
        }
        overlay.clear();
        panel.unmount();
        store.markSeen(status, currentStep().id);
        track(status === 'completed' ? 'onboarding_completed' : 'onboarding_skipped');
        index = WELCOME_INDEX;
        currentTargets = [];
    }

    function handleAction(action) {
        if (action === 'next') goTo(index + 1);
        else if (action === 'previous') goTo(index - 1);
        else if (action === 'skip') stop(index >= finishIndex() ? 'completed' : 'skipped');
    }

    return {
        start() {
            if (running) return;
            running = true;
            index = WELCOME_INDEX;
            panel.onAction(handleAction);
            panel.mount(overlay.element);
            bindViewportListeners(true);
            track('onboarding_started');
            goTo(WELCOME_INDEX);
        },

        stop,

        isRunning() {
            return running;
        },
    };
}
