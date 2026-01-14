/**
 * Auth Module - Gestion de l'authentification côté client
 * Sécurisé: validation des données, protection XSS, gestion sécurisée du token
 */

// État global
let currentUser = null;
let authToken = null;
let tokenExpiry = null;


// --- Validation Utilities ---

function isValidEmail(email) {
    const pattern = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    return typeof email === 'string' && pattern.test(email) && email.length <= 254;
}

function isValidUUID(str) {
    if (typeof str !== 'string') return false;
    const pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return pattern.test(str);
}

function sanitizeString(str, maxLength = 200) {
    if (typeof str !== 'string') return '';
    return str.slice(0, maxLength);
}

function escapeHtml(str) {
    if (typeof str !== 'string') return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function validateUserObject(user) {
    if (!user || typeof user !== 'object') return null;
    
    // Valide les champs requis
    if (!user.id || !isValidUUID(user.id)) return null;
    if (!user.email || !isValidEmail(user.email)) return null;
    
    // Retourne un objet nettoyé avec seulement les champs attendus
    return {
        id: user.id,
        email: sanitizeString(user.email, 254),
        name: sanitizeString(user.name || '', 100),
        role: ['user', 'admin'].includes(user.role) ? user.role : 'user',
        created_at: user.created_at || '',
        last_login: user.last_login || '',
        is_active: Boolean(user.is_active),
        settings: (typeof user.settings === 'object' && user.settings !== null) ? user.settings : {}
    };
}

// --- Stockage sécurisé ---

function saveAuthData(token, user, expiresAt = null) {
    // Valide le token (format JWT ou token opaque)
    if (typeof token !== 'string' || token.length < 20 || token.length > 500) {
        console.error('Invalid token format');
        return false;
    }
    
    // Valide l'utilisateur
    const validatedUser = validateUserObject(user);
    if (!validatedUser) {
        console.error('Invalid user object');
        return false;
    }
    
    try {
        // Note: localStorage est vulnérable aux attaques XSS
        // Pour une sécurité maximale, utiliser des cookies HttpOnly côté serveur
        sessionStorage.setItem('auth_token', token);
        sessionStorage.setItem('auth_user', JSON.stringify(validatedUser));
        
        if (expiresAt) {
            sessionStorage.setItem('auth_expires', expiresAt);
            tokenExpiry = new Date(expiresAt);
        }
        
        authToken = token;
        currentUser = validatedUser;
        return true;
    } catch (e) {
        console.error('Failed to save auth data:', e);
        return false;
    }
}

function loadAuthData() {
    try {
        authToken = sessionStorage.getItem('auth_token');
        const userStr = sessionStorage.getItem('auth_user');
        const expiresStr = sessionStorage.getItem('auth_expires');
        
        if (userStr) {
            const parsed = JSON.parse(userStr);
            currentUser = validateUserObject(parsed);
            
            // Si validation échoue, clear les données
            if (!currentUser) {
                clearAuthData();
                return { token: null, user: null };
            }
        }
        
        if (expiresStr) {
            tokenExpiry = new Date(expiresStr);
            // Vérifie si le token est expiré
            if (tokenExpiry < new Date()) {
                clearAuthData();
                return { token: null, user: null };
            }
        }
        
        return { token: authToken, user: currentUser };
    } catch (e) {
        console.error('Failed to load auth data:', e);
        clearAuthData();
        return { token: null, user: null };
    }
}

function clearAuthData() {
    try {
        sessionStorage.removeItem('auth_token');
        sessionStorage.removeItem('auth_user');
        sessionStorage.removeItem('auth_expires');
    } catch (e) {
        // Ignore errors
    }
    authToken = null;
    currentUser = null;
    tokenExpiry = null;
}

function isTokenExpired() {
    if (!tokenExpiry) return false;
    return tokenExpiry < new Date();
}


// --- API Calls ---

async function apiCall(endpoint, options = {}) {
    // Vérifie l'expiration du token avant chaque appel
    if (authToken && isTokenExpired()) {
        clearAuthData();
        updateAuthUI();
        return new Response(JSON.stringify({ error: 'Token expiré' }), { status: 401 });
    }
    
    const headers = {
        'Content-Type': 'application/json',
        ...options.headers
    };
    
    if (authToken) {
        headers['Authorization'] = `Bearer ${authToken}`;
    }
    
    try {
        const response = await fetch(endpoint, {
            ...options,
            headers,
            credentials: 'same-origin'  // Inclut les cookies si utilisés
        });
        
        // Si 401, déconnexion automatique
        if (response.status === 401) {
            clearAuthData();
            updateAuthUI();
        }
        
        return response;
    } catch (e) {
        console.error('API call failed:', e);
        throw e;
    }
}

async function register(email, password, name = '') {
    // Validation côté client
    if (!isValidEmail(email)) {
        return { success: false, error: 'Email invalide' };
    }
    if (typeof password !== 'string' || password.length < 8) {
        return { success: false, error: 'Mot de passe trop court' };
    }
    
    try {
        const res = await apiCall('/api/auth/register', {
            method: 'POST',
            body: JSON.stringify({ 
                email: sanitizeString(email, 254), 
                password, 
                name: sanitizeString(name, 100) 
            })
        });
        
        const data = await res.json();
        
        if (res.ok && data.success) {
            if (saveAuthData(data.token, data.user, data.expires_at)) {
                updateAuthUI();
                return { success: true, user: currentUser };
            }
            return { success: false, error: 'Erreur de validation des données' };
        }
        
        return { success: false, error: sanitizeString(data.error || 'Erreur inconnue', 200) };
    } catch (e) {
        return { success: false, error: 'Erreur de connexion au serveur' };
    }
}

async function login(email, password) {
    // Validation côté client
    if (!isValidEmail(email)) {
        return { success: false, error: 'Email invalide' };
    }
    if (typeof password !== 'string' || password.length === 0) {
        return { success: false, error: 'Mot de passe requis' };
    }
    
    try {
        const res = await apiCall('/api/auth/login', {
            method: 'POST',
            body: JSON.stringify({ 
                email: sanitizeString(email, 254), 
                password 
            })
        });
        
        const data = await res.json();
        
        if (res.ok && data.success) {
            if (saveAuthData(data.token, data.user, data.expires_at)) {
                updateAuthUI();
                return { success: true, user: currentUser };
            }
            return { success: false, error: 'Erreur de validation des données' };
        }
        
        return { success: false, error: sanitizeString(data.error || 'Erreur inconnue', 200) };
    } catch (e) {
        return { success: false, error: 'Erreur de connexion au serveur' };
    }
}

async function logout() {
    if (authToken) {
        try {
            await apiCall('/api/auth/logout', { method: 'POST' });
        } catch (e) {
            // Continue même si l'appel échoue
        }
    }
    clearAuthData();
    updateAuthUI();
}

async function getCurrentUser() {
    if (!authToken) return null;
    
    try {
        const res = await apiCall('/api/auth/me');
        if (res.ok) {
            const data = await res.json();
            const validatedUser = validateUserObject(data.user);
            if (validatedUser) {
                currentUser = validatedUser;
                sessionStorage.setItem('auth_user', JSON.stringify(currentUser));
                return currentUser;
            }
        }
    } catch (e) {
        console.error('Failed to get current user:', e);
    }
    
    return null;
}

async function updateProfile(updates) {
    // Valide les updates
    const safeUpdates = {};
    if (updates.name !== undefined) {
        safeUpdates.name = sanitizeString(updates.name, 100);
    }
    if (updates.settings !== undefined && typeof updates.settings === 'object') {
        safeUpdates.settings = updates.settings;
    }
    
    try {
        const res = await apiCall('/api/auth/me', {
            method: 'PUT',
            body: JSON.stringify(safeUpdates)
        });
        
        const data = await res.json();
        
        if (res.ok && data.success) {
            const validatedUser = validateUserObject(data.user);
            if (validatedUser) {
                currentUser = validatedUser;
                sessionStorage.setItem('auth_user', JSON.stringify(currentUser));
                return { success: true, user: currentUser };
            }
        }
        
        return { success: false, error: sanitizeString(data.error || 'Erreur inconnue', 200) };
    } catch (e) {
        return { success: false, error: 'Erreur de connexion au serveur' };
    }
}

async function changePassword(currentPassword, newPassword) {
    if (typeof currentPassword !== 'string' || currentPassword.length === 0) {
        return { success: false, error: 'Mot de passe actuel requis' };
    }
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
        return { success: false, error: 'Nouveau mot de passe trop court' };
    }
    
    try {
        const res = await apiCall('/api/auth/change-password', {
            method: 'POST',
            body: JSON.stringify({
                current_password: currentPassword,
                new_password: newPassword
            })
        });
        
        const data = await res.json();
        
        // Si le serveur retourne un nouveau token, l'utiliser
        if (res.ok && data.token) {
            saveAuthData(data.token, currentUser, data.expires_at);
        }
        
        return { 
            success: res.ok, 
            error: sanitizeString(data.error || '', 200), 
            message: sanitizeString(data.message || '', 200) 
        };
    } catch (e) {
        return { success: false, error: 'Erreur de connexion au serveur' };
    }
}

