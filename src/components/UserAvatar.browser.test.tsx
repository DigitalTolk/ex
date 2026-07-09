import { describe, it, expect } from 'vitest';
import { render } from 'vitest-browser-react';
import { UserAvatar } from './UserAvatar';

// Browser twin: the presence notch is a real mask only the engine
// evaluates, and the <img> onError → fallback path needs a real image load
// to fail. Both are invisible to jsdom.
describe('UserAvatar (browser)', () => {
  it('online: carves the notch and shows a filled dot', async () => {
    const screen = await render(<UserAvatar displayName="Ada Lovelace" online />);
    const box = screen.container.querySelector('[data-slot="avatar"]') as HTMLElement;
    expect(getComputedStyle(box).maskImage).toContain('radial-gradient');
    const dot = screen.container.querySelector('[data-presence]')!;
    expect(dot.getAttribute('data-presence')).toBe('online');
  });

  it('offline: carves the notch and shows a hollow ring', async () => {
    const screen = await render(<UserAvatar displayName="Ada Lovelace" online={false} />);
    const box = screen.container.querySelector('[data-slot="avatar"]') as HTMLElement;
    expect(getComputedStyle(box).maskImage).toContain('radial-gradient');
    expect(screen.container.querySelector('[data-presence="offline"]')).not.toBeNull();
  });

  it('no presence tracked: no notch mask and no dot at all', async () => {
    const screen = await render(<UserAvatar displayName="Ada Lovelace" />);
    const box = screen.container.querySelector('[data-slot="avatar"]') as HTMLElement;
    expect(getComputedStyle(box).maskImage).toBe('none');
    expect(screen.container.querySelector('[data-presence]')).toBeNull();
  });

  it('a broken avatar URL falls back to the initials (onError path)', async () => {
    const screen = await render(
      <UserAvatar displayName="Ada Lovelace" avatarURL="data:image/png;base64,not-a-real-image" online />,
    );
    // The <img> load fails → the component flips to the initials fallback.
    await expect.element(screen.getByText('AL')).toBeVisible();
  });
});
