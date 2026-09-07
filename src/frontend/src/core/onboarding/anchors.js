// Resolution des cibles declarees dans steps.js vers des elements reellement
// visibles. Les boutons d'upload alternent selon l'etat d'authentification
// (data-auth), la legende n'existe qu'une fois un graphique cree: la premiere
// entree exploitable de la liste gagne, sinon la cible est ignoree.

const MIN_VISIBLE_SIZE = 4;
const POLL_INTERVAL_MS = 200;

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

export function resolveElements(selectors, root) {
    const scope = root || document;
    return selectors
        .map((selector) => Array.from(scope.querySelectorAll(selector)))
        .reduce((all, found) => all.concat(found), [])
        .filter(isVisible);
}

// Rectangle englobant: deux boutons voisins forment une seule zone a designer,
// sinon on obtient deux fleches superposees et deux libelles qui se chevauchent.
export function unionRect(elements) {
    const rects = elements.map((element) => element.getBoundingClientRect());
    if (rects.length === 0) return null;
    const left = Math.min(...rects.map((r) => r.left));
    const top = Math.min(...rects.map((r) => r.top));
    const right = Math.max(...rects.map((r) => r.right));
    const bottom = Math.max(...rects.map((r) => r.bottom));
    return { left, top, right, bottom, width: right - left, height: bottom - top };
}

// Retourne les cibles d'une etape enrichies de leurs elements. Une cible groupee
// reunit tous les elements correspondants; sinon seule la premiere entree
// exploitable de la liste est retenue. Les cibles introuvables sont ecartees:
// l'etape reste affichable sans sa fleche.
export function resolveTargets(step, root) {
    if (!step || !step.targets) return [];
    return step.targets
        .map((target) => {
            if (target.group) return { ...target, elements: resolveElements(target.selectors, root) };
            const element = resolveElement(target.selectors, root);
            return { ...target, elements: element ? [element] : [] };
        })
        .filter((target) => target.elements.length > 0);
}

// Zones a garder lisibles sous le voile. Contrairement aux cibles, toutes les
// correspondances comptent, et les modales ouvertes par l'application sont
// revelees d'office: sans cela, la boite d'upload s'ouvre sous le voile.
const ALWAYS_REVEALED = ['.modal-overlay.active'];

export function resolveReveals(step, root) {
    const selectors = (step && step.reveal ? step.reveal : []).concat(ALWAYS_REVEALED);
    return resolveElements(selectors, root);
}

export function waitForElement(selectors, timeoutMs) {
    // Disponibilite = presence dans le DOM, pas visibilite: la vue est injectee
    // par innerHTML puis mise en page, et exiger un rectangle non nul ici fait
    // rater la fenetre. La visibilite reste exigee pour les ancres de fleche.
    const present = () => selectors
        .map((selector) => document.querySelector(selector))
        .find((element) => element !== null) || null;

    const existing = present();
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve) => {
        let timer = 0;
        let poll = 0;
        let observer = null;

        function settle(element) {
            window.clearTimeout(timer);
            window.clearInterval(poll);
            if (observer) observer.disconnect();
            resolve(element);
        }

        function check() {
            const found = present();
            if (found) settle(found);
        }

        // Observateur et scrutation combines: l'observateur reagit dans la
        // milliseconde, la scrutation couvre les mises a jour qui ne produisent
        // aucune mutation observable dans document.body.
        observer = new MutationObserver(check);
        observer.observe(document.body, { childList: true, subtree: true, attributes: true });
        poll = window.setInterval(check, POLL_INTERVAL_MS);
        timer = window.setTimeout(() => settle(null), timeoutMs);
    });
}
