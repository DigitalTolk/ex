import { describe, expect, it } from 'vitest';
import { createEditor } from 'lexical';
import { ChannelMentionNode, $createChannelMentionNode, $isChannelMentionNode } from './ChannelMentionNode';

function inEditor(fn: () => void) {
  const editor = createEditor({ namespace: 'chmention-test', nodes: [ChannelMentionNode], onError: (e) => { throw e; } });
  editor.update(fn, { discrete: true });
}

function spanConverter() {
  const map = ChannelMentionNode.importDOM()!;
  return map.span as (el: HTMLElement) => { conversion: (n: HTMLElement) => { node: ChannelMentionNode }; priority: number } | null;
}

describe('ChannelMentionNode (browser)', () => {
  it('exposes type, ids, text content, and JSON round-trip', () => {
    let c: Record<string, unknown> = {};
    inEditor(() => {
      const node = $createChannelMentionNode('ch-1', 'general');
      c = {
        type: ChannelMentionNode.getType(),
        channelId: node.getChannelId(),
        slug: node.getSlug(),
        text: node.getTextContent(),
        json: node.exportJSON(),
        restored: ChannelMentionNode.importJSON(node.exportJSON()).getSlug(),
        cloneSlug: ChannelMentionNode.clone(node).getSlug(),
      };
    });
    expect(c.channelId).toBe('ch-1');
    expect(c.slug).toBe('general');
    expect(c.text).toBe('~general');
    expect(c.json).toMatchObject({ channelId: 'ch-1', slug: 'general' });
    expect(c.restored).toBe('general');
    expect(c.cloneSlug).toBe('general');
  });

  it('renders DOM with channel attributes and exports a contenteditable=false span', () => {
    let c: Record<string, unknown> = {};
    inEditor(() => {
      const node = $createChannelMentionNode('ch-2', 'random');
      const dom = node.createDOM({} as never);
      const exported = node.exportDOM().element as HTMLElement;
      c = {
        id: dom.getAttribute('data-channel-id'),
        cls: dom.className,
        inline: node.isInline(),
        isolated: node.isIsolated(),
        update: node.updateDOM(),
        exportSlug: exported.getAttribute('data-channel-slug'),
        exportText: exported.textContent,
      };
    });
    expect(c.id).toBe('ch-2');
    expect(c.cls).toContain('mention');
    expect(c.inline).toBe(true);
    expect(c.isolated).toBe(true);
    expect(c.update).toBe(false);
    expect(c.exportSlug).toBe('random');
    expect(c.exportText).toBe('~random');
  });

  it('skips DOM conversion for non-mention or id-less spans', () => {
    const plain = document.createElement('span');
    expect(spanConverter()(plain)).toBeNull();
    const noId = document.createElement('span');
    noId.className = 'mention';
    expect(spanConverter()(noId)).toBeNull();
  });

  it('converts a channel-mention span using data-channel-slug', () => {
    const el = document.createElement('span');
    el.className = 'mention';
    el.setAttribute('data-channel-id', 'ch-3');
    el.setAttribute('data-channel-slug', 'eng');
    const out = spanConverter()(el)!;
    let id = '', slug = '';
    inEditor(() => {
      const node = out.conversion(el).node;
      id = node.getChannelId();
      slug = node.getSlug();
    });
    expect(id).toBe('ch-3');
    expect(slug).toBe('eng');
  });

  it('derives the slug from textContent when data-channel-slug is absent', () => {
    const el = document.createElement('span');
    el.className = 'mention';
    el.setAttribute('data-channel-id', 'ch-4');
    el.textContent = '~ops';
    const out = spanConverter()(el)!;
    let slug = '';
    inEditor(() => {
      slug = out.conversion(el).node.getSlug();
    });
    expect(slug).toBe('ops');
  });

  it('falls back to empty strings when the conversion node lacks attributes and text', () => {
    // importDOM matches on `el` (carrying the mention class + channel id), but
    // the conversion reads its own `node` argument. A bare element drives the
    // `?? ''` right-hand sides of both the data-channel-id and slug fallbacks.
    const matchEl = document.createElement('span');
    matchEl.className = 'mention';
    matchEl.setAttribute('data-channel-id', 'ch-match');
    const conversion = spanConverter()(matchEl)!.conversion;
    const bare = document.createElement('span');
    let id = 'x', slug = 'x';
    inEditor(() => {
      const node = conversion(bare).node;
      id = node.getChannelId();
      slug = node.getSlug();
    });
    expect(id).toBe('');
    expect(slug).toBe('');
  });

  it('type-guards channel-mention nodes', () => {
    let isCh = false;
    inEditor(() => {
      isCh = $isChannelMentionNode($createChannelMentionNode('c', 's'));
    });
    expect(isCh).toBe(true);
    expect($isChannelMentionNode(null)).toBe(false);
  });
});
