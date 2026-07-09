import { describe, it, expect } from 'vitest';
import { EditorState, EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { Strikethrough } from '@lezer/markdown';
import { inlinePreview } from './inlinePreview';

// Build a headless-ish EditorView in a real DOM (browser test) so the
// ViewPlugin actually runs and produces decorations.
function makeView(doc: string): EditorView {
  const host = document.createElement('div');
  document.body.appendChild(host);
  return new EditorView({
    parent: host,
    state: EditorState.create({
      doc,
      extensions: [markdown({ extensions: [Strikethrough] }), inlinePreview],
    }),
  });
}

// The rendered (visible) text excludes ranges hidden by Decoration.replace, so
// asserting on it tells us whether the delimiters are hidden or revealed.
function visibleText(view: EditorView): string {
  return view.contentDOM.textContent ?? '';
}

describe('inlinePreview decorations', () => {
  it('hides bold/italic/strike/code delimiters when the caret is elsewhere', () => {
    const view = makeView('a **b** _c_ ~~d~~ `e` end');
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length) });
    const text = visibleText(view);
    expect(text).not.toContain('**');
    expect(text).not.toContain('~~');
    expect(text).toContain('b');
    expect(text).toContain('e');
    view.destroy();
  });

  it('reveals the raw delimiters when the caret is inside the token (so you can edit)', () => {
    const view = makeView('**bold**');
    // Caret at offset 3 — inside the StrongEmphasis token.
    view.dispatch({ selection: EditorSelection.cursor(3) });
    expect(visibleText(view)).toContain('**');
    view.destroy();
  });

  it('hides the leading # of a heading when the caret is on another line', () => {
    const view = makeView('# Title\n\nbody');
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length) }); // caret in "body"
    expect(visibleText(view)).not.toContain('#');
    expect(visibleText(view)).toContain('Title');
    view.destroy();
  });

  it('decorates fenced code blocks and blockquotes at the line level', () => {
    const view = makeView('```\ncode\n```\n\n> quoted');
    view.dispatch({ selection: EditorSelection.cursor(0) });
    expect(view.dom.querySelector('.cm-codeblock')).not.toBeNull();
    expect(view.dom.querySelector('.cm-quote')).not.toBeNull();
    view.destroy();
  });

  it('marks inline code with the pill class', () => {
    const view = makeView('say `hi` now');
    view.dispatch({ selection: EditorSelection.cursor(0) });
    expect(view.dom.querySelector('.cm-inlineCode')).not.toBeNull();
    view.destroy();
  });

  it('recomputes on edit (delimiter hidden once the caret leaves the token)', () => {
    const view = makeView('');
    view.dispatch({ changes: { from: 0, insert: '**x** end' } });
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length) }); // caret in " end"
    expect(visibleText(view)).not.toContain('**');
    view.destroy();
  });
});
