// Baltimore Bird - Recherche lexicale de signaux: tokenisation, correspondance floue, score, surlignage
// Fonctions pures (sauf appendHighlighted qui ecrit dans un element fourni), sans etat global.

// Nature de chaque caractere du nom, calculee une fois par signal (buildEntry).
const INNER = 0;
const START = 1;
const SEP = 2;

// Paliers de score d'un terme. Les bonus internes a un palier restent sous l'ecart
// avec le palier superieur, bonus nom court compris.
const TIER_EXACT = 1000;
const TIER_PREFIX = 800;
const TIER_TOKEN = 600;
const TIER_SUBSTRING = 400;
const TIER_SUBSEQ = 200;
const TIER_TYPO = 100;
const TOKEN_END_BONUS = 30;
const SUBSEQ_BONUS_MAX = 150;
const SHORT_BONUS_MAX = 40;

// Longueur minimale d'un terme pour tolerer une faute de frappe.
const TYPO_MIN_LENGTH = 4;

const K_LOWER = 0;
const K_UPPER = 1;
const K_DIGIT = 2;
const K_SEP = 3;
const K_OTHER = 4;

function charKind(c) {
    if (c >= 97 && c <= 122) return K_LOWER;
    if (c >= 65 && c <= 90) return K_UPPER;
    if (c >= 48 && c <= 57) return K_DIGIT;
    // _ . [ ] ( ) espace tabulation - / :
    if (c === 95 || c === 46 || c === 91 || c === 93 || c === 40 || c === 41
        || c === 32 || c === 9 || c === 45 || c === 47 || c === 58) return K_SEP;
    return K_OTHER;
}

// Minuscules de meme longueur que l'original: les positions de correspondance
// servent telles quelles au surlignage du nom d'origine.
function lowerSameLength(s) {
    const lower = s.toLowerCase();
    if (lower.length === s.length) return lower;
    let out = '';
    for (let i = 0; i < s.length; i++) {
        const c = s[i].toLowerCase();
        out += c.length === 1 ? c : s[i];
    }
    return out;
}

/**
 * Precalcule la forme indexee d'un nom de signal.
 *
 * Debuts de token: apres un separateur, transition minuscule -> majuscule
 * (camelCase), derniere majuscule d'un sigle suivie d'une minuscule (ABSSpd),
 * frontiere lettre/chiffre.
 *
 * @param {string} name Nom du signal.
 * @returns {{name: string, lower: string, starts: Uint8Array}} Entree d'index.
 */
export function buildEntry(name) {
    const raw = name == null ? '' : String(name);
    const n = raw.length;
    const starts = new Uint8Array(n);
    let prev = K_SEP;
    for (let i = 0; i < n; i++) {
        const kind = charKind(raw.charCodeAt(i));
        if (kind === K_SEP) {
            starts[i] = SEP;
        } else {
            const isDigit = kind === K_DIGIT;
            let start = prev === K_SEP || isDigit !== (prev === K_DIGIT);
            if (!start && kind === K_UPPER) {
                if (prev === K_LOWER || prev === K_OTHER) start = true;
                else if (prev === K_UPPER && i + 1 < n && charKind(raw.charCodeAt(i + 1)) === K_LOWER) start = true;
            }
            starts[i] = start ? START : INNER;
        }
        prev = kind;
    }
    return { name: raw, lower: lowerSameLength(raw), starts };
}

/**
 * Decoupe un nom en tokens minuscules (camelCase, _, ., [, ], chiffres/lettres).
 *
 * @param {string} name Nom du signal.
 * @returns {string[]} Tokens, `VehSpd_kph` -> `['veh', 'spd', 'kph']`.
 */
export function tokenize(name) {
    const { lower, starts } = buildEntry(name);
    const tokens = [];
    let from = -1;
    for (let i = 0; i <= lower.length; i++) {
        const s = i < lower.length ? starts[i] : SEP;
        if (s !== INNER && from !== -1) {
            tokens.push(lower.slice(from, i));
            from = -1;
        }
        if (s === START) from = i;
    }
    return tokens;
}

