import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useUploadEmoji, useDeleteEmoji } from './useEmoji';

// Browser-gate coverage for the emoji mutation hooks (upload + delete). The
// query hooks are covered in api-hooks.browser.test.tsx; the mutations — which
// hit the presigned-URL PUT and the failure branch — were not.

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

let realFetch: typeof fetch;
beforeEach(() => {
  apiFetchMock.mockReset();
  realFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function MutationProbe({ hook, vars }: { hook: () => { mutate: (v: unknown) => void; status: string }; vars: unknown }) {
  const m = hook();
  return <button data-testid="trigger" data-status={m.status} onClick={() => m.mutate(vars)} />;
}

function renderMutation(hook: () => { mutate: (v: unknown) => void; status: string }, vars: unknown) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MutationProbe hook={hook} vars={vars} />
    </QueryClientProvider>,
  );
}

describe('useUploadEmoji', () => {
  it('requests a presigned URL, PUTs the file, then POSTs the emoji record', async () => {
    apiFetchMock
      .mockResolvedValueOnce({ uploadURL: 'https://s3.test/put', key: 'emoji/abc' })
      .mockResolvedValueOnce({ name: 'party', imageURL: 'https://cdn.test/party.png' });
    const putMock = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
    globalThis.fetch = putMock as unknown as typeof fetch;
    const file = new File(['x'], 'party.png', { type: 'image/png' });
    const screen = await renderMutation(useUploadEmoji as never, { name: 'party', file });
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(screen.getByTestId('trigger').element().getAttribute('data-status')).toBe('success');
    });
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/v1/uploads/url');
    expect(putMock.mock.calls[0][0]).toBe('https://s3.test/put');
    expect(apiFetchMock.mock.calls[1][0]).toBe('/api/v1/emojis');
  });

  it('errors when the presigned PUT fails (the !put.ok branch)', async () => {
    apiFetchMock.mockResolvedValueOnce({ uploadURL: 'https://s3.test/put', key: 'k' });
    const putMock = vi.fn().mockResolvedValue({ ok: false, status: 403 } as Response);
    globalThis.fetch = putMock as unknown as typeof fetch;
    const file = new File(['x'], 'bad.png', { type: 'image/png' });
    const screen = await renderMutation(useUploadEmoji as never, { name: 'bad', file });
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(screen.getByTestId('trigger').element().getAttribute('data-status')).toBe('error');
    });
  });
});

describe('useDeleteEmoji', () => {
  it('DELETEs /emojis/:name with the name URL-encoded', async () => {
    apiFetchMock.mockResolvedValue(undefined);
    const screen = await renderMutation(useDeleteEmoji as never, 'party time');
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(screen.getByTestId('trigger').element().getAttribute('data-status')).toBe('success');
    });
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/v1/emojis/party%20time');
    expect((apiFetchMock.mock.calls[0][1] as { method: string }).method).toBe('DELETE');
  });
});
