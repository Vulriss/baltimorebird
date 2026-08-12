import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

// Config de test séparée de vite.config.js : on ne veut ni le plugin de copie
// de dossiers ni le proxy dev pendant les tests. jsdom fournit un DOM minimal
// pour les modules qui posent des listeners au chargement (bool-zones importe
// plots.js qui touche document au top-level).
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.js'],
    globals: false,
  },
  resolve: {
    alias: { '@': resolve(__dirname, 'src') },
  },
})
