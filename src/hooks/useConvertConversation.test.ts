import { describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { followConvertedConversation } from './useConvertConversation';
import { queryKeys } from '@/lib/query-keys';

// Someone else made a group message a private channel.
describe('followConvertedConversation', () => {
  function client() {
    const qc = new QueryClient();
    qc.setQueryData(queryKeys.userConversations(), [{ conversationID: 'g-1' }, { conversationID: 'dm-1' }]);
    return qc;
  }

  it('takes the group off the list and moves whoever has it open to the channel', () => {
    const qc = client();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const navigate = vi.fn();
    followConvertedConversation(qc, { conversationID: 'g-1', slug: 'ops' }, navigate, {
      pathname: '/conversation/g-1',
      search: '?thread=r-1',
      hash: '#msg-m-1',
    });
    expect(qc.getQueryData(queryKeys.userConversations())).toEqual([{ conversationID: 'dm-1' }]);
    const keys = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
    expect(keys).toEqual([queryKeys.userConversations(), queryKeys.userChannels(), queryKeys.userThreads()]);
    expect(navigate).toHaveBeenCalledWith('/channel/ops?thread=r-1#msg-m-1', { replace: true });
  });

  it('leaves anyone elsewhere where they are', () => {
    const navigate = vi.fn();
    followConvertedConversation(client(), { conversationID: 'g-1', slug: 'ops' }, navigate);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('is fine with no list loaded', () => {
    const qc = new QueryClient();
    followConvertedConversation(qc, { conversationID: 'g-1', slug: 'ops' }, vi.fn(), { pathname: '/', search: '', hash: '' });
    expect(qc.getQueryData(queryKeys.userConversations())).toBeUndefined();
  });
});
