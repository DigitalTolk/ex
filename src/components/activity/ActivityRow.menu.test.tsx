import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ActivityRowView } from './ActivityRow';
import { groupActivity } from '@/lib/activity-feed';
import type { ActivityItem } from '@/types';

// The real menu, so the items and their callbacks are exercised.
const base: ActivityItem = {
  id: 'a',
  type: 'mention',
  createdAt: new Date().toISOString(),
  messageID: 'm-1',
  parentID: 'ch-1',
  parentType: 'channel',
  actorID: 'u-1',
  read: false,
};

function renderRow(item: ActivityItem, handlers: Partial<Record<'onRemind' | 'onCopyLink' | 'onMuteThread' | 'onClearBefore' | 'onMenuOpenChange', ReturnType<typeof vi.fn>>> = {}) {
  render(
    <MemoryRouter>
      <ActivityRowView
        row={groupActivity([item])[0]}
        href="/channel/general#msg-m-1"
        selected={false}
        actor={undefined}
        emojiMap={undefined}
        channel={undefined}
        conversation={undefined}
        onOpen={vi.fn()}
        onSetRead={vi.fn()}
        onRemove={vi.fn()}
        {...handlers}
      />
    </MemoryRouter>,
  );
}

// The menu animates open and closed: let its updates land inside act.
async function click(testId: string) {
  await act(async () => {
    fireEvent.click(screen.getByTestId(testId));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('ActivityRowView menu', () => {
  it('offers remind, copy link and clear-before when a host provides them, and reports the menu opening', async () => {
    const onRemind = vi.fn();
    const onCopyLink = vi.fn();
    const onClearBefore = vi.fn();
    const onMuteThread = vi.fn();
    const onMenuOpenChange = vi.fn();
    renderRow(base, { onRemind, onCopyLink, onClearBefore, onMuteThread, onMenuOpenChange });
    await click('activity-row-more');
    expect(onMenuOpenChange).toHaveBeenCalledWith(true);
    // A mention is not a thread reply: no "turn off replies".
    expect(screen.queryByTestId('activity-menu-mute-thread')).toBeNull();
    await click('activity-menu-remind');
    expect(onRemind).toHaveBeenCalledWith(expect.objectContaining({ key: expect.any(String) }));
    await click('activity-row-more');
    await click('activity-menu-copy-link');
    expect(onCopyLink).toHaveBeenCalled();
    await click('activity-row-more');
    await click('activity-menu-clear-before');
    expect(onClearBefore).toHaveBeenCalled();
  });

  it('offers to turn off reply notifications on a thread reply', async () => {
    const onMuteThread = vi.fn();
    renderRow({ ...base, type: 'thread_reply', parentMessageID: 'root-1' }, { onMuteThread });
    await click('activity-row-more');
    await click('activity-menu-mute-thread');
    expect(onMuteThread).toHaveBeenCalled();
    // Without the other hosts' handlers, only the stock items remain.
    expect(screen.queryByTestId('activity-menu-remind')).toBeNull();
    expect(screen.queryByTestId('activity-menu-copy-link')).toBeNull();
    expect(screen.queryByTestId('activity-menu-clear-before')).toBeNull();
  });

  it('keeps the plain menu when a host provides nothing extra', async () => {
    renderRow(base);
    await click('activity-row-more');
    expect(screen.getByTestId('activity-menu-remove')).toBeInTheDocument();
    expect(screen.queryByTestId('activity-menu-remind')).toBeNull();
  });
});
