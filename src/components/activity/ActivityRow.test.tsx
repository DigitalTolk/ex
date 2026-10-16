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

// Each kind names itself and leads with where it happened, and its message is
// shaped by kind, so mentions, thread replies and DMs read apart at a glance.
describe('ActivityRowView kinds', () => {
  function renderKind(overrides: Partial<ActivityItem>, extra: { conversation?: { name: string; group: boolean } } = {}) {
    const row = groupActivity([{ ...item, messagePreview: 'hello there', ...overrides }])[0];
    return render(
      <MemoryRouter>
        <ActivityRowView
          row={row}
          href="/x"
          selected={false}
          actor={undefined}
          emojiMap={undefined}
          channel={{ name: 'general', private: false }}
          conversation={extra.conversation}
          onOpen={vi.fn()}
          onSetRead={vi.fn()}
          onRemove={vi.fn()}
        />
      </MemoryRouter>,
    );
  }

  it('a mention is labelled, placed in its channel, and quoted', () => {
    const { unmount } = renderKind({ type: 'mention' });
    expect(screen.getByTestId('activity-row-kind')).toHaveTextContent('Mention');
    expect(screen.getByTestId('activity-row-where')).toHaveTextContent('general');
    const preview = screen.getByTestId('activity-row-preview');
    expect(preview).toHaveClass('border-l-2');
    expect(preview.querySelector('svg')).toBeNull();
    unmount();
  });

  it('a thread reply hangs off a reply arrow, unquoted', () => {
    renderKind({ type: 'thread_reply' });
    expect(screen.getByTestId('activity-row-kind')).toHaveTextContent('Thread reply');
    const preview = screen.getByTestId('activity-row-preview');
    expect(preview).not.toHaveClass('border-l-2');
    expect(preview.querySelector('svg')).not.toBeNull();
  });

  it('a DM names itself once (no repeated "Direct message" place); a group names the group', () => {
    const { unmount } = renderKind({ type: 'dm', parentType: 'conversation', parentID: 'c-1' });
    expect(screen.getByTestId('activity-row-kind')).toHaveTextContent('Direct message');
    expect(screen.getByTestId('activity-row-where')).toBeEmptyDOMElement();
    unmount();
    renderKind({ type: 'mention', parentType: 'conversation', parentID: 'c-2' }, { conversation: { name: 'Team trip', group: true } });
    expect(screen.getByTestId('activity-row-where')).toHaveTextContent('Team trip');
  });

  it('a mention in a 1:1 DM says so; reactions and unknown kinds still get a label', () => {
    const { unmount } = renderKind({ type: 'mention', parentType: 'conversation', parentID: 'c-1' });
    expect(screen.getByTestId('activity-row-where')).toHaveTextContent('Direct message');
    unmount();
    const r = renderKind({ type: 'reaction', emoji: '👍' });
    expect(screen.getByTestId('activity-row-kind')).toHaveTextContent('Reaction');
    r.unmount();
    renderKind({ type: 'something_new' as ActivityItem['type'] });
    expect(screen.getByTestId('activity-row-kind')).toHaveTextContent('Activity');
  });
});
