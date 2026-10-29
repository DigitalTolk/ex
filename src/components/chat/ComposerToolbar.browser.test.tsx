import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { userEvent } from 'vitest/browser';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ComposerToolbar } from './ComposerToolbar';
import { formatShortcuts } from '@/lib/format-shortcuts';
import { isApplePlatform } from '@/lib/platform';
import { isHoverPointer } from '@/lib/device';
import type { WysiwygEditorHandle } from './markdown/MarkdownComposer';

const keys = formatShortcuts(isApplePlatform(navigator.userAgent));

async function renderToolbar() {
  const applyMark = vi.fn();
  const editorRef = createRef<WysiwygEditorHandle>() as { current: WysiwygEditorHandle | null };
  editorRef.current = { applyMark } as unknown as WysiwygEditorHandle;
  const screen = await render(
    <QueryClientProvider client={new QueryClient()}>
    <MemoryRouter>
      <TooltipProvider delay={0}>
        <ComposerToolbar
          editorRef={editorRef}
          activeFormats={new Set()}
          isMobile={false}
          isEditingMode={false}
          giphyEnabled={false}
          giphyAPIKey=""
          isUploading={false}
          showSend
          scheduledCount={0}
          canSend
          onOpenLinkDialog={vi.fn()}
          onPickerOpenChange={vi.fn()}
          onAttach={vi.fn()}
          onSend={vi.fn()}
        />
      </TooltipProvider>
    </MemoryRouter>
    </QueryClientProvider>,
  );
  return { screen, applyMark };
}

describe('ComposerToolbar formatting buttons', () => {
  it('name their keys for assistive tech', async () => {
    const { screen } = await renderToolbar();
    for (const [label, key] of [
      ['Bold', keys.bold],
      ['Italic', keys.italic],
      ['Strikethrough', keys.strike],
      ['Code', keys.code],
      ['Quote', keys.quote],
      ['List', keys.ul],
      ['Numbered list', keys.ol],
      ['Link', keys.link],
    ] as const) {
      await expect.element(screen.getByRole('button', { name: label, exact: true })).toHaveAttribute('aria-keyshortcuts', key.aria);
    }
  });

  // Slack-style: hovering a formatting button names it and its key.
  it('show the shortcut when hovered with a mouse', async () => {
    const { screen, applyMark } = await renderToolbar();
    const bold = screen.getByRole('button', { name: 'Bold', exact: true });
    await userEvent.hover(bold);
    // A phone has no hover: no tooltip there.
    if (isHoverPointer('mouse')) {
      await expect.poll(() => document.querySelector('[data-slot="tooltip-content"]')?.textContent).toBe(`Bold${keys.bold.label}`);
    }
    await bold.click();
    expect(applyMark).toHaveBeenCalledWith('bold');
  });
});
