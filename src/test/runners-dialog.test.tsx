import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RunnersDialog } from '@/components/RunnersDialog';

const mockApiFetch = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

const mac = { id: 'rt1', label: 'Alices-Mac', createdAt: '2026-10-05T00:00:00Z', expiresAt: '2026-11-04T00:00:00Z' };

function renderDialog(open = true) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <RunnersDialog open={open} onOpenChange={() => {}} />
    </QueryClientProvider>,
  );
}

describe('RunnersDialog', () => {
  beforeEach(() => mockApiFetch.mockReset());

  it('fetches nothing while closed', () => {
    renderDialog(false);
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it('shows setup steps for this server when nothing is connected', async () => {
    mockApiFetch.mockResolvedValue({ runners: [] });
    renderDialog();
    expect(screen.getByRole('status')).toHaveTextContent('Loading');
    expect(await screen.findByText('No computers are connected yet.')).toBeInTheDocument();
    expect(screen.getByText(`ex-runner login ${window.location.origin}`)).toBeInTheDocument();
    expect(screen.getByText('ex-runner start')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'install ex-runner' })).toHaveAttribute(
      'href',
      'https://github.com/DigitalTolk/ex-runners#install',
    );
  });

  it('reports a failed load', async () => {
    mockApiFetch.mockRejectedValueOnce(new Error('offline'));
    renderDialog();
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load your runners: offline");
  });

  it('disconnects a runner only after confirming', async () => {
    mockApiFetch.mockImplementation((_path: string, init?: RequestInit) =>
      Promise.resolve(init?.method === 'DELETE' ? undefined : { runners: [mac] }),
    );
    renderDialog();
    expect(await screen.findByText('Alices-Mac')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('runner-disconnect-rt1'));
    expect(screen.getByText('Disconnect Alices-Mac?')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('runner-disconnect-confirm-cancel'));
    await waitFor(() => expect(screen.queryByText('Disconnect Alices-Mac?')).not.toBeInTheDocument());
    expect(mockApiFetch).not.toHaveBeenCalledWith('/api/v1/runner-tokens/rt1', { method: 'DELETE' });

    fireEvent.click(screen.getByTestId('runner-disconnect-rt1'));
    fireEvent.click(screen.getByTestId('runner-disconnect-confirm-confirm'));
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/runner-tokens/rt1', { method: 'DELETE' }));
  });

  it('reports a failed disconnect', async () => {
    mockApiFetch.mockImplementation((_path: string, init?: RequestInit) =>
      init?.method === 'DELETE' ? Promise.reject(new Error('server said no')) : Promise.resolve({ runners: [mac] }),
    );
    renderDialog();
    fireEvent.click(await screen.findByTestId('runner-disconnect-rt1'));
    fireEvent.click(screen.getByTestId('runner-disconnect-confirm-confirm'));
    expect(await screen.findByText("Couldn't disconnect: server said no")).toBeInTheDocument();
  });
});
