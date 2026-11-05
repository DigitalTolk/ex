import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';

const mockApiFetch = vi.fn();
vi.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => mockApiFetch(...args) }));
vi.mock('@/hooks/useConversations', () => ({
  useOpenDM: () => ({ openDM: vi.fn(), isPending: false }),
  useAllUsers: () => ({
    data: Array.from({ length: 10 }, (_, i) => ({ id: `u-${i}`, displayName: `Person ${i}`, avatarURL: i === 0 ? '/a.png' : undefined })),
  }),
}));
vi.mock('@/components/ui/dropdown-menu');
vi.mock('@/hooks/useRowLongPressMenu', () => ({
  useRowLongPressMenu: () => ({ menuOpen: false, setMenuOpen: vi.fn(), rowHandlers: {}, suppressNavClick: () => false }),
}));
const addMembers = vi.hoisted(() => ({ mutate: vi.fn(), isPending: false, isSuccess: false }));
vi.mock('@/hooks/useChannels', () => ({ useAddChannelMembers: () => addMembers }));

import { renderMarkdown } from '@/lib/markdown';
import { UserGroupMentionCard } from '@/components/UserGroupMentionCard';
import { UserHoverCard } from '@/components/UserHoverCard';
import { NonMemberInvitePrompt } from '@/components/chat/NonMemberInvitePrompt';
import { ActivityRowView } from '@/components/activity/ActivityRow';
import { groupActivity } from '@/lib/activity-feed';
import type { ActivityItem } from '@/types';

function Where() {
  const loc = useLocation();
  return <span data-testid="where">{loc.pathname + loc.search}</span>;
}

function wrap(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/channel/alerts']}>
        <Routes>
          <Route path="*" element={<>{node}<Where /></>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockApiFetch.mockReset();
  addMembers.mutate.mockReset();
});

describe('user-group pills in messages', () => {
  it('renders the highlighted pill the wrapper asks for', () => {
    wrap(<>{renderMarkdown('ping @[group-1|oncall]', { renderUserGroupMention: (_id, _handle, pill) => pill(true) })}</>);
    const pill = screen.getByTestId('usergroup-mention-pill');
    expect(pill).toHaveTextContent('@oncall');
    expect(pill).toHaveAttribute('data-mention-self', 'true');
    expect(pill).toHaveAttribute('data-usergroup-id', 'group-1');
  });

  it('renders a plain pill without options', () => {
    wrap(<>{renderMarkdown('ping @[group-1|oncall]')}</>);
    expect(screen.getByTestId('usergroup-mention-pill')).toHaveAttribute('data-mention-self', 'false');
  });

  it('reads a pill with missing attributes as empty', () => {
    const tree = { type: 'root', children: [{ type: 'element', tagName: 'ex-mention-usergroup', properties: {}, children: [] }] };
    wrap(<>{renderMarkdown('', { tree: tree as never })}</>);
    expect(screen.getByTestId('usergroup-mention-pill')).toHaveTextContent('@');
  });

  it('opens the group card from the pill', async () => {
    mockApiFetch.mockResolvedValue({ id: 'group-1', handle: 'oncall', name: 'On-call', description: 'Pagers', disabled: false, memberIds: ['u-0', 'u-1'] });
    wrap(
      <>
        {renderMarkdown('ping @[group-1|oncall]', {
          renderUserGroupMention: (groupId, handle, pill) => (
            <UserGroupMentionCard groupId={groupId} handle={handle}>
              {pill}
            </UserGroupMentionCard>
          ),
        })}
      </>,
    );
    fireEvent.click(screen.getByTestId('usergroup-mention-pill'));
    expect(await screen.findByTestId('usergroup-card')).toHaveTextContent('On-call');
    expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/usergroups/group-1');
  });
});

describe('UserGroupMentionCard', () => {
  function openCard(group: unknown) {
    let answer: (v: unknown) => void = () => {};
    mockApiFetch.mockImplementation(() => new Promise((r) => { answer = r; }));
    wrap(
      <UserGroupMentionCard groupId="group-1" handle="oncall">
        {() => <span>@oncall</span>}
      </UserGroupMentionCard>,
    );
    fireEvent.click(screen.getByText('@oncall'));
    return () => answer(group);
  }

  it('shows the group with up to eight members and a link to it', async () => {
    const memberIds = Array.from({ length: 10 }, (_, i) => `u-${i}`);
    const answer = openCard({ id: 'group-1', handle: 'oncall', name: 'On-call', description: 'Who gets paged', disabled: false, memberIds });
    expect(screen.getByText('Loading @oncall…')).toBeInTheDocument();
    answer();
    const card = await screen.findByTestId('usergroup-card');
    expect(card).toHaveTextContent('Who gets paged');
    expect(card.querySelectorAll('[title]')).toHaveLength(8);
    expect(screen.getByText('+2')).toBeInTheDocument();
    expect(screen.getByLabelText('10 members')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: 'View group' }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/directory/groups?group=group-1'));
    expect(screen.queryByTestId('usergroup-card')).not.toBeInTheDocument();
  });

  it('says an empty group has no members', async () => {
    const answer = openCard({ id: 'group-1', handle: 'oncall', name: 'On-call', description: '', disabled: false });
    answer();
    expect(await screen.findByText('No members yet')).toBeInTheDocument();
  });

  it('says a disabled group is no longer available', async () => {
    const answer = openCard({ id: 'group-1', handle: 'oncall', name: 'On-call', description: '', disabled: true, memberIds: [] });
    answer();
    expect(await screen.findByText('@oncall is no longer available.')).toBeInTheDocument();
  });

  it('says a missing group is no longer available, and toggles closed', async () => {
    mockApiFetch.mockRejectedValue(new Error('not found'));
    wrap(
      <UserGroupMentionCard groupId="group-x" handle="gone">
        {() => <span>@gone</span>}
      </UserGroupMentionCard>,
    );
    fireEvent.click(screen.getByText('@gone'));
    expect(await screen.findByText('@gone is no longer available.')).toBeInTheDocument();
    fireEvent.click(screen.getByText('@gone'));
    await waitFor(() => expect(screen.queryByText('@gone is no longer available.')).not.toBeInTheDocument());
  });

  it('closes on Escape', async () => {
    const answer = openCard({ id: 'group-1', handle: 'oncall', name: 'On-call', description: '', disabled: false, memberIds: [] });
    answer();
    await screen.findByTestId('usergroup-card');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('usergroup-card')).not.toBeInTheDocument());
  });

  it('names a member it has no profile for by id', async () => {
    const answer = openCard({ id: 'group-1', handle: 'oncall', name: 'On-call', description: '', disabled: false, memberIds: ['u-unknown'] });
    answer();
    const card = await screen.findByTestId('usergroup-card');
    expect(card.querySelector('[title="u-unknown"]')).not.toBeNull();
  });
});

