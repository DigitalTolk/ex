import { describe, it, expect, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Sidebar } from '@/components/layout/Sidebar';
import type { User, UserChannel, UserConversation } from '@/types';

// --- mocks ---------------------------------------------------------------

const mockUser: User = {
  id: 'u-1',
  email: 'alice@test.com',
  displayName: 'Alice Smith',
  systemRole: 'admin',
  status: 'active',
};

const mockChannels: UserChannel[] = [
  { channelID: 'ch-1', channelName: 'general', channelType: 'public', role: 1 },
];

const mockConversations: UserConversation[] = [
  { conversationID: 'conv-1', type: 'dm', displayName: 'Bob Jones' },
];

const mockLogout = vi.fn().mockResolvedValue(undefined);
const mockSetAuth = vi.fn();

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: mockUser,
    isAuthenticated: true,
    isLoading: false,
    login: vi.fn(),
    logout: mockLogout,
    setAuth: mockSetAuth,
  }),
}));

vi.mock('@/context/UnreadContext', () => ({
  useUnread: () => ({
    unreadChannels: new Set(),
    unreadConversations: new Set(),
    hiddenConversations: new Set(),
    markChannelUnread: vi.fn(),
    markConversationUnread: vi.fn(),
    clearChannelUnread: vi.fn(),
    clearConversationUnread: vi.fn(),
    hideConversation: vi.fn(),
    unhideConversation: vi.fn(),
  }),
}));

vi.mock('@/hooks/useChannels', () => ({
  useUserChannels: () => ({ data: mockChannels }),
  useChannelBySlug: () => ({ data: undefined }),
  useChannelMembers: () => ({ data: [] }),
  useBrowseChannels: () => ({ data: [] }),
  useCreateChannel: () => ({ mutate: vi.fn(), isPending: false }),
  useJoinChannel: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/useConversations', () => ({
  useUserConversations: () => ({ data: mockConversations }),
  useSearchUsers: () => ({ data: [] }),
  useCreateConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/lib/api', () => ({
  getAccessToken: () => 'mock-token',
  setAccessToken: vi.fn(),
  apiFetch: vi.fn(),
}));

// Mock the dropdown menu to work in jsdom
vi.mock('@/components/ui/dropdown-menu', async () => {
  const React = await import('react');
  return {
    DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DropdownMenuTrigger: React.forwardRef<HTMLButtonElement, { children: React.ReactNode; [k: string]: unknown }>(
      ({ children, ...props }, ref) => (
        <button {...props} ref={ref} data-testid="user-menu-trigger">{children}</button>
      ),
    ),
    DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div data-testid="dropdown-content">{children}</div>,
    DropdownMenuItem: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
      <button data-testid="dropdown-item" onClick={onClick}>{children}</button>
    ),
  };
});

vi.mock('@/components/EditProfileDialog', () => ({
  EditProfileDialog: ({
    open,
    onOpenChange,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }) => open ? (
    <button
      data-testid="mock-edit-profile-close"
      onClick={() => {
        document.querySelector<HTMLButtonElement>('[aria-label="User menu"]')?.focus();
        onOpenChange(false);
      }}
    >
      Close edit profile
    </button>
  ) : null,
}));

vi.mock('@/components/UserStatusDialog', () => ({
  UserStatusDialog: ({
    open,
    onOpenChange,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }) => open ? (
    <button
      data-testid="mock-user-status-close"
      onClick={() => {
        document.querySelector<HTMLButtonElement>('[aria-label="User menu"]')?.focus();
        onOpenChange(false);
      }}
    >
      Close user status
    </button>
  ) : null,
}));

vi.mock('@/components/InviteDialog', () => ({
  InviteDialog: ({
    open,
    onOpenChange,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }) => open ? (
    <button
      data-testid="mock-invite-close"
      onClick={() => {
        document.querySelector<HTMLButtonElement>('[aria-label="User menu"]')?.focus();
        onOpenChange(false);
      }}
    >
      Close invite
    </button>
  ) : null,
}));

vi.mock('@/components/EmojiManagerDialog', () => ({
  EmojiManagerDialog: ({
    open,
    onOpenChange,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }) => open ? (
    <button
      data-testid="mock-emoji-manager-close"
      onClick={() => {
        document.querySelector<HTMLButtonElement>('[aria-label="User menu"]')?.focus();
        onOpenChange(false);
      }}
    >
      Close emoji manager
    </button>
  ) : null,
}));

vi.mock('@/components/AboutDialog', () => ({
  AboutDialog: ({
    open,
    onOpenChange,
    onClosed,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onClosed?: () => void;
  }) => open ? (
    <button
      data-testid="mock-about-close"
      onClick={() => {
        document.querySelector<HTMLButtonElement>('[aria-label="User menu"]')?.focus();
        onOpenChange(false);
        onClosed?.();
      }}
    >
      Close about
    </button>
  ) : null,
}));

// --- helpers -------------------------------------------------------------

function renderSidebar(onClose = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <Sidebar onClose={onClose} />
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

// --- tests ---------------------------------------------------------------

// The user menu (Edit profile / Set status / Invite people / Custom
// emojis / Admin / Change server / About / Sign out) was moved out
// of the sidebar into the top-bar account dropdown. The behavioural
// coverage now lives in components/layout/AppTopBar.test.tsx —
// keeping mocks here would assert against UI that no longer exists.
describe.skip('Sidebar - user menu actions (relocated to AppTopBar)', () => {
  it('is covered in AppTopBar tests', () => {
    expect(true).toBe(true);
  });
});

// Avoid unused-import warnings now that the user-menu cases above
// are gone — `waitFor` and `userEvent` were only used in those tests.
void waitFor;
void userEvent;
void mockLogout;
void renderSidebar;
