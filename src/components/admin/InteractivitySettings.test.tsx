import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingWebhook, InteractionStatus } from '@/types';
import { InteractivitySettings } from './InteractivitySettings';

const mockApiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => mockApiFetch(...args) }));
vi.mock('@/lib/clipboard', () => ({ copyToClipboard: vi.fn().mockResolvedValue(true) }));

const auth = vi.hoisted(() => ({ user: { id: 'u-1', systemRole: 'admin' } as { id: string; systemRole: string } | null }));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ user: auth.user, isAuthenticated: true }) }));

const base: IncomingWebhook = {
  id: 'wh-1',
  title: 'Release bot',
  channelID: 'ch-1',
  lockToChannel: true,
  createdBy: 'u-1',
  createdAt: '2026-10-30T10:00:00Z',
} as IncomingWebhook;

const path = '/api/v1/admin/webhooks/wh-1/interactivity';

// routes answers each request by "METHOD path"; the status GET answers status.
function serve(status: InteractionStatus | (() => Promise<unknown>), routes: Record<string, (body: unknown) => unknown> = {}) {
  mockApiFetch.mockImplementation((p: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET' && p === path) return typeof status === 'function' ? status() : Promise.resolve(status);
    const route = routes[`${method} ${p}`];
    if (!route) return Promise.reject(new Error(`unexpected ${method} ${p}`));
    try {
      return Promise.resolve(route(init?.body ? JSON.parse(init.body) : undefined));
    } catch (err) {
      return Promise.reject(err);
    }
  });
}

function renderSettings(webhook: IncomingWebhook = base) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <InteractivitySettings webhook={webhook} />
    </QueryClientProvider>,
  );
}

const open = () => fireEvent.click(screen.getByTestId('interactivity-toggle-wh-1'));
const statusOf = (webhook: Partial<IncomingWebhook>, extra: Partial<InteractionStatus> = {}): InteractionStatus => ({
  webhook: { ...base, ...webhook },
  interactions: [],
  ...extra,
});

beforeEach(() => {
  mockApiFetch.mockReset();
  auth.user = { id: 'u-1', systemRole: 'admin' };
});

