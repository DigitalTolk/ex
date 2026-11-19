import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SharePointHostsProvider } from './SharePointHostsProvider';
import { useSharePointHosts } from '@/hooks/useSharePoint';

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return { ...actual, apiFetch: (...args: unknown[]) => apiFetchMock(...args) };
});
const auth = vi.hoisted(() => ({ user: null as { id: string } | null }));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => auth }));

function Hosts() {
  return <p data-testid="hosts">{useSharePointHosts().join(',')}</p>;
}

function renderProvider() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SharePointHostsProvider>
        <Hosts />
      </SharePointHostsProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiFetchMock.mockReset();
  apiFetchMock.mockResolvedValue({ maxUploadBytes: 0, allowedExtensions: [], sharePointHosts: ['*.sharepoint.com'] });
});

describe('SharePointHostsProvider', () => {
  it('hands the settings hosts to everything below it once signed in', async () => {
    auth.user = { id: 'u-1' };
    renderProvider();
    expect(await screen.findByText('*.sharepoint.com')).toBeInTheDocument();
  });

  it('reads nothing before sign-in', () => {
    auth.user = null;
    renderProvider();
    expect(screen.getByTestId('hosts').textContent).toBe('');
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});
