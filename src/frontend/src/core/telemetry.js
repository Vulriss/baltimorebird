// Emission d'evenements d'usage anonymes vers /api/metrics/event. Fire-and-forget: la
// telemetrie ne doit jamais bloquer ni gener l'utilisateur. Expose window.bbTrack(event).
(function () {
    'use strict';

    const ENDPOINT = '/api/metrics/event';
    const VALID_EVENT = /^[a-z][a-z0-9_]{1,39}$/;

    function track(event) {
        if (typeof event !== 'string' || !VALID_EVENT.test(event)) return;
        const body = JSON.stringify({ event });

        try {
            if (navigator.sendBeacon) {
                navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }));
                return;
            }
        } catch (e) { /* repli sur fetch */ }

        try {
            fetch(ENDPOINT, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body,
                keepalive: true,
            });
        } catch (e) { /* silencieux par conception */ }
    }

    window.bbTrack = track;

    function start() { track('app_open'); }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
