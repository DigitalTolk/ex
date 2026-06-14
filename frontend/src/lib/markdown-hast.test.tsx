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
});
