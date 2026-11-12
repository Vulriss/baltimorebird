// Baltimore Bird - Zones booleennes etendues (fond colore derriere les analogiques)
// Module extrait de app.js (refactoring): voir src/eda/ARCHITECTURE.md

import { S } from '../core/state.js';
import { ectx } from './context.js';
import { colorWithOpacity } from './plots.js';

export function extractBoolHighRanges(timestamps, values, threshold = 0.5) {
    const ranges = [];
    let inHigh = false;
    let rangeStart = null;
    
    for (let i = 0; i < timestamps.length; i++) {
        const isHigh = values[i] > threshold;
        
        if (isHigh && !inHigh) {
            // Début d'une zone high
            rangeStart = timestamps[i];
            inHigh = true;
        } else if (!isHigh && inHigh) {
            // Fin d'une zone high
            ranges.push([rangeStart, timestamps[i]]);
            inHigh = false;
        }
    }
    
    // Si on termine en high, fermer la dernière range
    if (inHigh && rangeStart !== null) {
        ranges.push([rangeStart, timestamps[timestamps.length - 1]]);
    }
    
    return ranges;
}

// Un signal peut avoir quitte tous les panneaux sans que la carte ait ete purgee: quatre
// chemins de destruction y menent et chacun doit y penser. Le filtre de vivacite rend une
// entree oubliee inoffensive au dessin, la purge ci-dessous evite qu'elle ressuscite avec
// des plages perimees quand le meme signal est reajoute.
// La vivacite se mesure sur tous les onglets, pas sur le seul onglet actif: les zones
// debordent volontairement sur les autres vues, c'est ce qui permet de basculer d'un onglet
// a l'autre en gardant le highlight.
// Un onglet de layout restaure mais pas encore affiche (hydratation differee) compte aussi:
// ses signaux n'ont pas encore de panneau, mais leurs zones restaurees doivent deja
// deborder sur les vues affichees, comme avant le changement de fichier.
function collectLiveSignals() {
    const live = new Set();
    const addFrom = plots => (plots || []).forEach(plot => {
        (plot?.signals || []).forEach(sigIdx => live.add(sigIdx));
    });
    addFrom(S.plots);
    (S.tabs || []).forEach(tab => {
        addFrom(tab?.plots);
        if (tab?._pendingLayout && !tab._hydrated) {
            const index = signalIndexByName();
            tab._pendingLayout.forEach(spec => (spec?.signals || []).forEach(sig => {
                const sigIdx = index.get(sig?.name);
                if (sigIdx !== undefined) live.add(sigIdx);
            }));
        }
    });
    return live;
}

// Index nom -> indice du fichier courant, reconstruit seulement quand la liste de signaux
// change (collectLiveSignals tourne a chaque dessin de chaque graphe).
let nameIndexCache = { signals: null, index: new Map() };

function signalIndexByName() {
    if (nameIndexCache.signals !== S.signalsInfo) {
        nameIndexCache = {
            signals: S.signalsInfo,
            index: new Map((S.signalsInfo || []).map(sig => [sig.name, sig.index])),
        };
    }
    return nameIndexCache.index;
}

export function purgeExtendedZonesForPlots(plots) {
    (plots || []).forEach(plot => {
        (plot?.signals || []).forEach(sigIdx => {
            ectx.extendedBoolZones.delete(sigIdx);
            ectx.disabledBoolZones.delete(sigIdx);
            ectx.pendingBoolZones.delete(sigIdx);
        });
    });
}

// Oublie toutes les zones (changement de fichier: les indices ne designent plus les
// memes signaux).
export function clearBoolZones() {
    ectx.extendedBoolZones.clear();
    ectx.disabledBoolZones.clear();
    ectx.pendingBoolZones.clear();
}

// Etat explicite des zones d'un signal pour l'export de layout: true (etendues), false
// (desactivees par l'utilisateur), null (defaut: activation automatique du premier
// booleen d'un graphe).
export function boolZoneLayoutState(sigIdx) {
    if (ectx.extendedBoolZones.has(sigIdx)) return true;
    if (ectx.disabledBoolZones.has(sigIdx)) return false;
    return null;
}

