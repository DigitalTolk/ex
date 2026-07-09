import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.browser.config';

export default mergeConfig(
  base,
  defineConfig({
    test: {
      coverage: {
        reportsDirectory: '/tmp/cov-mine',
        include: [
          'src/components/chat/MessageItem.tsx',
          'src/components/chat/ImageLightbox.tsx',
          'src/components/chat/ChannelView.tsx',
          'src/components/chat/MessageDropZone.tsx',
        ],
        thresholds: { branches: 0, lines: 0, functions: 0, statements: 0 },
      },
    },
  }),
);