async function getUserFeatures() {
    try {
        const res = await apiCall('/api/auth/features');
        if (res.ok) {
            const data = await res.json();
            return {
                features: Array.isArray(data.features) ? data.features : [],
                role: ['user', 'admin', 'anonymous'].includes(data.role) ? data.role : 'anonymous',
                authenticated: Boolean(data.authenticated)
            };
        }
    } catch (e) {
        console.error('Failed to get features:', e);
    }
    return { features: [], role: 'anonymous', authenticated: false };
}


// --- UI Updates ---

function updateAuthUI() {
    const loginBtn = document.getElementById('loginBtn');
    const userInfo = document.getElementById('userInfo');
    const userDropdown = document.getElementById('userDropdown');
    
    if (currentUser) {
        // Utilisateur connecté
        if (loginBtn) loginBtn.style.display = 'none';
        if (userInfo) {
            userInfo.style.display = 'flex';
            
            // Avatar - utilise escapeHtml pour éviter XSS
            const avatar = userInfo.querySelector('.user-avatar');
            if (avatar) {
                const initial = (currentUser.name || currentUser.email || '?')[0].toUpperCase();
                avatar.textContent = initial;
            }
            
            // Nom dans le nav
            const userName = userInfo.querySelector('.user-name');
            if (userName) {
                userName.textContent = currentUser.name || currentUser.email.split('@')[0];
            }
        }
        
        // Dropdown header
        if (userDropdown) {
            const dropdownName = userDropdown.querySelector('.nav-user-dropdown-header .user-name');
            const dropdownEmail = userDropdown.querySelector('.nav-user-dropdown-header .user-email');
            if (dropdownName) {
                dropdownName.textContent = currentUser.name || currentUser.email.split('@')[0];
            }
            if (dropdownEmail) {
                dropdownEmail.textContent = currentUser.email;
            }
        }
        
        // Affiche/cache les éléments selon l'auth
        document.querySelectorAll('[data-auth="required"]').forEach(el => {
            el.style.display = '';
        });
        document.querySelectorAll('[data-auth="guest"]').forEach(el => {
            el.style.display = 'none';
        });
        
        // Éléments admin
        const isAdmin = currentUser.role === 'admin';
        document.querySelectorAll('[data-auth="admin"]').forEach(el => {
            el.style.display = isAdmin ? '' : 'none';
        });
        
    } else {
        // Non connecté
        if (loginBtn) loginBtn.style.display = 'flex';
        if (userInfo) userInfo.style.display = 'none';
        if (userDropdown) userDropdown.classList.remove('active');
        
        document.querySelectorAll('[data-auth="required"]').forEach(el => {
            el.style.display = 'none';
        });
        document.querySelectorAll('[data-auth="guest"]').forEach(el => {
            el.style.display = '';
        });
        document.querySelectorAll('[data-auth="admin"]').forEach(el => {
            el.style.display = 'none';
        });
    }
}

