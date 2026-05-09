import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { playwright } from '@vitest/browser-playwright';
import path from 'path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  optimizeDeps: {
    include: [
      '@giphy/js-fetch-api',
      '@giphy/react-components',
      '@lexical/code',
      '@lexical/link',
      '@lexical/list',
      '@lexical/markdown',
      '@lexical/react/LexicalComposer',
      '@lexical/react/LexicalComposerContext',
      '@lexical/react/LexicalContentEditable',
      '@lexical/react/LexicalErrorBoundary',
      '@lexical/react/LexicalHistoryPlugin',
      '@lexical/react/LexicalLinkPlugin',
      '@lexical/react/LexicalListPlugin',
      '@lexical/react/LexicalMarkdownShortcutPlugin',
      '@lexical/react/LexicalRichTextPlugin',
      '@lexical/react/LexicalTabIndentationPlugin',
      '@lexical/react/LexicalTypeaheadMenuPlugin',
      '@lexical/rich-text',
      '@lexical/selection',
      '@lexical/utils',
      'lexical',
      'react-dom/client',
      'react-virtuoso',
      'zod',
    ],
  },
  test: {
    include: ['src/**/*.browser.test.{ts,tsx}'],
    setupFiles: ['./src/test/browser-setup.ts'],
    coverage: {
      provider: 'istanbul',
      reporter: ['text', 'lcov'],
      reportsDirectory: './coverage-browser',
      exclude: [
        'src/main.tsx',
        'src/test/**',
        'src/**/*.test.{ts,tsx}',
        'src/**/*.browser.test.{ts,tsx}',
      ],
    },
    browser: {
      enabled: true,
      headless: true,
      ui: false,
      provider: playwright({
        launchOptions: {
          headless: true,
        },
      }),
      instances: [
        {
          name: 'chromium-desktop',
          browser: 'chromium',
          viewport: { width: 1280, height: 900 },
        },
        {
          name: 'chromium-mobile',
          browser: 'chromium',
          viewport: { width: 390, height: 844 },
        },
        {
          name: 'webkit-iphone',
          browser: 'webkit',
          viewport: { width: 393, height: 852 },
          provider: playwright({
            launchOptions: {
              headless: true,
            },
            contextOptions: {
              deviceScaleFactor: 3,
              hasTouch: true,
              isMobile: true,
              userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1',
            },
          }),
        },
      ],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
