import { describe, it, expect } from 'vitest';
import { EditorState, EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { shortcodeToUnicode } from '@/lib/emoji-shortcodes';
import { emojiGlyphs } from './emojiGlyphs';

function makeView(doc: string): EditorView {
  const host = document.createElement('div');
  document.body.appendChild(host);
  return new EditorView({ parent: host, state: EditorState.create({ doc, extensions: [emojiGlyphs] }) });
}
function glyphs(view: EditorView): HTMLElement[] {
  return Array.from(view.dom.querySelectorAll('.cm-emoji-glyph'));
}

describe('emojiGlyphs', () => {
  it('renders a known :shortcode: as its unicode glyph', () => {
    const view = makeView('hi :smile: there');
    view.dispatch({ selection: EditorSelection.cursor(0) });
    const g = glyphs(view);
    expect(g).toHaveLength(1);
    expect(g[0].textContent).toBe(shortcodeToUnicode(':smile:'));
    // The document still holds the raw shortcode.
    expect(view.state.doc.toString()).toBe('hi :smile: there');
    view.destroy();
  });

  it('applies a skin-tone suffix to the rendered glyph', () => {
    const view = makeView('x :wave::skin-tone-3: y');
    view.dispatch({ selection: EditorSelection.cursor(0) });
    const g = glyphs(view);
    expect(g).toHaveLength(1);
    // Toned glyph differs from the plain one.
    expect(g[0].textContent).not.toBe(shortcodeToUnicode(':wave:'));
    expect(g[0].title).toBe(':wave::skin-tone-3:');
    view.destroy();
  });

  it('reveals the raw shortcode (no glyph) while the caret is inside it', () => {
    const view = makeView(':smile:');
    view.dispatch({ selection: EditorSelection.cursor(3) });
    expect(glyphs(view)).toHaveLength(0);
    expect(view.contentDOM.textContent).toContain(':smile:');
    view.destroy();
  });

  it('leaves an unknown/custom shortcode as literal text (no glyph)', () => {
    const view = makeView('x :totally-not-an-emoji: y');
    view.dispatch({ selection: EditorSelection.cursor(0) });
    expect(glyphs(view)).toHaveLength(0);
    view.destroy();
  });

  it('recomputes glyphs as the document changes', () => {
    const view = makeView('');
    view.dispatch({ changes: { from: 0, insert: 'x :smile:' }, selection: EditorSelection.cursor(0) });
    expect(glyphs(view)).toHaveLength(1);
    view.destroy();
  });
});
