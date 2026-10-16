import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RunnersInAppCard } from '@/components/admin/RunnersInAppCard';

const mockApiFetch = vi.fn();
vi.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => mockApiFetch(...args) }));

const saved = { maxUploadBytes: 1024, allowedExtensions: ['png'], giphyAPIKey: 'k', giphyEnabled: true, runnersInApp: false };

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <RunnersInAppCard />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockApiFetch.mockReset();
});

describe('RunnersInAppCard', () => {
  it('is off by default and turns on, carrying the other settings over', async () => {
    const user = userEvent.setup();
    mockApiFetch.mockImplementation((_path: string, init?: RequestInit) =>
      Promise.resolve(init?.method === 'PUT' ? { ...saved, ...JSON.parse(String(init.body)) } : saved),
    );
    mount();
    const toggle = await screen.findByRole('switch', { name: 'Runners in the app' });
    expect(toggle).not.toBeChecked();
    await user.click(toggle);
    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/admin/settings', {
        method: 'PUT',
        body: JSON.stringify({ maxUploadBytes: 1024, allowedExtensions: ['png'], giphyAPIKey: 'k', runnersInApp: true }),
      }),
    );
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Runners in the app' })).toBeChecked());
  });

  it('says when saving fails', async () => {
    const user = userEvent.setup();
    mockApiFetch.mockImplementation((_path: string, init?: RequestInit) =>
      init?.method === 'PUT' ? Promise.reject(new Error('forbidden')) : Promise.resolve(saved),
    );
    mount();
    await user.click(await screen.findByRole('switch', { name: 'Runners in the app' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't save: forbidden");
  });

  it('shows a placeholder while the settings load', () => {
    mockApiFetch.mockReturnValue(new Promise(() => {}));
    mount();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.getByTestId('runners-in-app-card')).toBeInTheDocument();
  });
});
