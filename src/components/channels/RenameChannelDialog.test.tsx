import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RenameChannelDialog } from './RenameChannelDialog';
import type { Channel } from '@/types';

// The dialog's own states: the phone layout (Save in the top bar), the
// pending label, and a submit with nothing to save.

const mockMutate = vi.fn();
let mockPending = false;
vi.mock('@/hooks/useChannels', () => ({
  useRenameChannel: () => ({ mutate: mockMutate, isPending: mockPending }),
}));
let mockMobile = false;
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => mockMobile }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: () => Promise.resolve({ available: true }),
}));

const channel: Channel = {
  id: 'ch-m',
  name: 'marketing',
  slug: 'marketing',
  type: 'public',
  createdBy: 'u-1',
  archived: false,
  createdAt: '2026-01-01T00:00:00Z',
};

function renderDialog() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <RenameChannelDialog channel={channel} onOpenChange={vi.fn()} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('RenameChannelDialog', () => {
  beforeEach(() => {
    mockMutate.mockClear();
    mockPending = false;
    mockMobile = false;
  });

  it('does nothing when submitted with the name unchanged', () => {
    renderDialog();
    fireEvent.submit(screen.getByRole('textbox', { name: 'Name' }).closest('form')!);
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it('shows that it is saving', () => {
    mockPending = true;
    renderDialog();
    expect(screen.getByRole('button', { name: 'Saving...' })).toBeDisabled();
  });

  it('puts Save in the top bar on a phone', () => {
    mockMobile = true;
    renderDialog();
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'growth' } });
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    expect(mockMutate).toHaveBeenCalledWith({ channelId: 'ch-m', name: 'growth' }, expect.anything());
  });

  it('shows the phone top bar as saving', () => {
    mockMobile = true;
    mockPending = true;
    renderDialog();
    expect(screen.getByRole('button', { name: 'Saving...' })).toBeDisabled();
  });
});