function toggleUserMenu() {
    const dropdown = document.getElementById('userDropdown');
    if (dropdown) {
        dropdown.classList.toggle('active');
    }
}

// Fermer le dropdown quand on clique ailleurs
document.addEventListener('click', (e) => {
    const userInfo = document.getElementById('userInfo');
    const dropdown = document.getElementById('userDropdown');
    
    if (dropdown && dropdown.classList.contains('active')) {
        if (!userInfo?.contains(e.target) && !dropdown.contains(e.target)) {
            dropdown.classList.remove('active');
        }
    }
});

function showProfileModal() {
    const dropdown = document.getElementById('userDropdown');
    if (dropdown) dropdown.classList.remove('active');
    
    showNotification('Profil - Bientôt disponible', 'info');
}


// --- Modals (avec protection XSS) ---

function showLoginModal() {
    const modal = document.getElementById('authModal');
    const modalContent = document.getElementById('authModalContent');
    
    if (!modal || !modalContent) {
        console.warn('Auth modal not found');
        return;
    }
    
    // Création sécurisée du DOM (pas d'innerHTML avec des variables)
    modalContent.innerHTML = '';
    
    // Header
    const header = document.createElement('div');
    header.className = 'auth-modal-header';
    header.innerHTML = `
        <h2>Connexion</h2>
        <button class="auth-modal-close" type="button">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"/>
                <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
        </button>
    `;
    header.querySelector('.auth-modal-close').addEventListener('click', closeAuthModal);
    
    // Form
    const form = document.createElement('form');
    form.id = 'loginForm';
    form.className = 'auth-form';
    form.innerHTML = `
        <div class="auth-field">
            <label for="loginEmail">Email</label>
            <input type="email" id="loginEmail" required placeholder="votre@email.com" autocomplete="email">
        </div>
        <div class="auth-field">
            <label for="loginPassword">Mot de passe</label>
            <input type="password" id="loginPassword" required placeholder="••••••••" autocomplete="current-password">
        </div>
        <div class="auth-error" id="loginError"></div>
        <button type="submit" class="auth-submit-btn">Se connecter</button>
    `;
    form.addEventListener('submit', handleLogin);
    
    // Footer
    const footer = document.createElement('div');
    footer.className = 'auth-footer';
    footer.innerHTML = `<p>Pas encore de compte ? <a href="#">Créer un compte</a></p>`;
    footer.querySelector('a').addEventListener('click', (e) => {
        e.preventDefault();
        showRegisterModal();
    });
    
    modalContent.appendChild(header);
    modalContent.appendChild(form);
    modalContent.appendChild(footer);
    
    modal.classList.add('active');
    document.getElementById('loginEmail').focus();
}

