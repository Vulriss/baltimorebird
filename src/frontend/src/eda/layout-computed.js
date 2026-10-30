// Baltimore Bird - restauration des variables calculees d'un layout.
//
// Module pur et testable: resolution du mapping lettre -> signal source et ordonnancement
// des creations. Une variable peut dependre d'une autre variable calculee: on cree par
// passes successives jusqu'a ce qu'aucune nouvelle variable ne devienne creable.

// Lettres isolees A-Z utilisees par une formule, triees (meme convention que le drawer).
export function formulaLetters(formula) {
    return [...new Set(String(formula || '').match(/\b[A-Z]\b/g) || [])].sort();
}

// Ancien format (layout sans mapping): les lettres triees de la formule sont associees
// par position a source_signals. Ambigu si un slot etait defini sans etre utilise.
function legacyMapping(cv, letters) {
    const sources = Array.isArray(cv.source_signals) ? cv.source_signals : [];
    if (sources.length < letters.length) return null;
    const mapping = {};
    letters.forEach((letter, idx) => { mapping[letter] = sources[idx]; });
    return mapping;
}

/**
 * Resout le mapping a envoyer au backend pour recreer une variable du layout.
 * Le mapping enregistre fait foi; l'heuristique positionnelle ne sert qu'aux anciens layouts.
 * Seules les lettres utilisees par la formule sont transmises: un slot inutilise dont la
 * source manque ne doit pas bloquer la creation.
 *
 * @returns {{mapping: Object|null, missing: string[]}} mapping null si non resolvable.
 */
export function resolveComputedMapping(cv, availableNames) {
    const letters = formulaLetters(cv.formula);
    if (letters.length === 0) return { mapping: null, missing: [] };
    const saved = cv.mapping && typeof cv.mapping === 'object' && !Array.isArray(cv.mapping)
        && Object.keys(cv.mapping).length > 0 ? cv.mapping : null;
    const full = saved || legacyMapping(cv, letters);
    if (!full || letters.some(letter => typeof full[letter] !== 'string' || !full[letter])) {
        return { mapping: null, missing: [] };
    }
    const mapping = {};
    letters.forEach(letter => { mapping[letter] = full[letter]; });
    const missing = letters.map(letter => mapping[letter]).filter(name => !availableNames.has(name));
    return { mapping: missing.length ? null : mapping, missing };
}

/**
 * Recree les variables calculees absentes, dans un ordre compatible avec leurs dependances.
 *
 * @param {Array} computedVars variables du layout.
 * @param {Set<string>} availableNames noms deja disponibles dans le fichier courant.
 * @param {Function} create async (cv, mapping) => {ok: boolean, error?: string}.
 * @returns {Promise<{created: string[], failed: {name: string, reason: string}[]}>}
 */
export async function restoreComputedVariables(computedVars, availableNames, create) {
    const available = new Set(availableNames);
    const created = [];
    const failed = [];
    let pending = (computedVars || []).filter(cv => cv && cv.name && cv.formula && !available.has(cv.name));
    let progress = true;
    while (pending.length > 0 && progress) {
        progress = false;
        const next = [];
        for (const cv of pending) {
            const { mapping } = resolveComputedMapping(cv, available);
            if (!mapping) { next.push(cv); continue; }
            const result = await create(cv, mapping);
            if (result && result.ok) {
                available.add(cv.name);
                created.push(cv.name);
                progress = true;
            } else {
                failed.push({ name: cv.name, reason: (result && result.error) || 'création refusée' });
            }
        }
        pending = next;
    }
    for (const cv of pending) {
        const { missing } = resolveComputedMapping(cv, available);
        const reason = missing.length ? `signaux absents: ${missing.join(', ')}` : 'mapping incomplet';
        failed.push({ name: cv.name, reason });
    }
    return { created, failed };
}
