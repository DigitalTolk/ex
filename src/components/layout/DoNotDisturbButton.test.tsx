import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AuthProvider, useAuth } from '@/context/AuthContext';
import { clearAccessToken } from '@/lib/api';
import { INDEFINITE_SNOOZE_MINUTES } from '@/lib/notification-snooze';
import { showToast } from '@/lib/toast';
import type { User } from '@/types';
import { DoNotDisturbButton, MobilePauseNotifications, PausedMark } from './DoNotDisturbButton';

vi.mock('@/lib/toast', () => ({ showToast: vi.fn() }));

// The whole flow runs against a stand-in server at the fetch boundary: the
// real provider signs alice in, the real API client sends the snooze, and
// the server answers with the user as it now is, as the Go handler does.

const MINUTE = 60_000;
// 10:00 on a weekday, local time: "in an hour" is still today.
const START = new Date(2026, 0, 15, 10, 0);
const SNOOZE_URL = '/api/v1/users/me/notification-snooze';

// The clock time as the user's locale writes it.
const clock = (d: Date) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

interface SnoozeRequest {
  minutes: number;
  authorization: string | null;
  contentType: string | null;
}

let serverUser: User;
let snoozeRequests: SnoozeRequest[];
let snoozeFailure: { status: number; body: string } | null;
const originalFetch = globalThis.fetch;

