import { describe, expect, it } from 'vitest';
import { createEditor } from 'lexical';
import { MentionNode, $createMentionNode, $isMentionNode } from './MentionNode';

// MentionNode methods proxy through Lexical's getLatest(), so node operations
// must run inside an editor context. We capture primitive results out and
// assert after the update.
function inEditor(fn: () => void) {
  const editor = createEditor({ namespace: 'mention-test', nodes: [MentionNode], onError: (e) => { throw e; } });
  editor.update(fn, { discrete: true });
}

function spanConverter() {
  const map = MentionNode.importDOM()!;
  return map.span as (el: HTMLElement) => { conversion: (n: HTMLElement) => { node: MentionNode }; priority: number } | null;
}

describe('MentionNode (browser)', () => {
  it('exposes type, ids, text content, and JSON round-trip', () => {
    let captured: Record<string, unknown> = {};
    inEditor(() => {
      const node = $createMentionNode('u-1', 'Alice');
      captured = {
        type: MentionNode.getType(),
        userId: node.getUserId(),
        displayName: node.getDisplayName(),
        text: node.getTextContent(),
        json: node.exportJSON(),
        restored: MentionNode.importJSON(node.exportJSON()).getUserId(),
        cloneName: MentionNode.clone(node).getDisplayName(),
      };
    });
    expect(captured.type).toBe('mention');
    expect(captured.userId).toBe('u-1');
    expect(captured.displayName).toBe('Alice');
    expect(captured.text).toBe('@Alice');
    expect(captured.json).toMatchObject({ type: 'mention', userId: 'u-1', displayName: 'Alice' });
    expect(captured.restored).toBe('u-1');
    expect(captured.cloneName).toBe('Alice');
  });

  it('renders DOM with mention attributes and is inline/isolated', () => {
    let c: Record<string, unknown> = {};
    inEditor(() => {
      const node = $createMentionNode('u-2', 'Bob');
      const dom = node.createDOM({} as never);
      const exported = node.exportDOM().element as HTMLElement;
      c = {
        userId: dom.getAttribute('data-user-id'),
        cls: dom.className,
        inline: node.isInline(),
        isolated: node.isIsolated(),
        keyboard: node.isKeyboardSelectable(),
        update: node.updateDOM(),
        exportName: exported.getAttribute('data-mention-name'),
        exportText: exported.textContent,
      };
    });
    expect(c.userId).toBe('u-2');
    expect(c.cls).toContain('mention');
    expect(c.inline).toBe(true);
    expect(c.isolated).toBe(true);
    expect(c.keyboard).toBe(true);
    expect(c.update).toBe(false);
    expect(c.exportName).toBe('Bob');
    expect(c.exportText).toBe('@Bob');
  });

  it('skips DOM conversion for spans without the mention class', () => {
    const plain = document.createElement('span');
    expect(spanConverter()(plain)).toBeNull();
  });

  it('skips DOM conversion for mention spans missing a user id', () => {
    const el = document.createElement('span');
    el.className = 'mention';
    expect(spanConverter()(el)).toBeNull();
  });

  it('converts a mention span using its data-mention-name', () => {
    const el = document.createElement('span');
    el.className = 'mention';
    el.setAttribute('data-user-id', 'u-3');
    el.setAttribute('data-mention-name', 'Carol');
    const out = spanConverter()(el)!;
    let userId = '', name = '';
    inEditor(() => {
      const node = out.conversion(el).node;
      userId = node.getUserId();
      name = node.getDisplayName();
    });
    expect(userId).toBe('u-3');
    expect(name).toBe('Carol');
  });

  it('derives the name from textContent when data-mention-name is absent', () => {
    const el = document.createElement('span');
    el.className = 'mention';
    el.setAttribute('data-user-id', 'u-4');
    el.textContent = '@Dave';
    const out = spanConverter()(el)!;
    let name = '';
    inEditor(() => {
      name = out.conversion(el).node.getDisplayName();
    });
    expect(name).toBe('Dave');
  });

  it('falls back to empty strings when the conversion node lacks attributes and text', () => {
    // importDOM matches on `el` (which carries the mention class + user id),
    // but the returned conversion reads its own `node` argument. Passing a
    // bare element with no data-user-id and null textContent drives the
    // `?? ''` right-hand sides of both fallbacks.
    const matchEl = document.createElement('span');
    matchEl.className = 'mention';
    matchEl.setAttribute('data-user-id', 'u-match');
    const conversion = spanConverter()(matchEl)!.conversion;
    const bare = document.createElement('span'); // no attrs, textContent ''
    let userId = 'x', name = 'x';
    inEditor(() => {
      const node = conversion(bare).node;
      userId = node.getUserId();
      name = node.getDisplayName();
    });
    expect(userId).toBe('');
    expect(name).toBe('');
  });

  it('type-guards mention nodes', () => {
    let isMention = false;
    inEditor(() => {
      isMention = $isMentionNode($createMentionNode('u', 'x'));
    });
    expect(isMention).toBe(true);
    expect($isMentionNode(null)).toBe(false);
  });
});
