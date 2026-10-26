import { describe, it, expect, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { createRef } from 'react';
import { userEvent } from 'vitest/browser';
import { EditorView } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { MarkdownEditor } from './MarkdownEditor';
import type { WysiwygEditorHandle } from './types';

// lang-markdown's markdown() bundles lang-html (and through it the JavaScript
// and CSS grammars) for HTML-in-markdown parsing and tag completion — a
// composer with its own completion sources uses neither, so the editor builds
// its language from lang-markdown's parser and commands directly. These pin
// that, and that everything the composer relies on still works.

async function mount(props: Partial<React.ComponentProps<typeof MarkdownEditor>> = {}) {
  const ref = createRef<WysiwygEditorHandle>();
  await render(<MarkdownEditor ref={ref} ariaLabel="Message input" {...props} />);
  const view = EditorView.findFromDOM(ref.current!.getElement()!.querySelector('.cm-editor') as HTMLElement)!;
  return { ref, view };
}

function nodeNames(view: EditorView): string[] {
  const names: string[] = [];
  syntaxTree(view.state).iterate({ enter: (node) => { names.push(node.name); } });
  return names;
}

describe('MarkdownEditor language', () => {
  it('treats inline HTML as plain markdown: no HTML grammar, no tag completion', async () => {
    const { view } = await mount({ initialBody: 'a <b>bold</b> tag' });
    const names = nodeNames(view);
    expect(names).toContain('HTMLTag');
    expect(names).not.toContain('TagName');
    expect(view.state.languageDataAt('autocomplete', 4)).toEqual([]);
  });

  it('parses strikethrough and autolinks, and a --- under a line is a divider, not a heading', async () => {
    const { view } = await mount({ initialBody: 'one ~~two~~ https://example.com\nbar\n---' });
    const names = nodeNames(view);
    expect(names).toContain('Strikethrough');
    expect(names).toContain('URL');
    expect(names).toContain('HorizontalRule');
    expect(names).not.toContain('SetextHeading2');
  });

  it('Enter in a list continues the list instead of sending; Enter in plain text sends', async () => {
    const onSubmit = vi.fn();
    const { ref, view } = await mount({ initialBody: '- first', onSubmit });
    view.focus();
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    await userEvent.keyboard('{Enter}');
    expect(ref.current!.getMarkdown()).toBe('- first\n- ');
    expect(onSubmit).not.toHaveBeenCalled();

    // Backspace on the empty marker removes it (the list-markup command).
    await userEvent.keyboard('{Backspace}');
    expect(ref.current!.getMarkdown()).not.toContain('- first\n- ');

    ref.current!.setMarkdown('plain');
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    await userEvent.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledWith('plain');
  });

  it('pasting a URL over selected text turns it into a link', async () => {
    const { ref, view } = await mount({ initialBody: 'see docs' });
    view.focus();
    view.dispatch({ selection: { anchor: 4, head: 8 } });
    const dt = new DataTransfer();
    dt.setData('text/plain', 'https://example.com/docs');
    view.contentDOM.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    expect(ref.current!.getMarkdown()).toBe('see [docs](https://example.com/docs)');
  });
});