describe('InteractivitySettings', () => {
  it('stays folded and loads nothing until opened, showing the state', () => {
    const { rerender } = renderSettings();
    expect(screen.getByTestId('interactivity-toggle-wh-1')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('Off')).toBeInTheDocument();
    expect(mockApiFetch).not.toHaveBeenCalled();
    const qc = new QueryClient();
    rerender(
      <QueryClientProvider client={qc}>
        <InteractivitySettings webhook={{ ...base, interactivityURL: 'https://app.example.com/i' }} />
      </QueryClientProvider>,
    );
    expect(screen.getByText('On')).toBeInTheDocument();
    rerender(
      <QueryClientProvider client={qc}>
        <InteractivitySettings webhook={{ ...base, interactivityURL: 'https://app.example.com/i', adminPaused: true }} />
      </QueryClientProvider>,
    );
    expect(screen.getByText('Paused')).toBeInTheDocument();
  });

  it('opens on the list values while the status loads, then folds again', async () => {
    let resolve: (v: InteractionStatus) => void = () => {};
    serve(() => new Promise((r) => (resolve = r)));
    renderSettings({ ...base, interactivityURL: 'https://app.example.com/i' });
    open();
    expect(screen.getByTestId('request-url-input-wh-1')).toHaveValue('https://app.example.com/i');
    expect(screen.getByText('No interactions yet.')).toBeInTheDocument();
    resolve(statusOf({ interactivityURL: 'https://app.example.com/new' }));
    await waitFor(() => expect(screen.getByTestId('request-url-input-wh-1')).toHaveValue('https://app.example.com/new'));
    open();
    expect(screen.queryByTestId('request-url-input-wh-1')).toBeNull();
  });

  it('warns while ex has paused the app after failures', async () => {
    serve(statusOf({}, { pausedForSeconds: 290 }));
    renderSettings();
    open();
    expect(await screen.findByRole('status')).toHaveTextContent('resumes in 5 min');
  });

  it('saves the request URL, and turns it off when emptied', async () => {
    const puts: unknown[] = [];
    serve(statusOf({ interactivityURL: 'https://app.example.com/i' }), {
      [`PUT ${path}/request-url`]: (body) => {
        puts.push(body);
        return base;
      },
    });
    renderSettings();
    open();
    const input = await screen.findByTestId('request-url-input-wh-1');
    await waitFor(() => expect(input).toHaveValue('https://app.example.com/i'));
    const save = screen.getByTestId('request-url-save-wh-1');
    expect(save).toBeDisabled();
    fireEvent.change(input, { target: { value: 'https://app.example.com/v2' } });
    expect(save).toHaveTextContent('Save');
    fireEvent.click(save);
    await waitFor(() => expect(puts).toEqual([{ requestURL: 'https://app.example.com/v2' }]));
    // The draft gives way to the saved value once the save lands.
    await waitFor(() => expect(input).toHaveValue('https://app.example.com/i'));
    fireEvent.change(input, { target: { value: ' ' } });
    expect(save).toHaveTextContent('Turn off');
    fireEvent.click(save);
    await waitFor(() => expect(puts).toHaveLength(2));
  });

  it('shows why a request URL was refused', async () => {
    serve(statusOf({}), {
      [`PUT ${path}/request-url`]: () => {
        throw new Error('The request URL must use https');
      },
    });
    renderSettings();
    open();
    const input = await screen.findByTestId('request-url-input-wh-1');
    fireEvent.change(input, { target: { value: 'http://app.example.com' } });
    fireEvent.click(screen.getByTestId('request-url-save-wh-1'));
    expect(await screen.findByRole('alert')).toHaveTextContent('must use https');
    expect(input).toHaveAttribute('aria-invalid', 'true');
  });

  it('falls back to a plain message for an error without one', async () => {
    serve(statusOf({}), {
      [`PUT ${path}/request-url`]: () => {
        throw 'nope';
      },
    });
    renderSettings();
    open();
    fireEvent.change(await screen.findByTestId('request-url-input-wh-1'), { target: { value: 'https://a.example.com' } });
    fireEvent.click(screen.getByTestId('request-url-save-wh-1'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Request failed');
  });

  it('issues a bot token at once and shows it a single time', async () => {
    const posts: unknown[] = [];
    serve(statusOf({}), {
      [`POST ${path}/bot-token`]: (body) => {
        posts.push(body);
        return { token: 'xb-123', webhook: base };
      },
    });
    renderSettings();
    open();
    const card = await screen.findByTestId('credential-bot-token-wh-1');
    expect(within(card).getByText('Not issued')).toBeInTheDocument();
    fireEvent.click(within(card).getByTestId('credential-bot-token-action-wh-1'));
    const revealed = await screen.findByTestId('credential-bot-token-revealed-wh-1');
    expect(revealed).toHaveTextContent('xb-123');
    expect(within(revealed).getByRole('button', { name: 'Copy bot token' })).toBeInTheDocument();
    expect(posts).toEqual([{ revokeNow: false }]);
    fireEvent.click(within(revealed).getByRole('button', { name: 'Done' }));
    expect(screen.queryByTestId('credential-bot-token-revealed-wh-1')).toBeNull();
  });

  it('rotates an issued signing secret after a confirm, optionally revoking the old one', async () => {
    const posts: unknown[] = [];
    serve(statusOf({ hasSigningSecret: true }), {
      [`POST ${path}/signing-secret`]: (body) => {
        posts.push(body);
        return { secret: 'sec-456', webhook: base };
      },
    });
    renderSettings();
    open();
    const action = await screen.findByTestId('credential-signing-secret-action-wh-1');
    await waitFor(() => expect(action).toHaveTextContent('Rotate…'));
    fireEvent.click(action);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(posts).toEqual([]);
    fireEvent.click(screen.getByTestId('credential-signing-secret-action-wh-1'));
    fireEvent.click(screen.getByTestId('credential-signing-secret-revoke-wh-1'));
    fireEvent.click(screen.getByTestId('credential-signing-secret-confirm-wh-1'));
    expect(await screen.findByTestId('credential-signing-secret-revealed-wh-1')).toHaveTextContent('sec-456');
    expect(posts).toEqual([{ revokeNow: true }]);
    expect(screen.queryByTestId('credential-signing-secret-revoke-wh-1')).toBeNull();
  });

  it('reveals nothing when the answer carries no value, and shows a refusal', async () => {
    let fail = false;
    serve(statusOf({}), {
      [`POST ${path}/bot-token`]: () => {
        if (fail) throw new Error('Only the webhook owner can do that');
        return { webhook: base };
      },
    });
    renderSettings();
    open();
    fireEvent.click(await screen.findByTestId('credential-bot-token-action-wh-1'));
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(3));
    expect(screen.queryByTestId('credential-bot-token-revealed-wh-1')).toBeNull();
    fail = true;
    fireEvent.click(screen.getByTestId('credential-bot-token-action-wh-1'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Only the webhook owner');
  });

  it('lets an admin flip the switches', async () => {
    const puts: Array<[string, unknown]> = [];
    serve(statusOf({ emailSharing: false, adminPaused: true }), {
      [`PUT ${path}/email-sharing`]: (body) => {
        puts.push(['email', body]);
        return base;
      },
      [`PUT ${path}/paused`]: (body) => {
        puts.push(['paused', body]);
        return base;
      },
    });
    renderSettings();
    open();
    const paused = await screen.findByTestId('switch-paused-wh-1');
    await waitFor(() => expect(paused).toBeChecked());
    fireEvent.click(screen.getByTestId('switch-email-sharing-wh-1'));
    fireEvent.click(paused);
    await waitFor(() =>
      expect(puts).toEqual([
        ['email', { enabled: true }],
        ['paused', { enabled: false }],
      ]),
    );
    expect(screen.queryByText('Only a workspace admin can change these.')).toBeNull();
  });

  it.each([
    ['a member', { id: 'u-2', systemRole: 'member' }],
    ['nobody signed in', null],
  ])('keeps the switches read-only for %s', async (_, user) => {
    auth.user = user;
    serve(statusOf({}));
    renderSettings();
    open();
    // Base UI marks a disabled switch with data-disabled, not the attribute.
    expect(await screen.findByTestId('switch-email-sharing-wh-1')).toHaveAttribute('data-disabled');
    expect(screen.getByTestId('switch-paused-wh-1')).toHaveAttribute('data-disabled');
    expect(screen.getByText('Only a workspace admin can change these.')).toBeInTheDocument();
  });

  it('needs a URL and a secret before a test can be sent', async () => {
    serve(statusOf({ interactivityURL: 'https://app.example.com/i' }));
    renderSettings();
    open();
    expect(await screen.findByTestId('test-interaction-wh-1')).toBeDisabled();
    expect(screen.getByText('Needs a request URL and a signing secret.')).toBeInTheDocument();
  });

  it('sends a test and shows how the app answered', async () => {
    const results = [
      { ok: true, status: 200, latencyMs: 42, reply: '{"ok":true}' },
      { ok: false, latencyMs: 3000, error: 'The app did not answer within 3 seconds' },
    ];
    serve(statusOf({ interactivityURL: 'https://app.example.com/i', hasSigningSecret: true }), {
      [`POST ${path}/test`]: () => {
        const next = results.shift();
        if (!next) throw new Error('Too many clicks');
        return next;
      },
    });
    renderSettings();
    open();
    const send = await screen.findByTestId('test-interaction-wh-1');
    await waitFor(() => expect(send).toBeEnabled());
    fireEvent.click(send);
    expect(await screen.findByTestId('test-result-wh-1')).toHaveTextContent('Answered 200 in 42 ms');
    expect(screen.getByText('{"ok":true}')).toBeInTheDocument();
    fireEvent.click(send);
    await waitFor(() => expect(screen.getByTestId('test-result-wh-1')).toHaveTextContent('did not answer within 3 seconds'));
    expect(screen.queryByText('{"ok":true}')).toBeNull();
    fireEvent.click(send);
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many clicks');
  });

  it('holds the buttons while a save or a test is on its way', async () => {
    serve(statusOf({ interactivityURL: 'https://app.example.com/i', hasSigningSecret: true }), {
      [`PUT ${path}/request-url`]: () => new Promise(() => {}),
      [`POST ${path}/test`]: () => new Promise(() => {}),
    });
    renderSettings();
    open();
    const send = await screen.findByTestId('test-interaction-wh-1');
    await waitFor(() => expect(send).toBeEnabled());
    fireEvent.click(send);
    await waitFor(() => expect(send).toHaveTextContent('Sending…'));
    expect(send).toBeDisabled();
    fireEvent.change(screen.getByTestId('request-url-input-wh-1'), { target: { value: 'https://app.example.com/v2' } });
    const save = screen.getByTestId('request-url-save-wh-1');
    fireEvent.click(save);
    await waitFor(() => expect(save).toHaveTextContent('Saving…'));
    expect(save).toBeDisabled();
  });

  it('lists the recent interactions', async () => {
    serve(
      statusOf(
        {},
        {
          interactions: [
            { at: '2026-10-30T10:00:00Z', kind: 'click', actionID: 'approve', result: 'ok', status: 200, latencyMs: 12 },
            { at: '2026-10-30T09:00:00Z', kind: 'response_url', result: 'failed', latencyMs: 0, error: 'used up' },
            { at: '2026-10-30T08:00:00Z', kind: 'test', actionID: 'test', result: 'timeout', latencyMs: 3000 },
            { at: '2026-10-30T07:00:00Z', kind: 'view_submission', actionID: 'booking', result: 'ok', status: 200, latencyMs: 40 },
            { at: '2026-10-30T06:00:00Z', kind: 'view_closed', result: 'ok', status: 200, latencyMs: 8 },
            { at: '2026-10-30T05:00:00Z', kind: 'api', actionID: 'views.open', result: 'failed', latencyMs: 2, error: 'trigger expired' },
          ],
        },
      ),
    );
    renderSettings();
    open();
    fireEvent.click(await screen.findByText('Recent interactions (6)'));
    const rows = screen.getAllByTestId('interaction-row');
    expect(rows[0]).toHaveTextContent('Click · approve');
    expect(rows[0]).toHaveTextContent('OK');
    expect(rows[1]).toHaveTextContent('Response URL');
    expect(rows[1]).toHaveTextContent('Failedused up');
    // A test's action is always "test": not repeated.
    expect(rows[2]).toHaveTextContent('Test');
    expect(rows[2]).not.toHaveTextContent('· test');
    expect(rows[2]).toHaveTextContent('Timed out');
    expect(rows[2]).toHaveTextContent('3000');
    // A form's submission and dismissal, and the app's own calls to ex.
    expect(rows[3]).toHaveTextContent('Form sent · booking');
    expect(rows[4]).toHaveTextContent('Form closed');
    expect(rows[4]).not.toHaveTextContent('·');
    expect(rows[5]).toHaveTextContent('API call · views.open');
    expect(rows[5]).toHaveTextContent('Failedtrigger expired');
  });
});
