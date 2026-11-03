import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderMarkdown } from '@/lib/markdown';
import { MessageRichAttachments } from './MessageRichAttachments';

// Wrapped, not replaced: every test still renders real markdown, and the
// re-render test can count how often a field is parsed.
vi.mock('@/lib/markdown', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/markdown')>();
  return { ...actual, renderMarkdown: vi.fn(actual.renderMarkdown) };
});

describe('MessageRichAttachments', () => {
  it('renders nothing without attachments', () => {
    const { container } = render(<MessageRichAttachments attachments={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders Mattermost attachment variants and reports image loads', () => {
    const onContentHeightChange = vi.fn();
    render(
      <MessageRichAttachments
        onContentHeightChange={onContentHeightChange}
        attachments={[
          {
            color: 'not-a-color',
            author_name: 'Build Bot',
            author_icon: '/media/author.webp',
            title: 'Plain title',
            text: '**Body**',
            fields: [
              { title: 'Short', value: 'Yes', short: true },
              { title: 'Wide', value: '[Logs](https://example.com/logs)', short: false },
            ],
            image_url: '/media/image.webp',
            image_width: 400,
            image_height: 300,
            footer_icon: '/media/footer.webp',
            footer: 'ci',
          },
          {
            color: '#0a0',
            pretext: 'Deploy',
            author_name: 'Linked Bot',
            author_link: 'https://example.com/bot',
            title: 'Linked report',
            title_link: 'https://example.com/report',
            thumb_url: '/media/thumb.webp',
          },
        ]}
      />,
    );

    // Notion-style: no side bar; a colour tints the whole card, and one ex
    // can't read is the theme's plain card.
    const cards = screen.getAllByTestId('message-rich-attachment');
    expect(cards).toHaveLength(2);
    expect(cards[0]).toHaveClass('border', 'bg-background');
    expect(cards[1]).toHaveClass('bg-rt-green-bg');
    expect(cards[1]).toHaveClass('border-rt-green/15');
    expect(cards[1]).not.toHaveAttribute('style');
    expect(screen.getByText('Build Bot')).toBeInTheDocument();
    expect(screen.getByText('Plain title')).toBeInTheDocument();
    expect(screen.getByText('Short')).toBeInTheDocument();
    expect(screen.getByText('Wide')).toBeInTheDocument();
    expect(screen.getByText('Linked Bot')).toHaveAttribute('href', 'https://example.com/bot');
    expect(screen.getByText('Linked report')).toHaveAttribute('href', 'https://example.com/report');

    // image_url renders explicit intrinsic dimensions when provided so the
    // virtualised list can reserve space (no layout shift on decode).
    const mainImage = document.querySelector('img[src="/media/image.webp"]');
    expect(mainImage).toHaveAttribute('width', '400');
    expect(mainImage).toHaveAttribute('height', '300');

    for (const image of document.querySelectorAll('img')) {
      fireEvent.load(image);
    }
    expect(onContentHeightChange).toHaveBeenCalledTimes(4);
  });

  it('links author and title only to absolute http(s) URLs', () => {
    render(
      <MessageRichAttachments
        attachments={[
          { author_name: 'Share bot', author_link: 'smb://attacker.example/share', title: 'Diag', title_link: 'ms-msdt:/id PCWDiagnostic' },
          { author_name: 'Relative bot', author_link: '/auth/desktop/complete?code=X', title: 'Mail', title_link: 'mailto:x@example.com' },
        ]}
      />,
    );
    for (const text of ['Share bot', 'Diag', 'Relative bot', 'Mail']) {
      expect(screen.getByText(text).closest('a')).toBeNull();
    }
  });

  it('strips unsafe-scheme links and image srcs', () => {
    render(
      <MessageRichAttachments
        attachments={[
          {
            author_name: 'Evil Bot',
            author_icon: 'javascript:alert(1)',
            author_link: 'javascript:alert(1)',
            title: 'Evil title',
            title_link: 'data:text/html,<script>alert(1)</script>',
            thumb_url: 'javascript:alert(1)',
            image_url: 'data:text/html,evil',
            footer: 'ci',
            footer_icon: 'vbscript:msgbox(1)',
          },
        ]}
      />,
    );

    // Author name + title still render as plain text, but without an href.
    expect(screen.getByText('Evil Bot').closest('a')).toBeNull();
    expect(screen.getByText('Evil title').closest('a')).toBeNull();
    // No <img> survives the unsafe scheme filter.
    expect(document.querySelectorAll('img')).toHaveLength(0);
  });

  it('does not re-parse unchanged markdown fields when the message row re-renders', () => {
    // A message row re-renders for hover, reactions, presence and edits of
    // other fields; the webhook card's markdown is unchanged by all of them.
    const attachment = {
      pretext: 'Deploy *started*',
      text: '**Body**',
      fields: [{ title: 'Env', value: '`prod`', short: true }],
    };
    const onContentHeightChange = () => undefined;
    const parse = vi.mocked(renderMarkdown);
    const { rerender } = render(
      <MessageRichAttachments attachments={[attachment]} onContentHeightChange={onContentHeightChange} />,
    );
    expect(parse).toHaveBeenCalledTimes(3);
    parse.mockClear();

    // The same content in a fresh array/object (the WS patch path rebuilds
    // the message object) parses nothing again.
    rerender(
      <MessageRichAttachments attachments={[{ ...attachment, fields: [...attachment.fields] }]} onContentHeightChange={onContentHeightChange} />,
    );
    expect(parse).not.toHaveBeenCalled();
    expect(screen.getByText('Body').tagName).toBe('STRONG');

    // Changing one field re-parses only that field.
    rerender(
      <MessageRichAttachments attachments={[{ ...attachment, text: '**Edited**' }]} onContentHeightChange={onContentHeightChange} />,
    );
    expect(parse).toHaveBeenCalledTimes(1);
    expect(parse).toHaveBeenCalledWith('**Edited**');
    expect(screen.getByText('Edited').tagName).toBe('STRONG');
  });
});

describe('MessageRichAttachments with blocks', () => {
  it('draws a card’s blocks inside its coloured bar', () => {
    render(
      <MessageRichAttachments
        attachments={[
          {
            color: '#D97706',
            text: 'card',
            blocks: [{ type: 'section', block_id: 'b1', text: { type: 'markdown', text: '**A3** due Fri' } }],
          },
        ]}
      />,
    );
    const cardEl = screen.getByTestId('message-rich-attachment');
    expect(cardEl).toContainElement(screen.getByTestId('message-blocks'));
    expect(screen.getByText('A3').tagName).toBe('STRONG');
  });

  it('heads a card with its icon and title, keeps pretext above it and the footer under a rule', () => {
    render(
      <MessageRichAttachments
        attachments={[
          { icon: '🚀', title: 'api deployed', pretext: 'Release 2.14', text: 'All checks passed.', fields: [{ title: 'Version', value: 'v2.14.0', short: true }], footer: 'deploy-bot' },
          { icon: 'not_a_known_emoji', text: 'No title' },
          { icon: '🚨', text: 'Deploy failed' },
        ]}
      />,
    );
    const [card, bare, untitled] = screen.getAllByTestId('message-rich-attachment');
    // Without a title, the icon leads the first line instead of a header.
    expect(untitled).toHaveClass('flex');
    expect(untitled.firstElementChild).toHaveTextContent('🚨');
    expect(untitled.lastElementChild).toHaveTextContent('Deploy failed');
    expect(card.firstElementChild!.firstElementChild).toHaveTextContent('🚀api deployed');
    expect(card).not.toHaveTextContent('Release 2.14');
    expect(screen.getByText('Release 2.14').closest('[data-testid="message-rich-attachment"]')).toBeNull();
    expect(screen.getByText('Version').tagName).toBe('DT');
    expect(screen.getByText('deploy-bot')).toHaveClass('border-t');
    // An icon ex can't draw is left out, never ":name:".
    expect(bare).not.toHaveTextContent(':not_a_known_emoji:');
  });
});
