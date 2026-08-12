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
// =========================================================================
// Expose globals for other modules (Vite compatibility)
// =========================================================================
window.Utils = Utils;
window.formatFileSize = formatFileSize;
window.getAuthToken = getAuthToken;
window.authFetch = authFetch;
