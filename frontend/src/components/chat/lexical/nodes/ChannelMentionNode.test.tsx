import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { createHeadlessEditor } from '@lexical/headless';
import {
  $createChannelMentionNode,
  $isChannelMentionNode,
  ChannelMentionNode,
} from './ChannelMentionNode';

function withEditor(fn: () => void) {
  const editor = createHeadlessEditor({
    nodes: [ChannelMentionNode],
    onError: (e) => { throw e; },
  });
  editor.update(fn, { discrete: true });
}

describe('ChannelMentionNode', () => {
  it('round-trips through JSON serialization', () => {
    withEditor(() => {
      const node = $createChannelMentionNode('c-1', 'general');
      const json = node.exportJSON();
      expect(json).toMatchObject({ type: 'channelMention', version: 1, channelId: 'c-1', slug: 'general' });
      const restored = ChannelMentionNode.importJSON(json);
      expect(restored.getChannelId()).toBe('c-1');
      expect(restored.getSlug()).toBe('general');
    });
  });

  it('exports DOM with the wire-format attributes', () => {
    withEditor(() => {
      const node = $createChannelMentionNode('c-2', 'random');
      const { element } = node.exportDOM();
      const span = element as HTMLElement;
      expect(span.classList.contains('mention')).toBe(true);
      expect(span.classList.contains('channel-mention')).toBe(true);
      expect(span.getAttribute('data-channel-id')).toBe('c-2');
      expect(span.getAttribute('data-channel-slug')).toBe('random');
      expect(span.getAttribute('contenteditable')).toBe('false');
      expect(span.textContent).toBe('~random');
    });
  });

  it('imports DOM created with the wire-format shape', () => {
    withEditor(() => {
      const html = `<span class="mention channel-mention" data-channel-id="c-3" data-channel-slug="eng">~eng</span>`;
      const tmp = document.createElement('div');
      tmp.innerHTML = html;
      const span = tmp.firstChild as HTMLElement;
      const matcher = ChannelMentionNode.importDOM()?.span?.(span);
      expect(matcher).not.toBeNull();
      const node = matcher!.conversion(span).node as ChannelMentionNode;
      expect(node.getChannelId()).toBe('c-3');
      expect(node.getSlug()).toBe('eng');
    });
  });

  it('importDOM returns null for plain spans', () => {
    const tmp = document.createElement('div');
    tmp.innerHTML = '<span>plain</span>';
    expect(ChannelMentionNode.importDOM()?.span?.(tmp.firstChild as HTMLElement)).toBeNull();
  });

  it('decorate renders a span containing the ~slug', () => {
    withEditor(() => {
      const node = $createChannelMentionNode('c-1', 'general');
      const { container } = render(node.decorate());
      expect(container.textContent).toBe('~general');
    });
  });

  it('$isChannelMentionNode discriminates against unrelated nodes', () => {
    withEditor(() => {
      expect($isChannelMentionNode($createChannelMentionNode('c-1', 'general'))).toBe(true);
    });
    expect($isChannelMentionNode(null)).toBe(false);
  });

  it('getTextContent returns "~slug"', () => {
    withEditor(() => {
      expect($createChannelMentionNode('c-1', 'general').getTextContent()).toBe('~general');
    });
  });
});
