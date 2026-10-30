import { act, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { newClickID } from '@/lib/app-clicks';
import { closeAppView, openAppView } from '@/stores/app-view';
import { AppViewHost } from './AppViewHost';
// The form is a lazy chunk; loaded here, with the file, so no test's wait
// includes its first import (slow under coverage and a loaded machine).
import './AppViewDialog';

const mockApiFetch = vi.hoisted(() => vi.fn(() => Promise.resolve([])));
vi.mock('@/lib/api', () => ({ apiFetch: () => mockApiFetch() }));

const view = { id: 'V1', type: 'modal' as const, title: { type: 'plain_text' as const, text: 'Reschedule A3' }, blocks: [], hash: 'h1' };

function renderHost() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AppViewHost />
    </QueryClientProvider>,
  );
}

describe('AppViewHost', () => {
  it('draws nothing while no form is open in this tab', () => {
    const { container } = renderHost();
    expect(container).toBeEmptyDOMElement();
    // Another tab's click: still nothing here.
    act(() => openAppView({ view, app: { name: 'MeetingMind' }, clickID: 'someone-else' }));
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('app-view-dialog')).toBeNull();
  });

  it('loads and shows the form when the app opens one for this tab, and takes it away on close', async () => {
    renderHost();
    act(() => openAppView({ view, app: { name: 'MeetingMind' }, clickID: newClickID() }));
    expect(await screen.findByRole('heading', { name: 'Reschedule A3' })).toBeInTheDocument();
    act(() => closeAppView());
    expect(screen.queryByTestId('app-view-dialog')).toBeNull();
  });
});
