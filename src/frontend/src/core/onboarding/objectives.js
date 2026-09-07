// Objectifs d'etape: une etape interactive est accomplie quand l'utilisateur a
// reellement agi dans l'application. Les etapes declarent la condition, jamais
// le code qui la teste, ce qui garde steps.js sans dependance au DOM.

const CONDITIONS = {
    // Un fichier est charge: le selecteur de source porte une valeur.
    'has-value': (element) => Boolean(element && element.value),
    // Une recherche est saisie.
    'non-empty-value': (element) => Boolean(element && element.value && element.value.trim().length > 0),
    // Au moins un element correspondant existe dans le DOM.
    exists: (element) => element !== null,
};

function firstMatch(selectors) {
    for (let i = 0; i < selectors.length; i += 1) {
        const found = document.querySelector(selectors[i]);
        if (found) return found;
    }
    return null;
}

export function evaluate(watch) {
    if (!watch) return false;
    const test = CONDITIONS[watch.condition];
    if (!test) return false;
    return test(firstMatch(watch.selectors));
}

// Surveille la condition et notifie une seule fois. Les ecouteurs sont poses en
// capture sur document: la cible peut etre remplacee par un rechargement de vue
// sans que la surveillance ne soit perdue.
export function createObjective(watch, onDone) {
    if (!watch) return { check: () => false, stop: () => {} };

    const events = watch.events || ['change'];
    let done = false;

    function check() {
        if (done || !evaluate(watch)) return false;
        done = true;
        stop();
        onDone();
        return true;
    }

    function stop() {
        events.forEach((name) => document.removeEventListener(name, check, true));
    }

    events.forEach((name) => document.addEventListener(name, check, true));
    return { check, stop };
}

// Applique une suggestion: remplit un champ et notifie l'application comme le
// ferait une saisie manuelle.
export function applySuggestion(suggestion) {
    if (!suggestion) return false;
    const target = firstMatch(suggestion.selectors);
    if (!target) return false;

    target.value = suggestion.value;
    // window.Event et non le constructeur global: l'evenement doit appartenir au
    // meme realm que l'element, sinon dispatchEvent le rejette.
    target.dispatchEvent(new window.Event(suggestion.event || 'input', { bubbles: true }));
    if (typeof target.focus === 'function') target.focus();
    return true;
}
