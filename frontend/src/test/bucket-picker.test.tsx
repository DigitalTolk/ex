import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

import { BucketPicker } from '@/components/search/BucketPicker';

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

beforeEach(() => {
  apiFetchMock.mockReset();
  apiFetchMock.mockResolvedValue([]);
});

describe('BucketPicker', () => {
  it('renders the empty-state when no buckets are present', () => {
    const onPick = vi.fn();
    wrap(
      <BucketPicker kind="users" buttonLabel="From ▾" buckets={[]} onPick={onPick} />,
    );
    fireEvent.click(screen.getByTestId('bucket-picker-users'));
    expect(screen.getByText(/no options/i)).toBeInTheDocument();
  });

  it('lists buckets with counts and resolves user labels', async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/v1/users/batch')) {
        return Promise.resolve([
          { id: 'u-1', displayName: 'Alice' },
          { id: 'u-2', displayName: 'Bob' },
        ]);
      }
      return Promise.resolve([]);
    });
    const onPick = vi.fn();
    wrap(
      <BucketPicker
        kind="users"
        buttonLabel="From ▾"
        buckets={[
          { key: 'u-1', count: 12 },
          { key: 'u-2', count: 3 },
        ]}
        onPick={onPick}
      />,
    );
    fireEvent.click(screen.getByTestId('bucket-picker-users'));
    await waitFor(() => screen.getByText('Alice'));
    expect(screen.getByText('12')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Alice'));
    expect(onPick).toHaveBeenCalledWith('u-1');
  });

  it('renders ~slug for channels', async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url === '/api/v1/channels') {
        return Promise.resolve([
          { channelID: 'c-1', channelName: 'engineering', channelType: 'public' },
        ]);
      }
      return Promise.resolve([]);
    });
    const onPick = vi.fn();
    wrap(
      <BucketPicker
        kind="channels"
        buttonLabel="In ▾"
        buckets={[{ key: 'c-1', count: 5 }]}
        onPick={onPick}
      />,
    );
    fireEvent.click(screen.getByTestId('bucket-picker-channels'));
    await waitFor(() => screen.getByText('~engineering'));
    fireEvent.click(screen.getByText('~engineering'));
    expect(onPick).toHaveBeenCalledWith('c-1');
  });
});
