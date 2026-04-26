import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
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
    expect(screen.getByText('water-cooler chat')).toBeInTheDocument();
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
