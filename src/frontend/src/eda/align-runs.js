// Baltimore Bird - Auto-alignement temporel des runs (correlation croisee)
// Module extrait de app.js (refactoring): voir src/eda/ARCHITECTURE.md

import { S } from '../core/state.js';
import { estimateOffset } from './align.js';
import { notify } from './analysis.js';
import { API } from './context.js';
import { isSeriesSynth, seriesDescriptor } from './overlay.js';
import { fetchViewData } from './render.js';
import { setRunOffset } from './runs.js';

// =========================================================================
// Auto-alignement temporel des runs (correlation croisee sur un signal commun)
// =========================================================================

// Signal de reference de l'alignement: en priorite une serie overlay deja tracee dont
// le nom existe dans les deux runs, sinon un signal reel trace commun aux deux.
function pickAlignmentSignal(refRun, targetRun) {
    const commonTo = (name) => !!name
        && refRun.nameToIndex && refRun.nameToIndex.has(name)
        && targetRun.nameToIndex && targetRun.nameToIndex.has(name);

    for (const plot of S.plots) {
        for (const key of plot.signals) {
            if (isSeriesSynth(key) && commonTo(seriesDescriptor(key).name)) {
                return seriesDescriptor(key).name;
            }
        }
    }
    for (const plot of S.plots) {
        for (const key of plot.signals) {
            if (!isSeriesSynth(key) && commonTo(S.signalsInfo[key]?.name)) {
                return S.signalsInfo[key].name;
            }
        }
    }
    return null;
}

// Retourne la paire de signaux a correler: d'abord un signal commun aux deux runs (meme
// nom), sinon, faute de signal 2/2, un signal de chaque run traces sur un meme strip (noms
// potentiellement differents representant la meme grandeur). Retourne null si aucun.
function pickAlignmentPair(refRun, targetRun) {
    const commonName = pickAlignmentSignal(refRun, targetRun);
    if (commonName) {
        return {
            refName: commonName, refIndex: refRun.nameToIndex.get(commonName),
            tgtName: commonName, tgtIndex: targetRun.nameToIndex.get(commonName),
        };
    }

    for (const plot of S.plots) {
        let ref = null;
        let tgt = null;
        for (const key of plot.signals) {
            if (!isSeriesSynth(key)) continue;
            const d = seriesDescriptor(key);
            if (!ref && d.sessionId === refRun.sessionId && refRun.nameToIndex?.has(d.name)) {
                ref = { name: d.name, index: refRun.nameToIndex.get(d.name) };
            } else if (!tgt && d.sessionId === targetRun.sessionId && targetRun.nameToIndex?.has(d.name)) {
                tgt = { name: d.name, index: targetRun.nameToIndex.get(d.name) };
            }
        }
        if (ref && tgt) {
            return { refName: ref.name, refIndex: ref.index, tgtName: tgt.name, tgtIndex: tgt.index };
        }
    }
    return null;
}

async function fetchAlignmentSeries(sessionId, signalIndex) {
    let url = `${API}/view?signals=${signalIndex}&start=0&end=0&max_points=8192`
        + `&session_id=${encodeURIComponent(sessionId)}&format=bin`;
    const headers = {};
    const token = sessionStorage.getItem('auth_token');
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const data = await fetchViewData(url, headers);
    const sig = data && data.signals && data.signals[0];
    return sig && sig.timestamps.length ? sig : null;
}

// Aligne un run sur le run de reference: correlation croisee normalisee du signal
// commun (invariante au gain et a l'offset d'amplitude), offset applique via
// setRunOffset. Le score est expose a l'utilisateur - un contenu periodique rend
// l'alignement ambigu modulo la periode, le champ manuel reste l'arbitre final.
async function autoAlignRun(sessionId) {
    const refRun = S.runs.find(r => r.ref);
    const targetRun = S.runs.find(r => r.sessionId === sessionId);
    if (!refRun || !targetRun || refRun.sessionId === sessionId) return null;

    const pair = pickAlignmentPair(refRun, targetRun);
    const name = pair
        ? (pair.refName === pair.tgtName ? pair.refName : `${pair.refName}" / "${pair.tgtName}`)
        : null;
    if (!name) {
        notify('Tracez un signal commun aux deux runs, ou un signal de chaque run sur un meme strip, pour aligner.', 'warning');
        return null;
    }

    const [refSig, tgtSig] = await Promise.all([
        fetchAlignmentSeries(refRun.sessionId, pair.refIndex),
        fetchAlignmentSeries(targetRun.sessionId, pair.tgtIndex),
    ]);
    if (!refSig || !tgtSig) {
        notify("Series d'alignement indisponibles.", 'error');
        return null;
    }

    const result = estimateOffset(refSig.timestamps, refSig.values, tgtSig.timestamps, tgtSig.values);
    if (!result) {
        notify(`Alignement impossible sur "${name}" (signal trop plat ou recouvrement insuffisant).`, 'warning');
        return null;
    }

    const offset = Math.round(result.offset * 1000) / 1000;
    setRunOffset(sessionId, offset);
    notify(
        `Aligne sur "${name}": \u0394t = ${offset.toFixed(3)} s`
        + ` (correlation ${result.score.toFixed(2)}${result.score < 0.7 ? ', faible - verifier' : ''})`,
        result.score >= 0.7 ? 'success' : 'warning'
    );
    if (typeof window.bbTrack === 'function') window.bbTrack('auto_align');
    return { offset, score: result.score, name };
}

window.autoAlignRun = (sid) => autoAlignRun(sid);

