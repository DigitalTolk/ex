import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { ActivityRowView } from './ActivityRow';
import { groupActivity } from '@/lib/activity-feed';
import type { ActivityItem } from '@/types';

// A long press on touch opens the row's menu; the click that ends it must not
// also open the message. (A real touch hold can't be driven here; the hook's
// own tests cover detecting one.)
const longPress = vi.hoisted(() => ({ suppress: false }));
vi.mock('@/hooks/useRowLongPressMenu', () => ({
  useRowLongPressMenu: () => ({
    menuOpen: false,
    setMenuOpen: vi.fn(),
    rowHandlers: {},
    suppressNavClick: () => longPress.suppress,
  }),
}));
vi.mock('@/components/ui/dropdown-menu');

function Where() {
  return <span data-testid="where">{useLocation().pathname}</span>;
}

const item: ActivityItem = {
  id: 'a',
  type: 'mention',
  createdAt: new Date().toISOString(),
  messageID: 'm-1',
  parentID: 'ch-1',
  parentType: 'channel',
  actorID: 'u-1',
  read: false,
};

function renderRow(onOpen = vi.fn()) {
  render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <ActivityRowView
                row={groupActivity([item])[0]}
                href="/channel/general#msg-m-1"
                selected={false}
                actor={undefined}
                emojiMap={undefined}
                channel={undefined}
                conversation={undefined}
                onOpen={onOpen}
                onSetRead={vi.fn()}
                onRemove={vi.fn()}
              />
              <Where />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
  return onOpen;
}

describe('ActivityRowView', () => {
  it('opens the message on a tap', () => {
    longPress.suppress = false;
    const onOpen = renderRow();
    fireEvent.click(screen.getByTestId('activity-row-open'));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('where')).toHaveTextContent('/channel/general');
  });

  it('does not open the message for the click that ends a long press', () => {
    longPress.suppress = true;
    const onOpen = renderRow();
    fireEvent.click(screen.getByTestId('activity-row-open'));
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/$/);
  });
});
