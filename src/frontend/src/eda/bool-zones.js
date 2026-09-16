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
function collectLiveSignals() {
    const live = new Set();
    const addFrom = plots => (plots || []).forEach(plot => {
        (plot?.signals || []).forEach(sigIdx => live.add(sigIdx));
    });
    addFrom(S.plots);
    (S.tabs || []).forEach(tab => addFrom(tab?.plots));
    return live;
}

export function purgeExtendedZonesForPlots(plots) {
    (plots || []).forEach(plot => {
        (plot?.signals || []).forEach(sigIdx => {
            ectx.extendedBoolZones.delete(sigIdx);
            ectx.disabledBoolZones.delete(sigIdx);
        });
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

