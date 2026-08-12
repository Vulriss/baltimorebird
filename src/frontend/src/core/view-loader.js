/**
 * ViewLoader - Dynamic HTML view loader with lazy loading
 * 
 * Strategy:
 * - Only EDA is loaded at startup
 * - Other views are preloaded on hover (anticipate user intent)
 * - Click = instant display (already cached)
 */
const ViewLoader = (() => {
    const cache = new Map();
    const preloadingInProgress = new Set();

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
        auth: '/components/modals/auth-modal.html',
        'var-creation': '/components/modals/var-creation-modal.html',
        layouts: '/components/modals/layouts-interact-modal.html'
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

    return Object.freeze({
        /**
         * Preload a view in background (called on hover)
         * Non-blocking, silent failures
         */
        async preloadView(viewId) {
            // Already cached or loading
            if (cache.has(viewId) || preloadingInProgress.has(viewId)) return;
            
            const path = viewPaths[viewId];
            if (!path) return;

            preloadingInProgress.add(viewId);
            
            try {
                const html = await fetchHTML(path);
                cache.set(viewId, html);
            } catch (e) {
                // Silent fail - will load on demand
            } finally {
                preloadingInProgress.delete(viewId);
            }
        },

        /**
         * Check if a view is cached
         */
        isCached(viewId) {
            return cache.has(viewId);
        },

        /**
         * Load and display a view
         */
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

        /**
         * Get cache stats (for debugging)
         */
        getStats() {
            return {
                cached: Array.from(cache.keys()),
                loading: Array.from(preloadingInProgress)
            };
        }
    });
})();

// Expose globally for other modules
window.ViewLoader = ViewLoader;