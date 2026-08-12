/**
 * Baltimore Bird - Main Entry Point (Vite)
 *
 * Structure:
 *   core/   - infrastructure transverse (etat, utilitaires, chargement de vues, nav, auth)
 *   eda/    - vue EDA (ancien app.js decoupe en modules + modules metier associes)
 *   views/  - autres vues (dashboard, reports, settings, storage)
 * Les modules communiquent via imports ESM au sein d'eda/, et via le pont window.*
 * (eda/globals.js) pour les modules historiques non convertis.
 */

// ============================================================================
// Styles (Vite les bundle automatiquement)
// ============================================================================
import '../styles/main.scss'

// ============================================================================
// Core (ordre important preserve)
// ============================================================================
import './core/state.js'
import './core/units.js'
import './core/utils.js'
import './core/view-loader.js'

// ============================================================================
// Vue EDA (decoupage de l'ancien app.js: voir src/eda/ARCHITECTURE.md)
// ============================================================================
import './eda/index.js'
import './eda/run-list.js'
import './eda/tabs.js'
import './eda/export-annotate.js'
import './eda/mda-import.js'
import './eda/layouts.js'
import './eda/lxf.js'

// ============================================================================
// Core (suite) et autres vues
// ============================================================================
import './core/banner.js'
import './core/telemetry.js'
import './core/feedback.js'
import './core/nav.js'
import './views/reports.js'
import './views/dashboard.js'
import './views/settings.js'
import './core/auth.js'
import './views/storage.js'
import './core/init.js'
import './core/code-editor.js'

// ============================================================================
// Ready
// ============================================================================
console.log('[Baltimore Bird] Loaded')
