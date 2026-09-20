// Retour utilisateur: modale legere ouverte depuis le pied de menu, envoi vers
// /api/feedback. Sans dependance, CSP-safe (aucun handler inline). Reprend le
// squelette modal-overlay/modal-content/btn-primary/btn-secondary partage par
// les autres dialogues (upload, auth) plutot qu'un skin fb-* isole.
import { activateDialog, deactivateDialog } from './dialog-a11y.js';

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
            deactivateDialog(overlay.querySelector('.modal-content'));
            overlay.remove();
            overlay = null;
        }
    }

    function setStatus(status, text, kind) {
        status.textContent = text;
        status.classList.remove('error', 'success');
        if (kind) status.classList.add(kind);
    }

    async function submit(message, email, status, sendBtn) {
        const text = message.value.trim();
        if (!text) {
            setStatus(status, 'Le message est vide.', 'error');
            return;
        }
        sendBtn.disabled = true;
        setStatus(status, 'Envoi...', null);

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
                setStatus(status, 'Merci pour votre retour.', 'success');
                setTimeout(close, 1200);
            } else if (res.status === 429) {
                setStatus(status, 'Trop de retours envoyes, reessayez plus tard.', 'error');
                sendBtn.disabled = false;
            } else {
                setStatus(status, 'Echec de l\'envoi, reessayez.', 'error');
                sendBtn.disabled = false;
            }
        } catch (e) {
            setStatus(status, 'Echec de l\'envoi, reessayez.', 'error');
            sendBtn.disabled = false;
        }
    }

    function makeField(tag, { id, labelText, optional, ...attrs }) {
        const field = document.createElement('div');
        field.className = 'modal-field';

        const label = document.createElement('label');
        label.htmlFor = id;
        label.textContent = labelText;
        if (optional) {
            const hint = document.createElement('span');
            hint.className = 'optional';
            hint.textContent = ` (${optional})`;
            label.appendChild(hint);
        }

        const input = document.createElement(tag);
        input.id = id;
        input.className = tag === 'textarea' ? 'fb-message' : 'fb-email';
        Object.entries(attrs).forEach(([k, v]) => { input[k] = v; });

        field.appendChild(label);
        field.appendChild(input);
        return { field, input };
    }

    function build() {
        overlay = document.createElement('div');
        overlay.className = 'modal-overlay active';
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

        const modal = document.createElement('div');
        modal.className = 'modal-content fb-modal';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.setAttribute('aria-labelledby', 'fbModalTitle');
        modal.addEventListener('click', (e) => e.stopPropagation());

        const header = document.createElement('div');
        header.className = 'modal-header';
        const title = document.createElement('h2');
        title.id = 'fbModalTitle';
        title.textContent = 'Envoyer un retour';
        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'modal-close';
        closeBtn.setAttribute('aria-label', 'Fermer');
        closeBtn.textContent = '×';
        closeBtn.addEventListener('click', close);
        header.appendChild(title);
        header.appendChild(closeBtn);

        const body = document.createElement('div');
        body.className = 'modal-body';

        const { field: messageField, input: message } = makeField('textarea', {
            id: 'fbMessage',
            labelText: 'Votre message',
            rows: 6,
            maxLength: 4000,
            placeholder: 'Retour, suggestion ou probleme rencontre...',
        });

        const { field: emailField, input: email } = makeField('input', {
            id: 'fbEmail',
            labelText: 'Email',
            optional: 'pour vous recontacter',
            type: 'email',
            maxLength: 254,
            placeholder: 'votre@email.com',
        });

        const status = document.createElement('div');
        status.className = 'fb-status';
        status.setAttribute('aria-live', 'polite');

        body.appendChild(messageField);
        body.appendChild(emailField);
        body.appendChild(status);

        const footer = document.createElement('div');
        footer.className = 'modal-footer';

        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'btn-secondary';
        cancel.textContent = 'Annuler';
        cancel.addEventListener('click', close);

        const send = document.createElement('button');
        send.type = 'button';
        send.className = 'btn-primary';
        send.textContent = 'Envoyer';
        send.addEventListener('click', () => submit(message, email, status, send));

        footer.appendChild(cancel);
        footer.appendChild(send);

        modal.appendChild(header);
        modal.appendChild(body);
        modal.appendChild(footer);
        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        activateDialog(modal, { initialFocus: message, onEscape: close });
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
        const active = document.activeElement;
        if ((e.key === 'Enter' || e.key === ' ') && active && active.id === 'navFeedbackBtn') {
            e.preventDefault();
            open();
        }
    });
})();
