import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-react';
import { ChannelIcon, PrivateChannelMark } from './ChannelIcon';

describe('ChannelIcon browser behaviour', () => {
  it('renders a public-channel globe with the default aria-label', async () => {
    await render(<ChannelIcon type="public" />);
    const labeled = document.querySelector('[aria-label="Public channel"]');
    expect(labeled).not.toBeNull();
  });

  it('renders a private-channel lock with the default aria-label', async () => {
    await render(<ChannelIcon type="private" />);
    const labeled = document.querySelector('[aria-label="Private channel"]');
    expect(labeled).not.toBeNull();
  });

  it('treats the icon as decorative (aria-hidden) when ariaLabel is empty', async () => {
    await render(<ChannelIcon type="public" ariaLabel="" />);
    const hidden = document.querySelector('svg[aria-hidden="true"]');
    expect(hidden).not.toBeNull();
    expect(document.querySelector('[aria-label]')).toBeNull();
  });

  it('uses the explicit ariaLabel override when provided', async () => {
    await render(<ChannelIcon type="private" ariaLabel="Secret room" />);
    const labeled = document.querySelector('[aria-label="Secret room"]');
    expect(labeled).not.toBeNull();
  });

  it("draws the channel's own emoji in place of the globe, under the same label", async () => {
    const screen = await render(<ChannelIcon type="public" icon="rocket" className="h-5 w-5" />);
    const emoji = screen.getByRole('img', { name: 'Public channel' });
    await expect.element(emoji).toHaveTextContent('\u{1F680}');
    await expect.element(emoji).toHaveAttribute('data-testid', 'channel-emoji');
    await expect.element(emoji).toHaveClass('h-5', 'w-5');
    expect(document.querySelector('svg')).toBeNull();
  });

  it('draws the emoji in place of the lock for a private channel', async () => {
    const screen = await render(<ChannelIcon type="private" icon="rocket" />);
    await expect.element(screen.getByRole('img', { name: 'Private channel' })).toHaveTextContent('\u{1F680}');
    expect(document.querySelector('svg')).toBeNull();
  });

  it('hides a decorative emoji from assistive tech when ariaLabel is empty', async () => {
    const screen = await render(<ChannelIcon type="public" icon="rocket" ariaLabel="" />);
    const emoji = screen.getByTestId('channel-emoji');
    await expect.element(emoji).toHaveTextContent('\u{1F680}');
    await expect.element(emoji).toHaveAttribute('aria-hidden', 'true');
    await expect.element(emoji).not.toHaveAttribute('role');
    await expect.element(emoji).not.toHaveAttribute('aria-label');
  });

  it('keeps the lock for an icon name it cannot draw', async () => {
    const screen = await render(<ChannelIcon type="private" icon="no_such_emoji_here" />);
    await expect.element(screen.getByLabelText('Private channel')).toBeInTheDocument();
    expect(screen.getByTestId('channel-emoji').query()).toBeNull();
    expect(document.querySelector('svg.lucide-lock')).not.toBeNull();
  });
});

describe('PrivateChannelMark', () => {
  it('marks a private channel whose emoji took the place of its lock', async () => {
    const screen = await render(<PrivateChannelMark type="private" icon="rocket" className="ml-1" />);
    const mark = screen.getByTestId('channel-private-mark');
    await expect.element(mark).toHaveAttribute('aria-label', 'Private');
    await expect.element(mark).toHaveClass('ml-1');
  });

  it('is absent when the lock itself is still showing', async () => {
    const screen = await render(
      <div data-testid="marks">
        <PrivateChannelMark type="private" />
        <PrivateChannelMark type="private" icon="no_such_emoji_here" />
      </div>,
    );
    await expect.element(screen.getByTestId('marks')).toBeInTheDocument();
    expect(screen.getByTestId('channel-private-mark').query()).toBeNull();
  });

  it('is absent for a public channel, emoji or not', async () => {
    const screen = await render(
      <div data-testid="marks">
        <PrivateChannelMark type="public" icon="rocket" />
        <PrivateChannelMark type="public" />
      </div>,
    );
    await expect.element(screen.getByTestId('marks')).toBeInTheDocument();
    expect(screen.getByTestId('channel-private-mark').query()).toBeNull();
  });
});
