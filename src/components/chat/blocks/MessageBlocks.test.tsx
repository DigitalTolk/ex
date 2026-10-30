import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionTally, Block, ButtonElement, Message } from '@/types';
import { isOwnClick } from '@/lib/app-clicks';
import { BlockList, MessageBlockScope } from './MessageBlocks';

const mockApiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => mockApiFetch(...args) }));
const mockToast = vi.hoisted(() => vi.fn());
vi.mock('@/lib/toast', () => ({ showToast: (...args: unknown[]) => mockToast(...args) }));

const label = (text: string) => ({ type: 'plain_text' as const, text });
const button = (action_id: string, over: Partial<ButtonElement> = {}): ButtonElement => ({
  type: 'button',
  action_id,
  text: label(action_id),
  ...over,
});

const users = new Map([
  ['u-alice', { displayName: 'Alice' }],
  ['u-bob', { displayName: 'Bob' }],
]);

function card(over: Partial<Message> = {}, blocks?: Block[]): Message {
  return {
    id: 'm1',
    parentID: 'ch-1',
    authorID: 'webhook',
    body: 'fallback',
    createdAt: '2026-10-30T10:00:00Z',
    blocks: blocks ?? [
      { type: 'actions', block_id: 'row', elements: [button('ack', { ex_action: 'ack' }), button('vote', { ex_action: 'vote' })] },
    ],
    ...over,
  } as Message;
}

function renderScope(message: Message, opts: { interactive?: boolean; currentUserId?: string; parentType?: 'channel' | 'conversation'; parentID?: string } = {}) {
  const props = {
    parentType: 'channel' as const,
    parentID: 'ch-1',
    interactive: true,
    currentUserId: 'u-alice',
    userMap: users,
    ...opts,
  };
  const ui = (m: Message) => (
    <MessageBlockScope message={m} {...props}>
      {(current) => <BlockList blocks={current.blocks} />}
    </MessageBlockScope>
  );
  const view = render(ui(message));
  return { ...view, rerenderWith: (m: Message) => view.rerender(ui(m)) };
}

// A click's answer: the message as it now is, maybe a note for the clicker.
const answer = (message: Message, notice?: string) => ({ message, notice });

beforeEach(() => {
  mockApiFetch.mockReset();
  mockToast.mockReset();
});

