import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import BotsPage from './BotsPage';

vi.mock('@/components/admin/BotsPanel', () => ({
  BotsPanel: () => <div data-testid="bots-panel" />,
}));
vi.mock('@/hooks/useDocumentTitle', () => ({ useDocumentTitle: vi.fn() }));

const useAuthMock = vi.hoisted(() => vi.fn());
vi.mock('@/context/AuthContext', () => ({ useAuth: useAuthMock }));

vi.mock('@/components/layout/PageContainer', () => ({
  PageContainer: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div>
      <h1>{title}</h1>
      {children}
    </div>
  ),
}));

describe('BotsPage', () => {
  it('renders the panel for an admin', () => {
    useAuthMock.mockReturnValue({ user: { systemRole: 'admin' } });
    render(<BotsPage />);
    expect(screen.getByTestId('bots-panel')).toBeInTheDocument();
    expect(screen.getByText('Bots')).toBeInTheDocument();
  });

  it('refuses a non-admin', () => {
    // Bot accounts hold API credentials, so the page is admin-only.
    useAuthMock.mockReturnValue({ user: { systemRole: 'member' } });
    render(<BotsPage />);
    expect(screen.getByText('Admin access required.')).toBeInTheDocument();
    expect(screen.queryByTestId('bots-panel')).toBeNull();
  });

  it('refuses a signed-out visitor', () => {
    useAuthMock.mockReturnValue({ user: undefined });
    render(<BotsPage />);
    expect(screen.getByText('Admin access required.')).toBeInTheDocument();
  });
});
