import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { createHeadlessEditor } from '@lexical/headless';
import { $createMentionNode, $isMentionNode, MentionNode } from './MentionNode';

// Lexical's $-prefixed factories require an active editor context. A
// headless editor (no DOM mount) is the documented way to exercise
// node code in unit tests.
function withEditor(fn: () => void) {
  const editor = createHeadlessEditor({ nodes: [MentionNode], onError: (e) => { throw e; } });
  editor.update(fn, { discrete: true });
}

// MentionNode round-trips an `@[id|name]` markdown pill through Lexical's
// editor state. The behaviour-level path is exercised in
// WysiwygEditor.test.tsx; here we cover the JSON/DOM serializers
// directly so a future schema change can't silently lose data.

describe('MentionNode', () => {
  it('round-trips through JSON serialization', () => {
    withEditor(() => {
      const node = $createMentionNode('u-1', 'Alice');
      const json = node.exportJSON();
      expect(json).toMatchObject({ type: 'mention', version: 1, userId: 'u-1', displayName: 'Alice' });
      const restored = MentionNode.importJSON(json);
      expect(restored.getUserId()).toBe('u-1');
      expect(restored.getDisplayName()).toBe('Alice');
    });
  });

  it('exports DOM with the wire-format attributes', () => {
    withEditor(() => {
      const node = $createMentionNode('u-2', 'Bob');
      const { element } = node.exportDOM();
      const span = element as HTMLElement;
      expect(span.tagName).toBe('SPAN');
      expect(span.classList.contains('mention')).toBe(true);
      expect(span.getAttribute('data-user-id')).toBe('u-2');
      expect(span.getAttribute('data-mention-name')).toBe('Bob');
      expect(span.getAttribute('contenteditable')).toBe('false');
      expect(span.textContent).toBe('@Bob');
    });
  });

  it('imports DOM created with the wire-format shape', () => {
    withEditor(() => {
      const html = `<span class="mention" data-user-id="u-3" data-mention-name="Carol">@Carol</span>`;
      const tmp = document.createElement('div');
      tmp.innerHTML = html;
      const span = tmp.firstChild as HTMLElement;
      const handlers = MentionNode.importDOM();
      const matcher = handlers?.span?.(span);
      expect(matcher).not.toBeNull();
      const node = matcher!.conversion(span).node as MentionNode;
      expect(node.getUserId()).toBe('u-3');
      expect(node.getDisplayName()).toBe('Carol');
    });
  });

  it('importDOM returns null for spans that are not mention pills', () => {
    const tmp = document.createElement('div');
    tmp.innerHTML = '<span>plain</span>';
    const span = tmp.firstChild as HTMLElement;
    expect(MentionNode.importDOM()?.span?.(span)).toBeNull();
  });

  it('decorate renders a span containing the @-prefixed name', () => {
    withEditor(() => {
      const node = $createMentionNode('u-1', 'Alice');
      const { container } = render(node.decorate());
      expect(container.textContent).toBe('@Alice');
    });
  });

  it('$isMentionNode discriminates against unrelated nodes', () => {
    withEditor(() => {
      expect($isMentionNode($createMentionNode('u-1', 'Alice'))).toBe(true);
    });
    expect($isMentionNode(null)).toBe(false);
    expect($isMentionNode({ getType: () => 'paragraph' } as never)).toBe(false);
  });

  it('getTextContent returns "@displayName" so search hit highlighting works', () => {
    withEditor(() => {
      expect($createMentionNode('u-1', 'Alice').getTextContent()).toBe('@Alice');
    });
  });
});
