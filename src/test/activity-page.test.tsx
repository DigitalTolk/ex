import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import ActivityPage from '@/pages/ActivityPage';
import { OPEN_CHANNELS_EVENT } from '@/lib/mobile-nav';
import { resetSidebarModeSessionState, useSidebarModeStore } from '@/stores/sidebar-mode';

const tier = vi.hoisted(() => ({ value: 'full' as 'full' | 'compact' | 'mobile' }));
vi.mock('@/hooks/useLayoutTier', () => ({ useLayoutTier: () => tier.value }));

function Home() {
  const loc = useLocation();
  return <div data-testid="home">{loc.pathname + loc.search}</div>;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/activity" element={<ActivityPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

// /activity is a way in, not a second Activity screen: the list lives in the
// sidebar, so the route points the sidebar at it and goes home — no copy-only
// "pick one" pane, and no extra copy of the list on a phone.
describe('ActivityPage', () => {
  const opened = vi.fn();
  beforeEach(() => {
    resetSidebarModeSessionState();
    opened.mockClear();
    window.addEventListener(OPEN_CHANNELS_EVENT, opened);
    return () => window.removeEventListener(OPEN_CHANNELS_EVENT, opened);
  });

  it('switches the sidebar to Activity and goes home (wide window)', () => {
    tier.value = 'full';
    renderAt('/activity');
    expect(screen.getByTestId('home')).toHaveTextContent(/^\/$/);
    expect(useSidebarModeStore.getState().mode).toBe('activity');
    expect(useSidebarModeStore.getState().filter).toBe('all');
    expect(opened).not.toHaveBeenCalled();
  });

  it('opens on the tab the link names', () => {
    tier.value = 'mobile';
    renderAt('/activity?tab=mention');
    expect(useSidebarModeStore.getState().filter).toBe('mention');
    expect(screen.getByTestId('home')).toBeInTheDocument();
    // On a phone home is the list screen; nothing else to open.
    expect(opened).not.toHaveBeenCalled();
  });

  it('opens the sidebar overlay on a compact window, where the list is hidden', () => {
    tier.value = 'compact';
    renderAt('/activity?tab=bogus');
    expect(useSidebarModeStore.getState().mode).toBe('activity');
    expect(useSidebarModeStore.getState().filter).toBe('all');
    expect(opened).toHaveBeenCalledTimes(1);
  });
});
