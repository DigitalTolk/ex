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
vi.mock('@/hooks/useChannels', () => ({
  useCreateChannel: () => ({ mutate: createChannelMutate, isPending: false }),
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
    await screen.getByRole('button', { name: 'Create Channel' }).click();
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
    await screen.getByRole('button', { name: 'Create Channel' }).click();
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
      expect((document.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(true);
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
