/**
 * Init Module - Initialisation de l'application
 * 
 * Lazy loading strategy:
 * - Only EDA loaded at startup
 * - Other views preloaded on hover (anticipate user intent)
 * - Click = instant display
 */

(function() {
    'use strict';

    // Charge uniquement EDA et les modals au démarrage
    async function bootstrapApp() {
        // Charge la vue EDA (active par défaut)
        await window.ViewLoader.loadView('eda');
        
        // Charge les modals (légers, nécessaires rapidement)
        await window.ViewLoader.loadModal('upload', 'modalsContainer');
        await window.ViewLoader.loadModal('auth', 'modalsContainer');
        await window.ViewLoader.loadModal('var-creation', 'modalsContainer');
        
        console.log('[Init] App bootstrapped');
    }

    // Override switchView pour charger les vues dynamiquement
    window.switchView = async function(viewId, element) {
        // Cleanup de la vue précédente
        const currentView = document.querySelector('.view-container.active');
        if (currentView) {
            if (currentView.id === 'view-reports' && typeof cleanupReportsView === 'function') {
                cleanupReportsView();
            }
        }
        
        // Charge la vue si pas encore chargée
        const container = document.getElementById(`view-${viewId}`);
        if (container && container.innerHTML.trim() === '') {
            await window.ViewLoader.loadView(viewId);
        }
        
        // Change la vue active
        document.querySelectorAll('.view-container').forEach(v => v.classList.remove('active'));
        if (container) container.classList.add('active');
        
        // Update nav
        document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
        if (element) element.classList.add('active');
        
        // Init spécifique à la vue
        if (viewId === 'reports' && typeof initReportsView === 'function') {
            initReportsView();
        }
        if (viewId === 'settings' && typeof initSettings === 'function') {
            initSettings();
        }
        if (viewId === 'dashboard' && typeof initDashboard === 'function') {
            initDashboard();
        }
    };

    // Utility open helper
    window.openUtility = async function(utilityId) {
        await switchView(utilityId, null);
    };

    // Setup des event listeners pour remplacer les onclick inline
    function setupNavigation() {
        // Toggle nav
        const navToggle = document.getElementById('navToggle');
        if (navToggle) {
            navToggle.addEventListener('click', function(e) {
                e.preventDefault();
                if (typeof toggleNav === 'function') toggleNav();
            });
        }

        // Nav items avec data-view
        document.querySelectorAll('.nav-item[data-view]').forEach(item => {
            const viewId = item.getAttribute('data-view');
            
            // HOVER: Preload la vue (anticipe l'intention)
            item.addEventListener('mouseenter', function() {
                if (viewId && !window.ViewLoader.isCached(viewId)) {
                    window.ViewLoader.preloadView(viewId);
                }
            });
            
            // CLICK: Affiche la vue (instantané si preloaded)
            item.addEventListener('click', function(e) {
                e.preventDefault();
                if (viewId) {
                    switchView(viewId, this);
                }
            });
        });

        // Login button
        const loginBtn = document.getElementById('loginBtn');
        if (loginBtn) {
            loginBtn.addEventListener('click', function(e) {
                e.preventDefault();
                if (typeof showLoginModal === 'function') showLoginModal();
            });
        }

        // User info (toggle menu)
        const userInfo = document.getElementById('userInfo');
        if (userInfo) {
            userInfo.addEventListener('click', function(e) {
                e.preventDefault();
                if (typeof toggleUserMenu === 'function') toggleUserMenu();
            });
        }

        // User dropdown items
        const userDropdown = document.getElementById('userDropdown');
        if (userDropdown) {
            // Profile button
            const profileBtn = userDropdown.querySelector('.nav-user-dropdown-item:not(.logout):not([data-auth])');
            if (profileBtn) {
                profileBtn.addEventListener('click', function() {
                    const settingsItem = document.querySelector('[data-view="settings"]');
                    switchView('settings', settingsItem);
                    if (typeof toggleUserMenu === 'function') toggleUserMenu();
                });
            }

            // Admin button
            const adminBtn = userDropdown.querySelector('.nav-user-dropdown-item[data-auth="admin"]');
            if (adminBtn) {
                adminBtn.addEventListener('click', function() {
                    const settingsItem = document.querySelector('[data-view="settings"]');
                    switchView('settings', settingsItem);
                    if (typeof toggleUserMenu === 'function') toggleUserMenu();
                });
            }

            // Logout button
            const logoutBtn = userDropdown.querySelector('.nav-user-dropdown-item.logout');
            if (logoutBtn) {
                logoutBtn.addEventListener('click', function() {
                    if (typeof handleLogout === 'function') handleLogout();
                });
            }
        }
    }

    // Init au chargement du DOM
    document.addEventListener('DOMContentLoaded', function() {
        setupNavigation();
        bootstrapApp();
    });

})();