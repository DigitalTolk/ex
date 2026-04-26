import path from "path"
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// __BUILD_VERSION__ is baked into the bundle so the running app can detect
// when the server has been deployed with a newer build. CI exports
// VITE_BUILD_VERSION (defaulting to git short-sha or tag) before `npm run
// build`; locally the value falls back to "dev".
const BUILD_VERSION = process.env.VITE_BUILD_VERSION || 'dev';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __BUILD_VERSION__: JSON.stringify(BUILD_VERSION),
  },
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
