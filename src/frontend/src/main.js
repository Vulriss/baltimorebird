/**
 * Baltimore Bird - Main Entry Point (Vite)
 * 
 * Ce fichier charge tous les styles et modules de l'application.
 */

// ============================================================================
// Styles (Vite les bundle automatiquement)
// ============================================================================
import '../styles/styles.css'
import '../styles/auth.css'
import '../styles/dashboard.css'
import '../styles/reports.css'
import '../styles/settings.css'
import '../styles/storage.css'
import '../styles/python-syntax-prism.css'

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
console.log('🐦 Baltimore Bird loaded via Vite')