/**
 * Met l'index a jour pour une liste de signaux. Seules les entrees dont le nom a
 * change sont recalculees, l'appel est donc bon marche a chaque frappe.
 *
 * @param {Array<Object>|null} index Index precedent (ou null).
 * @param {Array<{name: string}>} signals Signaux, dans l'ordre de la liste.
 * @returns {Array<Object>} Index aligne sur `signals`.
 */
export function syncSearchIndex(index, signals) {
    const out = index && index.length === signals.length ? index : new Array(signals.length);
    for (let i = 0; i < signals.length; i++) {
        const name = signals[i] && signals[i].name != null ? String(signals[i].name) : '';
        const prev = index ? index[i] : null;
        out[i] = prev && prev.name === name ? prev : buildEntry(name);
    }
    return out;
}

/**
 * Analyse la requete: termes separes par espaces ou `*`, `-terme` exclut.
 *
 * @param {string} query Saisie brute.
 * @returns {{include: string[], exclude: string[], empty: boolean}} Requete analysee.
 */
export function parseQuery(query) {
    const include = [];
    const exclude = [];
    const parts = String(query || '').toLowerCase().split(/[*\s]+/);
    for (const part of parts) {
        if (!part) continue;
        if (part[0] === '-') {
            if (part.length > 1) exclude.push(part.slice(1));
        } else {
            include.push(part);
        }
    }
    return { include, exclude, empty: include.length === 0 && exclude.length === 0 };
}

function isTokenEnd(starts, end) {
    return end >= starts.length || starts[end] !== INNER;
}

// Compare t[tFrom..] avec lower a partir de pos.
function matchesAt(lower, t, tFrom, pos) {
    const len = t.length - tFrom;
    if (pos < 0 || pos + len > lower.length) return false;
    for (let k = 0; k < len; k++) {
        if (lower.charCodeAt(pos + k) !== t.charCodeAt(tFrom + k)) return false;
    }
    return true;
}

let scratchA = new Int32Array(64);
let scratchB = new Int32Array(64);

// Sous-sequence depuis `first`. preferBoundary: quand le caractere suivant n'est pas
// contigu, viser d'abord un debut de token. Ecrit les positions dans pos.
function subsequenceFrom(lower, starts, t, first, preferBoundary, pos) {
    const n = lower.length;
    const m = t.length;
    pos[0] = first;
    let p = first + 1;
    for (let j = 1; j < m; j++) {
        const c = t.charCodeAt(j);
        let found = -1;
        if (p < n && lower.charCodeAt(p) === c) {
            found = p;
        } else {
            if (preferBoundary) {
                for (let k = p; k < n; k++) {
                    if (starts[k] === START && lower.charCodeAt(k) === c) { found = k; break; }
                }
            }
            if (found === -1) {
                for (let k = p; k < n; k++) {
                    if (lower.charCodeAt(k) === c) { found = k; break; }
                }
            }
        }
        if (found === -1) return false;
        pos[j] = found;
        p = found + 1;
    }
    return true;
}

function subsequenceBonus(starts, pos, m) {
    let hits = 0;
    let contiguous = 0;
    for (let j = 0; j < m; j++) {
        if (starts[pos[j]] === START) hits++;
        if (j > 0 && pos[j] === pos[j - 1] + 1) contiguous++;
    }
    const gap = pos[m - 1] - pos[0] + 1 - m;
    const bonus = hits * 30 + contiguous * 15 - gap;
    return bonus < 0 ? 0 : (bonus > SUBSEQ_BONUS_MAX ? SUBSEQ_BONUS_MAX : bonus);
}

