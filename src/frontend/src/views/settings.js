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
            case 'banner': loadBanner(); break;
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

    // =====================================================================
    // Gestion de la banniere (admin)
    // =====================================================================
    let bannerListenersBound = false;

    function authHeaders(extra) {
        const h = { ...(extra || {}) };
        const token = sessionStorage.getItem('auth_token');
        if (token) h['Authorization'] = 'Bearer ' + token;
        return h;
    }

    // Convertit un ISO 8601 UTC (stocke) <-> valeur d'un <input datetime-local>
    // (heure LOCALE, sans zone). On passe par l'objet Date pour la conversion.
    function isoToLocalInput(iso) {
        if (!iso) return '';
        const d = new Date(iso);
        if (isNaN(d)) return '';
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
    function localInputToIso(local) {
        if (!local) return null;
        const d = new Date(local);          // interprete comme heure locale
        if (isNaN(d)) return null;
        return d.toISOString();             // renvoie en UTC (Z)
    }

    function updateBannerPreview() {
        const preview = $('bannerPreview');
        if (!preview) return;
        const msg = ($('bannerMessage')?.value || '').trim();
        const severity = $('bannerSeverity')?.value || 'info';
        if (!msg) {
            preview.className = 'banner-preview-empty';
            preview.textContent = 'Aucun message';
            return;
        }
        preview.className = 'banner-preview bb-banner bb-banner-' + severity;
        preview.textContent = (severity === 'info' ? 'ℹ ' : '⚠ ') + msg;
    }

    function bindBannerListeners() {
        if (bannerListenersBound) return;
        const msg = $('bannerMessage');
        const sev = $('bannerSeverity');
        const count = $('bannerCharCount');
        if (msg) {
            msg.addEventListener('input', () => {
                if (count) count.textContent = msg.value.length;
                updateBannerPreview();
            });
        }
        if (sev) sev.addEventListener('change', updateBannerPreview);
        bannerListenersBound = true;
    }

    async function loadBanner() {
        bindBannerListeners();
        setBannerStatus('');
        try {
            const res = await fetch('/api/admin/banner', { headers: authHeaders() });
            if (!res.ok) throw new Error('load failed');
            const { banner } = await res.json();
            const b = banner || {};
            const set = (id, val) => { const el = $(id); if (el) el.value = val ?? ''; };
            const check = (id, val) => { const el = $(id); if (el) el.checked = !!val; };
            check('bannerActive', b.active);
            set('bannerMessage', b.message || '');
            set('bannerSeverity', b.severity || 'info');
            check('bannerDismissible', b.dismissible !== false);
            set('bannerStartsAt', isoToLocalInput(b.starts_at));
            set('bannerEndsAt', isoToLocalInput(b.ends_at));
            const count = $('bannerCharCount');
            if (count) count.textContent = (b.message || '').length;
            updateBannerPreview();
        } catch (e) {
            console.error('Failed to load banner:', e);
            setBannerStatus('Erreur de chargement', 'error');
        }
    }

    function setBannerStatus(text, kind) {
        const el = $('bannerSaveStatus');
        if (!el) return;
        el.textContent = text;
        el.className = 'banner-save-status' + (kind ? ' ' + kind : '');
    }

    async function saveBanner() {
        const btn = $('bannerSaveBtn');
        const payload = {
            active: $('bannerActive')?.checked || false,
            message: ($('bannerMessage')?.value || '').trim(),
            severity: $('bannerSeverity')?.value || 'info',
            dismissible: $('bannerDismissible')?.checked || false,
            starts_at: localInputToIso($('bannerStartsAt')?.value),
            ends_at: localInputToIso($('bannerEndsAt')?.value),
        };

        // Garde-fou cote client (le serveur revalide de toute facon).
        if (payload.active && !payload.message) {
            setBannerStatus('Un message est requis pour activer la bannière', 'error');
            return;
        }

        if (btn) btn.disabled = true;
        setBannerStatus('Enregistrement...');
        try {
            const res = await fetch('/api/admin/banner', {
                method: 'PUT',
                headers: authHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify(payload),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Échec');
            // Recharge l'id genere par le serveur (pour la coherence du rejet client).
            if (data.banner) {
                const sa = $('bannerStartsAt'), ea = $('bannerEndsAt');
                if (sa) sa.value = isoToLocalInput(data.banner.starts_at);
                if (ea) ea.value = isoToLocalInput(data.banner.ends_at);
            }
            setBannerStatus('Enregistré ✓', 'success');
            setTimeout(() => setBannerStatus(''), 3000);
        } catch (e) {
            setBannerStatus(e.message || 'Erreur', 'error');
        } finally {
            if (btn) btn.disabled = false;
        }
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

            // p50 (mediane) plutot que la moyenne: la moyenne melange requetes
            // legeres et lourdes (upload, ouverture MDF4) tous endpoints confondus,
            // une seule requete lente la fait exploser. La mediane reflete la
            // latence reellement ressentie sur la majorite des requetes. Repli sur
            // avg si percentiles absents (coherent avec le tableau par jour).
            const p50 = data.latency?.p50 ?? data.latency?.avg ?? 0;
            setText('metricAvgLatency', p50 > 0 ? `${Math.round(p50)}ms` : '-');
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
            renderMetricsCharts(data.daily_breakdown || []);
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

    // Instances uPlot vivantes, detruites/recreees a chaque rendu (le panneau se
    // recharge sur "Actualiser" et au changement d'onglet). Sans destroy(), les
    // anciennes instances fuiraient et empileraient des listeners de resize.
    let metricsChartInstances = [];

    function destroyMetricsCharts() {
        metricsChartInstances.forEach(u => { try { u.destroy(); } catch (_) {} });
        metricsChartInstances = [];
    }

    function renderMetricsCharts(days) {
        const container = $('metricsCharts');
        if (!container || typeof uPlot === 'undefined') return;

        // Le layout de la grille peut ne pas etre pret a l'appel synchrone (panneau
        // fraichement affiche). On rend au frame suivant, quand les largeurs sont
        // calculees - sinon uPlot part sur une largeur nulle et empile les labels.
        requestAnimationFrame(() => renderMetricsChartsNow(container, days));
    }

    function renderMetricsChartsNow(container, days) {
        if (typeof uPlot === 'undefined') return;
        destroyMetricsCharts();
        container.innerHTML = '';

        // Les jours arrivent du plus recent au plus ancien: on inverse pour un axe
        // temporel croissant (gauche = ancien, droite = aujourd'hui).
        const ordered = [...days].reverse().filter(d => !d.no_data);
        if (ordered.length < 2) {
            container.innerHTML = '<div class="metrics-no-data"><p>Pas assez de jours pour tracer une tendance (minimum 2).</p></div>';
            return;
        }

        const xs = ordered.map(d => new Date(d.date + 'T00:00:00').getTime() / 1000);

        // Couleurs lues sur le theme courant (coherence sombre/clair).
        const cs = getComputedStyle(document.documentElement);
        const cssVar = (name, fallback) => (cs.getPropertyValue(name) || fallback).trim();
        const axisColor = cssVar('--ctp-overlay1', '#9399b2');
        const gridColor = 'rgba(127,127,127,0.12)';
        const teal = cssVar('--ctp-teal', '#94e2d5');
        const blue = cssVar('--ctp-blue', '#89b4fa');
        const peach = cssVar('--ctp-peach', '#fab387');
        const red = cssVar('--ctp-red', '#f38ba8');

        // Largeur = celle du conteneur des graphes, mesuree maintenant (on est
        // dans un requestAnimationFrame, le layout est fait). Les graphes sont
        // empiles en pleine largeur (voir CSS): plus lisible pour 7 points et
        // surtout aucun conflit largeur-fixe / cellule-de-grille qui faisait
        // deborder le canvas a droite.
        const chartWidth = () => Math.max(280, Math.floor(container.clientWidth) - 2);

        // Fabrique un graphe uPlot pleine largeur.
        function makeChart(title, series, yFormat) {
            const wrap = document.createElement('div');
            wrap.className = 'metrics-chart';
            const heading = document.createElement('div');
            heading.className = 'metrics-chart-title';
            heading.textContent = title;
            wrap.appendChild(heading);
            container.appendChild(wrap);

            const data = [xs, ...series.map(s => s.data)];
            const opts = {
                width: chartWidth(),
                height: 200,
                cursor: { y: false },
                legend: { show: series.length > 1 },
                scales: { x: { time: true } },
                axes: [
                    {
                        stroke: axisColor,
                        grid: { stroke: gridColor, width: 1 },
                        ticks: { stroke: gridColor, width: 1 },
                        // Un tick par jour reel (nos xs), pas la grille auto de uPlot
                        // qui, avec peu de points sur une large zone, duplique les
                        // dates (22/7 22/7 22/7...).
                        splits: () => xs,
                        values: (u, splits) => splits.map(v => {
                            const d = new Date(v * 1000);
                            return `${d.getDate()}/${d.getMonth() + 1}`;
                        }),
                        font: '11px Inter, sans-serif',
                    },
                    {
                        stroke: axisColor,
                        grid: { stroke: gridColor, width: 1 },
                        ticks: { stroke: gridColor, width: 1 },
                        values: (u, splits) => splits.map(yFormat),
                        size: 52,
                        font: '11px Inter, sans-serif',
                    },
                ],
                series: [
                    {},
                    ...series.map(s => ({
                        label: s.label,
                        stroke: s.color,
                        width: s.width || 2,
                        points: { show: ordered.length <= 10, size: 5, stroke: s.color, fill: s.color },
                    })),
                ],
            };

            const u = new uPlot(opts, data, wrap);
            metricsChartInstances.push(u);
            return u;
        }

        const nInt = (v) => (v == null ? null : Math.round(v));

        // 1) Activite: utilisateurs uniques + requetes (deux echelles trop
        // differentes pour partager un axe -> deux graphes cote a cote).
        makeChart('Utilisateurs uniques',
            [{ label: 'Utilisateurs', data: ordered.map(d => nInt(d.unique_users)), color: teal }],
            v => `${v}`);

        makeChart('Requêtes',
            [{ label: 'Requêtes', data: ordered.map(d => nInt(d.total_requests)), color: blue }],
            v => v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${v}`);

        // 2) Latence: p50 vs p95 sur le meme graphe. C'est LE graphe qui raconte
        // l'histoire - l'ecart p50/p95 montre la dispersion que la moyenne cachait.
        const p50 = ordered.map(d => nInt(d.latency?.p50 ?? d.latency?.avg));
        const p95 = ordered.map(d => nInt(d.latency?.p95));
        const hasP95 = p95.some(v => v != null && v > 0);
        makeChart('Latence (médiane vs P95)',
            hasP95
                ? [
                    { label: 'P50 (médiane)', data: p50, color: teal },
                    { label: 'P95', data: p95, color: peach },
                ]
                : [{ label: 'P50 (médiane)', data: p50, color: teal }],
            v => `${v}ms`);

        observeMetricsContainer();
    }

    // Reflow des graphes quand leur conteneur change de largeur. Un ResizeObserver
    // sur le conteneur est plus fiable que l'evenement window: il capte aussi le
    // repli de la sidebar, l'apparition d'une scrollbar, etc. Tous les graphes
    // etant pleine largeur, ils suivent la meme mesure.
    let metricsResizeTimer = null;
    function reflowMetricsCharts() {
        const container = $('metricsCharts');
        if (!container || !metricsChartInstances.length) return;
        const w = Math.max(280, Math.floor(container.clientWidth) - 2);
        metricsChartInstances.forEach(u => u.setSize({ width: w, height: 200 }));
    }

    let metricsResizeObserver = null;
    function observeMetricsContainer() {
        const container = $('metricsCharts');
        if (!container || metricsResizeObserver || typeof ResizeObserver === 'undefined') return;
        metricsResizeObserver = new ResizeObserver(() => {
            clearTimeout(metricsResizeTimer);
            metricsResizeTimer = setTimeout(reflowMetricsCharts, 120);
        });
        metricsResizeObserver.observe(container);
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
                <div style="text-align: center;" title="Latence médiane (p50) : moitié des requêtes plus rapides. Plus représentative que la moyenne, qui est gonflée par les requêtes lourdes (upload, ouverture de fichier).">Latence méd.</div>
                <div>Activité</div>
            </div>
        `;

        days.forEach(day => {
            const date = new Date(day.date);
            const dayName = dayNames[date.getDay()];
            const formattedDate = formatDate(day.date);
            const barWidth = maxRequests > 0 ? (day.total_requests / maxRequests * 100) : 0;
            // Colonne latence: mediane (p50) et non moyenne. Repli sur avg pour
            // les jours anciens dont les echantillons de percentiles n'ont pas ete
            // persistes (retro-compat des donnees deja stockees).
            const p50 = day.latency?.p50 ?? day.latency?.avg ?? 0;

            html += `
                <div class="metrics-day-row">
                    <div class="metrics-day-date">${formattedDate}<span class="day-name">${dayName}</span></div>
                    <div class="metrics-day-value highlight">${day.unique_users || 0}</div>
                    <div class="metrics-day-value">${formatNumber(day.total_requests || 0)}</div>
                    <div class="metrics-day-value">${day.sessions?.count || 0}</div>
                    <div class="metrics-day-value">${p50 > 0 ? Math.round(p50) + 'ms' : '-'}</div>
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

        // Ordre par percentiles croissants (lecture de distribution), la moyenne
        // mise a l'ecart et annotee: c'est l'indicateur trompeur ici, on la garde
        // pour reference mais on ne la met plus en avant. L'ecart p50 <-> avg <-> p95
        // raconte l'histoire: si avg >> p50, quelques requetes lourdes tirent la
        // moyenne, la majorite du trafic est en realite au niveau du p50.
        const gap = latency.avg && latency.p50 ? latency.avg / Math.max(latency.p50, 1) : 1;
        const gapNote = gap >= 2
            ? `<div class="metrics-latency-note">La moyenne est ${gap.toFixed(1)}× la médiane : quelques requêtes lourdes (upload, ouverture de fichier) la gonflent. La médiane reflète l'expérience réelle.</div>`
            : '';

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
                <div class="metrics-latency-item highlight">
                    <div class="metrics-latency-value ${getClass(latency.p50)}">${Math.round(latency.p50)}ms</div>
                    <div class="metrics-latency-label">P50 (médiane)</div>
                </div>
                <div class="metrics-latency-item">
                    <div class="metrics-latency-value ${getClass(latency.p95)}">${Math.round(latency.p95)}ms</div>
                    <div class="metrics-latency-label">P95</div>
                </div>
                <div class="metrics-latency-item">
                    <div class="metrics-latency-value ${getClass(latency.p99 ?? latency.p95)}">${Math.round(latency.p99 ?? latency.p95)}ms</div>
                    <div class="metrics-latency-label">P99</div>
                </div>
                <div class="metrics-latency-item">
                    <div class="metrics-latency-value ${getClass(latency.max)}">${Math.round(latency.max)}ms</div>
                    <div class="metrics-latency-label">Max</div>
                </div>
                <div class="metrics-latency-item muted">
                    <div class="metrics-latency-value">${Math.round(latency.avg)}ms</div>
                    <div class="metrics-latency-label">Moyenne (indicatif)</div>
                </div>
            </div>
            ${gapNote}
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
                case 'saveBanner': saveBanner(); break;
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
