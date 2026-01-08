import { defineConfig } from 'vite'
import { resolve } from 'path'
import { copyFileSync, mkdirSync, readdirSync, statSync } from 'fs'

// Plugin pour copier les dossiers views/ et components/ dans dist/
function copyFoldersPlugin() {
  return {
    name: 'copy-folders',
    writeBundle() {
      const folders = ['views', 'components']
      
      function copyRecursive(src, dest) {
        try {
          mkdirSync(dest, { recursive: true })
        } catch (e) {}
        
        const entries = readdirSync(src)
        for (const entry of entries) {
          const srcPath = resolve(src, entry)
          const destPath = resolve(dest, entry)
          
          if (statSync(srcPath).isDirectory()) {
            copyRecursive(srcPath, destPath)
          } else {
            copyFileSync(srcPath, destPath)
          }
        }
      }
      
      for (const folder of folders) {
        const src = resolve(__dirname, folder)
        const dest = resolve(__dirname, 'dist', folder)
        try {
          copyRecursive(src, dest)
          console.log(`Copied ${folder}/ to dist/`)
        } catch (e) {
          console.warn(`Could not copy ${folder}/: ${e.message}`)
        }
      }
    }
  }
}

export default defineConfig({
  root: '.',
  publicDir: 'public',
  
  plugins: [copyFoldersPlugin()],
  
  server: {
    port: 5173,
    open: true,
    proxy: {
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true
      }
    }
  },
  
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html')
      }
    }
  },
  
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src')
    }
  }
})