function showRegisterModal() {
    const modal = document.getElementById('authModal');
    const modalContent = document.getElementById('authModalContent');
    
    if (!modal || !modalContent) return;
    
    modalContent.innerHTML = '';
    
    // Header
    const header = document.createElement('div');
    header.className = 'auth-modal-header';
    header.innerHTML = `
        <h2>Créer un compte</h2>
        <button class="auth-modal-close" type="button">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"/>
                <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
        </button>
    `;
    header.querySelector('.auth-modal-close').addEventListener('click', closeAuthModal);
    
    // Form
    const form = document.createElement('form');
    form.id = 'registerForm';
    form.className = 'auth-form';
    form.innerHTML = `
        <div class="auth-field">
            <label for="registerName">Nom</label>
            <input type="text" id="registerName" placeholder="Votre nom" autocomplete="name">
        </div>
        <div class="auth-field">
            <label for="registerEmail">Email</label>
            <input type="email" id="registerEmail" required placeholder="votre@email.com" autocomplete="email">
        </div>
        <div class="auth-field">
            <label for="registerPassword">Mot de passe</label>
            <input type="password" id="registerPassword" required placeholder="••••••••" autocomplete="new-password">
            <div class="auth-password-rules">
                <span class="auth-rule" id="rule-length">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10"/>
                    </svg>
                    8 caractères
                </span>
                <span class="auth-rule" id="rule-uppercase">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10"/>
                    </svg>
                    1 majuscule
                </span>
                <span class="auth-rule" id="rule-lowercase">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10"/>
                    </svg>
                    1 minuscule
                </span>
                <span class="auth-rule" id="rule-number">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10"/>
                    </svg>
                    1 chiffre
                </span>
            </div>
        </div>
        <div class="auth-field">
            <label for="registerPasswordConfirm">Confirmer le mot de passe</label>
            <input type="password" id="registerPasswordConfirm" required placeholder="••••••••" autocomplete="new-password">
            <div class="auth-password-match" id="passwordMatchIndicator" style="display: none;">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="10"/>
                </svg>
                <span></span>
            </div>
        </div>
        <div class="auth-error" id="registerError"></div>
        <button type="submit" class="auth-submit-btn">Créer mon compte</button>
    `;
    
    // Event listeners
    form.addEventListener('submit', handleRegister);
    form.querySelector('#registerPassword').addEventListener('input', validatePasswordRules);
    form.querySelector('#registerPasswordConfirm').addEventListener('input', validatePasswordMatch);
    
    // Footer
    const footer = document.createElement('div');
    footer.className = 'auth-footer';
    footer.innerHTML = `<p>Déjà un compte ? <a href="#">Se connecter</a></p>`;
    footer.querySelector('a').addEventListener('click', (e) => {
        e.preventDefault();
        showLoginModal();
    });
    
    modalContent.appendChild(header);
    modalContent.appendChild(form);
    modalContent.appendChild(footer);
    
    modal.classList.add('active');
    document.getElementById('registerName').focus();
}