// Applique l'etat d'un layout charge a un signal. Les plages derivent des donnees, qui
// ne sont pas encore la: une zone demandee est mise en attente et activee par
// autoEnableExtendedZones a l'arrivee du cache du signal.
export function applyBoolZoneLayoutState(sigIdx, state) {
    if (state === true) {
        ectx.disabledBoolZones.delete(sigIdx);
        if (!ectx.extendedBoolZones.has(sigIdx)) ectx.pendingBoolZones.add(sigIdx);
    } else if (state === false) {
        ectx.extendedBoolZones.delete(sigIdx);
        ectx.pendingBoolZones.delete(sigIdx);
        ectx.disabledBoolZones.add(sigIdx);
    }
}

// Photographie des zones etendues pour l'espace de travail d'un fichier: par nom (les
// indices sont propres au fichier) et avec leurs plages, pour qu'au retour elles
// reapparaissent sur toutes les vues avant meme le rechargement des donnees.
export function snapshotBoolZones(signals) {
    const names = new Map((signals || []).map(sig => [sig.index, sig.name]));
    const zones = [];
    ectx.extendedBoolZones.forEach((zone, sigIdx) => {
        const name = names.get(sigIdx);
        if (name === undefined) return;
        zones.push({ name, color: zone.color, ranges: (zone.ranges || []).map(r => [r[0], r[1]]) });
    });
    return zones;
}

export function restoreBoolZones(zones, signals) {
    const index = new Map((signals || []).map(sig => [sig.name, sig.index]));
    (zones || []).forEach(zone => {
        const sigIdx = index.get(zone?.name);
        if (sigIdx === undefined || ectx.disabledBoolZones.has(sigIdx)) return;
        ectx.extendedBoolZones.set(sigIdx, {
            color: zone.color,
            ranges: Array.isArray(zone.ranges) ? zone.ranges : [],
            plotId: null,
        });
        ectx.pendingBoolZones.delete(sigIdx);
    });
}

// Les plages sont derivees du cache du panneau, qui est remplace a chaque vue tant qu'il
// n'est pas complet. Sans ce recalcul, des bandes calculees en zoom serre, sur une fenetre
// partielle et a la resolution decimee de cette fenetre, restent dessinees telles quelles
// apres un dezoom. Le cache ne regresse jamais (une entree complete n'est pas remplacee par
// une plus etroite), donc les plages convergent vers la pleine resolution.
export function refreshBoolZoneRanges(sigIdx, cached) {
    const zone = ectx.extendedBoolZones.get(sigIdx);
    if (!zone || !cached || !cached.timestamps) return;
    zone.ranges = extractBoolHighRanges(cached.timestamps, cached.values);
}

export function boolZonesPlugin() {
    return {
        hooks: {
            drawClear: u => {
                // Dessine les zones AVANT les données (en fond)
                if (ectx.extendedBoolZones.size === 0) return;
                
                const ctx = u.ctx;
                const { left, top, width, height } = u.bbox;
                
                // Facteur de scale pour device pixel ratio
                const pxRatio = devicePixelRatio || 1;
                const live = collectLiveSignals();
                
                ectx.extendedBoolZones.forEach((zoneData, sigIdx) => {
                    if (!live.has(sigIdx)) return;
                    const { color, ranges } = zoneData;
                    
                    // Couleur avec opacité réduite (20%)
                    ctx.fillStyle = colorWithOpacity(color, 0.15);
                    
                    ranges.forEach(([start, end]) => {
                        // Convertir les temps en positions pixels
                        const xStart = u.valToPos(start, 'x', true);
                        const xEnd = u.valToPos(end, 'x', true);
                        
                        // Ne dessiner que si visible dans la vue
                        if (xEnd < left || xStart > left + width) return;
                        
                        // Clipper aux limites du graphique
                        const drawX = Math.max(left, xStart);
                        const drawWidth = Math.min(left + width, xEnd) - drawX;
                        
                        if (drawWidth > 0) {
                            ctx.fillRect(drawX, top, drawWidth, height);
                        }
                    });
                });
            }
        }
    };
}