// Meilleure sous-sequence dont le premier caractere tombe sur un debut de token.
function matchSubsequence(entry, t, out) {
    const { lower, starts } = entry;
    const n = lower.length;
    const m = t.length;
    if (scratchA.length < m) {
        scratchA = new Int32Array(m);
        scratchB = new Int32Array(m);
    }
    const c0 = t.charCodeAt(0);
    let best = -1;
    let bestFirst = -1;
    let bestBoundary = false;
    for (let k = 0; k < n; k++) {
        if (starts[k] !== START || lower.charCodeAt(k) !== c0) continue;
        let score = -1;
        let boundary = true;
        if (subsequenceFrom(lower, starts, t, k, true, scratchA)) {
            score = subsequenceBonus(starts, scratchA, m);
        }
        if (subsequenceFrom(lower, starts, t, k, false, scratchB)) {
            const plain = subsequenceBonus(starts, scratchB, m);
            if (plain > score) { score = plain; boundary = false; }
        } else {
            // Si le glouton simple echoue depuis k, il echouera depuis tout k' > k.
            break;
        }
        if (score > best) { best = score; bestFirst = k; bestBoundary = boundary; }
    }
    if (best < 0) return -1;
    if (out) {
        subsequenceFrom(lower, starts, t, bestFirst, bestBoundary, scratchA);
        let runStart = scratchA[0];
        for (let j = 1; j <= m; j++) {
            if (j === m || scratchA[j] !== scratchA[j - 1] + 1) {
                out.push(runStart, scratchA[j - 1] + 1);
                if (j < m) runStart = scratchA[j];
            }
        }
    }
    return TIER_SUBSEQ + best;
}

// Correspondance a une faute pres (substitution, insertion, suppression,
// transposition) ancree en i. Renvoie la fin de la plage, ou -1.
function approxAt(lower, t, i) {
    const n = lower.length;
    const m = t.length;
    let j = 0;
    while (j < m && i + j < n && lower.charCodeAt(i + j) === t.charCodeAt(j)) j++;
    if (j === m) return i + m;
    const p = i + j;
    if (p < n && matchesAt(lower, t, j + 1, p + 1)) return p + m - j;
    if (matchesAt(lower, t, j + 1, p)) return p + m - j - 1;
    if (p < n && matchesAt(lower, t, j, p + 1)) return p + 1 + m - j;
    if (j + 1 < m && p + 1 < n
        && lower.charCodeAt(p) === t.charCodeAt(j + 1)
        && lower.charCodeAt(p + 1) === t.charCodeAt(j)
        && matchesAt(lower, t, j + 2, p + 2)) return i + m;
    return -1;
}

function matchTypo(entry, t, out) {
    const { lower, starts } = entry;
    for (let i = 0; i < lower.length; i++) {
        if (starts[i] !== START) continue;
        const end = approxAt(lower, t, i);
        if (end > i) {
            if (out) out.push(i, end);
            return TIER_TYPO;
        }
    }
    return -1;
}

/**
 * Score d'un terme contre une entree, par palier: exact, prefixe du nom, debut
 * de token, sous-chaine, sous-sequence, une faute (termes de 4+ caracteres).
 *
 * @param {{lower: string, starts: Uint8Array}} entry Entree d'index.
 * @param {string} t Terme en minuscules.
 * @param {number[]|null} out Si fourni, recoit les plages [debut, fin) trouvees.
 * @returns {number} Score, ou -1 sans correspondance.
 */
export function matchTerm(entry, t, out) {
    const { lower, starts } = entry;
    const m = t.length;
    let pos = lower.indexOf(t);
    if (pos !== -1) {
        if (pos === 0) {
            if (out) out.push(0, m);
            if (m === lower.length) return TIER_EXACT;
            return TIER_PREFIX + (isTokenEnd(starts, m) ? TOKEN_END_BONUS : 0);
        }
        const firstPos = pos;
        let best = -1;
        let bestPos = -1;
        while (pos !== -1) {
            if (starts[pos] === START) {
                const s = TIER_TOKEN + (isTokenEnd(starts, pos + m) ? TOKEN_END_BONUS : 0);
                if (s > best) { best = s; bestPos = pos; }
                if (s === TIER_TOKEN + TOKEN_END_BONUS) break;
            }
            pos = lower.indexOf(t, pos + 1);
        }
        if (best < 0) { best = TIER_SUBSTRING; bestPos = firstPos; }
        if (out) out.push(bestPos, bestPos + m);
        return best;
    }
    const sub = matchSubsequence(entry, t, out);
    if (sub >= 0) return sub;
    if (m >= TYPO_MIN_LENGTH) return matchTypo(entry, t, out);
    return -1;
}

