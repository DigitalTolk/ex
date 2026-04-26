import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Header } from '@/components/layout/Header';
import type { Channel } from '@/types';

// Minimal stub for Radix DropdownMenu in jsdom
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <button data-testid="dropdown-trigger" className={className}>{children}</button>
  ),
  DropdownMenuContent: ({ children, className }: { children: React.ReactNode; className?: string }) => <div data-testid="dropdown-content" className={className}>{children}</div>,
  DropdownMenuItem: ({ children, onClick, className }: { children: React.ReactNode; onClick?: () => void; className?: string }) => (
    <button data-testid="dropdown-item" onClick={onClick} className={className}>{children}</button>
  ),
}));

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open: boolean }) => open ? <div data-testid="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

vi.mock('@/components/ui/badge', () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick, variant }: { children: React.ReactNode; onClick?: () => void; variant?: string }) => (
    <button onClick={onClick} data-variant={variant}>{children}</button>
  ),
}));

const baseChannel: Channel = {
  id: 'ch1',
  name: 'general',
  slug: 'general',
  type: 'public',
  createdBy: 'u1',
  archived: false,
  createdAt: '2024-01-01',
};

describe('Header', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders channel name in dropdown trigger', () => {
    render(<Header channel={baseChannel} />);
    expect(screen.getByText('general')).toBeInTheDocument();
    expect(screen.getByTestId('dropdown-trigger')).toBeInTheDocument();
  });

  it('renders title without dropdown when no channel', () => {
    render(<Header title="Direct Message" />);
    expect(screen.getByText('Direct Message')).toBeInTheDocument();
    expect(screen.queryByTestId('dropdown-trigger')).not.toBeInTheDocument();
  });

  it('renders subtitle for conversations', () => {
    render(<Header title="Alice" subtitle="Alice, Bob" />);
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Alice, Bob')).toBeInTheDocument();
  });

  it('shows edit description option when canEdit', () => {
    render(<Header channel={{ ...baseChannel, description: 'test' }} canEdit />);
    const items = screen.getAllByTestId('dropdown-item');
    const editItem = items.find(item => item.textContent?.includes('Edit description'));
    expect(editItem).toBeTruthy();
  });

  it('shows leave option when canLeave', () => {
    const onLeave = vi.fn();
    render(<Header channel={baseChannel} canLeave onLeave={onLeave} />);
    const items = screen.getAllByTestId('dropdown-item');
    const leaveItem = items.find(item => item.textContent?.includes('Leave channel'));
    expect(leaveItem).toBeTruthy();
    fireEvent.click(leaveItem!);
    expect(onLeave).toHaveBeenCalled();
  });

  it('shows archive option when canArchive', () => {
    render(<Header channel={baseChannel} canArchive onArchive={() => {}} />);
    const items = screen.getAllByTestId('dropdown-item');
    const archiveItem = items.find(item => item.textContent?.includes('Archive channel'));
    expect(archiveItem).toBeTruthy();
  });

  it('opens archive confirmation dialog on archive click', () => {
    const onArchive = vi.fn();
    render(<Header channel={baseChannel} canArchive onArchive={onArchive} />);
    const items = screen.getAllByTestId('dropdown-item');
    const archiveItem = items.find(item => item.textContent?.includes('Archive channel'));
    fireEvent.click(archiveItem!);
    // Dialog should now be open
    expect(screen.getByTestId('dialog')).toBeInTheDocument();
    expect(screen.getByText('Archive channel?')).toBeInTheDocument();
    // onArchive should NOT have been called yet (dialog is a confirmation)
    expect(onArchive).not.toHaveBeenCalled();
  });

  it('calls onArchive when confirming archive dialog', () => {
    const onArchive = vi.fn();
    render(<Header channel={baseChannel} canArchive onArchive={onArchive} />);
    // Open dialog
    const items = screen.getAllByTestId('dropdown-item');
    const archiveItem = items.find(item => item.textContent?.includes('Archive channel'));
    fireEvent.click(archiveItem!);
    // Click Archive button in dialog
    const archiveButton = screen.getByText('Archive');
    fireEvent.click(archiveButton);
    expect(onArchive).toHaveBeenCalledOnce();
  });

  it('hides leave/archive when not authorized', () => {
    render(<Header channel={baseChannel} />);
    const items = screen.queryAllByTestId('dropdown-item');
    expect(items).toHaveLength(0);
  });

  it('shows member count badge when memberCount provided', () => {
    render(<Header channel={baseChannel} memberCount={5} onMembersClick={() => {}} />);
    expect(screen.getByText('5')).toBeInTheDocument();
  });

  it('shows lock icon for private channels', () => {
    const privateChannel: Channel = { ...baseChannel, type: 'private' };
    render(<Header channel={privateChannel} />);
    expect(screen.getByLabelText('Private channel')).toBeInTheDocument();
  });

  it('shows hash icon for public channels', () => {
    render(<Header channel={baseChannel} />);
    expect(screen.getByLabelText('Public channel')).toBeInTheDocument();
  });

  it('renders dropdown menu content with w-56 width class', () => {
    render(<Header channel={baseChannel} canEdit />);
    const content = screen.getByTestId('dropdown-content');
    expect(content.className).toContain('w-56');
  });
});
