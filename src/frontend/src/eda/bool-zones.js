// Baltimore Bird - Zones booleennes etendues (fond colore derriere les analogiques)
// Module extrait de app.js (refactoring): voir src/eda/ARCHITECTURE.md

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
                
                ectx.extendedBoolZones.forEach((zoneData, sigIdx) => {
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

