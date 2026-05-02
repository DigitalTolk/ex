import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

// The global setup mocks the plugin to a no-op so the rest of the test
// suite can render composers without exercising the typeahead. This
// suite tests the real plugin, so we opt back in.
vi.unmock('@/components/chat/lexical/plugins/UserMentionsPlugin');

vi.mock('@/hooks/useConversations', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useConversations')>('@/hooks/useConversations');
  return {
    ...actual,
    useAllUsers: () => ({
      data: [
        { id: 'u-1', email: 'alice@example.com', displayName: 'Alice' },
        { id: 'u-2', email: 'bob@example.com', displayName: 'Bob' },
      ],
    }),
  };
});

vi.mock('@/context/PresenceContext', () => ({
  usePresence: () => ({ online: new Set<string>(['u-1']) }),
}));

import { WysiwygEditor, type WysiwygEditorHandle } from '@/components/chat/WysiwygEditor';
import { createRef } from 'react';

function Providers({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('UserMentionsPlugin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens the @-mention popup when the user types @', async () => {
    const ref = createRef<WysiwygEditorHandle>();
    render(<Providers><WysiwygEditor ref={ref} /></Providers>);
    await waitFor(() => expect(ref.current).not.toBeNull());
    act(() => {
      ref.current!.insertText('@');
    });
    await waitFor(() => {
      expect(screen.getByTestId('mention-popup')).toBeInTheDocument();
    });
    expect(screen.getAllByTestId('mention-option').length).toBeGreaterThan(0);
  });

  it('filters suggestions by query', async () => {
    const ref = createRef<WysiwygEditorHandle>();
    render(<Providers><WysiwygEditor ref={ref} /></Providers>);
    await waitFor(() => expect(ref.current).not.toBeNull());
    act(() => {
      ref.current!.insertText('@al');
    });
    await waitFor(() => {
      const rows = screen.getAllByTestId('mention-option');
      // Alice's row should be present.
      const hasAlice = rows.some((r) => r.textContent?.includes('Alice'));
      expect(hasAlice).toBe(true);
    });
  });

  it('does NOT suggest @all when user types a partial prefix like @a', async () => {
    // Regression: typing "@a" must NOT surface the @all group, otherwise
    // mid-type queries for "@alan" / "@alex" hover @all at the top of
    // the list and mis-select it on Enter. Group mentions only appear
    // when the user has typed the full keyword.
    const ref = createRef<WysiwygEditorHandle>();
    render(<Providers><WysiwygEditor ref={ref} /></Providers>);
    await waitFor(() => expect(ref.current).not.toBeNull());
    act(() => {
      ref.current!.insertText('@a');
    });
    await waitFor(() => {
      expect(screen.getAllByTestId('mention-option').length).toBeGreaterThan(0);
    });
    const rows = screen.getAllByTestId('mention-option');
    const allRow = rows.find((r) => r.textContent?.includes('@all'));
    expect(allRow).toBeUndefined();
  });

  it('surfaces @all only when the user has typed the full keyword', async () => {
    const ref = createRef<WysiwygEditorHandle>();
    render(<Providers><WysiwygEditor ref={ref} /></Providers>);
    await waitFor(() => expect(ref.current).not.toBeNull());
    act(() => {
      ref.current!.insertText('@all');
    });
    await waitFor(() => {
      const rows = screen.getAllByTestId('mention-option');
      const hasAll = rows.some((r) => r.textContent?.includes('@all'));
      expect(hasAll).toBe(true);
    });
  });

  it('surfaces @here only when the user has typed the full keyword', async () => {
    const ref = createRef<WysiwygEditorHandle>();
    render(<Providers><WysiwygEditor ref={ref} /></Providers>);
    await waitFor(() => expect(ref.current).not.toBeNull());
    act(() => {
      ref.current!.insertText('@here');
    });
    await waitFor(() => {
      const rows = screen.getAllByTestId('mention-option');
      const hasHere = rows.some((r) => r.textContent?.includes('@here'));
      expect(hasHere).toBe(true);
    });
  });

  it('renders the online presence dot anchored to the avatar, matching the member-list style', async () => {
    // Regression: the online indicator used to be a trailing right-
    // edge dot with no offline state and no ring, while the member
    // list anchored it to the avatar with `ring-2 ring-background`.
    // Both surfaces should now share the UserAvatar component, so the
    // dot lives inside the row's avatar wrapper and uses the same
    // ring class. We assert structural equivalence (a dot under the
    // avatar with the shared classes) rather than pixel-identical
    // styling so future restyling of the shared component cascades
    // without breaking this test.
    const ref = createRef<WysiwygEditorHandle>();
    render(<Providers><WysiwygEditor ref={ref} /></Providers>);
    await waitFor(() => expect(ref.current).not.toBeNull());
    act(() => {
      ref.current!.insertText('@al');
    });
    let aliceRow: HTMLElement | undefined;
    await waitFor(() => {
      aliceRow = screen.getAllByTestId('mention-option').find((r) =>
        r.textContent?.includes('Alice'),
      );
      expect(aliceRow).toBeDefined();
    });
    // Alice is online (mocked in usePresence). The dot should be a
    // descendant of the row marked Online with the shared ring class.
    const dot = aliceRow!.querySelector('span[aria-label="Online"]');
    expect(dot).not.toBeNull();
    expect(dot!.className).toContain('ring-background');
    expect(dot!.className).toContain('bg-emerald-500');
  });

  it('renders the typeahead popup above the trigger, not below', async () => {
    // The chat composer sits at the viewport bottom, so opening the
    // popup downward would clip it under the page chrome. The class
    // on the popup encodes the "above" placement: `bottom-full mb-2`
    // anchors the menu's bottom edge to the trigger's top edge.
    // Regression test for the case where this was inverted.
    const ref = createRef<WysiwygEditorHandle>();
    render(<Providers><WysiwygEditor ref={ref} /></Providers>);
    await waitFor(() => expect(ref.current).not.toBeNull());
    act(() => {
      ref.current!.insertText('@');
    });
    const popup = await screen.findByTestId('mention-popup');
    expect(popup.className).toContain('bottom-full');
    expect(popup.className).not.toContain('top-full');
  });

  it('inserts a mention pill on click', async () => {
    const onChange = vi.fn();
    const ref = createRef<WysiwygEditorHandle>();
    render(<Providers><WysiwygEditor ref={ref} onChange={onChange} /></Providers>);
    await waitFor(() => expect(ref.current).not.toBeNull());
    act(() => {
      ref.current!.insertText('@al');
    });
    let aliceRow: HTMLElement | undefined;
    await waitFor(() => {
      aliceRow = screen.getAllByTestId('mention-option').find((r) =>
        r.textContent?.includes('Alice'),
      );
      expect(aliceRow).toBeDefined();
    });
    fireEvent.mouseDown(aliceRow!);
    await waitFor(() => {
      expect(ref.current?.getElement()?.querySelector('span.mention[data-user-id="u-1"]')).not.toBeNull();
    });
    expect(ref.current?.getMarkdown()).toContain('@[u-1|Alice]');
  });
});
