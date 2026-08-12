// Baltimore Bird - Aides DOM partagees: escapeHtml, redimensionnement fantome (ghost resize)
// Module extrait de app.js (refactoring): voir src/eda/ARCHITECTURE.md

// =========================================================================
// Utility Functions
// =========================================================================
export function escapeHtml(str) {
    if (typeof str !== 'string') return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// Drag de redimensionnement performant: pendant le glissement on ne bouge qu'une
// fine ligne fantome (transform, compositeur seul, aucun reflow) et un bouclier
// transparent capte la souris pour supprimer le :hover sur le contenu. La taille
// reelle n'est appliquee qu'au relachement, via commit(ghostX).
// - startClientX: position initiale du curseur
// - clampGhostX(x): contraint la position X de la ligne fantome
// - commit(ghostX): applique le resultat (appele une fois au relachement)
export function beginGhostResize(startClientX, clampGhostX, commit) {
    let ghostX = clampGhostX(startClientX);
    let rafId = null;

    const shield = document.createElement('div');
    shield.style.cssText = 'position:fixed;inset:0;z-index:9998;cursor:col-resize;';
    document.body.appendChild(shield);

    const ghost = document.createElement('div');
    ghost.style.cssText = 'position:fixed;top:0;bottom:0;left:0;width:2px;'
        + 'background:#3b82f6;z-index:9999;pointer-events:none;'
        + `transform:translateX(${ghostX}px);`;
    document.body.appendChild(ghost);

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const move = () => { rafId = null; ghost.style.transform = `translateX(${ghostX}px)`; };
    const onMove = (e) => {
        ghostX = clampGhostX(e.clientX);
        if (rafId === null) rafId = requestAnimationFrame(move);
    };
    const onUp = () => {
        if (rafId !== null) cancelAnimationFrame(rafId);
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        ghost.remove();
        shield.remove();
        commit(ghostX);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
}

// Variante verticale de beginGhostResize: la ligne fantome est horizontale et
// suit clientY. Utilisee par le splitter interne a la sidebar (zone fichiers).
export function beginGhostResizeY(startClientY, clampGhostY, commit) {
    let ghostY = clampGhostY(startClientY);
    let rafId = null;

    const shield = document.createElement('div');
    shield.style.cssText = 'position:fixed;inset:0;z-index:9998;cursor:row-resize;';
    document.body.appendChild(shield);

    const ghost = document.createElement('div');
    ghost.style.cssText = 'position:fixed;left:0;right:0;top:0;height:2px;'
        + 'background:#3b82f6;z-index:9999;pointer-events:none;'
        + `transform:translateY(${ghostY}px);`;
    document.body.appendChild(ghost);

    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';

    const move = () => { rafId = null; ghost.style.transform = `translateY(${ghostY}px)`; };
    const onMove = (e) => {
        ghostY = clampGhostY(e.clientY);
        if (rafId === null) rafId = requestAnimationFrame(move);
    };
    const onUp = () => {
        if (rafId !== null) cancelAnimationFrame(rafId);
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        ghost.remove();
        shield.remove();
        commit(ghostY);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
}

