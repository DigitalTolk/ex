import { describe, it, expect } from 'vitest';
import { EditorState, EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { shortcodeToUnicode } from '@/lib/emoji-shortcodes';
import { emojiGlyphs } from './emojiGlyphs';

const CUSTOM: Record<string, string> = { partyparrot: 'https://x.test/parrot.gif' };

function makeView(doc: string, custom: Record<string, string> = {}): EditorView {
  const host = document.createElement('div');
  document.body.appendChild(host);
  return new EditorView({
    parent: host,
    state: EditorState.create({ doc, extensions: [emojiGlyphs((name) => custom[name])] }),
  });
}
function glyphs(view: EditorView): HTMLElement[] {
  return Array.from(view.dom.querySelectorAll('.cm-emoji-glyph'));
}
function images(view: EditorView): HTMLImageElement[] {
  return Array.from(view.dom.querySelectorAll('img.cm-emoji-img'));
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

  it('leaves an unknown shortcode (not standard, not custom) as literal text', () => {
    const view = makeView('x :totally-not-an-emoji: y');
    view.dispatch({ selection: EditorSelection.cursor(0) });
    expect(glyphs(view)).toHaveLength(0);
    expect(images(view)).toHaveLength(0);
    view.destroy();
  });

  it('renders a custom emoji shortcode as its image', () => {
    const view = makeView('hi :partyparrot: there', CUSTOM);
    view.dispatch({ selection: EditorSelection.cursor(0) });
    const imgs = images(view);
    expect(imgs).toHaveLength(1);
    expect(imgs[0].getAttribute('src')).toBe('https://x.test/parrot.gif');
    expect(imgs[0].getAttribute('title')).toBe(':partyparrot:');
    // Document keeps the raw shortcode.
    expect(view.state.doc.toString()).toBe('hi :partyparrot: there');
    view.destroy();
  });

  it('reveals the raw custom shortcode (no image) while the caret is inside it', () => {
    const view = makeView(':partyparrot:', CUSTOM);
    view.dispatch({ selection: EditorSelection.cursor(3) });
    expect(images(view)).toHaveLength(0);
    expect(view.contentDOM.textContent).toContain(':partyparrot:');
    view.destroy();
  });

  it('recomputes glyphs as the document changes', () => {
    const view = makeView('');
    view.dispatch({ changes: { from: 0, insert: 'x :smile:' }, selection: EditorSelection.cursor(0) });
    expect(glyphs(view)).toHaveLength(1);
    view.destroy();
  });
});
