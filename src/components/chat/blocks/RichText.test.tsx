import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { RichText } from './RichText';
import { BlockList } from './MessageBlocks';
import { BlockScope, type BlockScopeValue } from './blockScope';
import type { RichNode } from '@/types';

const scope = (currentUserId: string): BlockScopeValue => ({
  interactive: true,
  appButtons: true,
  idPrefix: 'msg-m1',
  currentUserId,
  act: async () => {},
});

describe('RichText', () => {
  it('draws every kind of part', () => {
    const content: RichNode[] = [
      { type: 'heading', level: 1, spans: [{ type: 'text', text: 'Release 1.43' }] },
      { type: 'heading', level: 2, spans: [{ type: 'text', text: 'What changed' }] },
      { type: 'heading', level: 3, spans: [{ type: 'text', text: 'Fixes' }] },
      { type: 'paragraph', spans: [{ type: 'text', text: 'Checkout is faster.' }] },
      { type: 'quote', spans: [{ type: 'text', text: 'No Friday deploys' }] },
      {
        type: 'list',
        style: 'bullet',
        items: [
          { spans: [{ type: 'text', text: 'Build' }], items: [{ spans: [{ type: 'text', text: 'Lint' }] }] },
          { items: [{ spans: [{ type: 'text', text: 'Only nested' }] }] },
        ],
      },
      { type: 'list', style: 'ordered', items: [{ spans: [{ type: 'text', text: 'First' }] }] },
      { type: 'code', language: 'go', text: 'go test ./...' },
    ];
    render(<RichText content={content} />);
    const levels = screen.getAllByRole('heading').map((h) => [h.textContent, h.getAttribute('aria-level')]);
    expect(levels).toEqual([['Release 1.43', '3'], ['What changed', '4'], ['Fixes', '5']]);
    expect(screen.getByText('Checkout is faster.').tagName).toBe('P');
    expect(screen.getByText('No Friday deploys').closest('blockquote')).not.toBeNull();
    const bullets = screen.getByText('Build').closest('ul')!;
    expect(bullets).toHaveClass('list-disc');
    expect(within(bullets).getByText('Lint').closest('ul')).not.toBe(bullets);
    expect(screen.getByText('Only nested')).toBeInTheDocument();
    expect(screen.getByText('First').closest('ol')).toHaveClass('list-decimal');
    expect(screen.getByText(/go test/)).toBeInTheDocument();
  });

  it('styles text from palette tokens only', () => {
    render(
      <RichText
        content={[
          {
            type: 'paragraph',
            spans: [
              { type: 'text', text: 'plain' },
              { type: 'text', text: 'loud', bold: true, italic: true, strike: true, underline: true, color: 'red', highlight: 'yellow' },
              { type: 'text', text: 'snippet', code: true },
              { type: 'text', text: 'struck', strike: true },
              { type: 'text', text: 'underlined', underline: true },
              { type: 'pill', text: 'Passed', color: 'green' },
            ],
          },
        ]}
      />,
    );
    expect(screen.getByText('plain').tagName).toBe('P');
    // Strikethrough and underline together keep both lines.
    expect(screen.getByText('loud')).toHaveClass('font-semibold', 'italic', '[text-decoration-line:underline_line-through]', 'text-rt-red', 'bg-rt-yellow-bg');
    expect(screen.getByText('struck')).toHaveClass('line-through');
    expect(screen.getByText('underlined')).toHaveClass('underline');
    expect(screen.getByText('snippet').tagName).toBe('CODE');
    expect(screen.getByTestId('rich-pill')).toHaveClass('bg-rt-green-bg', 'text-rt-green');
  });

  it('opens http and mailto links in a new tab, and never an unsafe one', () => {
    render(
      <RichText
        content={[
          {
            type: 'paragraph',
            spans: [
              { type: 'text', text: 'notes', link: 'https://example.com/notes', bold: true },
              { type: 'text', text: 'mail', link: 'mailto:team@example.com' },
              { type: 'text', text: 'tinted', link: 'https://example.com/t', color: 'blue' },
              { type: 'text', text: 'trap', link: 'javascript:alert(1)' },
            ],
          },
        ]}
      />,
    );
    const notes = screen.getByRole('link', { name: 'notes' });
    expect(notes).toHaveAttribute('href', 'https://example.com/notes');
    expect(notes).toHaveAttribute('target', '_blank');
    expect(notes).toHaveAttribute('rel', 'noreferrer noopener');
    expect(notes).toHaveClass('font-semibold');
    expect(screen.getByRole('link', { name: 'mail' })).toHaveAttribute('href', 'mailto:team@example.com');
    expect(screen.getByRole('link', { name: 'mail' })).toHaveClass('text-link');
    // An app's colour wins over the link colour.
    const tinted = screen.getByRole('link', { name: 'tinted' });
    expect(tinted).toHaveClass('text-rt-blue');
    expect(tinted).not.toHaveClass('text-link');
    expect(screen.queryByRole('link', { name: 'trap' })).toBeNull();
    expect(screen.getByText('trap')).toBeInTheDocument();
  });

  it('draws mentions, emoji and dates', () => {
    const content: RichNode[] = [
      {
        type: 'paragraph',
        spans: [
          { type: 'user', user: 'u-alice', name: 'Alice' },
          { type: 'user', user: 'u-bob', name: 'Bob' },
          { type: 'channel', channel: 'c-builds', name: 'builds' },
          { type: 'emoji', name: 'rocket' },
          { type: 'date', timestamp: 0, format: 'on {date_long}' },
          { type: 'date', timestamp: 0, format: '{fortnight}', fallback: 'some day' },
          { type: 'date', timestamp: 0, format: '{fortnight}' },
        ],
      },
    ];
    const { container } = render(
      <BlockScope.Provider value={scope('u-alice')}>
        <RichText content={content} />
      </BlockScope.Provider>,
    );
    const [alice, bob] = screen.getAllByTestId('mention-pill');
    expect(alice).toHaveTextContent('@Alice');
    expect(alice).toHaveAttribute('data-mention-self', 'true');
    expect(bob).toHaveAttribute('data-mention-self', 'false');
    expect(screen.getByTestId('channel-mention-pill')).toHaveAttribute('href', '/channel/builds');
    expect(container.textContent).toContain('🚀');
    expect(container.textContent).toContain('on ');
    expect(container.textContent).toContain('1970');
    expect(container.textContent).toContain('some day');
  });

  it('is drawn for a rich_text block in a message', () => {
    render(<BlockList blocks={[{ type: 'rich_text', block_id: 'b1', content: [{ type: 'paragraph', spans: [{ type: 'text', text: 'Hello' }] }] }]} />);
    expect(within(screen.getByTestId('message-blocks')).getByTestId('block-rich-text')).toHaveTextContent('Hello');
  });
});

