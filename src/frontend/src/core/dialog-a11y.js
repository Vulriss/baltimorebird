// Baltimore Bird - Comportement standard des boites de dialogue (modales et drawers)
// Piege le focus dans le conteneur, restaure le focus au declencheur a la fermeture,
// et ferme sur Echap. Un seul point de verite partage par les 4 dialogues de l'app
// (upload, auth, variable calculee, layouts) au lieu d'un cablage duplique par module.

const FOCUSABLE_SELECTOR = [
    'a[href]', 'button:not([disabled])', 'input:not([disabled])',
    'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])'
].join(', ');

function getFocusable(container) {
    return Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR))
        .filter(el => el.offsetParent !== null);
}

function resolveTarget(container, initialFocus) {
    if (typeof initialFocus === 'string') return container.querySelector(initialFocus);
    if (initialFocus instanceof HTMLElement) return initialFocus;
    return null;
}

/**
 * Active le comportement de dialogue sur un conteneur deja visible (classe 'active'
 * ajoutee par l'appelant): focus initial, piege du Tab, fermeture sur Echap.
 * @param {HTMLElement} container - Le conteneur du dialogue (modal-content ou drawer).
 * @param {{initialFocus?: string|HTMLElement, onEscape?: () => void}} [options]
 */
export function activateDialog(container, { initialFocus, onEscape } = {}) {
    if (!container) return;
    deactivateDialog(container);

    const state = { returnFocus: document.activeElement };
    const focusTarget = resolveTarget(container, initialFocus) || getFocusable(container)[0] || container;
    focusTarget.focus();

    state.keydown = (e) => {
        if (e.key === 'Escape') {
            if (onEscape) onEscape();
            return;
        }
        if (e.key !== 'Tab') return;
        const focusable = getFocusable(container);
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
        }
    };
    document.addEventListener('keydown', state.keydown);
    container._dialogA11y = state;
}

/**
 * Desactive le comportement cable par activateDialog et restaure le focus.
 * @param {HTMLElement} container - Le meme conteneur passe a activateDialog.
 */
export function deactivateDialog(container) {
    if (!container) return;
    const state = container._dialogA11y;
    if (!state) return;
    document.removeEventListener('keydown', state.keydown);
    if (state.returnFocus && document.contains(state.returnFocus) && typeof state.returnFocus.focus === 'function') {
        state.returnFocus.focus();
    }
    container._dialogA11y = null;
}
