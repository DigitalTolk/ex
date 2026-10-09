import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { MobileTabBar } from './MobileTabBar';
import { resetSidebarModeSessionState, useSidebarModeStore } from '@/stores/sidebar-mode';

const unread = vi.hoisted(() => ({ value: 0 }));
vi.mock('@/hooks/useActivity', () => ({ useActivityUnread: () => unread.value }));
vi.mock('./AccountMenu', () => ({ AccountMenu: () => <button type="button" data-testid="mobile-tab-you">You</button> }));
vi.mock('./MobileSearchSheet', () => ({
  MobileSearchSheet: ({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) =>
    open ? (
      <div data-testid="mobile-search-sheet">
        <button type="button" onClick={() => onOpenChange(false)}>close sheet</button>
      </div>
    ) : null,
}));

function renderBar(props: { onShowList?: () => void; hidden?: boolean } = {}) {
  return render(
    <MemoryRouter>
      <MobileTabBar {...props} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  resetSidebarModeSessionState();
  unread.value = 0;
});

describe('MobileTabBar', () => {
  it('switches the list between Home and Activity and brings it into view', () => {
    const onShowList = vi.fn();
    renderBar({ onShowList });
    expect(screen.getByTestId('mobile-tab-home')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByTestId('mobile-tab-activity'));
    expect(useSidebarModeStore.getState().mode).toBe('activity');
    expect(screen.getByTestId('mobile-tab-activity')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('mobile-tab-home')).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByTestId('mobile-tab-home'));
    expect(useSidebarModeStore.getState().mode).toBe('home');
    expect(onShowList).toHaveBeenCalledTimes(2);
  });

  // On the list screen there's nothing to bring into view: asking anyway armed
  // a Back-to-close for a drawer that can't close (a dead Back press, then a
  // stale history entry).
  it('only switches the list when it already shows', () => {
    renderBar();
    fireEvent.click(screen.getByTestId('mobile-tab-activity'));
    expect(useSidebarModeStore.getState().mode).toBe('activity');
  });

  it('shows the unread count on Activity, capped at 99+', () => {
    unread.value = 4;
    const { unmount } = renderBar();
    expect(screen.getByTestId('mobile-tab-unread')).toHaveTextContent('4');
    expect(screen.getByTestId('mobile-tab-activity')).toHaveAccessibleName('Activity, 4 unread');
    unmount();
    unread.value = 150;
    renderBar();
    expect(screen.getByTestId('mobile-tab-unread')).toHaveTextContent('99+');
  });

  it('has no badge with nothing unread', () => {
    renderBar();
    expect(screen.queryByTestId('mobile-tab-unread')).not.toBeInTheDocument();
  });

  it('opens and closes the search sheet from the Search tab', () => {
    renderBar();
    const tab = screen.getByTestId('mobile-tab-search');
    expect(screen.queryByTestId('mobile-search-sheet')).not.toBeInTheDocument();
    expect(tab).toHaveAttribute('aria-expanded', 'false');
    expect(tab).toHaveAttribute('aria-haspopup', 'dialog');
    fireEvent.click(tab);
    expect(screen.getByTestId('mobile-search-sheet')).toBeInTheDocument();
    expect(tab).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByText('close sheet'));
    expect(screen.queryByTestId('mobile-search-sheet')).not.toBeInTheDocument();
    expect(tab).toHaveAttribute('aria-expanded', 'false');
  });

  it('hides (but stays mounted) while the keyboard is up', () => {
    renderBar({ hidden: true });
    expect(screen.getByTestId('mobile-tab-bar')).toHaveClass('hidden');
    expect(screen.getByTestId('mobile-tab-you')).toBeInTheDocument();
  });
});
