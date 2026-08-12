// Ruban d'annonce temporaire. Recupere /api/banner (config serveur editable par ops),
// l'affiche en haut, gere le rejet par identifiant (localStorage) et rafraichit
// periodiquement pour faire apparaitre/disparaitre une annonce sans rechargement.
(function () {
    'use strict';

    const POLL_MS = 5 * 60 * 1000;
    const DISMISS_KEY = 'bb_banner_dismissed';
    let currentSig = null;
    let resizeObs = null;

    function setOffset(px) {
        document.documentElement.style.setProperty('--bb-banner-h', (px || 0) + 'px');
        document.body.classList.toggle('has-bb-banner', px > 0);
    }

    function removeBanner() {
        const node = document.getElementById('bbBanner');
        if (node) node.remove();
        if (resizeObs) { resizeObs.disconnect(); resizeObs = null; }
        setOffset(0);
    }

    function dismiss(id) {
        try { localStorage.setItem(DISMISS_KEY, id); } catch (e) { /* stockage indispo */ }
        removeBanner();
    }

    function render(banner) {
        removeBanner();

        let dismissed = null;
        try { dismissed = localStorage.getItem(DISMISS_KEY); } catch (e) { /* ignore */ }
        if (banner.dismissible && dismissed === banner.id) return;

        const bar = document.createElement('div');
        bar.id = 'bbBanner';
        bar.className = 'bb-banner bb-banner-' + banner.severity;
        bar.setAttribute('role', 'status');

        const icon = document.createElement('span');
        icon.className = 'bb-banner-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = banner.severity === 'info' ? 'i' : '!';

        const msg = document.createElement('span');
        msg.className = 'bb-banner-msg';
        msg.textContent = banner.message; // textContent: aucune injection HTML possible

        bar.appendChild(icon);
        bar.appendChild(msg);

        if (banner.dismissible) {
            const close = document.createElement('button');
            close.className = 'bb-banner-close';
            close.type = 'button';
            close.setAttribute('aria-label', 'Fermer');
            close.textContent = '\u00d7';
            close.addEventListener('click', () => dismiss(banner.id));
            bar.appendChild(close);
        }

        document.body.insertBefore(bar, document.body.firstChild);

        const apply = () => setOffset(bar.offsetHeight);
        apply();
        if (typeof ResizeObserver === 'function') {
            resizeObs = new ResizeObserver(apply);
            resizeObs.observe(bar);
        } else {
            window.addEventListener('resize', apply);
        }
    }

    async function fetchBanner() {
        let data;
        try {
            const res = await fetch('/api/banner', { headers: { Accept: 'application/json' } });
            if (!res.ok) return;
            data = await res.json();
        } catch (e) {
            return;
        }

        const banner = data && data.banner;
        if (!banner) {
            currentSig = null;
            removeBanner();
            return;
        }

        // Ne reconstruire que si le contenu a change (sinon on ecraserait un rejet en boucle).
        const sig = JSON.stringify([banner.id, banner.message, banner.severity, banner.dismissible]);
        if (sig === currentSig) return;
        currentSig = sig;
        render(banner);
    }

    function start() {
        fetchBanner();
        setInterval(fetchBanner, POLL_MS);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
