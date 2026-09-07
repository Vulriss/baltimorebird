// Vue de la visite: carte, indicateurs de progression et actions. Le panneau ne
// decide de rien, il rend un etat et remonte les actions via data-action. Aucun
// handler inline: compatible avec la CSP de l'application.

import { LABELS } from './steps.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const TITLE_ID = 'bb-onb-title';
const DESCRIPTION_ID = 'bb-onb-description';
const FOCUSABLE = 'button:not([disabled]), a[href]';

function h(tag, props, children) {
    const node = document.createElement(tag);
    if (props) {
        Object.keys(props).forEach((key) => {
            const value = props[key];
            if (value === null || value === undefined) return;
            if (key === 'class') node.className = value;
            else if (key === 'text') node.textContent = value;
            else if (key === 'dataset') Object.assign(node.dataset, value);
            else node.setAttribute(key, value);
        });
    }
    (children || []).forEach((child) => node.appendChild(child));
    return node;
}

function strokeIcon(pathData, size) {
    const icon = document.createElementNS(SVG_NS, 'svg');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('width', size);
    icon.setAttribute('height', size);
    icon.setAttribute('fill', 'none');
    icon.setAttribute('stroke', 'currentColor');
    icon.setAttribute('stroke-width', '1.75');
    icon.setAttribute('stroke-linecap', 'round');
    icon.setAttribute('stroke-linejoin', 'round');
    icon.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', pathData);
    icon.appendChild(path);
    return icon;
}

function closeIcon() {
    return strokeIcon('M18 6L6 18M6 6l12 12', 16);
}

function buildBadge(step) {
    if (!step.icon) return null;
    return h('span', { class: 'bb-onb-badge', 'aria-hidden': 'true' }, [strokeIcon(step.icon, 20)]);
}

function buildProgress(index, total) {
    const dots = [];
    for (let i = 0; i < total; i += 1) {
        dots.push(h('span', { class: i === index ? 'bb-onb-dot is-current' : 'bb-onb-dot' }));
    }
    return h('div', { class: 'bb-onb-progress', 'aria-hidden': 'true' }, dots);
}

function buildTask(interaction, satisfied) {
    const children = [
        h('span', { class: 'bb-onb-task-mark', 'aria-hidden': 'true' }, [
            strokeIcon(satisfied ? 'M20 6L9 17l-5-5' : 'M12 8v5M12 16v.5', 14),
        ]),
        h('span', { class: 'bb-onb-task-text', text: satisfied ? interaction.done : interaction.task }),
    ];
    if (!satisfied && interaction.suggestion) {
        children.push(h('button', {
            type: 'button',
            class: 'bb-onb-task-action',
            dataset: { action: 'suggest' },
            text: interaction.suggestion.label,
        }));
    }
    return h('div', { class: satisfied ? 'bb-onb-task is-done' : 'bb-onb-task' }, children);
}

function buildLink(link) {
    return h('p', { class: 'bb-onb-link-row' }, [
        h('a', {
            class: 'bb-onb-link',
            href: link.href,
            target: '_blank',
            rel: 'noopener noreferrer',
            text: link.label,
        }),
    ]);
}

function buildWelcome(step) {
    const outline = step.outline.map((item, position) => h('li', { class: 'bb-onb-outline-item' }, [
        h('span', { class: 'bb-onb-outline-rank', text: String(position + 1) }),
        h('span', { class: 'bb-onb-outline-text' }, [
            h('strong', { text: item.title }),
            h('span', { text: item.detail }),
        ]),
    ]));

    return [
        h('div', { class: 'bb-onb-head' }, [buildBadge(step)].filter(Boolean)),
        h('h2', { id: TITLE_ID, class: 'bb-onb-title', text: step.title }),
        h('p', { id: DESCRIPTION_ID, class: 'bb-onb-lead', text: step.lead }),
        h('ol', { class: 'bb-onb-outline' }, outline),
        h('div', { class: 'bb-onb-actions' }, [
            h('button', {
                type: 'button', class: 'bb-onb-btn is-ghost', dataset: { action: 'skip' }, text: step.secondaryLabel,
            }),
            h('button', {
                type: 'button', class: 'bb-onb-btn is-primary', dataset: { action: 'next' }, text: step.primaryLabel,
            }),
        ]),
    ];
}

function buildStep(step, index, total, nextLabel, satisfied) {
    const body = step.paragraphs.map((paragraph) => h('p', { class: 'bb-onb-text', text: paragraph }));
    if (step.note) body.push(h('p', { class: 'bb-onb-note', text: step.note }));
    if (step.link) body.push(buildLink(step.link));
    if (step.interaction) body.push(buildTask(step.interaction, satisfied));

    return [
        h('div', { class: 'bb-onb-head' }, [
            buildBadge(step),
            h('p', { class: 'bb-onb-counter', text: LABELS.counter(index, total) }),
        ].filter(Boolean)),
        h('h2', { id: TITLE_ID, class: 'bb-onb-title', text: step.title }),
        h('div', { id: DESCRIPTION_ID, class: 'bb-onb-body' }, body),
        h('div', { class: 'bb-onb-footer' }, [
            buildProgress(index, total),
            h('div', { class: 'bb-onb-actions-main' }, [
                h('button', {
                    type: 'button', class: 'bb-onb-btn', dataset: { action: 'previous' }, text: LABELS.previous,
                }),
                h('button', {
                    type: 'button', class: 'bb-onb-btn is-primary', dataset: { action: 'next' }, text: nextLabel,
                }),
            ]),
        ]),
    ];
}

