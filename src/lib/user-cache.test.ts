import { describe, it, expect, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { applyUserUpdatedEvent } from './user-cache';
import { queryKeys } from './query-keys';
import type { ChannelMembership } from '@/types';

const member = (userID: string): ChannelMembership => ({
  channelID: 'ch-1',
  userID,
  role: 'member',
  displayName: userID,
  joinedAt: '2026-01-01T00:00:00Z',
});

describe('applyUserUpdatedEvent: account status', () => {
  it('takes a deactivated account out of every member list at once', () => {
    const qc = new QueryClient();
    const other = [member('u-3')];
    qc.setQueryData(queryKeys.channelMembers('ch-1'), [member('u-2'), member('u-gone')]);
    qc.setQueryData(queryKeys.channelMembers('ch-2'), other);

    applyUserUpdatedEvent(qc, { id: 'u-gone', status: 'deactivated' }, 'u-me');

    expect(qc.getQueryData<ChannelMembership[]>(queryKeys.channelMembers('ch-1'))?.map((m) => m.userID)).toEqual(['u-2']);
    // A list without them is left as it was.
    expect(qc.getQueryData(queryKeys.channelMembers('ch-2'))).toBe(other);
  });

  it('re-reads the member lists when an account is reactivated', () => {
    const qc = new QueryClient();
    qc.setQueryData(queryKeys.channelMembers('ch-1'), [member('u-2')]);
    const invalidate = vi.spyOn(qc, 'invalidateQueries');

    applyUserUpdatedEvent(qc, { id: 'u-back', status: 'active' }, 'u-me');

    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.channelMembers() });
  });

  it('leaves the member lists alone when the status is unchanged', () => {
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    applyUserUpdatedEvent(qc, { id: 'u-2', timeZone: 'Asia/Karachi' }, 'u-me');
    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe('applyUserUpdatedEvent: directory sync', () => {
  it('patches a renamed user\'s name, department, squad and title into every cached copy', () => {
    const qc = new QueryClient();
    qc.setQueryData(queryKeys.user('u-2'), { id: 'u-2', displayName: 'Old', department: 'Sales', squad: 'EMEA', jobTitle: 'Rep' });

    applyUserUpdatedEvent(qc, { id: 'u-2', displayName: 'New', department: 'Engineering', squad: 'Platform', jobTitle: '' }, 'u-me');

    expect(qc.getQueryData(queryKeys.user('u-2'))).toEqual({
      id: 'u-2',
      displayName: 'New',
      department: 'Engineering',
      squad: 'Platform',
      // "" is the directory clearing it.
      jobTitle: '',
    });
  });
});
