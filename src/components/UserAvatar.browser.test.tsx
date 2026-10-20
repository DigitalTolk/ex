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

  // Initials never drop below the 12px text floor, and stay well inside the
  // circle at every avatar size the app uses. Below 28px two wide letters at
  // 12px don't fit, so those avatars show one. "Mary Williams" is the widest
  // pair (MW).
  it.each([
    { where: 'sidebar DM row', className: 'h-5 w-5', maxInitials: 1, shown: 'M' },
    { where: 'user picker row', className: 'h-6 w-6 shrink-0', maxInitials: 1, shown: 'M' },
    { where: 'header (default size)', className: undefined, maxInitials: undefined, shown: 'MW' },
    { where: 'Activity row', className: 'h-8 w-8', maxInitials: undefined, shown: 'MW' },
    { where: 'message', className: 'h-9 w-9', maxInitials: undefined, shown: 'MW', initialsClassName: 'text-sm font-medium' },
  ] as const)('initials fit a $where avatar at 12px or more', async ({ className, maxInitials, shown, ...rest }) => {
    const initialsClassName = 'initialsClassName' in rest ? rest.initialsClassName : undefined;
    const screen = await render(
      <UserAvatar displayName="Mary Williams" className={className} maxInitials={maxInitials} initialsClassName={initialsClassName} />,
    );
    const fallback = screen.container.querySelector('[data-slot="avatar-fallback"]') as HTMLElement;
    expect(fallback.textContent).toBe(shown);
    expect(parseFloat(getComputedStyle(fallback).fontSize)).toBeGreaterThanOrEqual(12);
    const range = document.createRange();
    range.selectNodeContents(fallback);
    expect(range.getBoundingClientRect().width).toBeLessThanOrEqual(fallback.getBoundingClientRect().width * 0.8);
  });
});
