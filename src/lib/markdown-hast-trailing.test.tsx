import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { renderHastTree } from './markdown-hast';
import type { HastNode } from '@/types';

const text = (value: string): HastNode => ({ type: 'text', value });
const el = (tagName: string, children: HastNode[], properties: Record<string, unknown> = {}): HastNode => ({
  type: 'element',
  tagName,
  properties,
  children,
});
const root = (...children: HastNode[]): HastNode => ({ type: 'root', children });

describe('renderHastTree trailing', () => {
  it('rides the last paragraph when the body ends in one', () => {
    const { container } = render(
      <>{renderHastTree(root(el('p', [text('first')]), el('p', [text('last')])), { trailing: <em data-testid="t">(edited)</em> })}</>,
    );
    const paragraphs = container.querySelectorAll('p');
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[1].querySelector('[data-testid="t"]')).not.toBeNull();
    expect(paragraphs[0].querySelector('[data-testid="t"]')).toBeNull();
  });

  it('follows the body when it ends in something other than a paragraph, or a blank one', () => {
    for (const last of [el('ul', [el('li', [text('item')])]), el('p', [text(' ')], { 'data-blank': 'true' }), el('p', [text(' ')], { dataBlank: 'true' })]) {
      const { container, unmount } = render(
        <>{renderHastTree(root(el('p', [text('intro')]), last), { trailing: <em data-testid="t">(edited)</em> })}</>,
      );
      const marker = container.querySelector('[data-testid="t"]') as HTMLElement;
      expect(marker).not.toBeNull();
      expect(marker.closest('p, ul')).toBeNull();
      unmount();
    }
  });

  it('tolerates a root or paragraph that arrives without a children list', () => {
    const bare = render(<>{renderHastTree({ type: 'root' } as HastNode, { trailing: <em data-testid="t">(edited)</em> })}</>);
    expect(bare.container.querySelector('[data-testid="t"]')).not.toBeNull();
    bare.unmount();
    const bareP = render(
      <>{renderHastTree({ type: 'root', children: [{ type: 'element', tagName: 'p', properties: {} } as HastNode] }, { trailing: <em data-testid="t">(edited)</em> })}</>,
    );
    expect(bareP.container.querySelector('p [data-testid="t"]')).not.toBeNull();
  });

  it('is absent without a trailing node, and an empty root gets it after', () => {
    const { container } = render(<>{renderHastTree(root(el('p', [text('x')])))}</>);
    expect(container.querySelectorAll('[data-testid="t"]')).toHaveLength(0);
    const empty = render(<>{renderHastTree(root(), { trailing: <em data-testid="t">(edited)</em> })}</>);
    expect(empty.container.querySelector('[data-testid="t"]')).not.toBeNull();
  });
});
