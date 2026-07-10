import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { playwright } from '@vitest/browser-playwright';
import path from 'path';

// ONE vitest config for every frontend suite, via test.projects:
//   • jsdom            — src/**/*.test.{ts,tsx}
//   • chromium-desktop — src/**/*.browser.test.{ts,tsx} (1280×900)
//   • chromium-mobile  — src/**/*.browser.test.{ts,tsx} (390×844)
//   • webkit-iphone    — src/**/*.browser.test.{ts,tsx} (393×852, touch)
//
// Coverage is a single MERGED istanbul report across all four projects
// (vitest requires one provider at the root with projects). The 100%
// thresholds therefore gate the UNION of jsdom + browser hits: every
// runtime file must be fully covered by SOME suite. This replaced the
// two-config split (v8 for jsdom + istanbul for browser) and its
// coverage-partition script — with one merged universe there is no
// partition to police, only the union gate plus the universe check
// (scripts/check-coverage-universe.mjs) that ensures every non-excluded
// src file actually appears in the report.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  optimizeDeps: {
    include: [
      '@giphy/js-fetch-api',
      '@giphy/react-components',
      '@codemirror/state',
      '@codemirror/view',
      '@codemirror/commands',
      '@codemirror/language',
      '@codemirror/lang-markdown',
      '@codemirror/autocomplete',
      '@lezer/markdown',
      '@lezer/highlight',
      '@lezer/common',
      'react-dom/client',
      // useServerVersion.browser.test drives a real SSR pass (getServerSnapshot
      // is only consulted by server renders); pre-bundle so Vite doesn't
      // discover it mid-run and reload deps under in-flight test files.
      'react-dom/server',
      'react-virtuoso',
      'zod',
      // Pulled in via ErrorBoundary → @/lib/sentry; pre-bundle it or Vite
      // discovers it mid-run and the dep-reload fails in-flight test files.
      '@sentry/react',
    ],
  },
  test: {
    // Cap the worker pool: the browser project's three Playwright instances
    // run alongside the jsdom pool in the merged run, and an uncapped pool
    // oversubscribes the machine badly enough to flake timing-sensitive
    // tests that pass in isolation.
    maxWorkers: '50%',
    coverage: {
      provider: 'istanbul',
      // json-summary writes coverage/coverage-summary.json with the merged
      // totals. The Makefile reads that file instead of grepping the
      // human-readable stdout summary — stdout formatting is fragile across
      // vitest versions and hides the failure mode "tests passed but summary
      // line wasn't emitted" behind a coverage=0 false negative.
      reporter: ['text', 'lcov', 'json-summary'],
      reportsDirectory: './coverage',
      // NOTE deliberately NO `include` here: vitest-4's include-universe
      // statically instruments never-loaded files, which double-instruments
      // modules also loaded through vi.mock(importOriginal) and corrupts the
      // merged report (bloated totals, phantom uncovered halves — seen on
      // lib/api.ts). The graded-universe guarantee comes from
      // scripts/check-coverage-universe.mjs instead, which runs right after
      // the suite in `make check` and fails if any non-excluded src file is
      // missing from the produced lcov.
      exclude: [
        'src/test/**',
        'src/**/__mocks__/**',
        'src/**/*.test.{ts,tsx}',
        'src/**/*.browser.test.{ts,tsx}',
        // Boot shim: createRoot(<App/>) + tier tracking start; no logic
        // beyond wiring (was the coverage-partition allowlist).
        'src/main.tsx',
        // Type-only modules — emit no runtime code to instrument.
        'src/components/chat/markdown/types.ts',
        'src/types/index.ts',
        // tygo-generated wire-type mirror — import-type-only, never loaded.
        'src/types/generated.ts',
      ],
      // Full 100% gate on every metric over the MERGED report — vitest
      // enforces it itself (non-zero exit), so `make check` and CI gate on
      // it without extra scripting.
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'jsdom',
          globals: true,
          environment: 'jsdom',
          include: ['src/**/*.{test,spec}.{ts,tsx}'],
          exclude: ['src/**/*.browser.test.{ts,tsx}'],
          setupFiles: ['./src/test/react-act-setup.ts', './src/test/setup.ts'],
          css: true,
          // Same rationale as the browser project's raised ceiling below:
          // in the merged run the jsdom workers share the machine with three
          // Playwright instances, and a userEvent-driven test can exceed the
          // 5s default under that saturation (seen on CreateChannelDialog).
          // This only affects how long a slow test may run — assertions and
          // hangs still fail, just with a later report.
          testTimeout: 30000,
        },
      },
      {
        extends: true,
        test: {
          name: 'browser',
          include: ['src/**/*.browser.test.{ts,tsx}'],
          setupFiles: ['./src/test/react-act-setup.ts', './src/test/browser-setup.ts'],
          // Heavy full-route integration specs (e.g. channel-files-pinned) and
          // the CodeMirror composer specs mount the entire ChatPage / real
          // editor across 3 Playwright instances; under full-suite CPU
          // saturation their async send/draft/WS/zoom chains can exceed the 5s
          // default and flake. Raise the ceiling so the suite is deterministic
          // under load. This only affects how long a slow test may run — it
          // does not touch coverage.
          testTimeout: 45000,
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
      },
    ],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
