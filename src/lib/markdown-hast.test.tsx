import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { reactNodeText, renderHastTree } from './markdown-hast';
import type { HastNode } from '@/types';

// Stub GiphyEmbed so the test can read the resolved id prop without pulling in
// the real embed's network/iframe behaviour.
vi.mock('@/components/GiphyEmbed', () => ({
  GiphyEmbed: ({ id }: { id: string }) => <div data-testid="giphy" data-id={id} />,
}));

describe('renderHastTree', () => {
  it('renders an email address as a mailto link showing the address', () => {
    const tree: HastNode = {
      type: 'root',
      children: [
        {
          type: 'element',
          tagName: 'ex-bare-url',
          properties: { 'data-href': 'mailto:user@example.com', 'data-value': 'user@example.com' },
          children: [],
        },
      ],
    };
    const { container } = render(<>{renderHastTree(tree)}</>);
    const link = container.querySelector('a');
    expect(link).toHaveAttribute('href', 'mailto:user@example.com');
    expect(link).toHaveTextContent(/^user@example\.com$/);
  });

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

  it('renders a link to the sign-in routes as plain text, no anchor', () => {
    for (const href of ['/auth/desktop/complete?code=X', '../auth/oidc/login', `${window.location.origin}/auth/logout`]) {
      const view = render(<>{renderHastTree(linkTree(href))}</>);
      expect(view.container.querySelector('a')).toBeNull();
      expect(view.container.textContent).toContain('click');
      view.unmount();
    }
  });

  it('renders a same-origin bare URL to the sign-in routes as plain text', () => {
    const href = `${window.location.origin}/auth/desktop/complete?code=X`;
    const tree: HastNode = {
      type: 'root',
      children: [{ type: 'element', tagName: 'ex-bare-url', properties: { 'data-href': href } }],
    };
    const { container } = render(<>{renderHastTree(tree)}</>);
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toBe(href);
  });

  it('keeps a channel mention inside /channel/ whatever its slug says', () => {
    const tree: HastNode = {
      type: 'root',
      children: [
        {
          type: 'element',
          tagName: 'ex-mention-channel',
          properties: { 'data-channel-id': 'c-1', 'data-slug': '../../auth/desktop/complete?code=X' },
        },
      ],
    };
    const { container } = render(<>{renderHastTree(tree)}</>);
    const pill = container.querySelector('a');
    expect(pill).toHaveAttribute('href', '/channel/..%2F..%2Fauth%2Fdesktop%2Fcomplete%3Fcode%3DX');
    expect(new URL(pill!.getAttribute('href')!, window.location.origin).pathname).toMatch(/^\/channel\/[^/]+$/);
  });

  it('drops nodes of any type the server never emits (mdx JSX would bypass the tag allowlist)', () => {
    const tree = {
      type: 'root',
      children: [
        {
          type: 'element',
          tagName: 'p',
          children: [
            { type: 'text', value: 'kept' },
            { type: 'mdxJsxTextElement', name: 'img', attributes: [{ type: 'mdxJsxAttribute', name: 'src', value: 'x' }], children: [] },
          ],
        },
        { type: 'mdxJsxFlowElement', name: 'script', attributes: [], children: [{ type: 'text', value: 'alert(1)' }] },
        { type: 'comment', value: 'c' },
      ],
    } as unknown as HastNode;
    const { container } = render(<>{renderHastTree(tree)}</>);
    expect(container.innerHTML).toBe('<p class="whitespace-pre-wrap break-words">kept</p>');
  });

  it('renders nothing for a tree whose root is of an unknown type', () => {
    const tree = { type: 'mdxJsxFlowElement', name: 'script', attributes: [], children: [] } as unknown as HastNode;
    const { container } = render(<>{renderHastTree(tree)}</>);
    expect(container.innerHTML).toBe('');
  });

  it('unwraps an element that carries no tag name', () => {
    const tree: HastNode = {
      type: 'root',
      children: [{ type: 'element', children: [{ type: 'text', value: 'inner' }] }],
    };
    const { container } = render(<>{renderHastTree(tree)}</>);
    expect(container.innerHTML).toBe('inner');
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

describe('reactNodeText', () => {
  it('flattens every ReactNode shape to its literal text', () => {
    expect(reactNodeText(null)).toBe('');
    expect(reactNodeText(undefined)).toBe('');
    expect(reactNodeText(true)).toBe('');
    expect(reactNodeText(false)).toBe('');
    expect(reactNodeText('a')).toBe('a');
    expect(reactNodeText(7)).toBe('7');
    expect(reactNodeText(['a', 7, null, ['b']])).toBe('a7b');
    expect(reactNodeText(<span>{'x'}</span>)).toBe('x');
    // Unrenderable shapes (plain objects) flatten to nothing.
    expect(reactNodeText({} as unknown as React.ReactNode)).toBe('');
  });
});

describe('code className passthrough', () => {
  it('keeps the language className on code elements that carry one', () => {
    const tree: HastNode = {
      type: 'root',
      children: [
        {
          type: 'element',
          tagName: 'code',
          properties: { className: ['language-go'] },
          children: [{ type: 'text', value: 'x := 1' }],
        },
      ],
    };
    const { container } = render(<>{renderHastTree(tree)}</>);
    const code = container.querySelector('code.language-go');
    expect(code).toBeInTheDocument();
    expect(code!.textContent).toBe('x := 1');
  });
});
