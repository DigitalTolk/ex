import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, screen, waitFor } from '@testing-library/react';
import { createRef, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WysiwygEditor, type WysiwygEditorHandle } from './WysiwygEditor';

// The mention/channel/emoji typeahead plugins read live data via
// React Query — stubs are enough for composer-level tests.
vi.mock('@/lib/api', () => ({ apiFetch: vi.fn().mockResolvedValue([]) }));
vi.mock('@/hooks/useConversations', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useConversations')>('@/hooks/useConversations');
  return { ...actual, useAllUsers: () => ({ data: [] }) };
});
vi.mock('@/hooks/useChannels', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useChannels')>('@/hooks/useChannels');
  return { ...actual, useUserChannels: () => ({ data: [] }) };
});
vi.mock('@/hooks/useEmoji', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useEmoji')>('@/hooks/useEmoji');
  return { ...actual, useEmojis: () => ({ data: [] }) };
});
vi.mock('@/context/PresenceContext', () => ({
  usePresence: () => ({ online: new Set<string>() }),
}));

function Providers({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function renderEditor(props: Parameters<typeof WysiwygEditor>[0] & { ref?: React.Ref<WysiwygEditorHandle> } = {}) {
  return render(<Providers><WysiwygEditor {...props} /></Providers>);
}

function getEditor() {
  return screen.getByLabelText('Message input');
}

describe('WysiwygEditor', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('mounts with initial markdown rendered and round-trips back', async () => {
    const ref = createRef<WysiwygEditorHandle>();
    renderEditor({ ref, initialBody: '**bold** and *italic*' });
    await waitFor(() => expect(ref.current).not.toBeNull());
    const md = ref.current!.getMarkdown();
    expect(md).toContain('**bold**');
    expect(md).toContain('*italic*');
  });

  it('Enter without Shift submits the current markdown', async () => {
    const onSubmit = vi.fn();
    const ref = createRef<WysiwygEditorHandle>();
    renderEditor({ ref, onSubmit, initialBody: 'hi' });
    await waitFor(() => expect(ref.current).not.toBeNull());
    fireEvent.keyDown(getEditor(), { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalled();
    expect(onSubmit.mock.calls[0][0]).toContain('hi');
  });

  it('Shift+Enter does not submit', async () => {
    const onSubmit = vi.fn();
    const ref = createRef<WysiwygEditorHandle>();
    renderEditor({ ref, onSubmit, initialBody: 'hi' });
    await waitFor(() => expect(ref.current).not.toBeNull());
    fireEvent.keyDown(getEditor(), { key: 'Enter', shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('Escape calls onCancel when provided', async () => {
    const onCancel = vi.fn();
    const ref = createRef<WysiwygEditorHandle>();
    renderEditor({ ref, onCancel });
    await waitFor(() => expect(ref.current).not.toBeNull());
    fireEvent.keyDown(getEditor(), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalled();
  });

  it('applyBlock("ul") wraps the current line in a bullet list', async () => {
    const ref = createRef<WysiwygEditorHandle>();
    renderEditor({ ref, initialBody: 'item one' });
    await waitFor(() => expect(ref.current).not.toBeNull());
    ref.current!.applyBlock('ul');
    await waitFor(() => expect(ref.current!.getElement()?.querySelector('ul')).not.toBeNull());
    expect(ref.current!.getMarkdown()).toMatch(/-\s+item one/);
  });

  it('applyBlock("ol") wraps the current line in an ordered list', async () => {
    const ref = createRef<WysiwygEditorHandle>();
    renderEditor({ ref, initialBody: 'step' });
    await waitFor(() => expect(ref.current).not.toBeNull());
    ref.current!.applyBlock('ol');
    await waitFor(() => expect(ref.current!.getElement()?.querySelector('ol')).not.toBeNull());
    expect(ref.current!.getMarkdown()).toMatch(/1\.\s+step/);
  });

  it('applyBlock("quote") wraps the line in a blockquote', async () => {
    const ref = createRef<WysiwygEditorHandle>();
    renderEditor({ ref, initialBody: 'quoted' });
    await waitFor(() => expect(ref.current).not.toBeNull());
    ref.current!.applyBlock('quote');
    await waitFor(() => expect(ref.current!.getElement()?.querySelector('blockquote')).not.toBeNull());
    expect(ref.current!.getMarkdown()).toMatch(/^>\s+quoted/m);
  });

  it('beginLinkEdit + commitLinkEdit links the text inserted by the dialog', async () => {
    const ref = createRef<WysiwygEditorHandle>();
    renderEditor({ ref });
    await waitFor(() => expect(ref.current).not.toBeNull());
    // No selection yet (collapsed) — commit inserts the display text
    // and links it. Mirrors the toolbar Link button flow when nothing
    // is selected.
    ref.current!.beginLinkEdit();
    ref.current!.commitLinkEdit('https://example.com', 'docs');
    await waitFor(() => expect(ref.current!.getElement()?.querySelector('a[href="https://example.com"]')).not.toBeNull());
    expect(ref.current!.getMarkdown()).toContain('[docs](https://example.com)');
  });

  it('commitLinkEdit returns selectedText="" when nothing is selected', async () => {
    // The full select-and-link path requires real DOM focus + selection,
    // which jsdom can't replicate (Lexical's selection state syncs from
    // the DOM, and an unfocused contenteditable always reports an empty
    // selection). Cover the wiring here; the round-trip is exercised by
    // the dialog test in MessageInput.extra.test.tsx and by E2E.
    const ref = createRef<WysiwygEditorHandle>();
    renderEditor({ ref, initialBody: 'see docs' });
    await waitFor(() => expect(ref.current).not.toBeNull());
    expect(ref.current!.beginLinkEdit().selectedText).toBe('');
  });

  it('insertText injects raw text at the caret', async () => {
    const ref = createRef<WysiwygEditorHandle>();
    renderEditor({ ref, initialBody: 'hello ' });
    await waitFor(() => expect(ref.current).not.toBeNull());
    ref.current!.focus();
    ref.current!.insertText('world');
    // Lexical mutations land on the next paint in jsdom; wait for the
    // DOM to reflect the new text content.
    await waitFor(() => {
      expect(ref.current!.getElement()?.textContent ?? '').toContain('world');
    });
    expect(ref.current!.getMarkdown()).toContain('world');
  });

  it('setMarkdown replaces the editor content and emits onChange', async () => {
    const onChange = vi.fn();
    const ref = createRef<WysiwygEditorHandle>();
    renderEditor({ ref, onChange });
    await waitFor(() => expect(ref.current).not.toBeNull());
    ref.current!.setMarkdown('**hi**');
    await waitFor(() => expect(ref.current!.getMarkdown()).toContain('**hi**'));
    expect(onChange).toHaveBeenCalled();
  });

  it('focus() runs without throwing and exposes getElement()', async () => {
    const ref = createRef<WysiwygEditorHandle>();
    renderEditor({ ref });
    await waitFor(() => expect(ref.current).not.toBeNull());
    expect(() => ref.current!.focus()).not.toThrow();
    expect(ref.current!.getElement()).toBe(getEditor());
  });

  it('renders a <blockquote> in the DOM when initial markdown is "> hi"', async () => {
    renderEditor({ initialBody: '> hi' });
    await waitFor(() => {
      expect(getEditor().querySelector('blockquote')).not.toBeNull();
    });
  });

  it('round-trips an ordered list back to markdown without blank-line bloat', async () => {
    const ref = createRef<WysiwygEditorHandle>();
    renderEditor({ ref, initialBody: '1. one\n2. two' });
    await waitFor(() => expect(ref.current).not.toBeNull());
    const md = ref.current!.getMarkdown();
    expect(md).toMatch(/1\.\s+one/);
    expect(md).toMatch(/2\.\s+two/);
    expect(md).not.toMatch(/\d+\.\s*\n\n\S/);
  });

  it('round-trips a multi-line blockquote back to "> line" per row', async () => {
    const ref = createRef<WysiwygEditorHandle>();
    renderEditor({ ref, initialBody: '> a\n> b' });
    await waitFor(() => expect(ref.current).not.toBeNull());
    const md = ref.current!.getMarkdown();
    expect(md).toMatch(/>\s+a/);
    expect(md).toMatch(/>\s+b/);
  });

  it('preserves "# Heading" as literal markdown text without rendering an <h1>', async () => {
    // Headings are deliberately not rendered in the composer (UX feedback:
    // mid-thought heading typography felt buggy). The wire format must
    // still round-trip the raw `# foo` literal so the message list
    // renders it as a heading.
    const ref = createRef<WysiwygEditorHandle>();
    renderEditor({ ref, initialBody: '# Hello' });
    await waitFor(() => expect(ref.current).not.toBeNull());
    expect(ref.current!.getElement()?.querySelector('h1')).toBeNull();
    expect(ref.current!.getMarkdown()).toMatch(/^#\s+Hello/);
  });

  it('round-trips a user mention through markdown', async () => {
    const ref = createRef<WysiwygEditorHandle>();
    renderEditor({ ref, initialBody: 'hello @[u-1|Alice] there' });
    await waitFor(() => expect(ref.current).not.toBeNull());
    expect(ref.current!.getElement()?.querySelector('span.mention[data-user-id="u-1"]')).not.toBeNull();
    expect(ref.current!.getMarkdown()).toContain('@[u-1|Alice]');
  });

  it('round-trips a channel mention through markdown', async () => {
    const ref = createRef<WysiwygEditorHandle>();
    renderEditor({ ref, initialBody: 'see ~[c-1|general]' });
    await waitFor(() => expect(ref.current).not.toBeNull());
    expect(ref.current!.getElement()?.querySelector('span.channel-mention[data-channel-id="c-1"]')).not.toBeNull();
    expect(ref.current!.getMarkdown()).toContain('~[c-1|general]');
  });

  it('preserves underscores in emoji shortcodes — `:smile_face_heart_eyes:` does NOT export as `:smile_face\\_heart\\_eyes:`', async () => {
    // Regression: Lexical's exportTextFormat blindly escapes every `_`
    // in TextNode content, breaking emoji shortcodes whose names
    // contain underscores. Our $exportMarkdown helper strips the
    // escape on the way out so the renderer's `/:[a-z0-9_+-]+:/` regex
    // still matches.
    const ref = createRef<WysiwygEditorHandle>();
    renderEditor({ ref, initialBody: ':smile_face_heart_eyes:' });
    await waitFor(() => expect(ref.current).not.toBeNull());
    const md = ref.current!.getMarkdown();
    expect(md).toContain(':smile_face_heart_eyes:');
    expect(md).not.toContain(':smile_face\\_heart\\_eyes:');
  });
});
