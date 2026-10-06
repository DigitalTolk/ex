import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';

// Browser coverage for UserStatusIndicator — specifically the
// `tooltip={false}` branch that returns the bare indicator without the
// Tooltip wrapper, plus the inactive (no current status) null return.

vi.mock('@/hooks/useEmoji', () => ({
  useEmojiMap: () => ({ data: {} }),
}));

import { UserStatusIndicator } from './UserStatusIndicator';

const activeStatus = { emoji: '🎯', text: 'Focusing', clearAt: '' };

describe('UserStatusIndicator browser', () => {
  it('renders the bare indicator (no tooltip wrapper) when tooltip={false}', async () => {
    const screen = await render(
      <UserStatusIndicator status={activeStatus} tooltip={false} />,
    );
    const indicator = screen.getByLabelText(/Focusing/);
    await expect.element(indicator).toBeVisible();
    // The non-tooltip path returns a single <span>, not a Tooltip trigger.
    expect(document.querySelector('[data-slot="tooltip-trigger"]')).toBeNull();
  });

  it('wraps the indicator in a tooltip trigger by default', async () => {
    await render(<UserStatusIndicator status={activeStatus} />);
    expect(document.querySelector('[data-slot="tooltip-trigger"]')).not.toBeNull();
  });

  it('renders the tooltip trigger as a <span> (not a nested button) with inlineTrigger', async () => {
    await render(
      <button type="button">
        <UserStatusIndicator status={activeStatus} inlineTrigger />
      </button>,
    );
    const trigger = document.querySelector('[data-slot="tooltip-trigger"]');
    expect(trigger?.tagName).toBe('SPAN');
    expect(document.querySelectorAll('button button').length).toBe(0);
  });

  it('renders nothing when there is no active status', async () => {
    await render(<UserStatusIndicator status={undefined} />);
    expect(document.querySelector('[data-slot="tooltip-trigger"]')).toBeNull();
    expect(document.querySelector('[aria-label*="Focusing"]')).toBeNull();
  });
});
