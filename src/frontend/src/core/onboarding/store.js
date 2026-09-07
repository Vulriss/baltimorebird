// Persistance de l'etat de la visite. Seul module qui connait localStorage:
// le reste du parcours ne manipule que hasSeen / markSeen / reset.

import { ONBOARDING_VERSION } from './steps.js';

const STORAGE_KEY = 'bb.onboarding';

function createMemoryStorage() {
    const map = new Map();
    return {
        getItem: (key) => (map.has(key) ? map.get(key) : null),
        setItem: (key, value) => map.set(key, String(value)),
        removeItem: (key) => map.delete(key),
    };
}

// Navigation privee et stockage desactive levent des l'ecriture: on bascule
// alors en memoire, la visite reste utilisable sur la session courante.
function resolveStorage() {
    try {
        const probe = `${STORAGE_KEY}.probe`;
        window.localStorage.setItem(probe, '1');
        window.localStorage.removeItem(probe);
        return window.localStorage;
    } catch (e) {
        return createMemoryStorage();
    }
}

export function createOnboardingStore(options) {
    const settings = options || {};
    const storage = settings.storage || resolveStorage();
    const version = settings.version || ONBOARDING_VERSION;
    const key = settings.key || STORAGE_KEY;

    function read() {
        try {
            const raw = storage.getItem(key);
            return raw ? JSON.parse(raw) : null;
        } catch (e) {
            return null;
        }
    }

    function write(record) {
        try {
            storage.setItem(key, JSON.stringify(record));
        } catch (e) {
            // La visite ne doit jamais echouer sur un probleme de stockage.
        }
    }

    return {
        // Vrai uniquement si la version vue correspond a la version courante:
        // une evolution du parcours reproposera la visite.
        hasSeen() {
            const record = read();
            return Boolean(record) && record.version === version;
        },

        markSeen(status, stepId) {
            write({ version, status, stepId: stepId || null, at: new Date().toISOString() });
        },

        reset() {
            try {
                storage.removeItem(key);
            } catch (e) {
                // Idem: echec silencieux.
            }
        },
    };
}