describe('the invite prompt for user groups', () => {
  it("offers to add a group's missing members, warning about a private channel's history", () => {
    const onDismiss = vi.fn();
    render(
      <NonMemberInvitePrompt
        channelId="ch-1"
        channelName="alerts"
        users={[{ id: 'u-ann', displayName: 'Ann' }]}
        groups={[
          { groupId: 'group-1', handle: 'oncall', missingUserIds: ['u-bob', 'u-ann'] },
          { groupId: 'group-2', handle: 'sre', missingUserIds: ['u-cy'] },
        ]}
        isPrivate
        onDismiss={onDismiss}
      />,
    );
    expect(screen.getByText('2 members of @oncall')).toBeInTheDocument();
    expect(screen.getByText('1 member of @sre')).toBeInTheDocument();
    expect(screen.getAllByTestId('usergroup-invite')[1]).toHaveTextContent("isn't in ~alerts yet.");
    expect(screen.getByText("They'll be able to see the channel's history.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add them (3)' }));
    expect(addMembers.mutate).toHaveBeenCalledWith({ channelId: 'ch-1', userIds: ['u-ann', 'u-bob', 'u-cy'] }, expect.anything());
  });

  it('says nothing about history in a public channel, and renders nothing with no one to add', () => {
    const { rerender } = render(
      <NonMemberInvitePrompt
        channelId="ch-1"
        channelName="alerts"
        users={[]}
        groups={[{ groupId: 'group-1', handle: 'oncall', missingUserIds: ['u-bob'] }]}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText("isn't in ~alerts yet.", { exact: false })).toBeInTheDocument();
    expect(screen.queryByText(/history/)).not.toBeInTheDocument();
    rerender(<NonMemberInvitePrompt channelId="ch-1" channelName="alerts" users={[]} groups={[]} onDismiss={vi.fn()} />);
    expect(screen.queryByTestId('non-member-invite')).not.toBeInTheDocument();
  });
});

describe('Activity rows for user-group mentions', () => {
  const base: ActivityItem = {
    id: 'a', type: 'mention', createdAt: new Date().toISOString(), messageID: 'm-1', parentID: 'ch-1',
    parentType: 'channel', actorID: 'u-1', read: false, mentionKind: 'usergroup',
  };
  function row(item: ActivityItem) {
    render(
      <MemoryRouter>
        <ActivityRowView
          row={groupActivity([item])[0]}
          href="/channel/alerts#msg-m-1"
          selected={false}
          actor={undefined}
          emojiMap={undefined}
          channel={undefined}
          conversation={undefined}
          onOpen={vi.fn()}
          onSetRead={vi.fn()}
          onRemove={vi.fn()}
        />
      </MemoryRouter>,
    );
  }

  it('names the group', () => {
    row({ ...base, userGroupID: 'group-1', userGroupHandle: 'oncall' });
    expect(screen.getByText(/mentioned @oncall/)).toBeInTheDocument();
  });

  it('falls back when the handle is missing', () => {
    row(base);
    expect(screen.getByText(/mentioned @a group you belong to/)).toBeInTheDocument();
  });
});

describe("a person's user groups on their card", () => {
  it('lists the groups they belong to', async () => {
    mockApiFetch.mockImplementation((path: string) =>
      Promise.resolve(
        path === '/api/v1/users/u-ann/usergroups'
          ? [{ id: 'group-1', handle: 'oncall' }, { id: 'group-2', handle: 'sre' }]
          : { id: 'u-ann', displayName: 'Ann', status: 'active' },
      ),
    );
    wrap(
      <UserHoverCard userId="u-ann" displayName="Ann" currentUserId="u-me">
        <span>Ann</span>
      </UserHoverCard>,
    );
    fireEvent.click(screen.getByText('Ann'));
    expect(await screen.findByTestId('hover-card-usergroups')).toHaveTextContent('@oncall, @sre');
  });
});
