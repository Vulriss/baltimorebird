// Import de layouts ETAS MDA (.xdx) dans Baltimore Bird.
// Le fichier .xdx (base SQLite) est parse cote serveur (/api/layouts/import-mda) qui
// renvoie un layout au schema standard; on l'applique via applyLayout, qui resout les
// noms de signaux vers le fichier courant et ignore les signaux absents.
(function () {
    'use strict';

    function notify(msg, type) {
        if (typeof window.showNotification === 'function') {
            window.showNotification(msg, type || 'info');
        } else {
            console.log('[MDA]', type || 'info', msg);
        }
    }

    // Compte les signaux du layout resolus dans le fichier courant.
    function coverage(layout) {
        const wanted = new Set();
        (layout.tabs || []).forEach(t => (t.plots || []).forEach(p => (p.signals || []).forEach(s => {
            if (s && s.name) wanted.add(s.name);
        })));
        const have = new Set((window.signalsInfo || []).map(s => s.name));
        let matched = 0;
        wanted.forEach(n => { if (have.has(n)) matched += 1; });
        return { matched, total: wanted.size };
    }

    async function importFile(file) {
        if (!window.signalsInfo || !window.signalsInfo.length) {
            notify('Charge d\'abord un fichier (MF4/BLF) pour resoudre les signaux du layout', 'warning');
            return;
        }
        if (typeof window.applyLayout !== 'function') {
            notify('Application de layout indisponible', 'error');
            return;
        }

        notify('Import du layout MDA en cours...', 'info');
        const form = new FormData();
        form.append('file', file);

        const headers = {};
        const token = sessionStorage.getItem('auth_token');
        if (token) headers['Authorization'] = 'Bearer ' + token;

        let data;
        try {
            const res = await fetch('/api/layouts/import-mda', { method: 'POST', headers, body: form });
            data = await res.json();
            if (!res.ok || !data.success) {
                notify('Import MDA echoue: ' + (data && data.error ? data.error : 'erreur inconnue'), 'error');
                return;
            }
        } catch (e) {
            notify('Import MDA echoue: ' + e.message, 'error');
            return;
        }

        const layout = data.layout;
        const cov = coverage(layout);
        try {
            await window.applyLayout(layout);
        } catch (e) {
            notify('Application du layout echouee: ' + e.message, 'error');
            return;
        }

        const nTabs = (layout.tabs || []).length;
        const missed = cov.total - cov.matched;
        if (typeof window.bbTrack === 'function') window.bbTrack('mda_import');
        let msg = `Layout MDA importe: ${nTabs} onglet(s), ${cov.matched}/${cov.total} signaux resolus`;
        notify(msg, missed > 0 ? 'warning' : 'success');
    }

    // Delegation au niveau document: robuste a l'injection dynamique de la vue EDA.
    document.addEventListener('click', (e) => {
        const btn = e.target && e.target.closest ? e.target.closest('#importMdaBtn') : null;
        if (!btn) return;
        const input = document.getElementById('importMdaInput');
        if (input) input.click();
    });

    document.addEventListener('change', (e) => {
        if (!e.target || e.target.id !== 'importMdaInput') return;
        const input = e.target;
        const file = input.files && input.files[0];
        input.value = ''; // permet de reselectionner le meme fichier
        if (file) importFile(file);
    });
})();
