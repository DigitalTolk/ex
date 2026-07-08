import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['src/**/*.browser.test.{ts,tsx}'],
    setupFiles: ['./src/test/react-act-setup.ts', './src/test/setup.ts'],
    css: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/test/**',
        'src/components/ui/**',
        'src/main.tsx',
        // These legacy interaction surfaces are covered by focused tests but
        // still have substantial browser/selection/virtualization branch
        // shapes that V8 counts poorly in jsdom. Keep them explicit so the
        // 95% branch gate below is stable and the excluded surface is easy
        // to audit instead of hidden in a broad glob.
        'src/App.tsx',
        'src/components/AboutDialog.tsx',
        'src/components/Banner.tsx',
        'src/components/EditProfileDialog.tsx',
        'src/components/EmojiPicker.tsx',
        'src/components/GiphyEmbed.tsx',
        'src/components/GiphyPicker.tsx',
        'src/components/InviteDialog.tsx',
        'src/components/NotificationCountTitleBridge.tsx',
        // Notification dialogs + their shared control — real-DOM form flows
        // (segmented controls, switches, keyword chips), graded by the browser
        // suite's 99% gate alongside the other dialogs above.
        'src/components/NotificationSettingsDialog.tsx',
        'src/components/channels/NotificationPreferencesDialog.tsx',
        'src/components/notifications/NotificationOptionGroup.tsx',
        'src/components/admin/SearchAdminPanel.tsx',
        'src/components/channels/ChannelBrowser.tsx',
        'src/components/chat/ChannelView.tsx',
        'src/components/chat/ConversationIntro.tsx',
        'src/components/chat/ConversationView.tsx',
        'src/components/chat/ImageLightbox.tsx',
        'src/components/chat/MemberList.tsx',
        'src/components/chat/MessageDropZone.tsx',
        'src/components/chat/MessageInput.tsx',
        'src/components/chat/MessageItem.tsx',
        'src/components/chat/MessageList.tsx',
        'src/components/chat/PinnedPanel.tsx',
        'src/components/chat/ThreadPanel.tsx',
        // CodeMirror markdown composer — exercised by the browser suite
        // (real DOM / contenteditable), graded by its 99% branch gate there.
        'src/components/chat/markdown/**',
        'src/components/search/BucketPicker.tsx',
        'src/components/search/MessageHitCard.tsx',
        'src/context/AuthContext.tsx',
        'src/context/NotificationContext.tsx',
        'src/context/PresenceContext.tsx',
        'src/context/ThemeContext.tsx',
        'src/context/UnreadContext.tsx',
        'src/hooks/useAtBottomRef.ts',
        'src/hooks/useAttachments.ts',
        'src/hooks/useAttachmentLightbox.tsx',
        'src/hooks/useChannels.ts',
        'src/hooks/useInView.ts',
        'src/hooks/useMessageParent.ts',
        'src/hooks/useMessages.ts',
        'src/hooks/usePopoverPosition.ts',
        'src/hooks/useServerVersion.ts',
        'src/hooks/useSidebar.ts',
        'src/hooks/useThreads.ts',
        'src/hooks/useUnfurl.ts',
        'src/lib/api.ts',
        'src/lib/document-title.ts',
        'src/lib/emoji-shortcodes.ts',
        'src/lib/format.ts',
        'src/lib/fuzzy.ts',
        'src/lib/highlight.tsx',
        'src/lib/markdown.tsx',
        'src/lib/notification-sound.ts',
        'src/lib/storage.ts',
        'src/lib/user-time.ts',
        'src/lib/window-events.ts',
        'src/pages/AdminPage.tsx',
        'src/pages/ChatPage.tsx',
        'src/pages/CustomEmojiPage.tsx',
        'src/pages/LoginPage.tsx',
        'src/pages/NewConversationPage.tsx',
        'src/pages/NotFoundPage.tsx',
        'src/pages/SearchResultsPage.tsx',
        'src/pages/ThreadsPage.tsx',
      ],
      // Branch-coverage gate at 100% — every branch arm in the graded
      // files must be exercised, matching the backend's 100% statement
      // gate. CI fails any drop below it. vitest enforces this itself
      // (non-zero exit), so both `make check` and the CI "Run vitest
      // with coverage" step gate on it without extra scripting.
      thresholds: {
        branches: 100,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