function shortBonus(length) {
    return SHORT_BONUS_MAX * 16 / (16 + length);
}

/**
 * Score cumule d'une entree pour une requete (termes en ET).
 *
 * @param {{lower: string, starts: Uint8Array}} entry Entree d'index.
 * @param {{include: string[], exclude: string[]}} parsed Requete analysee.
 * @returns {number} Score, 0 si la requete n'a que des exclusions, -1 si rejetee.
 */
export function scoreEntry(entry, parsed) {
    const lower = entry.lower;
    const exclude = parsed.exclude;
    for (let i = 0; i < exclude.length; i++) {
        if (lower.indexOf(exclude[i]) !== -1) return -1;
    }
    const include = parsed.include;
    if (!include.length) return 0;
    let total = 0;
    for (let i = 0; i < include.length; i++) {
        const s = matchTerm(entry, include[i], null);
        if (s < 0) return -1;
        total += s;
    }
    return total + shortBonus(lower.length);
}

/**
 * Filtre et classe l'index. Ordre: entrees epinglees d'abord, puis score
 * decroissant, puis ordre d'origine.
 *
 * @param {Array<Object>} index Index (cf. syncSearchIndex).
 * @param {{include: string[], exclude: string[]}} parsed Requete analysee.
 * @param {function(number): boolean} [isPinned] Epinglage par position.
 * @returns {number[]} Positions retenues, classees.
 */
export function rankEntries(index, parsed, isPinned) {
    const n = index.length;
    const scores = new Float64Array(n);
    const pinned = new Uint8Array(n);
    const order = [];
    for (let i = 0; i < n; i++) {
        const s = scoreEntry(index[i], parsed);
        if (s < 0) continue;
        scores[i] = s;
        if (isPinned && isPinned(i)) pinned[i] = 1;
        order.push(i);
    }
    order.sort((a, b) => (pinned[b] - pinned[a]) || (scores[b] - scores[a]) || (a - b));
    return order;
}

/**
 * Plages de caracteres a surligner, fusionnees et triees.
 *
 * @param {{lower: string, starts: Uint8Array}} entry Entree d'index.
 * @param {{include: string[]}} parsed Requete analysee.
 * @returns {number[]} Plages a plat: [debut0, fin0, debut1, fin1, ...].
 */
export function matchRanges(entry, parsed) {
    const raw = [];
    for (const t of parsed.include) matchTerm(entry, t, raw);
    const pairs = [];
    for (let i = 0; i < raw.length; i += 2) pairs.push([raw[i], raw[i + 1]]);
    pairs.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const [s, e] of pairs) {
        const last = merged.length - 1;
        if (merged.length && s <= merged[last]) {
            if (e > merged[last]) merged[last] = e;
        } else {
            merged.push(s, e);
        }
    }
    return merged;
}

/**
 * Remplit un element avec le texte, les plages en <mark class="signal-match">.
 * Uniquement des noeuds texte: aucun HTML n'est interprete.
 *
 * @param {HTMLElement} el Element cible (son contenu est remplace).
 * @param {string} text Texte a afficher.
 * @param {number[]} ranges Plages a plat, triees et disjointes.
 */
export function appendHighlighted(el, text, ranges) {
    el.textContent = '';
    let cursor = 0;
    for (let i = 0; i < ranges.length; i += 2) {
        const s = ranges[i];
        const e = ranges[i + 1];
        if (s > cursor) el.appendChild(document.createTextNode(text.slice(cursor, s)));
        const mark = document.createElement('mark');
        mark.className = 'signal-match';
        mark.textContent = text.slice(s, e);
        el.appendChild(mark);
        cursor = e;
    }
    if (cursor < text.length) el.appendChild(document.createTextNode(text.slice(cursor)));
}
