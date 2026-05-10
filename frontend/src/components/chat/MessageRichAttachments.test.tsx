import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MessageRichAttachments } from './MessageRichAttachments';

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

    expect(screen.getAllByTestId('message-rich-attachment')).toHaveLength(2);
    expect(screen.getByText('Build Bot')).toBeInTheDocument();
    expect(screen.getByText('Plain title')).toBeInTheDocument();
    expect(screen.getByText('Short')).toBeInTheDocument();
    expect(screen.getByText('Wide')).toBeInTheDocument();
    expect(screen.getByText('Linked Bot')).toHaveAttribute('href', 'https://example.com/bot');
    expect(screen.getByText('Linked report')).toHaveAttribute('href', 'https://example.com/report');

    for (const image of document.querySelectorAll('img')) {
      fireEvent.load(image);
    }
    expect(onContentHeightChange).toHaveBeenCalledTimes(4);
  });
});
