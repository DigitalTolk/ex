import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { playwright } from '@vitest/browser-playwright';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['src/**/*.browser.test.{ts,tsx}'],
    setupFiles: ['./src/test/browser-setup.ts'],
    coverage: {
      provider: 'v8',
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
      ],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
