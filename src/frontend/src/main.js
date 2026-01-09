/**
 * Baltimore Bird - Main Entry Point (Vite)
 * 
 * Ce fichier charge tous les styles et modules de l'application.
 */

// ============================================================================
// Styles (Vite les bundle automatiquement)
// ============================================================================
import '../styles/styles.scss'
import '../styles/auth.scss'
import '../styles/dashboard.scss'
import '../styles/reports.scss'
import '../styles/settings.scss'
import '../styles/storage.scss'
import '../styles/python-syntax-prism.scss'

// ============================================================================
// Legacy modules (ordre important préservé)
// ============================================================================
import './utils.js'
import './view-loader.js'
import './app.js'
import './nav.js'
import './reports.js'
import './dashboard.js'
import './settings.js'
import './auth.js'
import './storage.js'
import './init.js'
import './code-editor.js'

// ============================================================================
// Ready
// ============================================================================
console.log('[Baltimore Bird] Loaded')
