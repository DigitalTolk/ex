import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, cleanup } from 'vitest-browser-react';
import { CustomEmojiDialog } from './CustomEmojiDialog';

// The manager itself is covered by the /emojis page suites; here it's a stub
// so the pop-up shell (title, description, open/close) is tested on its own.
const form = vi.hoisted(() => ({ shown: true }));
vi.mock('./CustomEmojiManager', () => ({
  // Guests get a message instead of the form (no shortcode field).
  CustomEmojiManager: () => (
    <p>
      manager-body {form.shown && <input id="emoji-name" aria-label="Emoji shortcode" />}
    </p>
  ),
  CustomEmojiDescription: () => <>Upload images and use :name:</>,
}));

describe('CustomEmojiDialog', () => {
  afterEach(() => {
    form.shown = true;
    cleanup();
  });

  it('renders nothing while closed', async () => {
    await render(<CustomEmojiDialog open={false} onOpenChange={vi.fn()} />);
    expect(document.querySelector('[data-testid="custom-emoji-dialog"]')).toBeNull();
  });

  it('shows the manager in a titled pop-up', async () => {
    const screen = await render(<CustomEmojiDialog open onOpenChange={vi.fn()} />);
    await expect.element(screen.getByRole('dialog', { name: 'Custom emojis' })).toBeVisible();
    await expect.element(screen.getByText('Upload images and use :name:')).toBeVisible();
    await expect.element(screen.getByText('manager-body')).toBeVisible();
    // Focus starts in the shortcode field.
    await vi.waitFor(() => expect(document.activeElement?.id).toBe('emoji-name'));
  });

  it('falls back to focusing the dialog when there is no form (guests)', async () => {
    form.shown = false;
    const screen = await render(<CustomEmojiDialog open onOpenChange={vi.fn()} />);
    await expect.element(screen.getByText('manager-body')).toBeVisible();
    await vi.waitFor(() => expect(screen.getByRole('dialog').element().contains(document.activeElement)).toBe(true));
  });

  it('closes from its close control', async () => {
    const onOpenChange = vi.fn();
    const screen = await render(<CustomEmojiDialog open onOpenChange={onOpenChange} />);
    const close = window.innerWidth < 768 ? screen.getByRole('button', { name: 'Done' }) : screen.getByRole('button', { name: 'Close' });
    await close.click();
    expect(onOpenChange).toHaveBeenCalledWith(false, expect.anything());
  });
});
