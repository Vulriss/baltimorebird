/**
 * ViewLoader - Dynamic HTML view loader
 */
const ViewLoader = (() => {
    const cache = new Map();

    const viewPaths = Object.freeze({
        eda: '/views/eda.html',
        dashboard: '/views/dashboard.html',
        reports: '/views/reports.html',
        utilities: '/views/utilities.html',
        'data-conversion': '/views/data-conversion.html',
        concatenation: '/views/concatenation.html',
        settings: '/views/settings.html'
    });

    const modalPaths = Object.freeze({
        upload: '/components/modals/upload-modal.html',
        auth: '/components/modals/auth-modal.html'
    });

    const viewInitializers = Object.freeze({
        eda: () => typeof initEDA === 'function' && initEDA(),
        dashboard: () => typeof initDashboard === 'function' && initDashboard(),
        reports: () => typeof initReportsView === 'function' && initReportsView(),
        settings: () => typeof initSettings === 'function' && initSettings()
    });

    async function fetchHTML(path) {
        const response = await fetch(path);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
    }

    function renderError(viewId) {
        return `
            <div class="view-load-error">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="10"/>
                    <line x1="12" y1="8" x2="12" y2="12"/>
                    <line x1="12" y1="16" x2="12.01" y2="16"/>
                </svg>
                <h3>Loading Error</h3>
                <p>Unable to load view "${viewId}"</p>
                <button onclick="ViewLoader.loadView('${viewId}')">Retry</button>
            </div>
        `;
    }

    async function preloadSingle(viewId) {
        if (cache.has(viewId)) return;
        const path = viewPaths[viewId];
        if (!path) return;

        try {
            cache.set(viewId, await fetchHTML(path));
        } catch {
            // Preload failures are non-critical
        }
    }

    return Object.freeze({
        async loadView(viewId) {
            const container = document.getElementById(`view-${viewId}`);
            if (!container) {
                console.error(`Container view-${viewId} not found`);
                return false;
            }

            const cached = cache.get(viewId);
            if (cached) {
                container.innerHTML = cached;
                viewInitializers[viewId]?.();
                return true;
            }

            const path = viewPaths[viewId];
            if (!path) {
                console.error(`No path defined for view: ${viewId}`);
                return false;
            }

            try {
                const html = await fetchHTML(path);
                cache.set(viewId, html);
                container.innerHTML = html;
                viewInitializers[viewId]?.();
                return true;
            } catch (error) {
                console.error(`Failed to load view ${viewId}:`, error);
                container.innerHTML = renderError(viewId);
                return false;
            }
        },

        async loadModal(modalId, targetId = null) {
            const target = (targetId && document.getElementById(targetId)) || document.body;
            const cacheKey = `modal-${modalId}`;
            const modalElementId = `${modalId}Modal`;

            const cached = cache.get(cacheKey);
            if (cached) {
                if (!document.getElementById(modalElementId)) {
                    target.insertAdjacentHTML('beforeend', cached);
                }
                return true;
            }

            const path = modalPaths[modalId];
            if (!path) {
                console.error(`No path defined for modal: ${modalId}`);
                return false;
            }

            try {
                const html = await fetchHTML(path);
                cache.set(cacheKey, html);
                target.insertAdjacentHTML('beforeend', html);
                return true;
            } catch (error) {
                console.error(`Failed to load modal ${modalId}:`, error);
                return false;
            }
        },

        async preloadCritical() {
            await Promise.all([
                preloadSingle('eda'),
                preloadSingle('dashboard')
            ]);
        },

        async preloadAll() {
            await Promise.allSettled(Object.keys(viewPaths).map(preloadSingle));
        }
    });
})();

// Expose globally for other modules
window.ViewLoader = ViewLoader;

document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => ViewLoader.preloadCritical(), 1000);
    setTimeout(() => ViewLoader.preloadAll(), 3000);
});