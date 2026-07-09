import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-react';
import { ChannelIcon } from './ChannelIcon';

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
});
