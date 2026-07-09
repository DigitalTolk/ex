import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Header } from '@/components/layout/Header';
import type { Channel } from '@/types';

const channel: Channel = {
  id: 'ch-1',
  name: 'general',
  slug: 'general',
  type: 'public',
};

describe('Header pinned toggle', () => {
  it('renders a pin button when onPinnedClick is wired', () => {
    render(<Header channel={channel} onPinnedClick={vi.fn()} />);
    expect(screen.getByTestId('pinned-toggle')).toBeInTheDocument();
  });

  it('does not render the pin button when onPinnedClick is omitted', () => {
    render(<Header channel={channel} />);
    expect(screen.queryByTestId('pinned-toggle')).toBeNull();
  });

  it('invokes onPinnedClick when activated', () => {
    const onPinnedClick = vi.fn();
    render(<Header channel={channel} onPinnedClick={onPinnedClick} />);
    fireEvent.click(screen.getByTestId('pinned-toggle'));
    expect(onPinnedClick).toHaveBeenCalledTimes(1);
  });

  it('reflects pinnedActive via aria-pressed', () => {
    const { rerender } = render(
      <Header channel={channel} onPinnedClick={vi.fn()} pinnedActive={false} />,
    );
    expect(screen.getByTestId('pinned-toggle').getAttribute('aria-pressed')).toBe('false');

    rerender(<Header channel={channel} onPinnedClick={vi.fn()} pinnedActive={true} />);
    expect(screen.getByTestId('pinned-toggle').getAttribute('aria-pressed')).toBe('true');
  });
});
