import { describe, it, expect } from 'vitest';
import { EditorState, EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { Strikethrough } from '@lezer/markdown';
import { applyMark, applyBlock, getActiveFormats } from './commands';

function makeView(doc: string): EditorView {
  const host = document.createElement('div');
  document.body.appendChild(host);
  return new EditorView({
    parent: host,
    state: EditorState.create({ doc, extensions: [markdown({ extensions: [Strikethrough] })] }),
  });
}
function select(view: EditorView, from: number, to: number) {
  view.dispatch({ selection: EditorSelection.range(from, to) });
}

describe('commands.applyMark', () => {
  it('wraps a selected word', () => {
    const view = makeView('hello world');
    select(view, 6, 11); // "world"
    applyMark(view, 'bold');
    expect(view.state.doc.toString()).toBe('hello **world**');
    view.destroy();
  });
  it('unwraps an already-wrapped selection (toggle off)', () => {
    const view = makeView('**bold**');
    select(view, 0, 8);
    applyMark(view, 'bold');
    expect(view.state.doc.toString()).toBe('bold');
    view.destroy();
  });
  it('inserts an empty pair on a collapsed selection', () => {
    const view = makeView('');
    applyMark(view, 'code');
    expect(view.state.doc.toString()).toBe('``');
    view.destroy();
  });
});

describe('commands.applyBlock', () => {
  it('prefixes a bullet list', () => {
    const view = makeView('one\ntwo');
    select(view, 0, view.state.doc.length);
    applyBlock(view, 'ul');
    expect(view.state.doc.toString()).toBe('- one\n- two');
    view.destroy();
  });
  it('numbers an ordered list', () => {
    const view = makeView('one\ntwo');
    select(view, 0, view.state.doc.length);
    applyBlock(view, 'ol');
    expect(view.state.doc.toString()).toBe('1. one\n2. two');
    view.destroy();
  });
  it('toggles a quote off when already quoted', () => {
    const view = makeView('> quoted');
    select(view, 0, 0);
    applyBlock(view, 'quote');
    expect(view.state.doc.toString()).toBe('quoted');
    view.destroy();
  });
  it('removes the marker only from lines that have it (mixed selection)', () => {
    // First line decides we are "removing"; the second line has no marker, so
    // its match is null and zero characters are stripped.
    const view = makeView('> a\nplain');
    select(view, 0, view.state.doc.length);
    applyBlock(view, 'quote');
    expect(view.state.doc.toString()).toBe('a\nplain');
    view.destroy();
  });
});

describe('commands.getActiveFormats', () => {
  const cases: Array<[string, number, string]> = [
    ['**b**', 3, 'bold'],
    ['*i*', 1, 'italic'],
    ['~~s~~', 3, 'strike'],
    ['`c`', 1, 'code'],
    ['> q', 2, 'quote'],
    ['- item', 3, 'ul'],
    ['1. item', 4, 'ol'],
  ];
  for (const [doc, pos, fmt] of cases) {
    it(`detects ${fmt}`, () => {
      const view = makeView(doc);
      view.dispatch({ selection: EditorSelection.cursor(pos) });
      expect(getActiveFormats(view).has(fmt as never)).toBe(true);
      view.destroy();
    });
  }
  it('returns an empty set in plain text', () => {
    const view = makeView('plain');
    view.dispatch({ selection: EditorSelection.cursor(2) });
    expect(getActiveFormats(view).size).toBe(0);
    view.destroy();
  });
});
