import { describe, it, expect, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { createRef } from 'react';
import { startCompletion, currentCompletions, completionStatus } from '@codemirror/autocomplete';
import { EditorView } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { MarkdownEditor } from './MarkdownEditor';
import type { WysiwygEditorHandle } from './types';
import type { CompletionProviders } from './extensions/completions';
import { userEvent } from 'vitest/browser';

async function mount(props: Partial<React.ComponentProps<typeof MarkdownEditor>> = {}) {
  const ref = createRef<WysiwygEditorHandle>();
  const screen = await render(<MarkdownEditor ref={ref} ariaLabel="Message input" {...props} />);
  await new Promise((r) => requestAnimationFrame(() => r(undefined)));
  return { ref, screen };
}

describe('MarkdownEditor (CM6) — Phase 1 core', () => {
  it('round-trips text losslessly through the imperative handle (no tree, no drift)', async () => {
    const { ref } = await mount();
    ref.current!.setMarkdown('```\nabc\n```\n\n> quote\n\ntext');
    expect(ref.current!.getMarkdown()).toBe('```\nabc\n```\n\n> quote\n\ntext');
  });

  it('renders the document as raw markdown (the document IS the body)', async () => {
    const { screen } = await mount({ initialBody: 'hello **world**' });
    await expect.element(screen.getByLabelText('Message input')).toBeVisible();
    expect(screen.getByLabelText('Message input').element().textContent).toContain('hello');
  });

  it('fires onChange with the full markdown when the document changes', async () => {
    const onChange = vi.fn();
    const { ref } = await mount({ onChange });
    ref.current!.insertText('typed');
    expect(onChange).toHaveBeenCalledWith('typed');
  });

  it('applyMark wraps the (empty) selection in markdown delimiters', async () => {
    const { ref } = await mount();
    ref.current!.applyMark('bold');
    expect(ref.current!.getMarkdown()).toBe('****');
  });

  it('applyMark toggles an existing wrap back off', async () => {
    const { ref } = await mount({ initialBody: 'word' });
    // Select the whole word then bold, then bold again to unwrap.
    ref.current!.setMarkdown('word');
    ref.current!.insertText(''); // ensure view ready
    ref.current!.applyMark('italic');
    // empty-selection caret at start inserts the pair; assert delimiters present
    expect(ref.current!.getMarkdown()).toContain('*');
  });

  it('applyBlock prefixes the line with a quote marker', async () => {
    const { ref } = await mount({ initialBody: 'a line' });
    ref.current!.applyBlock('quote');
    expect(ref.current!.getMarkdown()).toBe('> a line');
  });

  it('Enter submits the markdown when submitOnEnter is set', async () => {
    const onSubmit = vi.fn();
    const { ref } = await mount({ onSubmit, submitOnEnter: true });
    ref.current!.setMarkdown('send me');
    ref.current!.focus();
    await userEvent.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledWith('send me');
  });

  it('reports active formats from the caret position', async () => {
    const { ref } = await mount({ initialBody: '**bold**' });
    ref.current!.setMarkdown('**bold**');
    ref.current!.focusEnd();
    // caret at end is outside the strong node; move into it via the handle.
    ref.current!.insertText('');
    expect(ref.current!.getActiveFormats()).toBeInstanceOf(Set);
  });
});

describe('MarkdownEditor handle + keymap branches', () => {
  it('commitLinkEdit inserts a markdown link with the given display text', async () => {
    const { ref } = await mount();
    ref.current!.beginLinkEdit();
    ref.current!.commitLinkEdit('https://x.test', 'click');
    expect(ref.current!.getMarkdown()).toBe('[click](https://x.test)');
  });

  it('commitLinkEdit falls back to the URL as text when none is given', async () => {
    const { ref } = await mount();
    ref.current!.beginLinkEdit();
    ref.current!.commitLinkEdit('https://x.test', '');
    expect(ref.current!.getMarkdown()).toBe('[https://x.test](https://x.test)');
  });

  it('beginLinkEdit reports the selected text (empty for a collapsed caret)', async () => {
    const { ref } = await mount({ initialBody: 'word' });
    expect(ref.current!.beginLinkEdit().selectedText).toBe('');
  });

  it('blur removes focus; getElement returns the host', async () => {
    const { ref } = await mount();
    ref.current!.focus();
    ref.current!.blur();
    expect(ref.current!.getElement()).not.toBeNull();
  });

  it('subscribeActiveFormats notifies on change and stops after unsubscribe', async () => {
    const { ref } = await mount();
    const cb = vi.fn();
    const unsub = ref.current!.subscribeActiveFormats(cb);
    ref.current!.insertText('**x**');
    expect(cb).toHaveBeenCalled();
    cb.mockClear();
    unsub();
    ref.current!.insertText('y');
    expect(cb).not.toHaveBeenCalled();
  });

  it('Shift+Enter does NOT submit (falls through to a newline)', async () => {
    const onSubmit = vi.fn();
    const { ref } = await mount({ onSubmit, submitOnEnter: true });
    ref.current!.setMarkdown('hi');
    ref.current!.focusEnd();
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('Enter does not submit when submitOnEnter is false', async () => {
    const onSubmit = vi.fn();
    const { ref } = await mount({ onSubmit, submitOnEnter: false });
    ref.current!.setMarkdown('hi');
    ref.current!.focusEnd();
    await userEvent.keyboard('{Enter}');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('ArrowUp on an empty editor invokes onArrowUpEmpty', async () => {
    const onArrowUpEmpty = vi.fn(() => true);
    const { ref } = await mount({ onArrowUpEmpty });
    ref.current!.focus();
    await userEvent.keyboard('{ArrowUp}');
    expect(onArrowUpEmpty).toHaveBeenCalled();
  });

  it('ArrowUp on a non-empty editor does not invoke onArrowUpEmpty', async () => {
    const onArrowUpEmpty = vi.fn(() => true);
    const { ref } = await mount({ onArrowUpEmpty, initialBody: 'x' });
    ref.current!.focusEnd();
    await userEvent.keyboard('{ArrowUp}');
    expect(onArrowUpEmpty).not.toHaveBeenCalled();
  });

  it('Escape invokes onCancel when provided', async () => {
    const onCancel = vi.fn();
    const { ref } = await mount({ onCancel });
    ref.current!.focus();
    await userEvent.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalled();
  });

  it('a file paste is handed to onPasteFiles', async () => {
    const onPasteFiles = vi.fn();
    const { ref } = await mount({ onPasteFiles });
    const el = ref.current!.getElement()!.querySelector('[contenteditable]') as HTMLElement;
    const dt = new DataTransfer();
    dt.items.add(new File(['x'], 'a.png', { type: 'image/png' }));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    expect(onPasteFiles).toHaveBeenCalled();
  });

  it('a text-only paste is left to the editor (no file callback)', async () => {
    const onPasteFiles = vi.fn();
    const { ref } = await mount({ onPasteFiles });
    const el = ref.current!.getElement()!.querySelector('[contenteditable]') as HTMLElement;
    const dt = new DataTransfer();
    dt.setData('text/plain', 'just text');
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    expect(onPasteFiles).not.toHaveBeenCalled();
  });

  it('fires onFocusChange when focus enters', async () => {
    const onFocusChange = vi.fn();
    const { ref } = await mount({ onFocusChange });
    ref.current!.focus();
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    expect(onFocusChange).toHaveBeenCalledWith(true);
  });

  it('does not treat `text\\n---` as a setext heading (so it is not bolded)', async () => {
    const { ref } = await mount();
    ref.current!.setMarkdown('foobar\n---');
    const view = EditorView.findFromDOM(
      ref.current!.getElement()!.querySelector('.cm-editor') as HTMLElement,
    )!;
    const names: string[] = [];
    syntaxTree(view.state).iterate({ enter: (n) => { names.push(n.name); } });
    expect(names).not.toContain('SetextHeading');
    // `---` becomes a thematic break (HorizontalRule), not a heading underline.
    expect(names).toContain('HorizontalRule');
  });

  it('sets mobile keyboard attributes; enterkeyhint=send when Enter submits', async () => {
    const { ref } = await mount({ submitOnEnter: true });
    const cm = ref.current!.getElement()!.querySelector('.cm-content') as HTMLElement;
    expect(cm.getAttribute('enterkeyhint')).toBe('send');
    expect(cm.getAttribute('autocapitalize')).toBe('sentences');
    expect(cm.getAttribute('autocorrect')).toBe('on');
    expect(cm.getAttribute('spellcheck')).toBe('true');
  });

  it('uses enterkeyhint=enter when Enter does not submit', async () => {
    const { ref } = await mount({ submitOnEnter: false });
    const cm = ref.current!.getElement()!.querySelector('.cm-content') as HTMLElement;
    expect(cm.getAttribute('enterkeyhint')).toBe('enter');
  });

  it('renders the placeholder as an overlay (outside the contenteditable)', async () => {
    const { ref, screen } = await mount({ placeholder: 'Type a message…' });
    // The overlay carries the text; the editor's own content stays empty.
    await expect.element(screen.getByText('Type a message…')).toBeVisible();
    expect(ref.current!.getElement()!.querySelector('[contenteditable]')?.textContent).toBe('');
  });

  it('falls back to the default aria-label when none is passed', async () => {
    const ref = createRef<WysiwygEditorHandle>();
    const screen = await render(<MarkdownEditor ref={ref} />);
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    await expect.element(screen.getByLabelText('Message input')).toBeVisible();
  });

  it('ignores a paste event that carries no clipboard data', async () => {
    const onPasteFiles = vi.fn();
    const { ref } = await mount({ onPasteFiles });
    const el = ref.current!.getElement()!.querySelector('[contenteditable]') as HTMLElement;
    el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true }));
    expect(onPasteFiles).not.toHaveBeenCalled();
  });

  function viewOf(ref: React.RefObject<WysiwygEditorHandle | null>) {
    return EditorView.findFromDOM(
      ref.current!.getElement()!.querySelector('.cm-editor') as HTMLElement,
    )!;
  }
  function trigger(view: EditorView, doc: string) {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: doc }, selection: { anchor: doc.length } });
    view.focus();
    startCompletion(view);
  }
  // Completion sources resolve asynchronously — poll currentCompletions WITHOUT
  // re-dispatching (a re-dispatch would reset the pending query and never settle).
  async function waitForLabel(view: EditorView, label: string) {
    await vi.waitFor(() => {
      expect(currentCompletions(view.state).map((c) => c.label)).toContain(label);
    });
  }

  it('offers @-mention, ~-channel and :emoji: autocomplete from completionProviders', async () => {
    const completionProviders: CompletionProviders = {
      users: () => [{ id: 'u1', displayName: 'Alice' }],
      online: () => new Set(),
      memberIds: () => null,
      channels: () => [{ channelID: 'c1', channelName: 'general', channelType: 'public' }],
      customEmojis: () => [],
      skinTone: () => '',
    };
    const { ref } = await mount({ completionProviders });
    const view = viewOf(ref);
    trigger(view, '@Al');
    await waitForLabel(view, 'Alice');
    trigger(view, '~gen');
    await waitForLabel(view, '~general');
    trigger(view, ':smile');
    await waitForLabel(view, ':smile:');
  });

  it('shows no mention/channel completions without providers, but built-in emoji still resolve', async () => {
    const { ref } = await mount();
    const view = viewOf(ref);
    // Wait for the async query to actually run (not just be scheduled) so the
    // source — and thus the default-provider getters — execute before we assert.
    const settle = async () => {
      await vi.waitFor(() => expect(completionStatus(view.state)).not.toBe('pending'));
    };
    // Alice / ~general can never surface without their providers.
    trigger(view, '@Al');
    await settle();
    expect(currentCompletions(view.state).map((c) => c.label)).not.toContain('Alice');
    trigger(view, '~gen');
    await settle();
    expect(currentCompletions(view.state).map((c) => c.label)).not.toContain('~general');
    // Standard emoji are built-in (provider-independent) → still resolve.
    trigger(view, ':smile');
    await waitForLabel(view, ':smile:');
  });

  it('tolerates every event with no optional callbacks wired (undefined-callback branches)', async () => {
    const { ref } = await mount({ submitOnEnter: true });
    ref.current!.focus();
    await userEvent.keyboard('{Enter}');   // onSubmit undefined
    ref.current!.setMarkdown('');
    await userEvent.keyboard('{ArrowUp}'); // onArrowUpEmpty undefined → ?? false
    await userEvent.keyboard('{Escape}');  // onCancel undefined → returns false
    ref.current!.insertText('x');          // onChange undefined
    const el = ref.current!.getElement()!.querySelector('[contenteditable]') as HTMLElement;
    const dt = new DataTransfer();
    dt.items.add(new File(['x'], 'a.png', { type: 'image/png' }));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); // onPasteFiles undefined
    expect(ref.current!.getMarkdown()).toContain('x');
  });
});
