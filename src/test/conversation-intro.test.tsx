import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import {
  ChannelIntro,
  DMIntro,
  SelfDMIntro,
  GroupIntro,
} from '@/components/chat/ConversationIntro';
import type { Channel } from '@/types';

const channel: Channel = {
  id: 'ch-1',
  name: 'general',
  slug: 'general',
  type: 'public',
  createdBy: 'u-1',
  archived: false,
  createdAt: '2016-08-03T10:00:00Z',
};

describe('ChannelIntro', () => {
  it('shows creator and full long-format date', () => {
    render(<ChannelIntro channel={channel} creatorName="Alice" />);
    const intro = screen.getByTestId('conversation-intro');
    expect(intro.getAttribute('data-intro-kind')).toBe('channel');
    expect(intro.textContent).toContain('@Alice');
    expect(intro.textContent).toContain('August 3rd, 2016');
    expect(intro.textContent).toContain('the very beginning of the general channel');
  });

  it('falls back to "Someone" when creator name is unknown', () => {
    render(<ChannelIntro channel={channel} />);
    expect(screen.getByTestId('conversation-intro').textContent).toContain('Someone');
  });

  it('renders description when present', () => {
    render(<ChannelIntro channel={{ ...channel, description: 'water-cooler chat' }} creatorName="A" />);
    expect(within(screen.getByTestId('channel-intro-description')).getByText('water-cooler chat')).toBeInTheDocument();
  });

  it('has no description block for a channel without one', () => {
    render(<ChannelIntro channel={channel} creatorName="A" />);
    expect(screen.queryByTestId('channel-intro-description')).toBeNull();
  });

  // A description is written like a message: its lines stay apart, its links
  // can be clicked and its emphasis shows.
  it('renders the description as markdown, with its lines kept and its links live', () => {
    render(
      <ChannelIntro
        channel={{ ...channel, description: 'Daily **standup** notes.\nRunbook: https://example.com/runbook' }}
        creatorName="A"
      />,
    );
    const description = screen.getByTestId('channel-intro-description');
    expect(within(description).getByRole('link', { name: 'example.com/runbook' })).toHaveAttribute(
      'href',
      'https://example.com/runbook',
    );
    expect(within(description).getByText('standup').tagName).toBe('STRONG');
    expect(description.textContent).not.toContain('**');
    // Two lines, not one run of text: the line break is kept, and shown.
    expect(description.textContent).toBe('Daily standup notes.\nRunbook: example.com/runbook');
    expect(description.querySelector('p')).toHaveClass('whitespace-pre-wrap');
  });

  it("shows the channel's own emoji in place of the globe", () => {
    render(<ChannelIntro channel={{ ...channel, icon: 'rocket' }} creatorName="A" />);
    const intro = screen.getByTestId('conversation-intro');
    expect(within(intro).getByTestId('channel-emoji')).toHaveTextContent('\u{1F680}');
    expect(intro.querySelector('svg.lucide-globe')).toBeNull();
    // Decorative here: the heading beside it names the channel.
    expect(within(intro).getByTestId('channel-emoji')).toHaveAttribute('aria-hidden', 'true');
  });

  it('keeps the globe, or the lock of a private channel, when the channel has no emoji', () => {
    const { unmount } = render(<ChannelIntro channel={channel} creatorName="A" />);
    expect(screen.getByTestId('conversation-intro').querySelector('svg.lucide-globe')).not.toBeNull();
    expect(screen.queryByTestId('channel-emoji')).toBeNull();
    unmount();
    render(<ChannelIntro channel={{ ...channel, type: 'private' }} creatorName="A" />);
    expect(screen.getByTestId('conversation-intro').querySelector('svg.lucide-lock')).not.toBeNull();
  });
});

describe('DMIntro', () => {
  it('renders "between @USER and you" with the online dot when online', () => {
    render(<DMIntro otherDisplayName="Bob" online />);
    const intro = screen.getByTestId('conversation-intro');
    expect(intro.getAttribute('data-intro-kind')).toBe('dm');
    expect(intro.textContent).toContain('@Bob');
    expect(intro.textContent).toContain('and you');
    expect(screen.getByLabelText('Online')).toBeInTheDocument();
  });

  it('shows the offline indicator when online=false', () => {
    render(<DMIntro otherDisplayName="Bob" online={false} />);
    expect(screen.getByLabelText('Offline')).toBeInTheDocument();
  });
});

describe('SelfDMIntro', () => {
  it('renders the "your space" copy with notes-to-self framing', () => {
    render(<SelfDMIntro selfDisplayName="Me" />);
    const intro = screen.getByTestId('conversation-intro');
    expect(intro.getAttribute('data-intro-kind')).toBe('self-dm');
    expect(intro.textContent).toContain('This is your space.');
    expect(intro.textContent).toContain("supply both sides of the conversation");
  });
});

describe('GroupIntro', () => {
  it('renders one chip per participant and a natural-language mention list', () => {
    render(
      <GroupIntro
        participants={[
          { id: 'a', displayName: 'Ann' },
          { id: 'b', displayName: 'Ben' },
          { id: 'c', displayName: 'Cara' },
        ]}
      />,
    );
    expect(screen.getAllByTestId('group-intro-participant')).toHaveLength(3);
    const intro = screen.getByTestId('conversation-intro');
    expect(intro.getAttribute('data-intro-kind')).toBe('group');
    expect(intro.textContent).toContain('@Ann, @Ben and @Cara');
    expect(intro.textContent).toContain("You'll be notified for every new message");
  });

  it('formats two participants as "@A and @B" without a comma', () => {
    render(
      <GroupIntro
        participants={[
          { id: 'a', displayName: 'Ann' },
          { id: 'b', displayName: 'Ben' },
        ]}
      />,
    );
    expect(screen.getByTestId('conversation-intro').textContent).toContain('@Ann and @Ben');
  });
});
