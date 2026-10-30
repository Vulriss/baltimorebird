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
 * Une variable deja presente comme variable calculee est ignoree; un signal brut du fichier
 * portant le meme nom est un conflit (sinon les graphes afficheraient le signal brut a la
 * place de la variable, sans avertissement).
 *
 * @param {Array} computedVars variables du layout.
 * @param {Array<{name: string, computed?: boolean}>} signals signaux du fichier courant.
 * @param {Function} create async (cv, mapping) => {ok: boolean, error?: string}.
 * @returns {Promise<{created: string[], failed: {name: string, reason: string, definition: Object}[]}>}
 */
export async function restoreComputedVariables(computedVars, signals, create) {
    const available = new Set((signals || []).map(sig => sig.name));
    const alreadyComputed = new Set((signals || []).filter(sig => sig.computed).map(sig => sig.name));
    const created = [];
    const failed = [];
    let pending = [];
    for (const cv of computedVars || []) {
        if (!cv || !cv.name || !cv.formula || alreadyComputed.has(cv.name)) continue;
        if (available.has(cv.name)) {
            failed.push({ name: cv.name, reason: 'nom déjà utilisé par un signal du fichier', definition: cv });
        } else {
            pending.push(cv);
        }
    }
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
                failed.push({ name: cv.name, reason: (result && result.error) || 'création refusée', definition: cv });
            }
        }
        pending = next;
    }
    for (const cv of pending) {
        const { missing } = resolveComputedMapping(cv, available);
        const reason = missing.length ? `signaux absents: ${missing.join(', ')}` : 'mapping incomplet';
        failed.push({ name: cv.name, reason, definition: cv });
    }
    return { created, failed };
}

/**
 * Definitions a exporter: variables calculees du fichier courant (mapping explicite inclus),
 * puis definitions non recreees du dernier layout applique, pour qu'un aller-retour A -> B -> A
 * ne les perde pas.
 */
export function exportComputedVariables(signals, unresolved) {
    const exported = (signals || [])
        .filter(sig => sig.computed)
        .map(sig => {
            const cv = {
                name: sig.name,
                unit: sig.unit || '',
                description: sig.description || '',
                formula: sig.formula || '',
                source_signals: sig.source_signals || [],
            };
            if (sig.mapping && Object.keys(sig.mapping).length > 0) cv.mapping = { ...sig.mapping };
            return cv;
        });
    const names = new Set(exported.map(cv => cv.name));
    for (const cv of unresolved || []) {
        if (cv && cv.name && !names.has(cv.name)) {
            exported.push(cv);
            names.add(cv.name);
        }
    }
    return exported;
}

// Message utilisateur listant les variables non recreees et leur cause.
export function formatRestoreFailures(failed) {
    if (!failed || failed.length === 0) return '';
    const shown = failed.slice(0, 3).map(f => `${f.name} (${f.reason})`).join('; ');
    const extra = failed.length > 3 ? ` (+${failed.length - 3})` : '';
    return `${failed.length} variable(s) calculée(s) non recréée(s): ${shown}${extra}`;
}
