import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CreateChannelDialog } from './CreateChannelDialog';

// Mobile variant of the dialog: the Cancel/Create controls move from the
// bottom footer into the dialog's top header (mobileCloseLabel/mobileAction),
// and the name field must not autofocus (keyboard pop). useIsMobile is
// mocked true so the jsdom suite grades the mobile arms of those branches.

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => true }));

const mockMutate = vi.fn(
  (
    _vars: { name: string; description?: string; type: 'public' | 'private' },
    opts?: { onSuccess?: (channel: { slug: string; id: string }) => void },
  ) => {
    opts?.onSuccess?.({ slug: 'marketing', id: 'ch-123' });
  },
);
let mockIsPending = false;

vi.mock('@/hooks/useChannels', () => ({
  useCreateChannel: () => ({ mutate: mockMutate, isPending: mockIsPending }),
}));

function renderDialog(onOpenChange = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <CreateChannelDialog open onOpenChange={onOpenChange} />
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

function mobileAction(): HTMLButtonElement {
  const btn = document.querySelector('[data-slot="dialog-mobile-action"]');
  expect(btn).not.toBeNull();
  return btn as HTMLButtonElement;
}

describe('CreateChannelDialog (mobile)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsPending = false;
  });

  it('moves Cancel/Create into the top header and drops the bottom footer', () => {
    renderDialog();
    expect(mobileAction()).toHaveTextContent('Create');
    expect(document.querySelector('[data-slot="dialog-mobile-close"]')).not.toBeNull();
    // No footer submit on mobile.
    expect(screen.queryByText('Create Channel')).not.toBeInTheDocument();
    expect(document.querySelector('button[type="submit"]')).toBeNull();
    // Empty name → the header action is disabled (same gate as the footer).
    expect(mobileAction()).toBeDisabled();
  });

  it('creates the channel via the top-header action: mutate → close → navigate', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderDialog(onOpenChange);

    await user.type(screen.getByLabelText('Name'), 'marketing');
    await user.click(mobileAction());

    expect(mockMutate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'marketing', type: 'public' }),
      expect.anything(),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mockNavigate).toHaveBeenCalledWith('/channel/marketing');
  });

  it('shows the pending label on the header action while the mutation is in flight', () => {
    mockIsPending = true;
    renderDialog();
    expect(mobileAction()).toHaveTextContent('Creating...');
    expect(mobileAction()).toBeDisabled();
  });

  it('does not autofocus the name field (no keyboard pop on open)', () => {
    renderDialog();
    expect(document.activeElement).not.toBe(screen.getByLabelText('Name'));
  });
});
