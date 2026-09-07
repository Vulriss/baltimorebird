// Resolution des cibles declarees dans steps.js vers des elements reellement
// visibles. Les boutons d'upload alternent selon l'etat d'authentification
// (data-auth), la legende n'existe qu'une fois un graphique cree: la premiere
// entree exploitable de la liste gagne, sinon la cible est ignoree.

const MIN_VISIBLE_SIZE = 4;

export function isVisible(element) {
    if (!element || !element.getBoundingClientRect) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width < MIN_VISIBLE_SIZE || rect.height < MIN_VISIBLE_SIZE) return false;
    const style = window.getComputedStyle(element);
    // parseFloat plutot que Number: une valeur calculee absente donne NaN, pas 0,
    // et ne doit pas faire passer un element visible pour masque.
    const opacity = Number.parseFloat(style.opacity);
    return style.visibility !== 'hidden' && style.display !== 'none' && opacity !== 0;
}

export function resolveElement(selectors, root) {
    const scope = root || document;
    for (let i = 0; i < selectors.length; i += 1) {
        const candidate = scope.querySelector(selectors[i]);
        if (isVisible(candidate)) return candidate;
    }
    return null;
}

// Retourne les cibles d'une etape enrichies de leur element. Les cibles
// introuvables sont ecartees: l'etape reste affichable sans sa fleche.
export function resolveTargets(step, root) {
    if (!step || !step.targets) return [];
    return step.targets
        .map((target) => ({ ...target, element: resolveElement(target.selectors, root) }))
        .filter((target) => target.element !== null);
}

export function waitForElement(selectors, timeoutMs) {
    const existing = resolveElement(selectors);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve) => {
        let timer = 0;
        const observer = new MutationObserver(() => {
            const found = resolveElement(selectors);
            if (!found) return;
            window.clearTimeout(timer);
            observer.disconnect();
            resolve(found);
        });

        observer.observe(document.body, { childList: true, subtree: true });
        timer = window.setTimeout(() => {
            observer.disconnect();
            resolve(null);
        }, timeoutMs);
    });
}
