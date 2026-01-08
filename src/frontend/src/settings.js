/**
 * Settings Module - Settings page management
 */
const SettingsManager = (() => {
    const $ = (id) => document.getElementById(id);
    const setText = (id, text) => { const el = $(id); if (el) el.textContent = text; };
    const setHTML = (id, html) => { const el = $(id); if (el) el.innerHTML = html; };

    function showSection(sectionId) {
        document.querySelectorAll('.settings-section').forEach(s => s.classList.remove('active'));
        $(`settings-${sectionId}`)?.classList.add('active');
    }

    function switchSection(sectionId, element) {
        if (!window.currentUser && sectionId !== 'not-logged') {
            showSection('not-logged');
            return;
        }

        showSection(sectionId);

        document.querySelectorAll('.settings-nav-item').forEach(item => item.classList.remove('active'));
        element?.classList.add('active');

        switch (sectionId) {
            case 'profile': loadProfileData(); break;
            case 'storage': StorageManager.init(); break;
            case 'users': loadUsersList(); break;
            case 'metrics': loadMetrics(); break;
        }
    }

    function updateAdminSections() {
        const isAdmin = window.currentUser?.role === 'admin';
        document.querySelectorAll('.settings-nav-section[data-auth="admin"]').forEach(section => {
            section.style.display = isAdmin ? '' : 'none';
        });
    }

    function loadProfileData() {
        if (!window.currentUser) return;
        const nameInput = $('settingsName');
        const emailInput = $('settingsEmail');
        if (nameInput) nameInput.value = window.currentUser.name || '';
        if (emailInput) emailInput.value = window.currentUser.email || '';
    }

    async function saveProfile() {
        const name = $('settingsName')?.value.trim();
        const result = await updateProfile({ name });

        if (result.success) {
            showNotification('Profil mis à jour', 'success');
        } else {
            showNotification(result.error || 'Erreur lors de la mise à jour', 'error');
        }
    }

    async function changeUserPassword() {
        const currentPwd = $('currentPassword')?.value;
        const newPwd = $('newPassword')?.value;
        const confirmPwd = $('confirmNewPassword')?.value;

        if (!currentPwd || !newPwd || !confirmPwd) {
            showNotification('Veuillez remplir tous les champs', 'error');
            return;
        }

        if (newPwd !== confirmPwd) {
            showNotification('Les mots de passe ne correspondent pas', 'error');
            return;
        }

        const result = await changePassword(currentPwd, newPwd);

        if (result.success) {
            showNotification('Mot de passe modifié', 'success');
            $('currentPassword').value = '';
            $('newPassword').value = '';
            $('confirmNewPassword').value = '';
        } else {
            showNotification(result.error || 'Erreur lors du changement', 'error');
        }
    }

    async function loadUsersList() {
        const listEl = $('settingsUsersList');
        if (!listEl) return;

        listEl.innerHTML = '<div class="settings-loading">Chargement...</div>';

        try {
            const res = await apiCall('/api/admin/users');
            if (!res.ok) throw new Error('Failed to load users');
            const data = await res.json();
            renderUsersList(data.users);
        } catch {
            listEl.innerHTML = '<div class="settings-loading">Erreur de chargement</div>';
        }
    }

    function renderUsersList(users) {
        const listEl = $('settingsUsersList');
        if (!listEl) return;

        if (!users?.length) {
            listEl.innerHTML = '<div class="settings-loading">Aucun utilisateur</div>';
            return;
        }

        listEl.innerHTML = users.map(user => `
            <div class="settings-user-item" data-user-id="${user.id}">
                <div class="settings-user-avatar">${(user.name || user.email)[0].toUpperCase()}</div>
                <div class="settings-user-info">
                    <div class="settings-user-name">${user.name || 'Sans nom'}</div>
                    <div class="settings-user-email">${user.email}</div>
                </div>
                <div class="settings-user-meta">
                    <span class="settings-user-role ${user.role}">${user.role}</span>
                    <span class="settings-user-status ${user.is_active ? '' : 'inactive'}"
                          title="${user.is_active ? 'Actif' : 'Inactif'}"></span>
                </div>
                <div class="settings-user-actions">
                    <button class="settings-btn small secondary"
                            data-action="editUser"
                            data-user-id="${user.id}"
                            title="Modifier">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                        </svg>
                    </button>
                    ${user.id !== window.currentUser.id ? `
                        <button class="settings-btn small danger"
                                data-action="toggleUserActive"
                                data-user-id="${user.id}"
                                data-active="${!user.is_active}"
                                title="${user.is_active ? 'Désactiver' : 'Activer'}">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                ${user.is_active
                                    ? '<circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>'
                                    : '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>'}
                            </svg>
                        </button>
                    ` : ''}
                </div>
            </div>
        `).join('');
    }

    async function toggleUserActive(userId, active) {
        try {
            const res = await apiCall(`/api/admin/users/${userId}`, {
                method: 'PUT',
                body: JSON.stringify({ is_active: active })
            });

            if (res.ok) {
                showNotification(`Utilisateur ${active ? 'activé' : 'désactivé'}`, 'success');
                loadUsersList();
            } else {
                const data = await res.json();
                showNotification(data.error || 'Erreur', 'error');
            }
        } catch {
            showNotification('Erreur de connexion', 'error');
        }
    }

    function editUser(userId) {
        showNotification('Édition utilisateur - Bientôt disponible', 'info');
    }

    function savePreferences() {
        const prefs = {
            theme: $('settingsTheme')?.value || 'dark',
            language: $('settingsLanguage')?.value || 'fr',
            lod: $('settingsLod')?.value || 2000,
            interpolation: $('settingsInterpolation')?.value || 'linear'
        };

        localStorage.setItem('preferences', JSON.stringify(prefs));
        applyTheme(prefs.theme);
        showNotification('Préférences sauvegardées', 'success');
    }

    function loadPreferences() {
        const prefs = JSON.parse(localStorage.getItem('preferences') || '{}');
        if ($('settingsTheme')) $('settingsTheme').value = prefs.theme || 'dark';
        if ($('settingsLanguage')) $('settingsLanguage').value = prefs.language || 'fr';
        if ($('settingsLod')) $('settingsLod').value = prefs.lod || 2000;
        if ($('settingsInterpolation')) $('settingsInterpolation').value = prefs.interpolation || 'linear';
    }

    function applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
    }

    function formatNumber(num) {
        if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
        if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
        return num.toString();
    }

    function formatDate(dateStr) {
        const date = new Date(dateStr);
        const day = date.getDate().toString().padStart(2, '0');
        const month = (date.getMonth() + 1).toString().padStart(2, '0');
        return `${day}/${month}`;
    }

    async function loadMetrics() {
        try {
            await Promise.all([
                loadCurrentMetrics(),
                loadWeeklyMetrics(),
                loadDailyMetrics()
            ]);
        } catch (e) {
            console.error('Failed to load metrics:', e);
        }
    }

    async function refreshMetrics(btn) {
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = `
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="spinning">
                    <polyline points="23 4 23 10 17 10"/>
                    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                </svg>
                Actualisation...
            `;
        }

        await loadMetrics();

        if (btn) {
            btn.disabled = false;
            btn.innerHTML = `
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="23 4 23 10 17 10"/>
                    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                </svg>
                Actualiser
            `;
        }

        showNotification('Métriques actualisées', 'success');
    }

    async function loadCurrentMetrics() {
        const headers = {};
        const token = sessionStorage.getItem('auth_token');
        if (token) headers['Authorization'] = 'Bearer ' + token;

        try {
            const res = await fetch('/api/metrics/current', { headers });
            const data = await res.json();

            setText('metricActiveSessions', data.active_sessions || 0);
            setText('metricTodayUsers', data.today?.unique_users || 0);
            setText('metricTodayRequests', formatNumber(data.today?.total_requests || 0));

            const latency = data.latency?.avg || 0;
            setText('metricAvgLatency', latency > 0 ? `${Math.round(latency)}ms` : '-');
        } catch (e) {
            console.error('Failed to load current metrics:', e);
        }
    }

    async function loadWeeklyMetrics() {
        const container = $('metricsWeeklySummary');
        if (!container) return;

        const headers = {};
        const token = sessionStorage.getItem('auth_token');
        if (token) headers['Authorization'] = 'Bearer ' + token;

        try {
            const res = await fetch('/api/metrics/weekly', { headers });
            const data = await res.json();

            if (data.no_data) {
                container.innerHTML = `
                    <div class="metrics-no-data">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M18 20V10M12 20V4M6 20v-6"/>
                        </svg>
                        <p>Aucune donnée disponible pour cette période</p>
                    </div>
                `;
                return;
            }

            container.innerHTML = `
                <div class="metrics-weekly-stats">
                    <div class="metrics-weekly-stat highlight">
                        <div class="metrics-weekly-stat-value">${data.total_unique_users || 0}</div>
                        <div class="metrics-weekly-stat-label">Utilisateurs uniques</div>
                    </div>
                    <div class="metrics-weekly-stat">
                        <div class="metrics-weekly-stat-value">${formatNumber(data.total_requests || 0)}</div>
                        <div class="metrics-weekly-stat-label">Requêtes totales</div>
                    </div>
                    <div class="metrics-weekly-stat">
                        <div class="metrics-weekly-stat-value">${data.total_sessions || 0}</div>
                        <div class="metrics-weekly-stat-label">Sessions</div>
                    </div>
                    <div class="metrics-weekly-stat">
                        <div class="metrics-weekly-stat-value">${data.avg_daily_users || 0}</div>
                        <div class="metrics-weekly-stat-label">Moy. utilisateurs/jour</div>
                    </div>
                </div>
                <div class="metrics-period-info" style="text-align: center; color: #666; font-size: 12px;">
                    Période : ${data.period || 'N/A'} (${data.days || 0} jours)
                </div>
            `;

            renderDailyBreakdown(data.daily_breakdown || []);
        } catch (e) {
            console.error('Failed to load weekly metrics:', e);
            container.innerHTML = `
                <div class="metrics-no-data">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10"/>
                        <line x1="12" y1="8" x2="12" y2="12"/>
                        <line x1="12" y1="16" x2="12.01" y2="16"/>
                    </svg>
                    <p>Erreur lors du chargement des métriques</p>
                </div>
            `;
        }
    }

    function renderDailyBreakdown(days) {
        const container = $('metricsDailyBreakdown');
        if (!container) return;

        if (!days?.length) {
            container.innerHTML = '<div class="metrics-no-data"><p>Aucune donnée journalière disponible</p></div>';
            return;
        }

        const maxRequests = Math.max(...days.map(d => d.total_requests || 0));
        const dayNames = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];

        let html = `
            <div class="metrics-day-row header">
                <div>Date</div>
                <div style="text-align: center;">Utilisateurs</div>
                <div style="text-align: center;">Requêtes</div>
                <div style="text-align: center;">Sessions</div>
                <div style="text-align: center;">Latence moy.</div>
                <div>Activité</div>
            </div>
        `;

        days.forEach(day => {
            const date = new Date(day.date);
            const dayName = dayNames[date.getDay()];
            const formattedDate = formatDate(day.date);
            const barWidth = maxRequests > 0 ? (day.total_requests / maxRequests * 100) : 0;
            const avgLatency = day.latency?.avg || 0;

            html += `
                <div class="metrics-day-row">
                    <div class="metrics-day-date">${formattedDate}<span class="day-name">${dayName}</span></div>
                    <div class="metrics-day-value highlight">${day.unique_users || 0}</div>
                    <div class="metrics-day-value">${formatNumber(day.total_requests || 0)}</div>
                    <div class="metrics-day-value">${day.sessions?.count || 0}</div>
                    <div class="metrics-day-value">${avgLatency > 0 ? Math.round(avgLatency) + 'ms' : '-'}</div>
                    <div class="metrics-day-bar">
                        <div class="metrics-day-bar-fill" style="width: ${barWidth}%"></div>
                    </div>
                </div>
            `;
        });

        container.innerHTML = html;
    }

    async function loadDailyMetrics() {
        const headers = {};
        const token = sessionStorage.getItem('auth_token');
        if (token) headers['Authorization'] = 'Bearer ' + token;

        try {
            const res = await fetch('/api/metrics/daily', { headers });
            const data = await res.json();
            renderTopEndpoints(data.top_endpoints || {});
            renderLatencyStats(data.latency || {});
        } catch (e) {
            console.error('Failed to load daily metrics:', e);
        }
    }

    function renderTopEndpoints(endpoints) {
        const container = $('metricsEndpointsList');
        if (!container) return;

        const entries = Object.entries(endpoints);

        if (!entries.length) {
            container.innerHTML = '<div class="metrics-no-data"><p>Aucun endpoint enregistré aujourd\'hui</p></div>';
            return;
        }

        entries.sort((a, b) => b[1] - a[1]);
        const maxCount = entries[0][1];

        container.innerHTML = entries.slice(0, 10).map(([path, count], index) => {
            const barWidth = maxCount > 0 ? (count / maxCount * 100) : 0;
            return `
                <div class="metrics-endpoint-row">
                    <div class="metrics-endpoint-rank ${index < 3 ? 'top-3' : ''}">${index + 1}</div>
                    <div class="metrics-endpoint-path" title="${path}">${path}</div>
                    <div class="metrics-endpoint-count">${formatNumber(count)}</div>
                    <div class="metrics-endpoint-bar">
                        <div class="metrics-endpoint-bar-fill" style="width: ${barWidth}%"></div>
                    </div>
                </div>
            `;
        }).join('');
    }

    function renderLatencyStats(latency) {
        const container = $('metricsLatencyStats');
        if (!container) return;

        if (!latency?.count) {
            container.innerHTML = '<div class="metrics-no-data"><p>Aucune donnée de latence disponible</p></div>';
            return;
        }

        const getClass = (v) => v < 100 ? 'good' : v < 500 ? 'warning' : 'bad';

        container.innerHTML = `
            <div class="metrics-latency-grid">
                <div class="metrics-latency-item">
                    <div class="metrics-latency-value">${formatNumber(latency.count)}</div>
                    <div class="metrics-latency-label">Requêtes</div>
                </div>
                <div class="metrics-latency-item">
                    <div class="metrics-latency-value ${getClass(latency.min)}">${Math.round(latency.min)}ms</div>
                    <div class="metrics-latency-label">Min</div>
                </div>
                <div class="metrics-latency-item">
                    <div class="metrics-latency-value ${getClass(latency.avg)}">${Math.round(latency.avg)}ms</div>
                    <div class="metrics-latency-label">Moyenne</div>
                </div>
                <div class="metrics-latency-item">
                    <div class="metrics-latency-value ${getClass(latency.p50)}">${Math.round(latency.p50)}ms</div>
                    <div class="metrics-latency-label">P50 (médiane)</div>
                </div>
                <div class="metrics-latency-item">
                    <div class="metrics-latency-value ${getClass(latency.p95)}">${Math.round(latency.p95)}ms</div>
                    <div class="metrics-latency-label">P95</div>
                </div>
                <div class="metrics-latency-item">
                    <div class="metrics-latency-value ${getClass(latency.max)}">${Math.round(latency.max)}ms</div>
                    <div class="metrics-latency-label">Max</div>
                </div>
            </div>
        `;
    }

    function setupEventListeners() {
        const settingsView = $('view-settings');
        if (!settingsView) return;

        settingsView.addEventListener('click', (e) => {
            const target = e.target.closest('[data-action]');
            if (!target) return;

            e.preventDefault();
            const { action, section, userId, active } = target.dataset;

            switch (action) {
                case 'switchSection': switchSection(section, target); break;
                case 'saveProfile': saveProfile(); break;
                case 'changePassword': changeUserPassword(); break;
                case 'savePreferences': savePreferences(); break;
                case 'refreshUsers': loadUsersList(); break;
                case 'refreshMetrics': refreshMetrics(target); break;
                case 'editUser': editUser(userId); break;
                case 'toggleUserActive': toggleUserActive(userId, active === 'true'); break;
                case 'showLogin': showLoginModal?.(); break;
            }
        });
    }

    function init() {
        setupEventListeners();

        if (!window.currentUser) {
            showSection('not-logged');
            return;
        }

        showSection('profile');
        loadProfileData();
        loadPreferences();
        updateAdminSections();
    }

    return Object.freeze({ init, switchSection });
})();

const initSettings = () => SettingsManager.init();
const switchSettingsSection = (id, el) => SettingsManager.switchSection(id, el);
// =========================================================================
// Expose globals for other modules (Vite compatibility)
// =========================================================================
window.SettingsManager = SettingsManager;
window.initSettings = initSettings;
window.switchSettingsSection = switchSettingsSection;
