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

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: (props: { children: React.ReactNode; 'data-testid'?: string; 'aria-label'?: string }) => (
    <button data-testid={props['data-testid']} aria-label={props['aria-label']}>{props.children}</button>
  ),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: (props: { children: React.ReactNode; onClick?: () => void; disabled?: boolean }) => (
    <button onClick={props.onClick} disabled={props.disabled}>{props.children}</button>
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

  it('clicking unfavorite on a favorited row sends favorite=false', async () => {
    renderRow({ ...sampleConv, favorite: true });
    fireEvent.click(screen.getByTestId(`conv-fav-toggle-${sampleConv.conversationID}`));
    await waitFor(() => {
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
});
