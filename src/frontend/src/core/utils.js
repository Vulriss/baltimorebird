/**
 * Shared utilities
 */
const Utils = (() => {
    function formatFileSize(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }

    return Object.freeze({ formatFileSize });
})();

const formatFileSize = Utils.formatFileSize;

function getAuthToken() {
    return sessionStorage.getItem('auth_token');
}

async function authFetch(url, options = {}) {
    const token = getAuthToken();

    if (!token) {
        throw new Error('Token manquant');
    }

    const res = await fetch(url, {
        ...options,
        headers: {
            ...(options.headers || {}),
            Authorization: `Bearer ${token}`
        }
    });

    if (res.status === 401) {
        throw new Error('Non autorisé');
    }

    return res;
}

// Message d'echec d'un upload XHR. Un corps non JSON vient de nginx (timeout, taille), pas de Flask.
function uploadErrorMessage(xhr) {
    try {
        const err = JSON.parse(xhr.responseText);
        if (err && err.error) return err.error;
    } catch (e) { /* page d'erreur HTML du proxy */ }

    switch (xhr.status) {
        case 408:
        case 504:
            return `Délai dépassé (HTTP ${xhr.status}) : connexion trop lente ou interrompue pendant l'envoi`;
        case 413:
            return 'Fichier trop volumineux (max 5 Go)';
        case 502:
        case 503:
            return `Serveur indisponible (HTTP ${xhr.status}), réessayez dans quelques instants`;
        default:
            return `Upload échoué (HTTP ${xhr.status || 'inconnu'})`;
    }
}
// =========================================================================
// Expose globals for other modules (Vite compatibility)
// =========================================================================
window.Utils = Utils;
window.formatFileSize = formatFileSize;
window.getAuthToken = getAuthToken;
window.authFetch = authFetch;
window.uploadErrorMessage = uploadErrorMessage;
