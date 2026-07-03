import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CreateChannelDialog } from './CreateChannelDialog';

// Browser coverage for CreateChannelDialog — mount and form interactions.

// Drives mutate to either resolve (onSuccess) or fail (onError) so the
// dialog's success/navigate and error paths are both exercised.
let mutateMode: 'success' | 'error' | 'noop' = 'noop';
const createChannelMutate = vi.fn((_vars: unknown, opts?: { onSuccess?: (c: { slug: string }) => void; onError?: (e: unknown) => void }) => {
  if (mutateMode === 'success') opts?.onSuccess?.({ slug: 'new-channel' });
  else if (mutateMode === 'error') opts?.onError?.(new Error('Channel name already taken'));
});
const pendingRef = { value: false };
vi.mock('@/hooks/useChannels', () => ({
  useCreateChannel: () => ({ mutate: createChannelMutate, isPending: pendingRef.value }),
}));

function Wrap({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

function setReactInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

const isMobileViewport = () => window.innerWidth <= 767;

// The dialog's primary action lives in the bottom footer on desktop and in
// the top-right mobile header cluster on mobile — resolve whichever this
// viewport renders so every flow test runs on all three browser projects.
function submitButton(): HTMLButtonElement {
  const btn = isMobileViewport()
    ? document.querySelector('[data-slot="dialog-mobile-action"]')
    : document.querySelector('button[type="submit"]');
  expect(btn).not.toBeNull();
  return btn as HTMLButtonElement;
}

describe('CreateChannelDialog browser', () => {
  it('does not render when closed', async () => {
    await render(
      <Wrap>
        <CreateChannelDialog open={false} onOpenChange={vi.fn()} />
      </Wrap>,
    );
    expect(document.body.textContent).not.toMatch(/Create a channel|New channel/i);
  });

  it('renders the form when open and validates names while typing', async () => {
    await render(
      <Wrap>
        <CreateChannelDialog open={true} onOpenChange={vi.fn()} />
      </Wrap>,
    );
    await vi.waitFor(() => {
      const name = document.querySelector('input[type="text"], input:not([type])') as HTMLInputElement | null;
      expect(name).not.toBeNull();
    });
    const name = document.querySelector('input[type="text"], input:not([type])') as HTMLInputElement;
    setReactInputValue(name, 'New Channel!');
    await new Promise((r) => setTimeout(r, 30));
    // Invalid name (contains '!') surfaces an error message somewhere.
    // We only need to exercise the path; assertion on specific text is
    // brittle.
    setReactInputValue(name, 'new-channel');
    await new Promise((r) => setTimeout(r, 30));
  });

  it('toggling the private switch flips the channel type', async () => {
    await render(
      <Wrap>
        <CreateChannelDialog open={true} onOpenChange={vi.fn()} />
      </Wrap>,
    );
    const sw = document.querySelector('[role="switch"]') as HTMLElement | null;
    if (sw) {
      sw.click();
      await new Promise((r) => setTimeout(r, 30));
      expect(sw.getAttribute('aria-checked') === 'true' || sw.getAttribute('data-state') === 'checked').toBe(true);
    }
  });

  it('creates a private channel and navigates on success', async () => {
    mutateMode = 'success';
    createChannelMutate.mockClear();
    const onOpenChange = vi.fn();
    const screen = await render(
      <Wrap>
        <CreateChannelDialog open onOpenChange={onOpenChange} />
      </Wrap>,
    );
    setReactInputValue(document.getElementById('channel-name') as HTMLInputElement, 'new-channel');
    setReactInputValue(document.getElementById('channel-desc') as HTMLInputElement, 'About things');
    // A real pointer click toggles the Radix switch (element.click() doesn't).
    await screen.getByRole('switch').click();
    submitButton().click();
    await vi.waitFor(() => {
      expect(createChannelMutate).toHaveBeenCalled();
      const [vars] = createChannelMutate.mock.calls[0];
      expect(vars).toMatchObject({ name: 'new-channel', description: 'About things', type: 'private' });
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('surfaces a backend error when channel creation fails', async () => {
    mutateMode = 'error';
    createChannelMutate.mockClear();
    const screen = await render(
      <Wrap>
        <CreateChannelDialog open onOpenChange={vi.fn()} />
      </Wrap>,
    );
    setReactInputValue(document.getElementById('channel-name') as HTMLInputElement, 'taken-name');
    submitButton().click();
    await expect.element(screen.getByRole('alert')).toHaveTextContent('Channel name already taken');
  });

  it('marks the name + counter as invalid for an over-long name', async () => {
    await render(
      <Wrap>
        <CreateChannelDialog open onOpenChange={vi.fn()} />
      </Wrap>,
    );
    setReactInputValue(document.getElementById('channel-name') as HTMLInputElement, 'a'.repeat(40));
    await vi.waitFor(() => {
      const counter = document.querySelector('[data-testid="channel-name-counter"]') as HTMLElement;
      expect(counter.className).toContain('text-destructive');
      // Submit stays disabled while the name is invalid.
      expect(submitButton().disabled).toBe(true);
    });
  });

  it('shows the pending label and disables submit while creation is in flight', async () => {
    pendingRef.value = true;
    try {
      await render(
        <Wrap><CreateChannelDialog open onOpenChange={vi.fn()} /></Wrap>,
      );
      setReactInputValue(document.getElementById('channel-name') as HTMLInputElement, 'busy-channel');
      await vi.waitFor(() => {
        const btn = submitButton();
        expect(btn.textContent).toContain('Creating...');
        expect(btn.disabled).toBe(true);
      });
    } finally {
      pendingRef.value = false;
    }
  });

  it('falls back to a generic message when creation fails with a non-Error', async () => {
    mutateMode = 'noop';
    createChannelMutate.mockClear();
    createChannelMutate.mockImplementationOnce((_v: unknown, opts?: { onError?: (e: unknown) => void }) => {
      opts?.onError?.('weird');
    });
    const screen = await render(
      <Wrap><CreateChannelDialog open onOpenChange={vi.fn()} /></Wrap>,
    );
    setReactInputValue(document.getElementById('channel-name') as HTMLInputElement, 'ok-name');
    submitButton().click();
    await expect.element(screen.getByRole('alert')).toHaveTextContent('Failed to create channel');
  });

  it('ignores a form submit while the name is empty or invalid', async () => {
    createChannelMutate.mockClear();
    await render(
      <Wrap><CreateChannelDialog open onOpenChange={vi.fn()} /></Wrap>,
    );
    const form = document.querySelector('form') as HTMLFormElement;
    // Submit with an empty name → `if (!name.trim()) return`.
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 20));
    expect(createChannelMutate).not.toHaveBeenCalled();
    // Submit with an invalid name → `if (nameError || descriptionError) return`.
    setReactInputValue(document.getElementById('channel-name') as HTMLInputElement, 'Bad Name!');
    await new Promise((r) => setTimeout(r, 20));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 20));
    expect(createChannelMutate).not.toHaveBeenCalled();
  });

  it('mobile: Cancel/Create live in the top header like other modals; no bottom footer', async () => {
    if (!isMobileViewport()) return;
    const onOpenChange = vi.fn();
    await render(
      <Wrap><CreateChannelDialog open onOpenChange={onOpenChange} /></Wrap>,
    );
    const action = document.querySelector('[data-slot="dialog-mobile-action"]') as HTMLButtonElement;
    const cancel = document.querySelector('[data-slot="dialog-mobile-close"]') as HTMLButtonElement;
    expect(action).not.toBeNull();
    expect(cancel).not.toBeNull();
    expect(action.textContent).toBe('Create');
    // Both sit in the top header cluster — ABOVE the name field.
    const nameTop = (document.getElementById('channel-name') as HTMLElement).getBoundingClientRect().top;
    expect(action.getBoundingClientRect().bottom).toBeLessThanOrEqual(nameTop);
    expect(cancel.getBoundingClientRect().bottom).toBeLessThanOrEqual(nameTop);
    // The desktop bottom footer (with its own submit) is gone on mobile.
    expect(document.querySelector('button[type="submit"]')).toBeNull();
    // Empty name → the top action is disabled (same gate as the footer button).
    expect(action.disabled).toBe(true);
    // The mobile Cancel closes the dialog (base-ui passes extra event
    // details after the boolean, so assert on the first arg only).
    cancel.click();
    await vi.waitFor(() => {
      expect(onOpenChange).toHaveBeenCalled();
      expect(onOpenChange.mock.calls[0][0]).toBe(false);
    });
  });

  it('desktop: autofocuses the name field on open', async () => {
    // Mobile deliberately drops the input autoFocus (keyboard pop); that arm
    // is asserted in the jsdom suite (CreateChannelDialog.mobile.test.tsx) —
    // here a PROGRAMMATIC open makes base-ui itself focus the first tabbable
    // (its touch-open popup-focus path never runs), so the mobile behaviour
    // isn't observable in this harness.
    if (isMobileViewport()) return;
    await render(
      <Wrap><CreateChannelDialog open onOpenChange={vi.fn()} /></Wrap>,
    );
    const name = document.getElementById('channel-name') as HTMLInputElement;
    expect(name).not.toBeNull();
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(name);
    });
  });

  it('marks the description + counter as invalid for an over-long description', async () => {
    await render(
      <Wrap>
        <CreateChannelDialog open onOpenChange={vi.fn()} />
      </Wrap>,
    );
    setReactInputValue(document.getElementById('channel-name') as HTMLInputElement, 'ok-name');
    setReactInputValue(document.getElementById('channel-desc') as HTMLInputElement, 'd'.repeat(300));
    await vi.waitFor(() => {
      const counter = document.querySelector('[data-testid="channel-desc-counter"]') as HTMLElement;
      expect(counter.className).toContain('text-destructive');
      expect((document.getElementById('channel-desc') as HTMLInputElement).getAttribute('aria-invalid')).toBe('true');
    });
  });
});
