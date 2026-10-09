import path from "path"
import { mkdirSync, writeFileSync } from 'node:fs'
import { defineConfig, type Plugin } from 'vite'
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

// pdf.js (the lazy PdfPreview) and Uppy (loaded on the first attachment
// upload) are reachable only through dynamic imports, so they are left out of
// the manual groups on purpose: a group also captures the shared modules its
// members depend on (Vite's preload helper, clsx), which made the entry import
// — and preload — all of pdf.js. Natural code splitting keeps them in their
// lazy chunks; they must not fall into the eager catch-all `vendor` either.
// The rest are those libraries' own dependencies, used by nothing else.
const lazyOnlyPackages = [
  'react-pdf', 'pdfjs-dist',
  'es-toolkit', 'make-cancellable-promise', 'make-event-props', 'merge-refs', 'tiny-invariant', 'warning', 'loose-envify',
  '@uppy/core', '@uppy/aws-s3', '@transloadit/prettier-bytes',
  'preact', 'lodash', 'nanoid', 'classnames', 'mime-match', 'wildcard', 'namespace-emitter',
  'p-queue', 'p-retry', 'p-timeout', 'eventemitter3', 'is-network-error',
].map((pkg) => `/node_modules/${pkg}/`)

// Where the dev server proxies /api and /auth. In the containerised hot-reload
// stack (`make dev-watch`) Vite runs in its own container and reaches the Go
// service over the compose network, so docker-compose.dev.yml injects the
// target; a bare `npm run dev` keeps talking to a local server on
// config.Load's default PORT.
const proxyTarget = process.env.VITE_PROXY_TARGET ?? 'http://localhost:8080'

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
// reactScanDev injects react-scan (https://react-scan.com) into the page on
// the DEV SERVER ONLY (`apply: 'serve'` — never in a build): it outlines
// components as they re-render and shows render counts/timings, so render
// churn in the chat is visible instead of guessed. Loaded as a classic
// script ahead of the module graph, which is what the auto build expects.
// Opt out for a session with REACT_SCAN=0.
function reactScanDev(): Plugin {
  return {
    name: 'react-scan-dev',
    apply: 'serve',
    transformIndexHtml(html) {
      if (process.env.REACT_SCAN === '0') return html;
      return html.replace(
        '<head>',
        '<head>\n    <script src="https://unpkg.com/react-scan/dist/auto.global.js"></script>',
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), preserveDistGitignore(), reactScanDev()],
  build: {
    // Three cohesive chunks sit over the 500 kB default after the vendor
    // split: `editor-vendor` (the full CodeMirror 6 editor, ~181 kB gzip),
    // `index` (first-party app code, ~128 kB gzip) and the lazy PDF viewer
    // (pdf.js, ~191 kB gzip, loaded only when a PDF is opened). None splits cleanly —
    // each is one library or loaded as a unit — and the gzip sizes are fine,
    // so lift the warning bar to keep it meaningful (it still fires if any
    // chunk balloons past this) rather than noisy.
    chunkSizeWarningLimit: 650,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('/node_modules/')) return undefined
          if (lazyOnlyPackages.some((pkg) => id.includes(pkg))) return undefined
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
        target: proxyTarget,
        changeOrigin: true,
        ws: true,
      },
      '/auth': {
        target: proxyTarget,
        changeOrigin: true,
      },
    },
  },
})
