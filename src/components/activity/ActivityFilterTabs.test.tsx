import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ActivityFilterTabs } from './ActivityFilterTabs';
import { ACTIVITY_TABS, type ActivityTab } from '@/lib/activity-feed';

describe('ActivityFilterTabs unread dots', () => {
  it('dots every unread tab except Reactions, which only ever flash on the bell', () => {
    const unread = Object.fromEntries(ACTIVITY_TABS.map((t) => [t.id, 1])) as Record<ActivityTab, number>;
    render(<ActivityFilterTabs filter="all" unread={unread} />);
    for (const t of ACTIVITY_TABS) {
      const dot = screen.queryByTestId(`activity-filter-${t.id}-dot`);
      if (t.id === 'all' || t.id === 'reaction') expect(dot).toBeNull();
      else expect(dot).not.toBeNull();
    }
    expect(screen.getByTestId('activity-filter-reaction')).toHaveAttribute('aria-label', 'Reactions');
  });
});
