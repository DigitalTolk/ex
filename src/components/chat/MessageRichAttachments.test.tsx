import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageRichAttachments, type AttachmentActionTarget } from './MessageRichAttachments';
import { apiFetch } from '@/lib/api';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));

// Interactive actions go through react-query, so those cases need a provider.
function renderWithClient(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

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

    expect(screen.getAllByTestId('message-rich-attachment')).toHaveLength(2);
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
});

describe('MessageRichAttachments interactive actions', () => {
  const target: AttachmentActionTarget = {
    parentType: 'channel',
    parentID: 'ch1',
    messageID: 'm1',
  };
  const buttonAttachment = [
    {
      text: 'PR #12',
      actions: [
        { id: 'act1', name: 'Approve', type: 'button' as const, style: 'primary' },
        { id: 'act2', name: 'Reject', type: 'button' as const, style: 'danger' },
      ],
    },
  ];

  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it('invokes the action by id and shows the ephemeral reply', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ ephemeral_text: 'Approved — thanks!' });
    renderWithClient(<MessageRichAttachments attachments={buttonAttachment} actionTarget={target} />);

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Approved — thanks!'));
    // The client names only the action id — never a callback URL or context, which
    // stay server-side.
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/v1/channels/ch1/messages/m1/actions/act1',
      { method: 'POST', body: JSON.stringify({ selected_option: '' }) },
    );
  });

  it('sends the chosen option for a select action', async () => {
    vi.mocked(apiFetch).mockResolvedValue({});
    renderWithClient(
      <MessageRichAttachments
        actionTarget={target}
        attachments={[
          {
            text: 'Pick one',
            actions: [
              {
                id: 'sel1',
                name: 'Environment',
                type: 'select' as const,
                options: [
                  { text: 'Staging', value: 'staging' },
                  { text: 'Production', value: 'prod' },
                ],
              },
            ],
          },
        ]}
      />,
    );

    fireEvent.change(screen.getByLabelText('Environment'), { target: { value: 'prod' } });

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/api/v1/channels/ch1/messages/m1/actions/sel1', {
        method: 'POST',
        body: JSON.stringify({ selected_option: 'prod' }),
      }),
    );
  });

  it('surfaces an integration failure without posting anything', async () => {
    vi.mocked(apiFetch).mockRejectedValue(new Error("That action's integration didn't respond."));
    renderWithClient(<MessageRichAttachments attachments={buttonAttachment} actionTarget={target} />);

    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent("That action's integration didn't respond."),
    );
  });

  it('renders actions disabled with no target, and honours the disabled flag', () => {
    // No target (a preview or search result): the buttons still render so the
    // message reads as intended, but cannot be used.
    const { unmount } = renderWithClient(<MessageRichAttachments attachments={buttonAttachment} />);
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
    unmount();

    renderWithClient(
      <MessageRichAttachments
        actionTarget={target}
        attachments={[{ actions: [{ id: 'a', name: 'Gone', type: 'button' as const, disabled: true }] }]}
      />,
    );
    expect(screen.getByRole('button', { name: 'Gone' })).toBeDisabled();
  });
});
