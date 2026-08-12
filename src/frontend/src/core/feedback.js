// Retour utilisateur: modale legere ouverte depuis le pied de menu, envoi vers
// /api/feedback. Sans dependance, CSP-safe (aucun handler inline).
(function () {
    'use strict';

    let overlay = null;

    function currentContext() {
        const active = document.querySelector('.nav-item.active');
        const view = active && active.dataset ? active.dataset.view : '';
        return (view || 'app').slice(0, 200);
    }

    function close() {
        if (overlay) {
            overlay.remove();
            overlay = null;
        }
    }

    async function submit(message, email, status, sendBtn) {
        const text = message.value.trim();
        if (!text) {
            status.textContent = 'Le message est vide.';
            return;
        }
        sendBtn.disabled = true;
        status.textContent = 'Envoi...';

        try {
            const res = await fetch('/api/feedback', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: text,
                    email: email.value.trim(),
                    context: currentContext(),
                }),
            });
            if (res.ok) {
                if (typeof window.bbTrack === 'function') window.bbTrack('feedback_sent');
                status.textContent = 'Merci pour votre retour.';
                setTimeout(close, 1200);
            } else if (res.status === 429) {
                status.textContent = 'Trop de retours envoyes, reessayez plus tard.';
                sendBtn.disabled = false;
            } else {
                status.textContent = 'Echec de l\'envoi, reessayez.';
                sendBtn.disabled = false;
            }
        } catch (e) {
            status.textContent = 'Echec de l\'envoi, reessayez.';
            sendBtn.disabled = false;
        }
    }

    function build() {
        overlay = document.createElement('div');
        overlay.className = 'fb-overlay';
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

        const modal = document.createElement('div');
        modal.className = 'fb-modal';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');

        const title = document.createElement('h2');
        title.className = 'fb-title';
        title.textContent = 'Envoyer un retour';

        const message = document.createElement('textarea');
        message.className = 'fb-message';
        message.rows = 6;
        message.maxLength = 4000;
        message.placeholder = 'Votre retour, suggestion ou probleme rencontre...';

        const email = document.createElement('input');
        email.className = 'fb-email';
        email.type = 'email';
        email.maxLength = 254;
        email.placeholder = 'Email (optionnel, pour vous recontacter)';

        const status = document.createElement('div');
        status.className = 'fb-status';

        const actions = document.createElement('div');
        actions.className = 'fb-actions';

        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'fb-btn fb-cancel';
        cancel.textContent = 'Annuler';
        cancel.addEventListener('click', close);

        const send = document.createElement('button');
        send.type = 'button';
        send.className = 'fb-btn fb-send';
        send.textContent = 'Envoyer';
        send.addEventListener('click', () => submit(message, email, status, send));

        actions.appendChild(cancel);
        actions.appendChild(send);
        modal.appendChild(title);
        modal.appendChild(message);
        modal.appendChild(email);
        modal.appendChild(status);
        modal.appendChild(actions);
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        message.focus();
    }

    function open() {
        if (overlay) return;
        if (typeof window.bbTrack === 'function') window.bbTrack('feedback_open');
        build();
    }

    document.addEventListener('click', (e) => {
        const btn = e.target && e.target.closest ? e.target.closest('#navFeedbackBtn') : null;
        if (btn) { e.preventDefault(); open(); }
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && overlay) { close(); return; }
        const active = document.activeElement;
        if ((e.key === 'Enter' || e.key === ' ') && active && active.id === 'navFeedbackBtn') {
            e.preventDefault();
            open();
        }
    });
})();