function validatePasswordRules() {
    const password = document.getElementById('registerPassword')?.value || '';
    
    const rules = {
        'rule-length': password.length >= 8,
        'rule-uppercase': /[A-Z]/.test(password),
        'rule-lowercase': /[a-z]/.test(password),
        'rule-number': /[0-9]/.test(password)
    };
    
    for (const [ruleId, isValid] of Object.entries(rules)) {
        const ruleEl = document.getElementById(ruleId);
        if (ruleEl) {
            ruleEl.classList.toggle('valid', isValid);
            ruleEl.classList.toggle('invalid', !isValid);
            const svg = ruleEl.querySelector('svg');
            if (svg) {
                svg.innerHTML = isValid 
                    ? '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>'
                    : '<circle cx="12" cy="12" r="10"/>';
            }
        }
    }
    
    const confirmPassword = document.getElementById('registerPasswordConfirm')?.value;
    if (confirmPassword) {
        validatePasswordMatch();
    }
}

function validatePasswordMatch() {
    const password = document.getElementById('registerPassword')?.value || '';
    const confirmPassword = document.getElementById('registerPasswordConfirm')?.value || '';
    const indicator = document.getElementById('passwordMatchIndicator');
    
    if (!indicator) return;
    
    if (confirmPassword.length === 0) {
        indicator.style.display = 'none';
        return;
    }
    
    indicator.style.display = 'flex';
    const svg = indicator.querySelector('svg');
    const text = indicator.querySelector('span');
    
    const matches = password === confirmPassword;
    indicator.classList.toggle('match', matches);
    indicator.classList.toggle('no-match', !matches);
    
    if (svg) {
        svg.innerHTML = matches
            ? '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>'
            : '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>';
    }
    if (text) {
        text.textContent = matches 
            ? 'Les mots de passe correspondent' 
            : 'Les mots de passe ne correspondent pas';
    }
}

function closeAuthModal() {
    const modal = document.getElementById('authModal');
    if (modal) {
        modal.classList.remove('active');
    }
}


// --- Form Handlers ---

async function handleLogin(event) {
    event.preventDefault();
    
    const email = document.getElementById('loginEmail')?.value?.trim();
    const password = document.getElementById('loginPassword')?.value;
    const errorEl = document.getElementById('loginError');
    const submitBtn = event.target.querySelector('button[type="submit"]');
    
    if (!email || !password) {
        if (errorEl) errorEl.textContent = 'Veuillez remplir tous les champs';
        return;
    }
    
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Connexion...';
    }
    if (errorEl) errorEl.textContent = '';
    
    const result = await login(email, password);
    
    if (result.success) {
        closeAuthModal();
        showNotification('Connexion réussie !', 'success');
        
        if (typeof loadSources === 'function') {
            loadSources();
        }
    } else {
        if (errorEl) errorEl.textContent = result.error;
    }
    
    if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Se connecter';
    }
}

