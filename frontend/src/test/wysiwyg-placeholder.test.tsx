import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { WysiwygEditor } from '@/components/chat/WysiwygEditor';

function Providers({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('WysiwygEditor placeholder', () => {
  it('renders the placeholder text via the Lexical RichTextPlugin slot', async () => {
    // Lexical renders the placeholder in its own absolutely-positioned
    // div as a sibling of the contenteditable surface (not as an
    // attribute on a child paragraph the way Tiptap did).
    render(
      <Providers>
        <WysiwygEditor initialBody="" placeholder="Write to ~general" />
      </Providers>,
    );
    await waitFor(() => {
      expect(screen.getByText('Write to ~general')).toBeInTheDocument();
    });
  });

  it('does not render the placeholder when the editor has content', async () => {
    render(
      <Providers>
        <WysiwygEditor initialBody="hi" placeholder="Write to ~general" />
      </Providers>,
    );
    await waitFor(() => {
      expect(screen.getByLabelText('Message input').textContent).toContain('hi');
    });
    // Lexical's placeholder element exists in the DOM but is hidden via
    // CSS when the doc isn't empty. Either it's gone or it's hidden —
    // we only need to verify it isn't visibly the only thing showing.
    expect(screen.queryByText('Write to ~general')).toBeNull();
  });
});
