// Baltimore Bird - Fiche du fichier actif (zone infos de la sidebar, sous l'onglet fichier)
//
// L'onglet fichier se prolonge dans cette zone comme la couverture d'un classeur: elle
// porte ce qui concerne le fichier affiche (format, nom complet que l'onglet tronque,
// volume, duree, statut temporaire). Les stats sont posees par les chemins de chargement
// (setFileStats), l'identite par run-list.js a chaque reconstruction des onglets.

const integerFormat = new Intl.NumberFormat('fr-FR');

// Duree d'acquisition lisible d'un coup d'oeil: "42 s", "9 min 17 s", "1 h 09 min".
// Les secondes disparaissent au-dela de l'heure, ou elles ne disent plus rien.
export function formatAcquisitionDuration(seconds) {
    const total = Math.max(0, Math.round(seconds));
    if (total < 60) return `${total} s`;
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    if (hours === 0) return `${minutes} min ${String(total % 60).padStart(2, '0')} s`;
    return `${hours} h ${String(minutes).padStart(2, '0')} min`;
}

// Nombre de signaux et duree du fichier affiche (ou de l'union des runs compares).
// Un champ absent garde sa valeur courante. Une duree nulle (fichier de trames brutes
// tant qu'aucun signal n'est charge) est inconnue, pas "0 s": elle est masquee.
export function setFileStats({ signals, duration } = {}) {
    if (signals != null) {
        const el = document.getElementById('statSignals');
        if (el) el.textContent = `${integerFormat.format(signals)} ${signals > 1 ? 'signaux' : 'signal'}`;
    }
    if (duration != null) {
        const el = document.getElementById('statDuration');
        const known = duration > 0;
        if (el) el.textContent = known ? formatAcquisitionDuration(duration) : '';
        const wrap = document.getElementById('fileInfoDuration');
        if (wrap) wrap.hidden = !known;
    }
}

// Identite du fichier actif. title: infobulle du nom (nom de fichier complet), le nom
// par defaut. format: libelle court du badge (extension, "DÉMO"), vide pour le masquer.
// ephemeral: upload anonyme, perdu a la fermeture de la session.
export function renderFileInfo({ name = '', title = name, format = '', ephemeral = false } = {}) {
    const nameEl = document.getElementById('fileInfoName');
    if (!nameEl) return;
    nameEl.textContent = name;
    nameEl.title = title;

    const formatEl = document.getElementById('fileInfoFormat');
    formatEl.textContent = format;
    formatEl.hidden = !format;

    const status = document.getElementById('fileInfoStatus');
    status.hidden = !ephemeral;
    // Se connecter n'enregistre pas ce fichier-ci (une session anonyme le reste), mais
    // les suivants: le bouton n'a de sens que deconnecte.
    document.getElementById('fileInfoLogin').hidden = !!window.currentUser;
}

export function setupFileInfo() {
    const login = document.getElementById('fileInfoLogin');
    if (!login || login._listenerAdded) return;
    login.addEventListener('click', () => {
        if (typeof window.showLoginModal === 'function') window.showLoginModal();
    });
    login._listenerAdded = true;
}
