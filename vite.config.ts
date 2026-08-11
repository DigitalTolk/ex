import path from "path"
import { mkdirSync, writeFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// The build version is derived at runtime from the SHA-256 of the served
// index.html (Vite already cache-busts asset filenames into it, so any
// source change yields a different document hash). The server injects
// `<meta name="app-version">` into the served HTML and exposes the same
// hash via /api/v1/version — no Vite-side env var to keep in sync.

// import.meta.dirname (not __dirname): Vite 8's `configLoader: 'native'`
// loads this config as a real ESM module, where __dirname is undefined.
const distGitignorePath = path.resolve(import.meta.dirname, 'dist', '.gitignore')
const vendorChunks: Array<[string, (id: string) => boolean]> = [
  ['react-vendor', (id) => /node_modules\/(react|react-dom|react-router|react-router-dom)\//.test(id)],
  ['query-vendor', (id) => id.includes('/node_modules/@tanstack/react-query/')],
  // The composer is CodeMirror 6 (Lexical was removed) — split CodeMirror +
  // Lezer out of the catch-all vendor chunk.
  ['editor-vendor', (id) => id.includes('/node_modules/@codemirror/') || id.includes('/node_modules/codemirror/') || id.includes('/node_modules/@lezer/')],
  ['motion-vendor', (id) => id.includes('/node_modules/motion/') || id.includes('/node_modules/framer-motion/')],
  ['emoji-vendor', (id) => id.includes('/node_modules/unicode-emoji-json/')],
  ['giphy-vendor', (id) => id.includes('/node_modules/@giphy/')],
  ['dnd-vendor', (id) => id.includes('/node_modules/@atlaskit/pragmatic-drag-and-drop')],
  ['ui-vendor', (id) => (
    id.includes('/node_modules/@base-ui/') ||
    id.includes('/node_modules/lucide-react/') ||
    id.includes('/node_modules/class-variance-authority/') ||
    id.includes('/node_modules/tailwind-merge/') ||
    id.includes('/node_modules/clsx/')
  )],
  ['virtual-vendor', (id) => id.includes('/node_modules/react-virtuoso/')],
]

function preserveDistGitignore() {
  return {
    name: 'preserve-dist-gitignore',
    closeBundle() {
      mkdirSync(path.dirname(distGitignorePath), { recursive: true })
      writeFileSync(distGitignorePath, '*\n!.gitignore\n')
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), preserveDistGitignore()],
  build: {
    // Two cohesive chunks sit just over the 500 kB default after the vendor
    // split: `editor-vendor` (the full CodeMirror 6 editor, ~181 kB gzip) and
    // `index` (first-party app code, ~128 kB gzip). Neither splits cleanly —
    // CodeMirror is one library and the app is loaded as a unit — and the gzip
    // sizes are fine, so lift the warning bar to keep it meaningful (it still
    // fires if any chunk balloons past this) rather than noisy.
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('/node_modules/')) return undefined
          return vendorChunks.find(([, match]) => match(id))?.[0] ?? 'vendor'
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
        ws: true,
      },
      '/auth': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
})
