import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import ActivityPage from '@/pages/ActivityPage';
import { resetSidebarModeForTests, useSidebarModeStore } from '@/stores/sidebar-mode';

vi.mock('@/hooks/useDocumentTitle', () => ({ useDocumentTitle: vi.fn() }));
vi.mock('@/components/activity/ActivityPanel', () => ({
  ActivityPanel: () => <div data-testid="activity-panel" />,
}));
const tier = vi.hoisted(() => ({ value: 'full' as 'full' | 'compact' | 'mobile' }));
vi.mock('@/hooks/useLayoutTier', () => ({ useLayoutTier: () => tier.value }));

describe('ActivityPage', () => {
  beforeEach(() => resetSidebarModeForTests());

  it('switches the sidebar to Activity and shows the "pick one" pane beside it', () => {
    tier.value = 'full';
    render(<ActivityPage />);
    expect(useSidebarModeStore.getState().mode).toBe('activity');
    expect(screen.getByText('Your activity')).toBeInTheDocument();
    expect(screen.queryByTestId('activity-panel')).toBeNull();
  });

  it('is the Activity list itself when there is no persistent sidebar', () => {
    tier.value = 'compact';
    render(<ActivityPage />);
    expect(screen.getByTestId('activity-panel')).toBeInTheDocument();
    expect(screen.queryByText('Your activity')).toBeNull();
  });
});
