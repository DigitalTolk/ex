import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { useMessageParent } from './useMessageParent';

let mockChannels: Array<{ channelID: string; channelName: string }> = [];
let mockConversations: Array<{ conversationID: string; displayName: string }> = [];

vi.mock('@/hooks/useChannels', () => ({
  useUserChannels: () => ({ data: mockChannels }),
}));
vi.mock('@/hooks/useConversations', () => ({
  useUserConversations: () => ({ data: mockConversations }),
}));

function Probe({ parentId }: { parentId: string }) {
  const parent = useMessageParent(parentId, 'msg-1', 'root-1');
  return (
    <div
      data-testid="parent"
      data-label={parent?.label ?? ''}
      data-href={parent?.href ?? ''}
      data-resolved={parent ? 'yes' : 'no'}
    />
  );
}

function read() {
  const el = document.querySelector('[data-testid="parent"]') as HTMLElement;
  return { label: el.getAttribute('data-label'), href: el.getAttribute('data-href'), resolved: el.getAttribute('data-resolved') };
}

describe('useMessageParent (browser)', () => {
  beforeEach(() => {
    mockChannels = [];
    mockConversations = [];
  });

  it('resolves a channel parent to a ~prefixed label and channel href', async () => {
    mockChannels = [{ channelID: 'ch-1', channelName: 'general' }];
    await render(<Probe parentId="ch-1" />);
    const r = read();
    expect(r.label).toBe('~general');
    expect(r.href).toContain('general');
  });

  it('resolves a conversation parent to its display name', async () => {
    mockConversations = [{ conversationID: 'conv-1', displayName: 'Bob Jones' }];
    await render(<Probe parentId="conv-1" />);
    expect(read().label).toBe('Bob Jones');
  });

  it('falls back to "Direct message" when the conversation has no display name', async () => {
    mockConversations = [{ conversationID: 'conv-2', displayName: '' }];
    await render(<Probe parentId="conv-2" />);
    expect(read().label).toBe('Direct message');
  });

  it('returns undefined when the parent is no longer accessible', async () => {
    await render(<Probe parentId="gone" />);
    expect(read().resolved).toBe('no');
  });

  it('tolerates undefined hook data via the empty-array defaults', async () => {
    mockChannels = undefined as unknown as typeof mockChannels;
    mockConversations = undefined as unknown as typeof mockConversations;
    await render(<Probe parentId="anything" />);
    expect(read().resolved).toBe('no');
  });
});
