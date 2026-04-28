import path from "path"
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// The build version is derived at runtime from the SHA-256 of the served
// index.html (Vite already cache-busts asset filenames into it, so any
// source change yields a different document hash). The server injects
// `<meta name="app-version">` into the served HTML and exposes the same
// hash via /api/v1/version — no Vite-side env var to keep in sync.

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
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
