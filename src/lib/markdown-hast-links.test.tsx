import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { renderHastTree } from './markdown-hast';
import type { HastNode } from '@/types';

const text = (value: string): HastNode => ({ type: 'text', value });
const el = (tagName: string, children: HastNode[], properties: Record<string, unknown> = {}): HastNode => ({
  type: 'element',
  tagName,
  properties,
  children,
});

// A link the caller claims renders its way; every other link, and any
// unsafe one, keeps the default.
describe('renderHastTree links', () => {
  it('lets the caller render the links it claims, markdown and bare alike', () => {
    const renderLink = vi.fn((href: string, children: ReactNode) =>
      href.startsWith('https://claimed.example') ? (
        <a href="https://edit.example" data-testid="custom">
          {children}
        </a>
      ) : undefined,
    );
    const tree: HastNode = {
      type: 'root',
      children: [
        el('p', [
          el('a', [text('claimed')], { href: 'https://claimed.example/doc' }),
          el('a', [text('other')], { href: 'https://other.example' }),
          el('a', [text('unsafe')], { href: 'javascript:alert(1)' }),
          el('ex-bare-url', [], { 'data-href': 'https://claimed.example/bare' }),
          el('ex-bare-url', [], { 'data-href': 'https://other.example/bare' }),
          el('ex-bare-url', [], { 'data-href': 'javascript:alert(2)' }),
        ]),
      ],
    };
    render(<>{renderHastTree(tree, { renderLink })}</>);
    expect(screen.getAllByTestId('custom').map((a) => a.textContent)).toEqual(['claimed', 'claimed.example/bare']);
    expect(screen.getByRole('link', { name: 'other' })).toHaveAttribute('href', 'https://other.example');
    expect(screen.getByRole('link', { name: 'other.example/bare' })).toHaveAttribute('target', '_blank');
    expect(screen.queryByRole('link', { name: 'unsafe' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'javascript:alert(2)' })).toBeNull();
  });
});
