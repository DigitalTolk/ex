import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { ConfirmDialog } from './confirm-dialog';

// Browser coverage for the shared ConfirmDialog primitive. Most callers pass
// an explicit confirmLabel / testIDPrefix; these tests exercise the DEFAULT
// argument arms (no confirmLabel, no testIDPrefix) plus the confirm/cancel
// flows, including the description-present branch.

const mounted: Array<{ unmount: () => Promise<void> }> = [];
async function mount(ui: React.ReactElement) {
  const result = await render(ui);
  mounted.push(result);
  return result;
}
let killAnims: HTMLStyleElement | null = null;

describe('ConfirmDialog browser', () => {
  beforeEach(() => {
    killAnims = document.createElement('style');
    killAnims.textContent = '*,*::before,*::after{animation:none!important;transition:none!important}';
    document.head.appendChild(killAnims);
  });
  afterEach(async () => {
    for (const m of mounted.splice(0)) await m.unmount();
    killAnims?.remove();
    killAnims = null;
  });

  it('renders with default labels/testID and confirms via the default-prefixed button', async () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    // No confirmLabel/cancelLabel/testIDPrefix → the default-argument arms run
    // (confirmLabel='Confirm', testIDPrefix='confirm-dialog').
    const screen = await mount(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="Are you sure?"
        description="This cannot be undone."
        onConfirm={onConfirm}
      />,
    );
    await expect.element(screen.getByText('Are you sure?')).toBeVisible();
    await expect.element(screen.getByText('This cannot be undone.')).toBeVisible();
    // Default testIDPrefix builds the confirm button's test id.
    await screen.getByTestId('confirm-dialog-confirm').click();
    expect(onConfirm).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('cancels via the default cancel button without confirming', async () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    const screen = await mount(
      <ConfirmDialog open onOpenChange={onOpenChange} title="Discard?" onConfirm={onConfirm} />,
    );
    await screen.getByTestId('confirm-dialog-cancel').click();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('omits the description block when no description is provided', async () => {
    const screen = await mount(
      <ConfirmDialog open onOpenChange={vi.fn()} title="No description" onConfirm={vi.fn()} />,
    );
    await expect.element(screen.getByText('No description')).toBeVisible();
    // The description (DialogDescription) only renders when `description` is set.
    expect(document.querySelector('[data-slot="dialog-description"]')).toBeNull();
  });

  it('renders a destructive confirm button with a custom label and testID prefix', async () => {
    const onConfirm = vi.fn();
    const screen = await mount(
      <ConfirmDialog
        open
        onOpenChange={vi.fn()}
        title="Delete it?"
        confirmLabel="Delete"
        cancelLabel="Keep"
        destructive
        testIDPrefix="danger"
        onConfirm={onConfirm}
      />,
    );
    await expect.element(screen.getByTestId('danger-confirm')).toHaveTextContent('Delete');
    await expect.element(screen.getByTestId('danger-cancel')).toHaveTextContent('Keep');
  });
});
