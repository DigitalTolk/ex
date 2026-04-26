import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Header } from '@/components/layout/Header';

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onClick, ...rest }: { children: React.ReactNode; onClick?: () => void; 'aria-label'?: string }) => (
    <button onClick={onClick} aria-label={rest['aria-label']}>{children}</button>
  ),
}));

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open: boolean }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

const baseChannel = {
  id: 'ch1',
  name: 'general',
  slug: 'general',
  type: 'public' as const,
  createdBy: 'u1',
  archived: false,
  createdAt: '2026-01-01T00:00:00Z',
};

describe('Header — mute toggle', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders Mute channel item when not muted', () => {
    render(<Header channel={baseChannel} muted={false} onToggleMute={vi.fn()} />);
    expect(screen.getByLabelText('Mute channel')).toBeInTheDocument();
    expect(screen.queryByLabelText('Unmute channel')).toBeNull();
  });

  it('renders Unmute channel item when muted', () => {
    render(<Header channel={baseChannel} muted onToggleMute={vi.fn()} />);
    expect(screen.getByLabelText('Unmute channel')).toBeInTheDocument();
    expect(screen.queryByLabelText('Mute channel')).toBeNull();
  });

  it('invokes onToggleMute on click', () => {
    const cb = vi.fn();
    render(<Header channel={baseChannel} muted={false} onToggleMute={cb} />);
    fireEvent.click(screen.getByLabelText('Mute channel'));
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('does not render mute item when onToggleMute is omitted', () => {
    render(<Header channel={baseChannel} />);
    expect(screen.queryByLabelText('Mute channel')).toBeNull();
    expect(screen.queryByLabelText('Unmute channel')).toBeNull();
  });
});
