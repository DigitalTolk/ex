import { describe, it, expect } from 'vitest';
import { EditorState, EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { mentionPills } from './mentionPills';

function makeView(doc: string): EditorView {
  const host = document.createElement('div');
  document.body.appendChild(host);
  return new EditorView({ parent: host, state: EditorState.create({ doc, extensions: [mentionPills] }) });
}
function pills(view: EditorView): HTMLElement[] {
  return Array.from(view.dom.querySelectorAll('.cm-mention-pill'));
}

describe('mentionPills', () => {
  it('renders a user mention @[id|name] as a pill showing @name', () => {
    const view = makeView('hi @[u-1|Alice] there');
    view.dispatch({ selection: EditorSelection.cursor(0) });
    const p = pills(view);
    expect(p).toHaveLength(1);
    expect(p[0].textContent).toBe('@Alice');
    expect(p[0].getAttribute('data-mention-kind')).toBe('user');
    // The document is still the raw markdown.
    expect(view.state.doc.toString()).toBe('hi @[u-1|Alice] there');
    view.destroy();
  });

  it('renders a channel mention ~[id|slug] as a pill showing ~slug', () => {
    const view = makeView('see ~[c-1|general]');
    view.dispatch({ selection: EditorSelection.cursor(0) });
    const p = pills(view);
    expect(p[0].textContent).toBe('~general');
    expect(p[0].getAttribute('data-mention-kind')).toBe('channel');
    view.destroy();
  });

  it('renders @all and @here group mentions as pills', () => {
    const view = makeView('hey @all and @here');
    view.dispatch({ selection: EditorSelection.cursor(0) });
    const labels = pills(view).map((p) => p.textContent);
    expect(labels).toContain('@all');
    expect(labels).toContain('@here');
    expect(pills(view)[0].getAttribute('data-mention-kind')).toBe('group');
    view.destroy();
  });

  it('reveals the raw token (no pill) while the caret is inside it', () => {
    const view = makeView('@[u-1|Alice]');
    view.dispatch({ selection: EditorSelection.cursor(5) }); // inside the token
    expect(pills(view)).toHaveLength(0);
    expect(view.contentDOM.textContent).toContain('@[u-1|Alice]');
    view.destroy();
  });

  it('does not pill a group mention that is not standalone (e.g. an email)', () => {
    const view = makeView('a@allb');
    view.dispatch({ selection: EditorSelection.cursor(0) });
    expect(pills(view)).toHaveLength(0);
    view.destroy();
  });

  it('recomputes pills as the document changes', () => {
    const view = makeView('');
    view.dispatch({ changes: { from: 0, insert: '@[u-9|Bob] x' }, selection: EditorSelection.cursor(0) });
    // caret at 0 is at the token start (touches it) → revealed; move clear of it.
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length) });
    expect(pills(view).map((p) => p.textContent)).toContain('@Bob');
    view.destroy();
  });
});
