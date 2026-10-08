import { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { MobileTabBar } from './MobileTabBar';
import { resetSidebarModeForTests, useSidebarModeStore } from '@/stores/sidebar-mode';

const unread = vi.hoisted(() => ({ value: 0 as number | undefined }));
vi.mock('@/hooks/useActivity', () => ({
  useActivity: () => ({ data: unread.value === undefined ? undefined : { unread: unread.value } }),
}));
vi.mock('./AccountMenu', () => ({ AccountMenu: () => <button type="button" data-testid="mobile-tab-you">You</button> }));
vi.mock('./MobileSearchSheet', () => ({
  MobileSearchSheet: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="mobile-search-sheet">
      <button type="button" onClick={onClose}>close sheet</button>
    </div>
  ),
}));

let path = '/';
function Where() {
  const loc = useLocation();
  useEffect(() => {
    path = loc.pathname;
  }, [loc.pathname]);
  return null;
}

function renderBar(at = '/', hidden = false) {
  const onShowList = vi.fn();
  render(
    <MemoryRouter initialEntries={[at]}>
      <MobileTabBar onShowList={onShowList} hidden={hidden} />
      <Where />
    </MemoryRouter>,
  );
  return onShowList;
}

beforeEach(() => {
  resetSidebarModeForTests();
  unread.value = 0;
  path = '/';
});

describe('MobileTabBar', () => {
  it('switches the list between Home and Activity and brings it into view', () => {
    const onShowList = renderBar('/channel/general');
    expect(screen.getByTestId('mobile-tab-home')).toHaveAttribute('aria-current', 'page');
    fireEvent.click(screen.getByTestId('mobile-tab-activity'));
    expect(useSidebarModeStore.getState().mode).toBe('activity');
    expect(screen.getByTestId('mobile-tab-activity')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('mobile-tab-home')).not.toHaveAttribute('aria-current');
    fireEvent.click(screen.getByTestId('mobile-tab-home'));
    expect(useSidebarModeStore.getState().mode).toBe('home');
    expect(onShowList).toHaveBeenCalledTimes(2);
    expect(path).toBe('/channel/general');
  });

  it('goes home from the Activity page instead of opening the list', () => {
    const onShowList = renderBar('/activity');
    fireEvent.click(screen.getByTestId('mobile-tab-home'));
    expect(path).toBe('/');
    expect(onShowList).not.toHaveBeenCalled();
  });

  it('shows the unread count on Activity, capped at 99+', () => {
    unread.value = 4;
    const { unmount } = render(
      <MemoryRouter>
        <MobileTabBar onShowList={vi.fn()} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('mobile-tab-unread')).toHaveTextContent('4');
    expect(screen.getByTestId('mobile-tab-activity')).toHaveAccessibleName('Activity, 4 unread');
    unmount();
    unread.value = 150;
    renderBar();
    expect(screen.getByTestId('mobile-tab-unread')).toHaveTextContent('99+');
  });

  it('has no badge before the feed loads', () => {
    unread.value = undefined;
    renderBar();
    expect(screen.queryByTestId('mobile-tab-unread')).not.toBeInTheDocument();
  });

  it('opens and closes the search sheet from the Search tab', () => {
    renderBar();
    expect(screen.queryByTestId('mobile-search-sheet')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('mobile-tab-search'));
    expect(screen.getByTestId('mobile-search-sheet')).toBeInTheDocument();
    expect(screen.getByTestId('mobile-tab-search')).toHaveAttribute('aria-current', 'page');
    fireEvent.click(screen.getByText('close sheet'));
    expect(screen.queryByTestId('mobile-search-sheet')).not.toBeInTheDocument();
  });

  it('hides (but stays mounted) while the keyboard is up', () => {
    renderBar('/', true);
    expect(screen.getByTestId('mobile-tab-bar')).toHaveClass('hidden');
    expect(screen.getByTestId('mobile-tab-you')).toBeInTheDocument();
  });
});
