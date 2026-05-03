import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConversationRow } from '@/components/layout/ConversationRow';
import type { UserConversation } from '@/types';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

vi.mock('@/hooks/useEmoji', () => ({
  useEmojiMap: () => ({ data: {} }),
}));

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: (props: { children: React.ReactNode; 'data-testid'?: string; 'aria-label'?: string }) => (
    <button data-testid={props['data-testid']} aria-label={props['aria-label']}>{props.children}</button>
  ),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: (props: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    'data-testid'?: string;
  }) => (
    <button onClick={props.onClick} disabled={props.disabled} data-testid={props['data-testid']}>
      {props.children}
    </button>
  ),
}));

function renderRow(conv: UserConversation) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <ConversationRow
          conversation={conv}
          hasUnread={false}
          onClose={vi.fn()}
          onHide={vi.fn()}
        />
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

const sampleConv: UserConversation = {
  conversationID: 'c-1',
  type: 'dm',
  displayName: 'Bob',
  participantIDs: ['u-me', 'u-bob'],
};

describe('ConversationRow', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    // useCategories needs an array; everything else can be {} (default).
    apiFetchMock.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/sidebar/categories')) {
        return Promise.resolve([]);
      }
      return Promise.resolve({});
    });
  });

  it('renders the conversation displayName', () => {
    renderRow(sampleConv);
    expect(screen.getByText('Bob')).toBeInTheDocument();
  });

  it('renders DM status on the row', () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <BrowserRouter>
          <ConversationRow
            conversation={sampleConv}
            hasUnread={false}
            dmUserStatus={{ emoji: ':house:', text: 'Working from home' }}
            onClose={vi.fn()}
            onHide={vi.fn()}
          />
        </BrowserRouter>
      </QueryClientProvider>,
    );
    expect(screen.getAllByLabelText(/Working from home/).length).toBeGreaterThan(0);
  });

  it('renders the online indicator on the DM avatar', () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <BrowserRouter>
          <ConversationRow
            conversation={sampleConv}
            hasUnread={false}
            dmOnline
            onClose={vi.fn()}
            onHide={vi.fn()}
          />
        </BrowserRouter>
      </QueryClientProvider>,
    );

    expect(screen.getByLabelText('Online')).toBeInTheDocument();
  });

  it('clicking the star toggles favorite via the conversation favorite endpoint', async () => {
    renderRow(sampleConv);
    fireEvent.click(screen.getByTestId(`conv-fav-toggle-${sampleConv.conversationID}`));
    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith(
        `/api/v1/conversations/${sampleConv.conversationID}/favorite`,
        expect.objectContaining({ method: 'PUT', body: JSON.stringify({ favorite: true }) }),
      );
    });
  });

  it('clicking unfavorite on a favorited row clears the old favorite position', async () => {
    renderRow({ ...sampleConv, favorite: true, sidebarPosition: 2000 });
    fireEvent.click(screen.getByTestId(`conv-fav-toggle-${sampleConv.conversationID}`));
    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith(
        `/api/v1/conversations/${sampleConv.conversationID}/category`,
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ categoryID: '', sidebarPosition: 0 }),
        }),
      );
      expect(apiFetchMock).toHaveBeenCalledWith(
        `/api/v1/conversations/${sampleConv.conversationID}/favorite`,
        expect.objectContaining({ method: 'PUT', body: JSON.stringify({ favorite: false }) }),
      );
    });
  });

  it('"Move to Direct Messages" sends an empty categoryID', async () => {
    renderRow({ ...sampleConv, categoryID: 'cat-x' });
    fireEvent.click(screen.getByText('Move to Direct Messages'));
    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith(
        `/api/v1/conversations/${sampleConv.conversationID}/category`,
        expect.objectContaining({ method: 'PUT', body: JSON.stringify({ categoryID: '' }) }),
      );
    });
  });

  it('renders the participant-count badge for groups', () => {
    renderRow({
      ...sampleConv,
      type: 'group',
      participantIDs: ['u-1', 'u-2', 'u-3'],
    });
    expect(screen.getByLabelText('3 participants')).toBeInTheDocument();
  });

  it('exposes "Close conversation" inside the kebab menu (no standalone X)', () => {
    // The dedicated X button was removed so DM rows match channel-row
    // geometry exactly: star + kebab. Closing now lives inside the
    // kebab; the X with aria-label="Close conversation" must be gone.
    renderRow(sampleConv);
    expect(screen.queryByLabelText('Close conversation')).not.toBeInTheDocument();
    expect(screen.getByTestId(`conv-close-${sampleConv.conversationID}`)).toBeInTheDocument();
  });

  it('"Close conversation" menu item calls onHide with the conversation ID', () => {
    const onHide = vi.fn();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <BrowserRouter>
          <ConversationRow
            conversation={sampleConv}
            hasUnread={false}
            onClose={vi.fn()}
            onHide={onHide}
          />
        </BrowserRouter>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByTestId(`conv-close-${sampleConv.conversationID}`));
    expect(onHide).toHaveBeenCalledWith(sampleConv.conversationID);
  });

  it('disables "Move to Direct Messages" when the row is already in the default section', () => {
    renderRow(sampleConv);
    const item = screen.getByText('Move to Direct Messages') as HTMLButtonElement;
    expect(item.disabled).toBe(true);
  });

  it('does not offer a "New category" option in the row menu', () => {
    // Creating categories lives in the sidebar header; the per-row menu
    // only moves between existing buckets.
    renderRow(sampleConv);
    expect(screen.queryByText(/New category/)).not.toBeInTheDocument();
  });

  it('truncates long DM names with `truncate` and reserves room for the kebab', () => {
    const longConv: UserConversation = {
      ...sampleConv,
      displayName: 'Bartholomew Christopherson III von Habsburg',
    };
    renderRow(longConv);
    // Full text is in the DOM (not clipped server-side); CSS truncate
    // adds the ellipsis at render time.
    const span = screen.getByText(longConv.displayName);
    expect(span.className).toContain('truncate');
    // The link reserves space for the absolute-positioned star + kebab
    // so the text never runs underneath them.
    const link = span.closest('a');
    expect(link?.className).toContain('pr-12');
    expect(link?.className).toContain('min-w-0');
  });

  it('groups collapse a comma-joined list to first names; custom group names stay intact', () => {
    const groupConv: UserConversation = {
      conversationID: 'g-1',
      type: 'group',
      displayName: 'Alice Smith, Bob Jones, Charlie Brown',
      participantIDs: ['u-me', 'a', 'b', 'c'],
    };
    renderRow(groupConv);
    expect(screen.getByText('Alice, Bob, Charlie')).toBeInTheDocument();
  });
});