describe('Layout blocks', () => {
  const para = (text: string): RichNode => ({ type: 'paragraph', spans: [{ type: 'text', text }] });

  it('draws a callout tinted from the palette, with or without an icon', () => {
    render(
      <BlockList
        blocks={[
          { type: 'callout', block_id: 'b1', icon: 'light_bulb', color: 'yellow', content: [para('Freeze starts Friday')] },
          { type: 'callout', block_id: 'b2', color: 'gray', content: [para('No icon')] },
        ]}
      />,
    );
    const [withIcon, plain] = screen.getAllByTestId('block-callout');
    expect(withIcon).toHaveClass('bg-rt-yellow-bg');
    expect(withIcon.textContent).toContain('💡');
    expect(withIcon).toHaveTextContent('Freeze starts Friday');
    expect(plain).toHaveClass('bg-rt-gray-bg');
    expect(plain.textContent).toBe('No icon');
  });

  it('draws a table with a header row, alignment and empty cells', () => {
    render(
      <BlockList
        blocks={[
          {
            type: 'table',
            block_id: 'b1',
            columns: [{ header: 'Service', align: 'left' }, { header: 'Status', align: 'center' }, { header: 'p95', align: 'right' }],
            rows: [
              [{ spans: [{ type: 'text', text: 'api' }] }, { spans: [{ type: 'pill', text: 'Live', color: 'green' }] }, { spans: [{ type: 'text', text: '120 ms' }] }],
              [{ spans: [{ type: 'text', text: 'web' }] }, {}, {}],
            ],
          },
        ]}
      />,
    );
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Service', 'Status', 'p95']);
    expect(within(table).getByText('120 ms')).toHaveClass('text-right', 'tabular-nums');
    expect(within(table).getByTestId('rich-pill').closest('td')).toHaveClass('text-center');
    const rows = within(table).getAllByRole('row');
    expect(rows[1]).toHaveClass('border-t');
    expect(rows[2].querySelectorAll('td')[1].textContent).toBe('');
  });

  it('leaves out the header row when no column names one', () => {
    render(
      <BlockList
        blocks={[{ type: 'table', block_id: 'b1', columns: [{ align: 'left' }], rows: [[{ spans: [{ type: 'text', text: 'a' }] }], [{ spans: [{ type: 'text', text: 'b' }] }]] }]}
      />,
    );
    expect(screen.queryByRole('columnheader')).toBeNull();
    const [first, second] = screen.getAllByRole('row');
    expect(first).not.toHaveClass('border-t');
    expect(second).toHaveClass('border-t');
  });

  it('opens a toggle on click, rendering its blocks only then', () => {
    render(
      <BlockList
        blocks={[
          {
            type: 'toggle',
            block_id: 'b1',
            summary: [
              { type: 'text', text: 'Show logs', link: 'https://example.com/logs' },
              { type: 'channel', channel: 'c-builds', name: 'builds' },
            ],
            blocks: [{ type: 'rich_text', block_id: 'b2', content: [{ type: 'code', text: 'panic: nil map' }] }],
          },
        ]}
      />,
    );
    const button = screen.getByRole('button', { name: /Show logs/ });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    // The summary is the control: nothing in it is a link of its own.
    expect(within(button).queryByRole('link')).toBeNull();
    expect(screen.queryByText(/panic/)).toBeNull();
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/panic: nil map/)).toBeInTheDocument();
    expect(document.getElementById(button.getAttribute('aria-controls')!)).not.toBeNull();
    fireEvent.click(button);
    expect(screen.queryByText(/panic/)).toBeNull();
  });

  it('starts a toggle open when the app asks', () => {
    render(
      <BlockList
        blocks={[{ type: 'toggle', block_id: 'b1', open: true, summary: [{ type: 'text', text: 'Details' }], blocks: [{ type: 'divider', block_id: 'b2' }] }]}
      />,
    );
    expect(screen.getByRole('button', { name: 'Details' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('separator')).toBeInTheDocument();
  });
});
