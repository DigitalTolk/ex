import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { userEvent } from 'vitest/browser';
import { newClickID } from '@/lib/app-clicks';
import { openAppView, useAppViewStore } from '@/stores/app-view';
import type { AppView, ViewSubmitResult } from '@/types';
import { AppViewHost } from './AppViewHost';
// The form is a lazy chunk; loaded here, with the file, so no test's wait
// includes its first import (slow under coverage and a loaded machine).
import './AppViewDialog';

const mockApiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => mockApiFetch(...args) }));
const mockToast = vi.hoisted(() => vi.fn());
vi.mock('@/lib/toast', () => ({ showToast: (...args: unknown[]) => mockToast(...args) }));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u-alice' } }) }));

const text = (t: string) => ({ type: 'plain_text' as const, text: t });
const view: AppView = {
  id: 'V1',
  type: 'modal',
  title: text('Reschedule A3'),
  submit: text('Save'),
  hash: 'h1',
  blocks: [
    { type: 'section', block_id: 'intro', text: { type: 'markdown', text: 'A3 is due **Fri**.' } },
    { type: 'input', block_id: 'reason', label: text('Reason'), element: { type: 'plain_text_input', action_id: 'value', multiline: true } },
    { type: 'input', block_id: 'when', label: text('New date'), element: { type: 'datepicker', action_id: 'day', initial_date: '2026-11-02' } },
    {
      type: 'input',
      block_id: 'room',
      label: text('Room'),
      element: { type: 'static_select', action_id: 'room', options: [{ text: text('Room A'), value: 'a' }, { text: text('Room B'), value: 'b' }] },
    },
  ],
};

const el = <T extends HTMLElement = HTMLElement>(testID: string) => document.querySelector<T>(`[data-testid="${testID}"]`);
const day = (date: Date) => document.querySelector<HTMLButtonElement>(`button[data-day="${date.toLocaleDateString()}"]`);
const onPhone = () => window.__EX_FORCE_DEVICE__ === 'touch';
// The submit: the footer's button, or the top bar's on a phone.
const submitButton = () =>
  onPhone() ? document.querySelector<HTMLButtonElement>('[data-slot="dialog-mobile-action"]') : el<HTMLButtonElement>('app-view-submit');

let answers: ViewSubmitResult[];

beforeEach(() => {
  answers = [];
  mockToast.mockReset();
  mockApiFetch.mockReset();
  mockApiFetch.mockImplementation((path: string) => {
    if (path === '/api/v1/emojis') return Promise.resolve([]);
    if (path === '/api/v1/views/V1/submit') return Promise.resolve(answers.shift());
    return Promise.reject(new Error(`unexpected ${path}`));
  });
});

describe('an app form in a real browser', () => {
  it('fills in, picks a date on the calendar over the form, fixes what the app points at, and sends', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await render(
      <QueryClientProvider client={qc}>
        <AppViewHost />
      </QueryClientProvider>,
    );
    openAppView({ view, app: { name: 'MeetingMind' }, clickID: newClickID() });
    await vi.waitFor(() => expect(el('view-V1-reason')).not.toBeNull());
    expect(submitButton()).toHaveTextContent('Save');
    if (onPhone()) expect(el('app-view-submit')).toBeNull();

    await userEvent.fill(el('view-V1-reason')!, 'Out sick');
    await userEvent.selectOptions(el<HTMLSelectElement>('view-V1-room')!, 'b');

    // The calendar opens above the form, on the form's day; a tap picks a
    // day and closes it, leaving the form open.
    // Escape closes only the calendar, never the form under it.
    await userEvent.click(el('view-V1-when-trigger')!);
    await vi.waitFor(() => expect(el('view-V1-when-calendar')).not.toBeNull());
    await userEvent.keyboard('{Escape}');
    await vi.waitFor(() => expect(el('view-V1-when-calendar')).toBeNull());
    expect(el('app-view-dialog')).not.toBeNull();

    await userEvent.click(el('view-V1-when-trigger')!);
    await vi.waitFor(() => expect(day(new Date(2026, 10, 2))).toHaveAttribute('data-selected-single', 'true'));
    await userEvent.click(day(new Date(2026, 10, 19))!);
    await vi.waitFor(() => expect(el('view-V1-when-calendar')).toBeNull());
    expect(el('app-view-dialog')).not.toBeNull();

    answers.push({ action: 'errors', errors: { when: 'Thursdays are full' } });
    await userEvent.click(submitButton()!);
    await vi.waitFor(() => expect(el('view-V1-when-note')).toHaveTextContent('Thursdays are full'));
    await vi.waitFor(() => expect(document.activeElement).toBe(el('view-V1-when-trigger')));

    await userEvent.click(el('view-V1-when-trigger')!);
    await vi.waitFor(() => expect(day(new Date(2026, 10, 20))).not.toBeNull());
    await userEvent.click(day(new Date(2026, 10, 20))!);
    await vi.waitFor(() => expect(el('view-V1-when-note')).toBeNull());

    answers.push({ action: 'close', notice: 'Moved to Fri 20 Nov' });
    await userEvent.click(submitButton()!);
    // Sent: the form says so, with the app's note and what went — then Done
    // (the footer's, or the top bar's on a phone) closes it.
    await vi.waitFor(() => expect(el('app-view-sent')).not.toBeNull());
    const status = Array.from(el('app-view-sent')!.querySelectorAll('[role="status"] p')).map((p) => p.textContent);
    expect(status).toEqual(['Sent to MeetingMind', 'Moved to Fri 20 Nov']);
    const shownAnswers = Array.from(el('app-view-sent')!.querySelectorAll('dt')).map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]);
    expect(shownAnswers).toEqual([
      ['Reason', 'Out sick'],
      ['New date', new Date(2026, 10, 20).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })],
      ['Room', 'Room B'],
    ]);
    expect(mockToast).not.toHaveBeenCalled();
    const done = onPhone() ? document.querySelector<HTMLButtonElement>('[data-slot="dialog-mobile-action"]') : el<HTMLButtonElement>('app-view-done');
    expect(done).toHaveTextContent('Done');
    await userEvent.click(done!);
    await vi.waitFor(() => expect(useAppViewStore.getState().stack).toEqual([]));
    await vi.waitFor(() => expect(el('app-view-dialog')).toBeNull());

    const sent = mockApiFetch.mock.calls.filter(([path]) => path === '/api/v1/views/V1/submit').map(([, init]) => JSON.parse(init.body).values);
    expect(sent).toEqual([
      { reason: { value: 'Out sick' }, when: { day: '2026-11-19' }, room: { room: 'b' } },
      { reason: { value: 'Out sick' }, when: { day: '2026-11-20' }, room: { room: 'b' } },
    ]);
  });
});
