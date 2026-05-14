import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-react';
import { ChannelIntro, DMIntro, SelfDMIntro, GroupIntro } from './ConversationIntro';
import type { Channel } from '@/types';

const baseChannel: Channel = {
  id: 'ch-1',
  name: 'general',
  slug: 'general',
  type: 'public',
  description: '',
  createdAt: '2026-01-15T09:00:00Z',
  createdBy: 'u-1',
  memberCount: 5,
  unreadCount: 0,
};

describe('ConversationIntro browser behaviour', () => {
  it('ChannelIntro renders channel name, creator, and date copy', async () => {
    const screen = await render(<ChannelIntro channel={baseChannel} creatorName="Alice" />);
    await expect.element(screen.getByText('~general')).toBeVisible();
    await expect.element(screen.getByText(/@Alice/)).toBeVisible();
    await expect.element(screen.getByText(/very beginning of the/)).toBeVisible();
  });

  it('ChannelIntro shows the description block when set', async () => {
    const channel = { ...baseChannel, description: 'A channel for general chat' };
    const screen = await render(<ChannelIntro channel={channel} />);
    await expect.element(screen.getByText('A channel for general chat')).toBeVisible();
  });

  it('ChannelIntro falls back to "Someone" when the creator name is missing', async () => {
    const screen = await render(<ChannelIntro channel={baseChannel} />);
    await expect.element(screen.getByText(/Someone created this channel/)).toBeVisible();
  });

  it('DMIntro renders the partner name and online dot when online is true', async () => {
    const screen = await render(<DMIntro otherDisplayName="Bob" online />);
    await expect.element(screen.getByRole('heading', { name: 'Bob' })).toBeVisible();
    const dot = document.querySelector('[aria-label="Online"]');
    expect(dot).not.toBeNull();
  });

  it('DMIntro renders the offline dot when online is false', async () => {
    await render(<DMIntro otherDisplayName="Bob" online={false} />);
    const dot = document.querySelector('[aria-label="Offline"]');
    expect(dot).not.toBeNull();
  });

  it('SelfDMIntro renders the self-conversation copy', async () => {
    const screen = await render(<SelfDMIntro selfDisplayName="Alice" />);
    await expect.element(screen.getByRole('heading', { name: 'Alice' })).toBeVisible();
    await expect.element(screen.getByText(/This is your space/)).toBeVisible();
  });

  it('GroupIntro renders one chip per participant and a natural-language mention list', async () => {
    const screen = await render(
      <GroupIntro
        participants={[
          { id: 'u-1', displayName: 'Alice' },
          { id: 'u-2', displayName: 'Bob' },
          { id: 'u-3', displayName: 'Carol' },
        ]}
      />,
    );
    const chips = document.querySelectorAll('[data-testid="group-intro-participant"]');
    expect(chips.length).toBe(3);
    await expect.element(screen.getByText(/@Alice, @Bob and @Carol/)).toBeVisible();
  });
});
