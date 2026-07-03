import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { renderHastTree } from './markdown-hast';
import type { HastNode } from '@/types';

// Stub GiphyEmbed so the test can read the resolved id prop without pulling in
// the real embed's network/iframe behaviour.
vi.mock('@/components/GiphyEmbed', () => ({
  GiphyEmbed: ({ id }: { id: string }) => <div data-testid="giphy" data-id={id} />,
}));

describe('renderHastTree', () => {
  it('patches in an empty child list for an element node missing children', () => {
    // The <p> element arrives with no `children` key — normaliseTree must
    // default it to [] rather than crashing the hydrator.
    const tree: HastNode = {
      type: 'root',
      children: [{ type: 'element', tagName: 'p' }],
    };
    const { container } = render(<>{renderHastTree(tree)}</>);
    expect(container.querySelector('p')).toBeInTheDocument();
  });

  it('falls back to an empty id when an ex-giphy element omits data-id', () => {
    const tree: HastNode = {
      type: 'root',
      children: [{ type: 'element', tagName: 'ex-giphy', properties: {} }],
    };
    const { getByTestId } = render(<>{renderHastTree(tree)}</>);
    expect(getByTestId('giphy')).toHaveAttribute('data-id', '');
  });

  const linkTree = (href: string): HastNode => ({
    type: 'root',
    children: [
      {
        type: 'element',
        tagName: 'a',
        properties: { href },
        children: [{ type: 'text', value: 'click' }],
      },
    ],
  });

  it('renders a safe link as an anchor', () => {
    const { container } = render(<>{renderHastTree(linkTree('https://example.com'))}</>);
    expect(container.querySelector('a')).toHaveAttribute('href', 'https://example.com');
  });

  it('renders an unsafe-scheme link as plain text, no anchor', () => {
    const { container } = render(<>{renderHastTree(linkTree('javascript:alert(1)'))}</>);
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('click');
  });

  it('renders a hast table with thead/tbody, a scroll wrapper, and per-column alignment', () => {
    const cell = (tag: string, value: string, align?: string): HastNode => ({
      type: 'element',
      tagName: tag,
      properties: align ? { 'data-align': align } : {},
      children: [{ type: 'text', value }],
    });
    const row = (cells: HastNode[]): HastNode => ({ type: 'element', tagName: 'tr', children: cells });
    const tree: HastNode = {
      type: 'root',
      children: [
        {
          type: 'element',
          tagName: 'table',
          children: [
            {
              type: 'element',
              tagName: 'thead',
              children: [row([cell('th', 'L'), cell('th', 'C', 'center'), cell('th', 'R', 'right')])],
            },
            {
              type: 'element',
              tagName: 'tbody',
              children: [row([cell('td', 'a'), cell('td', 'b', 'center'), cell('td', 'c', 'right')])],
            },
          ],
        },
      ],
    };
    const { container } = render(<>{renderHastTree(tree)}</>);
    const table = container.querySelector('table');
    expect(table).not.toBeNull();
    // Wide tables scroll inside their own box.
    expect(table!.parentElement?.className).toContain('overflow-x-auto');

    const ths = container.querySelectorAll('thead th');
    expect(ths.length).toBe(3);
    expect(ths[0].className).toContain('text-left'); // no data-align → default
    expect(ths[1].className).toContain('text-center');
    expect(ths[2].className).toContain('text-right');

    const tds = container.querySelectorAll('tbody td');
    expect(tds[0].textContent).toBe('a');
    expect(tds[2].className).toContain('text-right');
  });
});
