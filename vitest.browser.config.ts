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
      // NOTE deliberately NO `include` here: vitest-4's include-universe
      // statically instruments never-loaded files, which double-instruments
      // modules also loaded through vi.mock(importOriginal) and corrupts the
      // merged report (bloated totals, phantom uncovered halves — seen on
      // lib/api.ts). The graded-universe guarantee comes from
      // scripts/check-browser-universe.mjs instead, which runs right after
      // the suite in `make check` and fails if any non-excluded src file is
      // missing from the produced lcov. scripts/check-coverage-partition.mjs
      // separately guarantees nothing is excluded from BOTH suites.
      exclude: [
        'src/main.tsx',
        // Type-only modules — emit no runtime code to instrument.
        'src/components/chat/markdown/types.ts',
        'src/types/index.ts',
        // Route/page shells + pure helpers graded by the jsdom gate (each
        // has a dedicated jsdom suite; nothing in the browser run mounts
        // them).
        'src/App.tsx',
        'src/components/NotificationCountTitleBridge.tsx',
        'src/components/channels/ChannelBrowser.tsx',
        'src/components/search/BucketPicker.tsx',
        'src/hooks/useInView.ts',
        'src/lib/highlight.tsx',
        'src/pages/AdminPage.tsx',
        'src/pages/NewConversationPage.tsx',
        'src/pages/SearchResultsPage.tsx',
        'src/pages/ThreadsPage.tsx',
        // Also graded by the jsdom gate; no browser flow loads them (the
        // browser-universe check keeps this list honest — a file listed here
        // while jsdom-excluded fails the partition check instead).
        'src/components/ErrorBoundary.tsx',
        'src/components/NotificationPermissionBanner.tsx',
        'src/components/admin/IncomingWebhooksPanel.tsx',
        'src/components/threads/ThreadCard.tsx',
        'src/hooks/useSearchAdmin.ts',
        'src/hooks/useWebSocket.ts',
        'src/lib/boot-splash.ts',
        'src/lib/event-types.ts',
        'src/lib/message-preview.ts',
        'src/pages/DirectoriesPage.tsx',
        'src/pages/DraftsPage.tsx',
        'src/pages/IncomingWebhooksPage.tsx',
        'src/pages/OIDCCallbackPage.tsx',
        'src/test/**',
        'src/**/__mocks__/**',
        'src/**/*.test.{ts,tsx}',
        'src/**/*.browser.test.{ts,tsx}',
        // Pure URL-scheme guard — exhaustively unit-tested in the jsdom suite
        // (url-safety.test.ts); graded there, not here.
        'src/lib/url-safety.ts',
        // Layout-tier + panel-width logic: pure modules exhaustively
        // unit-tested in the jsdom suite (device.test.ts, panel-width.test.ts,
        // usePanelWidth.test.tsx — drag, clamp, keyboard, reset arms); the
        // browser gate proves the WIRING via compact-tier.browser.test.tsx
        // and layout-resize.browser.test.tsx.
        'src/lib/device.ts',
        'src/lib/panel-width.ts',
        'src/hooks/usePanelWidth.ts',
        // Webhook rich-attachment renderer — exhaustively unit-tested in the
        // jsdom suite (MessageRichAttachments.test.tsx). It is pulled into the
        // browser run transitively via MessageItem, but its webhook-attachment
        // branches aren't exercised there; graded in jsdom, not here.
        'src/components/chat/MessageRichAttachments.tsx',
        // Gesture/keyboard helpers graded in the jsdom suite. blur-input.ts is
        // now ALSO graded here (real-browser focus, blur-input.browser.test.ts)
        // and is intentionally NOT listed below. The three that remain excluded
        // each carry a branch that a real browser can't deterministically reach,
        // so grading them under the browser (istanbul) provider would drag the
        // gate below 99%:
        //   • useSwipeDismiss.ts — carries a `v8 ignore`d SSR guard (not honored
        //     by istanbul) plus the non-Element pointer-target and re-entrant
        //     dismiss-latch arms that native pointer input can't drive; its
        //     wiring is proven by useSwipeDismiss.realswipe.browser.test.tsx and
        //     fully graded in jsdom.
        //   • useDismissKeyboardOnScroll.ts — needs synthetic TouchEvent dispatch
        //     (not the pointer-based swipe helper) and an `activeElement not an
        //     HTMLElement` arm real focus never produces.
        //   • useKeyboardSurfaceColor.ts — its `activeElement instanceof Element`
        //     false arm isn't reachable via real focus (activeElement is always
        //     an element / falls back to <body>).
        'src/hooks/useSwipeDismiss.ts',
        'src/hooks/useDismissKeyboardOnScroll.ts',
        'src/hooks/useKeyboardSurfaceColor.ts',
        //   • useMobileBackClose.ts — the stacked-overlay marker arms and the
        //     consumed-sentinel-vs-real-navigation cleanup arms need scripted
        //     history sequences that are deterministic in jsdom but racy
        //     against a real browser's async history traversal; wiring is
        //     proven by the dialog back-close browser test and the hook is
        //     fully graded in jsdom (useMobileBackClose.test.ts).
        'src/hooks/useMobileBackClose.ts',
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
        // Sentry init/report shim — DSN-gated singleton exhaustively
        // unit-tested in jsdom (sentry.test.ts). Pulled into the browser
        // graph via ErrorBoundary; graded in jsdom, not here.
        'src/lib/sentry.ts',
        // Input-recency tracker for the notification ack gate — a pure
        // event/clock helper exhaustively unit-tested in jsdom
        // (user-activity.test.ts). Pulled into the browser graph via
        // NotificationContext (whose ack-gating branches ARE exercised in
        // the browser suite); graded in jsdom, not here.
        'src/lib/user-activity.ts',
        // Desktop-shell DnD/Focus bridge — a pure window-global wrapper
        // exhaustively unit-tested in jsdom (dnd.test.ts), including the
        // throwing/rejecting-bridge arms. Pulled into the browser graph via
        // NotificationContext (whose DnD-gated ping branches ARE exercised
        // in the browser suite); graded in jsdom, not here.
        'src/lib/dnd.ts',
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
        // Incoming-webhooks admin React-Query hooks — an admin-only page not on
        // any browser flow; its list/create/update/delete mutations (incl. the
        // optimistic-delete cache patch + rollback) are exhaustively unit-tested
        // in jsdom (useWebhooks.test.tsx, incoming-webhooks-page.test.tsx).
        'src/hooks/useWebhooks.ts',
      ],
      // Full 100% gate (statements/branches/functions/lines) over the
      // merged desktop + mobile browser run.
      // vitest enforces it (non-zero exit), so `npm run
      // test:browser:coverage` fails on its own in both `make check`
      // and the CI "Run browser tests" step. The Makefile's explicit
      // summary-json check is a redundant backstop at the same bar.
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
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