async function handleRegister(event) {
    event.preventDefault();
    
    const name = document.getElementById('registerName')?.value?.trim();
    const email = document.getElementById('registerEmail')?.value?.trim();
    const password = document.getElementById('registerPassword')?.value;
    const passwordConfirm = document.getElementById('registerPasswordConfirm')?.value;
    const errorEl = document.getElementById('registerError');
    const submitBtn = event.target.querySelector('button[type="submit"]');
    
    // Validation
    if (!email || !password || !passwordConfirm) {
        if (errorEl) errorEl.textContent = 'Veuillez remplir tous les champs obligatoires';
        return;
    }
    
    if (password !== passwordConfirm) {
        if (errorEl) errorEl.textContent = 'Les mots de passe ne correspondent pas';
        return;
    }
    
    if (password.length < 8) {
        if (errorEl) errorEl.textContent = 'Le mot de passe doit contenir au moins 8 caractères';
        return;
    }
    
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Création...';
    }
    if (errorEl) errorEl.textContent = '';
    
    const result = await register(email, password, name);
    
    if (result.success) {
        closeAuthModal();
        showNotification('Compte créé avec succès !', 'success');
        
        if (typeof loadSources === 'function') {
            loadSources();
        }
    } else {
        if (errorEl) errorEl.textContent = result.error;
    }
    
    if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Créer mon compte';
    }
}

function handleLogout() {
    logout();
    showNotification('Déconnexion réussie', 'info');

    if (typeof loadSources === 'function') {
        loadSources();
    }
}


// --- Notifications ---

function showNotification(message, type = 'info') {
    const container = document.getElementById('notificationContainer') || createNotificationContainer();
    
    const notification = document.createElement('div');
    notification.className = `notification notification-${type}`;
    
    const span = document.createElement('span');
    span.textContent = message;  // textContent pour éviter XSS
    
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', () => notification.remove());
    
    notification.appendChild(span);
    notification.appendChild(closeBtn);
    container.appendChild(notification);
    
    setTimeout(() => notification.remove(), 5000);
}

function createNotificationContainer() {
    const container = document.createElement('div');
    container.id = 'notificationContainer';
    container.className = 'notification-container';
    document.body.appendChild(container);
    return container;
}


// --- Feature Gating ---

function canUseFeature(feature) {
    const publicFeatures = ['view_eda', 'view_reports', 'convert_files'];
    
    if (!currentUser) {
        return publicFeatures.includes(feature);
    }
    
    if (currentUser.role === 'admin') return true;
    
    const userFeatures = [
        ...publicFeatures,
        'create_scripts', 'run_scripts', 'save_layouts',
        'create_mappings', 'upload_files'
    ];
    return userFeatures.includes(feature);
}

function requireFeature(feature, callback) {
    if (canUseFeature(feature)) {
        callback();
    } else {
        if (!currentUser) {
            showNotification('Connectez-vous pour accéder à cette fonctionnalité', 'warning');
            showLoginModal();
        } else {
            showNotification('Accès non autorisé', 'error');
        }
    }
}


// --- Initialization ---

function initAuth() {
    loadAuthData();
    updateAuthUI();
    
    // Vérifie la validité du token
    if (authToken) {
        getCurrentUser().then(user => {
            if (!user) {
                clearAuthData();
                updateAuthUI();
            }
        });
    }
    
    // Ferme le modal au clic sur l'overlay
    const modal = document.getElementById('authModal');
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                closeAuthModal();
            }
        });
    }
    
    // Ferme le modal avec Escape
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeAuthModal();
        }
    });
}

// Auto-init
document.addEventListener('DOMContentLoaded', initAuth);
// =========================================================================
// Expose globals for other modules (Vite compatibility)
// =========================================================================
window.showLoginModal = showLoginModal;
window.closeLoginModal = closeAuthModal;  // alias
window.closeAuthModal = closeAuthModal;
window.showRegisterModal = showRegisterModal;
window.showProfileModal = showProfileModal;
window.handleLogout = handleLogout;
window.toggleUserMenu = toggleUserMenu;
window.updateAuthUI = updateAuthUI;
window.showNotification = showNotification;
window.initAuth = initAuth;
window.apiCall = apiCall;

// Dynamic getter for currentUser (so other modules always get the current value)
Object.defineProperty(window, 'currentUser', {
    get: () => currentUser,
    set: (val) => { currentUser = val; }
});

Object.defineProperty(window, 'authToken', {
    get: () => authToken,
    set: (val) => { authToken = val; }
});