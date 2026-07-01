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
      'react-virtuoso',
      'zod',
    ],
  },
  test: {
    include: ['src/**/*.browser.test.{ts,tsx}'],
    setupFiles: ['./src/test/react-act-setup.ts', './src/test/browser-setup.ts'],
    // Heavy full-route integration specs (e.g. channel-files-pinned) and the
    // CodeMirror composer specs mount the entire ChatPage / real editor across 3
    // Playwright projects; under full-suite CPU saturation their async
    // send/draft/WS/zoom chains can exceed the 5s default and flake. Raise the
    // ceiling so the suite is deterministic under load. This only affects how
    // long a slow test may run — it does not touch coverage.
    testTimeout: 45000,
    coverage: {
      provider: 'istanbul',
      // json-summary writes coverage-browser/coverage-summary.json
      // with the aggregated totals. The Makefile reads that file
      // instead of grepping the human-readable stdout summary —
      // stdout formatting is fragile across vitest versions and
      // hides the failure mode "tests passed but summary line
      // wasn't emitted" behind a coverage=0 false negative.
      reporter: ['text', 'lcov', 'json-summary'],
      reportsDirectory: './coverage-browser',
      exclude: [
        'src/main.tsx',
        'src/test/**',
        'src/**/__mocks__/**',
        'src/**/*.test.{ts,tsx}',
        'src/**/*.browser.test.{ts,tsx}',
        // Pure URL-scheme guard — exhaustively unit-tested in the jsdom suite
        // (url-safety.test.ts); graded there, not here.
        'src/lib/url-safety.ts',
        // Webhook rich-attachment renderer — exhaustively unit-tested in the
        // jsdom suite (MessageRichAttachments.test.tsx). It is pulled into the
        // browser run transitively via MessageItem, but its webhook-attachment
        // branches aren't exercised there; graded in jsdom, not here.
        'src/components/chat/MessageRichAttachments.tsx',
        // Gesture/keyboard helpers — unit-tested in the jsdom suite
        // (useSwipeDismiss.test, useDismissKeyboardOnScroll.test,
        // blur-input.test). Motion's pointer-based drag isn't exercisable
        // in jsdom and the helpers are mocked in browser component tests, so
        // they're pulled into the browser graph but graded in jsdom only.
        'src/hooks/useSwipeDismiss.ts',
        'src/hooks/useDismissKeyboardOnScroll.ts',
        'src/hooks/useKeyboardSurfaceColor.ts',
        'src/lib/blur-input.ts',
        // Delegated same-origin link router — a document-level click handler
        // fully unit-tested in jsdom (InAppLinkRouter.test, in-app-link.test).
        'src/components/InAppLinkRouter.tsx',
        'src/lib/in-app-link.ts',
        // Non-member @mention invite prompt — unit-tested in jsdom
        // (NonMemberInvitePrompt.test, non-member-mentions.test,
        // useNonMemberInvite.test).
        'src/components/chat/NonMemberInvitePrompt.tsx',
        'src/lib/non-member-mentions.ts',
        'src/hooks/useNonMemberInvite.ts',
        // Cross-tab notification dedup — a pure localStorage helper exhaustively
        // unit-tested in jsdom (notification-dedup.test.ts), including its
        // storage-throw / corrupt-payload fallback branches, which real browser
        // localStorage never exercises. Pulled into the browser graph via
        // NotificationContext; graded in jsdom, not here.
        'src/lib/notification-dedup.ts',
        // Activity stream + reminders — pure date math, a React-Query hook
        // module, the activity page, and the custom-time dialog are all
        // exhaustively unit-tested in jsdom (reminder-times.test, useActivity.test,
        // activity-page.test, reminder-dialog.test). Pulled into the browser graph
        // via MessageItem/Sidebar; graded in jsdom, not here. The browser-only
        // surface (the MessageItem "Remind me" submenu) IS exercised here.
        'src/lib/reminder-times.ts',
        // Datetime-local formatting primitives — the timezone/empty-zone branches
        // are exhaustively unit-tested in jsdom (datetime-input.test.ts,
        // user-time.test.ts); pulled into the browser graph via UserStatusDialog.
        'src/lib/datetime-input.ts',
        'src/hooks/useActivity.ts',
        'src/pages/ActivityPage.tsx',
        'src/components/chat/ReminderDialog.tsx',
        // Toast overlay — portal + window-event + fake-timer dismissal are
        // exhaustively unit-tested in jsdom (toaster.test.tsx); pulled into the
        // browser graph via App, graded in jsdom.
        'src/components/Toaster.tsx',
      ],
      // 99% branch gate over the merged desktop + mobile browser run.
      // vitest enforces it (non-zero exit), so `npm run
      // test:browser:coverage` fails on its own in both `make check`
      // and the CI "Run browser tests" step. The Makefile's explicit
      // summary-json check is a redundant backstop at the same bar.
      thresholds: {
        branches: 99,
      },
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