function alice(snoozeUntil?: string): User {
  return {
    id: 'u-1',
    email: 'alice@example.com',
    displayName: 'Alice',
    systemRole: 'member',
    notificationSettings: snoozeUntil ? { snoozeUntil } : {},
  } as User;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

async function server(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  if (url === '/auth/token/refresh') return json({ accessToken: 'token-1' });
  if (url === '/api/v1/users/me') return json(serverUser);
  if (url === SNOOZE_URL && init?.method === 'PUT') {
    const headers = new Headers(init.headers);
    const { minutes } = JSON.parse(String(init.body)) as { minutes: number };
    snoozeRequests.push({ minutes, authorization: headers.get('Authorization'), contentType: headers.get('Content-Type') });
    if (snoozeFailure) return new Response(snoozeFailure.body, { status: snoozeFailure.status });
    serverUser = alice(minutes > 0 ? new Date(Date.now() + minutes * MINUTE).toISOString() : undefined);
    return json(serverUser);
  }
  return json({ error: `unexpected request ${url}` }, 404);
}

// The rail mounts the button for a signed-in user only.
function SignedIn({ button = true }: { button?: boolean }) {
  const { user } = useAuth();
  if (!user) return null;
  return (
    <>
      <span data-testid="signed-in" />
      {button && <DoNotDisturbButton />}
    </>
  );
}

async function renderButton() {
  render(
    <AuthProvider>
      <SignedIn />
    </AuthProvider>,
  );
  return screen.findByTestId('dnd-trigger');
}

// Unmount while the test's clock is still in place: an effect that runs
// after the real clock is back would measure the snooze against today.
function restoreClock() {
  cleanup();
  vi.useRealTimers();
}

const trigger = () => screen.getByTestId('dnd-trigger');
const snoozedUntil = () => new Date(serverUser.notificationSettings!.snoozeUntil!);

// Opens the menu and picks one of its entries; the menu closes behind it.
async function choose(testID: string) {
  fireEvent.click(trigger());
  fireEvent.click(await screen.findByTestId(testID));
  await waitFor(() => expect(screen.queryByTestId('dnd-state')).toBeNull());
}

describe('DoNotDisturbButton', () => {
  beforeEach(() => {
    // Only the calendar is pinned; timers run for real.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START);
    serverUser = alice();
    snoozeRequests = [];
    snoozeFailure = null;
    globalThis.fetch = vi.fn(server);
    vi.mocked(showToast).mockReset();
  });

  afterEach(() => {
    restoreClock();
    globalThis.fetch = originalFetch;
    clearAccessToken();
  });

  it('pauses notifications for the chosen time, stays lit, and brings them back on Resume', async () => {
    const button = await renderButton();
    expect(button).toHaveAttribute('aria-label', 'Pause notifications');
    expect(button).toHaveAttribute('data-paused', 'false');

    // At rest the menu explains what pausing does and offers no Resume.
    fireEvent.click(button);
    expect(await screen.findByTestId('dnd-state')).toHaveTextContent(
      'No popups, sounds or phone alerts. Nothing is lost: it all waits in Activity.',
    );
    expect(screen.getByText('Pause notifications')).toBeInTheDocument();
    expect(screen.queryByTestId('dnd-resume')).toBeNull();

    fireEvent.click(screen.getByTestId('dnd-1h'));
    await waitFor(() => expect(trigger()).toHaveAttribute('data-paused', 'true'));

    // The snooze went to the server, as alice, as JSON.
    expect(snoozeRequests).toEqual([{ minutes: 60, authorization: 'Bearer token-1', contentType: 'application/json' }]);
    const until = `until ${clock(snoozedUntil())}`;
    expect(trigger()).toHaveAttribute('aria-label', `Notifications paused ${until}`);
    expect(trigger()).toHaveAttribute('title', `Notifications paused ${until}`);
    await waitFor(() => expect(screen.queryByTestId('dnd-state')).toBeNull());

    // While paused the menu says until when, and Resume leads it.
    fireEvent.click(trigger());
    expect(await screen.findByTestId('dnd-state')).toHaveTextContent(`Paused ${until}.`);
    expect(screen.getByText('Notifications are paused')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('dnd-resume'));
    await waitFor(() => expect(trigger()).toHaveAttribute('data-paused', 'false'));
    expect(snoozeRequests.map((r) => r.minutes)).toEqual([60, 0]);
    expect(trigger()).toHaveAttribute('aria-label', 'Pause notifications');
    expect(serverUser.notificationSettings?.snoozeUntil).toBeUndefined();
  });

  it.each([
    { testID: 'dnd-30m', label: 'For 30 minutes', minutes: 30 },
    { testID: 'dnd-1h', label: 'For 1 hour', minutes: 60 },
    { testID: 'dnd-2h', label: 'For 2 hours', minutes: 120 },
  ])('"$label" snoozes for $minutes minutes', async ({ testID, label, minutes }) => {
    await renderButton();
    fireEvent.click(trigger());
    expect(await screen.findByTestId(testID)).toHaveTextContent(label);
    fireEvent.click(screen.getByTestId(testID));
    await waitFor(() => expect(trigger()).toHaveAttribute('data-paused', 'true'));

    expect(snoozeRequests.map((r) => r.minutes)).toEqual([minutes]);
    const end = new Date(START.getTime() + minutes * MINUTE);
    expect(trigger()).toHaveAttribute('aria-label', `Notifications paused until ${clock(end)}`);
  });

  it('"Until tomorrow morning" snoozes to 9 the next day', async () => {
    await renderButton();
    await choose('dnd-tomorrow');
    await waitFor(() => expect(trigger()).toHaveAttribute('data-paused', 'true'));

    // From 10:00 to 9:00 tomorrow.
    expect(snoozeRequests.map((r) => r.minutes)).toEqual([23 * 60]);
    const morning = new Date(2026, 0, 16, 9, 0);
    expect(trigger()).toHaveAttribute('aria-label', `Notifications paused until tomorrow, ${clock(morning)}`);
  });

  it('"Until I turn it back on" snoozes with no end in sight', async () => {
    await renderButton();
    await choose('dnd-indefinite');
    await waitFor(() => expect(trigger()).toHaveAttribute('data-paused', 'true'));

    expect(snoozeRequests.map((r) => r.minutes)).toEqual([INDEFINITE_SNOOZE_MINUTES]);
    expect(trigger()).toHaveAttribute('aria-label', 'Notifications paused until you turn them back on');

    fireEvent.click(trigger());
    expect(await screen.findByTestId('dnd-state')).toHaveTextContent('Paused until you turn them back on.');
  });

  it('changes the end time when another choice is made while paused', async () => {
    await renderButton();
    await choose('dnd-30m');
    await waitFor(() => expect(trigger()).toHaveAttribute('data-paused', 'true'));

    await choose('dnd-2h');
    const later = new Date(START.getTime() + 120 * MINUTE);
    await waitFor(() => expect(trigger()).toHaveAttribute('aria-label', `Notifications paused until ${clock(later)}`));
    expect(snoozeRequests.map((r) => r.minutes)).toEqual([30, 120]);
  });

  it('shows the pause someone already set, on this device or another', async () => {
    serverUser = alice(new Date(START.getTime() + 45 * MINUTE).toISOString());
    const button = await renderButton();
    expect(button).toHaveAttribute('data-paused', 'true');
    expect(button).toHaveAttribute('aria-label', `Notifications paused until ${clock(snoozedUntil())}`);
    expect(snoozeRequests).toEqual([]);
  });

  it('says why and stays as it was when the server refuses', async () => {
    snoozeFailure = { status: 500, body: JSON.stringify({ error: 'snooze unavailable' }) };
    await renderButton();
    await choose('dnd-1h');

    await waitFor(() => expect(showToast).toHaveBeenCalledWith('snooze unavailable', 'error'));
    expect(snoozeRequests.map((r) => r.minutes)).toEqual([60]);
    expect(trigger()).toHaveAttribute('data-paused', 'false');
    expect(trigger()).toHaveAttribute('aria-label', 'Pause notifications');
  });
});

describe('DoNotDisturbButton, when the time runs out', () => {
  beforeEach(() => {
    serverUser = alice(new Date(START.getTime() + 30 * MINUTE).toISOString());
    snoozeRequests = [];
    snoozeFailure = null;
    globalThis.fetch = vi.fn(server);
  });

  afterEach(() => {
    restoreClock();
    globalThis.fetch = originalFetch;
    clearAccessToken();
  });

  it('comes back on by itself, with no request', async () => {
    // Alice signs in first; the button then mounts under a clock the test
    // holds, half an hour before her snooze ends.
    const { rerender } = render(
      <AuthProvider>
        <SignedIn button={false} />
      </AuthProvider>,
    );
    await screen.findByTestId('signed-in');
    vi.useFakeTimers();
    vi.setSystemTime(START);
    rerender(
      <AuthProvider>
        <SignedIn />
      </AuthProvider>,
    );
    expect(trigger()).toHaveAttribute('data-paused', 'true');
    expect(trigger()).toHaveAttribute('aria-label', `Notifications paused until ${clock(snoozedUntil())}`);

    // A moment before the end it is still paused.
    act(() => {
      vi.advanceTimersByTime(30 * MINUTE - 1);
    });
    expect(trigger()).toHaveAttribute('data-paused', 'true');

    act(() => {
      vi.advanceTimersByTime(MINUTE);
    });
    expect(trigger()).toHaveAttribute('data-paused', 'false');
    expect(trigger()).toHaveAttribute('aria-label', 'Pause notifications');
    expect(snoozeRequests).toEqual([]);
  });
});

// The phone has no rail: Do Not Disturb is the first row of the You sheet,
// and the You tab carries a mark while it is on.
describe('MobilePauseNotifications', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START);
    serverUser = alice();
    snoozeRequests = [];
    snoozeFailure = null;
    globalThis.fetch = vi.fn(server);
  });

  afterEach(() => {
    restoreClock();
    globalThis.fetch = originalFetch;
    clearAccessToken();
  });

  function PhoneSheet() {
    const { user } = useAuth();
    if (!user) return null;
    return (
      <>
        <span data-testid="you-tab">
          You
          <PausedMark />
        </span>
        <MobilePauseNotifications />
      </>
    );
  }

  it('pauses from the You sheet, marks the You tab, and resumes', async () => {
    render(
      <AuthProvider>
        <PhoneSheet />
      </AuthProvider>,
    );
    const toggle = await screen.findByTestId('mobile-dnd-toggle');
    expect(toggle).toHaveTextContent('Pause notifications');
    expect(screen.getByTestId('mobile-dnd-state')).toHaveTextContent('No popups, sounds or phone alerts');
    expect(screen.queryByTestId('mobile-tab-paused')).toBeNull();

    // Closed until tapped; open, it offers the choices and no Resume.
    expect(screen.queryByTestId('mobile-dnd-1h')).toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.queryByTestId('mobile-dnd-resume')).toBeNull();
    fireEvent.click(screen.getByTestId('mobile-dnd-1h'));

    await waitFor(() => expect(screen.getByTestId('mobile-dnd-toggle')).toHaveTextContent('Notifications paused'));
    expect(snoozeRequests.map((r) => r.minutes)).toEqual([60]);
    expect(screen.getByTestId('mobile-dnd-state')).toHaveTextContent(`Paused until ${clock(snoozedUntil())}`);
    // Picking closed the choices; the You tab now says it is paused.
    expect(screen.queryByTestId('mobile-dnd-1h')).toBeNull();
    expect(screen.getByTestId('you-tab').querySelector('[data-testid="mobile-tab-paused"]')).not.toBeNull();

    fireEvent.click(screen.getByTestId('mobile-dnd-toggle'));
    fireEvent.click(screen.getByTestId('mobile-dnd-resume'));
    await waitFor(() => expect(screen.getByTestId('mobile-dnd-toggle')).toHaveTextContent('Pause notifications'));
    expect(snoozeRequests.map((r) => r.minutes)).toEqual([60, 0]);
    expect(screen.queryByTestId('mobile-tab-paused')).toBeNull();

    // Tapping the row again closes the choices without picking.
    fireEvent.click(screen.getByTestId('mobile-dnd-toggle'));
    fireEvent.click(screen.getByTestId('mobile-dnd-toggle'));
    expect(screen.queryByTestId('mobile-dnd-1h')).toBeNull();
  });
});