function buildFinish(step) {
    const body = step.paragraphs.map((paragraph) => h('p', { class: 'bb-onb-text', text: paragraph }));
    if (step.link) body.push(buildLink(step.link));

    return [
        h('div', { class: 'bb-onb-head is-centered' }, [buildBadge(step)].filter(Boolean)),
        h('h2', { id: TITLE_ID, class: 'bb-onb-title', text: step.title }),
        h('p', { id: DESCRIPTION_ID, class: 'bb-onb-lead', text: step.lead }),
        h('div', { class: 'bb-onb-body' }, body),
        h('div', { class: 'bb-onb-actions is-centered' }, [
            h('button', {
                type: 'button', class: 'bb-onb-btn is-primary', dataset: { action: 'next' }, text: step.primaryLabel,
            }),
        ]),
    ];
}

export function createOnboardingPanel() {
    const card = h('div', {
        class: 'bb-onb-card',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': TITLE_ID,
        'aria-describedby': DESCRIPTION_ID,
        'aria-label': LABELS.dialog,
    });
    const close = h('button', {
        type: 'button', class: 'bb-onb-close', dataset: { action: 'skip' }, 'aria-label': LABELS.close,
    }, [closeIcon()]);
    const content = h('div', { class: 'bb-onb-content' });
    card.appendChild(close);
    card.appendChild(content);

    const root = h('div', { class: 'bb-onb-root' }, [card]);

    let actionHandler = null;
    let previousFocus = null;

    function onClick(event) {
        const trigger = event.target.closest('[data-action]');
        if (!trigger || !root.contains(trigger) || !actionHandler) return;
        event.preventDefault();
        actionHandler(trigger.dataset.action);
    }

    // Piege a focus manuel: la carte n'est pas un <dialog> natif car l'overlay
    // SVG doit rester dans le meme empilement que le voile.
    function onKeydown(event) {
        if (event.key !== 'Tab') return;
        const focusable = Array.from(card.querySelectorAll(FOCUSABLE));
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement;

        if (event.shiftKey && (active === first || !card.contains(active))) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && active === last) {
            event.preventDefault();
            first.focus();
        }
    }

    function nodesFor(state) {
        if (state.kind === 'welcome') return buildWelcome(state.step);
        if (state.kind === 'finish') return buildFinish(state.step);
        return buildStep(state.step, state.index, state.total, state.nextLabel, state.satisfied);
    }

    return {
        element: root,

        mount(overlayElement) {
            previousFocus = document.activeElement;
            if (overlayElement) root.insertBefore(overlayElement, card);
            document.body.appendChild(root);
            root.addEventListener('click', onClick);
            root.addEventListener('keydown', onKeydown);
        },

        unmount() {
            root.removeEventListener('click', onClick);
            root.removeEventListener('keydown', onKeydown);
            if (root.parentNode) root.parentNode.removeChild(root);
            if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
            previousFocus = null;
        },

        // Etape interactive: la racine cesse de capter les clics, l'application
        // redevient manipulable sous le voile.
        setInteractive(interactive) {
            root.classList.toggle('is-interactive', Boolean(interactive));
        },

        onAction(handler) {
            actionHandler = handler;
        },

        // Rafraichit la seule tuile d'objectif, sans reconstruire la carte: un
        // rendu complet volerait le focus a l'utilisateur en pleine action.
        refreshTask(step, satisfied) {
            const current = content.querySelector('.bb-onb-task');
            if (!current || !step.interaction) return;
            current.replaceWith(buildTask(step.interaction, satisfied));
        },

        render(state) {
            card.style.transform = '';
            while (content.firstChild) content.removeChild(content.firstChild);
            nodesFor(state).forEach((node) => content.appendChild(node));
            card.setAttribute('data-kind', state.kind);

            const previous = content.querySelector('[data-action="previous"]');
            if (previous && !state.canGoBack) previous.setAttribute('disabled', 'disabled');

            const primary = content.querySelector('[data-action="next"]');
            // Sur une etape interactive, le focus reste a l'application: c'est
            // l'utilisateur qui doit pouvoir taper dans la barre de recherche.
            if (primary && !state.step.interaction && !state.step.interactive) primary.focus();
        },

        // Position de la carte sans decalage: base de calcul du placement. Elle est
        // deduite des dimensions et du viewport, jamais mesuree en remettant le
        // transform a zero: la propriete est animee, et getBoundingClientRect
        // renverrait alors une valeur en cours d'interpolation. Le decalage se
        // calculerait sur une reference mouvante et la carte deriverait a chaque
        // repaint.
        centeredRect() {
            const rect = card.getBoundingClientRect();
            const left = (window.innerWidth - rect.width) / 2;
            const top = (window.innerHeight - rect.height) / 2;
            return {
                left, top, right: left + rect.width, bottom: top + rect.height,
                width: rect.width, height: rect.height,
            };
        },

        setOffset(offset) {
            card.style.transform = offset.x === 0 && offset.y === 0
                ? ''
                : `translate(${offset.x}px, ${offset.y}px)`;
        },

        cardRect() {
            return card.getBoundingClientRect();
        },
    };
}