describe('BlockList', () => {
  it('draws nothing without blocks', () => {
    const { container } = render(<BlockList blocks={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('draws every block kind', () => {
    render(
      <BlockList
        blocks={[
          { type: 'header', block_id: 'h', text: label('Deploy finished') },
          {
            type: 'section',
            block_id: 's',
            text: { type: 'markdown', text: '**api** is live' },
            fields: [label('Version 1.42'), { type: 'markdown', text: '*6 min*' }],
            accessory: button('notes', { url: 'https://ex.test/notes', text: label('Release notes') }),
          },
          { type: 'section', block_id: 's2', text: label('plain\ntext') },
          { type: 'context', block_id: 'c', elements: [{ type: 'markdown', text: '_by_ bot' }, { type: 'plain_text', text: 'via CI' }] },
          { type: 'divider', block_id: 'd' },
        ]}
      />,
    );
    expect(screen.getByText('Deploy finished')).toBeInTheDocument();
    expect(screen.getByText('api').tagName).toBe('STRONG');
    expect(screen.getByText('Version 1.42')).toBeInTheDocument();
    expect(screen.getByText('6 min').tagName).toBe('EM');
    expect(screen.getByText(/plain/)).toHaveClass('whitespace-pre-wrap');
    expect(screen.getByText('via CI')).toBeInTheDocument();
    expect(screen.getByTestId('message-blocks').querySelector('hr')).not.toBeNull();
    // A link button is a real link, opened in a new tab.
    const link = screen.getByTestId('block-button-notes');
    expect(link).toHaveAttribute('href', 'https://ex.test/notes');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('shows buttons outside a scope (a preview) but never sends a click', () => {
    render(<BlockList blocks={card().blocks} />);
    const ack = screen.getByTestId('block-button-ack');
    expect(ack).toBeDisabled();
    fireEvent.click(ack);
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it('styles buttons the way ex styles its own', () => {
    render(
      <BlockList
        blocks={[{ type: 'actions', block_id: 'r', elements: [button('p', { style: 'primary', ex_action: 'ack' }), button('d', { style: 'danger', ex_action: 'ack' }), button('o', { ex_action: 'ack' })] }]}
      />,
    );
    expect(screen.getByTestId('block-button-p').className).toContain('bg-primary');
    expect(screen.getByTestId('block-button-d').className).toContain('text-destructive');
    expect(screen.getByTestId('block-button-o').className).toContain('border-border');
  });
});

describe('MessageBlockScope', () => {
  it('acknowledges: sends only which button, then shows who and when', async () => {
    const answered = card({ version: 1, actionTallies: [{ blockID: 'row', actionID: 'ack', userIDs: ['u-alice'], at: new Date().toISOString() }] });
    mockApiFetch.mockResolvedValue(answer(answered));
    renderScope(card());
    fireEvent.click(screen.getByTestId('block-button-ack'));
    expect(screen.getByTestId('block-button-ack')).toHaveAttribute('aria-busy', 'true');
    await screen.findByTestId('block-acked-ack');
    expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/channels/ch-1/messages/m1/actions', { method: 'POST', body: expect.any(String) });
    // Which button, plus this tab's name for the click (a form the app opens
    // in answer shows only in the tab that clicked).
    const sent = JSON.parse(mockApiFetch.mock.calls[0][1].body as string) as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(['actionID', 'blockID', 'clickID']);
    expect(sent).toMatchObject({ blockID: 'row', actionID: 'ack' });
    expect(sent.clickID).toMatch(/^[0-9a-f]{24}$/);
    expect(isOwnClick(sent.clickID as string)).toBe(true);
    expect(screen.getByTestId('block-acked-ack')).toHaveTextContent(/Acknowledged by Alice ·/);
    // The check is the app's one green accent, the presence token.
    expect(screen.getByTestId('block-acked-ack').querySelector('svg')).toHaveClass('text-online');
  });

  it('keeps showing the newest of its own answer and the broadcast', async () => {
    const tally = (users: string[]): ActionTally[] => [{ blockID: 'row', actionID: 'vote', userIDs: users, at: '2026-10-30T10:00:00Z' }];
    mockApiFetch.mockResolvedValue(answer(card({ version: 1, actionTallies: tally(['u-alice']) })));
    const view = renderScope(card());
    fireEvent.click(screen.getByTestId('block-button-vote'));
    await waitFor(() => expect(screen.getByTestId('block-vote-count')).toHaveTextContent('1'));
    expect(screen.getByTestId('block-button-vote')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('block-button-vote')).toHaveAttribute('title', 'Alice');
    // The broadcast of an older version doesn't take the answer back…
    view.rerenderWith(card({ version: 0 }));
    expect(screen.getByTestId('block-vote-count')).toHaveTextContent('1');
    // …a newer one (Bob voted too) wins.
    view.rerenderWith(card({ version: 2, actionTallies: tally(['u-alice', 'u-bob']) }));
    expect(screen.getByTestId('block-vote-count')).toHaveTextContent('2');
    expect(screen.getByTestId('block-button-vote')).toHaveAttribute('title', 'Alice, Bob');
  });

  it('keeps the message as it is when a click changed nothing', async () => {
    // Someone acknowledged first: the server answers with the message as it
    // was (never versioned), so the card stays what the broadcast says.
    mockApiFetch.mockResolvedValue(answer(card({ version: undefined })));
    renderScope(card());
    fireEvent.click(screen.getByTestId('block-button-ack'));
    await waitFor(() => expect(screen.getByTestId('block-button-ack')).not.toHaveAttribute('aria-busy'));
    expect(screen.queryByTestId('block-acked-ack')).toBeNull();
  });

  it('names unknown people "Someone" and leaves a vote unpressed for others', () => {
    renderScope(
      card({
        actionTallies: [
          { blockID: 'row', actionID: 'vote', userIDs: ['u-ghost'], at: '2026-10-30T10:00:00Z' },
          { blockID: 'row', actionID: 'ack', userIDs: ['u-ghost'], at: '2026-10-30T10:00:00Z' },
        ],
      }),
    );
    expect(screen.getByTestId('block-acked-ack')).toHaveTextContent('Acknowledged by Someone');
    expect(screen.getByTestId('block-button-vote')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('block-button-vote')).toHaveAttribute('title', 'Someone');
  });

  it('asks first when the app asked for a confirmation', async () => {
    mockApiFetch.mockResolvedValue(answer(card({ version: 1 })));
    renderScope(
      card({}, [
        {
          type: 'actions',
          block_id: 'row',
          elements: [
            button('hand-back', {
              ex_action: 'ack',
              style: 'danger',
              confirm: { title: label('Hand A1 back?'), text: label('It becomes unassigned.'), confirm: label('Hand back'), deny: label('Keep it') },
            }),
          ],
        },
      ]),
    );
    fireEvent.click(screen.getByTestId('block-button-hand-back'));
    const dialog = await screen.findByTestId('block-confirm');
    expect(within(dialog).getByText('Hand A1 back?')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByText('Keep it'));
    await waitFor(() => expect(screen.queryByTestId('block-confirm')).toBeNull());
    expect(mockApiFetch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('block-button-hand-back'));
    fireEvent.click(within(await screen.findByTestId('block-confirm')).getByText('Hand back'));
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(1));
  });

  it("tells the clicker why a click didn't land", async () => {
    mockApiFetch.mockRejectedValueOnce(new Error('this card changed, try again'));
    renderScope(card(), { parentType: 'conversation', parentID: 'dm-1' });
    fireEvent.click(screen.getByTestId('block-button-vote'));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('this card changed, try again'));
    expect(mockApiFetch.mock.calls[0][0]).toBe('/api/v1/conversations/dm-1/messages/m1/actions');
    // The button comes back for another try.
    expect(screen.getByTestId('block-button-vote')).not.toBeDisabled();

    mockApiFetch.mockRejectedValueOnce('offline');
    await act(async () => fireEvent.click(screen.getByTestId('block-button-vote')));
    await waitFor(() => expect(mockToast).toHaveBeenLastCalledWith("That didn't work. Try again."));
  });

  it("sends an app button's click when the app posted the card, and shows the app's note", async () => {
    const blocks: Block[] = [{ type: 'actions', block_id: 'row', elements: [button('use_date', { text: label('Use Fri 23 Oct') })] }];
    mockApiFetch.mockResolvedValue(answer(card({ version: 1, appButtons: true, body: 'A3 is due Fri' }, blocks), 'Saved for Fri 23 Oct'));
    renderScope(card({ appButtons: true }, blocks));
    const use = screen.getByTestId('block-button-use_date');
    expect(use).not.toBeDisabled();
    expect(use).not.toHaveAttribute('title');
    fireEvent.click(use);
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('Saved for Fri 23 Oct', 'success'));
  });

  it('keeps the card when an answer is about another message', async () => {
    const other = { ...card({ version: 3 }, [{ type: 'header', block_id: 'h', text: label('Someone else') }]), id: 'm2' };
    mockApiFetch.mockResolvedValue(answer(other));
    renderScope(card());
    fireEvent.click(screen.getByTestId('block-button-ack'));
    await waitFor(() => expect(screen.getByTestId('block-button-ack')).not.toHaveAttribute('aria-busy'));
    expect(screen.queryByText('Someone else')).toBeNull();
    expect(screen.getByTestId('block-button-ack')).toBeInTheDocument();
  });

  it("shows a click that didn't reach the app as an error", async () => {
    const blocks: Block[] = [{ type: 'actions', block_id: 'row', elements: [button('use_date', { text: label('Use Fri 23 Oct') })] }];
    const unchanged = card({ appButtons: true }, blocks);
    mockApiFetch.mockResolvedValue({ message: unchanged, notice: "MeetingMind didn't respond. Try again.", failed: true });
    renderScope(unchanged);
    fireEvent.click(screen.getByTestId('block-button-use_date'));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith("MeetingMind didn't respond. Try again.", 'error'));
    expect(screen.getByTestId('block-button-use_date')).not.toBeDisabled();
  });

  it('shows buttons as unclickable where the chat is read-only', () => {
    renderScope(card(), { interactive: false });
    expect(screen.getByTestId('block-button-ack')).toBeDisabled();
  });

  it('keeps an app button disabled until the app is set up for clicks', () => {
    renderScope(card({}, [{ type: 'actions', block_id: 'row', elements: [button('ask-app')] }]));
    const ask = screen.getByTestId('block-button-ask-app');
    expect(ask).toBeDisabled();
    expect(ask).toHaveAttribute('title', "This app isn't set up for buttons");
  });

  it('shows a button only to the people the app named', () => {
    const blocks: Block[] = [{ type: 'actions', block_id: 'row', elements: [button('take', { ex_action: 'ack', allowed_users: ['u-bob'] }), button('all', { ex_action: 'ack' })] }];
    const view = renderScope(card({}, blocks));
    expect(screen.queryByTestId('block-button-take')).toBeNull();
    expect(screen.getByTestId('block-button-all')).toBeInTheDocument();
    view.unmount();
    const bob = renderScope(card({}, blocks), { currentUserId: 'u-bob' });
    expect(screen.getByTestId('block-button-take')).toBeInTheDocument();
    bob.unmount();
    // Signed out (no current user): nobody named, nothing shown.
    render(<BlockList blocks={blocks} />);
    expect(screen.queryAllByTestId('block-button-take')).toHaveLength(0);
  });

  it('draws without a live scope when the message has no parent here', () => {
    renderScope(card(), { parentType: undefined, parentID: undefined });
    expect(screen.getByTestId('block-button-ack')).toBeDisabled();
  });
});
