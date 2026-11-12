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

    // Backspace on the empty marker removes it, leaving a plain line.
    await userEvent.keyboard('{Backspace}');
    expect(ref.current!.getMarkdown()).toBe('- first\n');

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

  // The reported case: a plain line typed under a list after one Backspace
  // used to be indented by the markup command, and joined the last item.
  it('one Backspace on a continued marker leaves a plain line, for bullets and numbers', async () => {
    const { ref, view } = await mount({ initialBody: '- GHI' });
    view.focus();
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    await userEvent.keyboard('{Enter}{Backspace}Additional info.');
    expect(ref.current!.getMarkdown()).toBe('- GHI\nAdditional info.');

    ref.current!.setMarkdown('1. one');
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    await userEvent.keyboard('{Enter}{Backspace}After.');
    expect(ref.current!.getMarkdown()).toBe('1. one\nAfter.');
  });

  it('a marker with text after the cursor goes too; nested items and code keep the default', async () => {
    const { ref, view } = await mount({ initialBody: '- item' });
    view.focus();
    view.dispatch({ selection: { anchor: 2 } });
    await userEvent.keyboard('{Backspace}');
    expect(ref.current!.getMarkdown()).toBe('item');

    // A nested marker: lang-markdown's own handling, not a plain line.
    ref.current!.setMarkdown('- a\n  - b');
    view.dispatch({ selection: { anchor: view.state.doc.length - 1 } });
    await userEvent.keyboard('{Backspace}');
    expect(ref.current!.getMarkdown()).not.toBe('- a\nb');
    expect(ref.current!.getMarkdown()).toContain('b');

    // "- " inside a code block is text: Backspace deletes one character.
    ref.current!.setMarkdown('```\n- x\n```');
    view.dispatch({ selection: { anchor: 6 } });
    await userEvent.keyboard('{Backspace}');
    expect(ref.current!.getMarkdown()).toBe('```\n-x\n```');

    // A selection is never this command's.
    ref.current!.setMarkdown('- item');
    view.dispatch({ selection: { anchor: 0, head: 2 } });
    await userEvent.keyboard('{Backspace}');
    expect(ref.current!.getMarkdown()).toBe('item');
  });
});
