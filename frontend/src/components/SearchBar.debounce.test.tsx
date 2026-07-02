import { useEffect } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { SearchBar } from './SearchBar';

// Unlike the main SearchBar suite, this file uses the REAL useDebouncedValue
// with fake timers: the 150ms entity-lookup debounce and the deliberate split
// where the message action tracks the LIVE query are behavior, and stubbing
// the debounce to identity everywhere left them unpinned — wiring the search
// hooks to the un-debounced value (a request per keystroke) or debouncing the
// Enter action too would have failed no test.
const useChannelBySlugMock = vi.hoisted(() => vi.fn(() => ({ data: undefined as unknown })));
const useUserConversationsMock = vi.hoisted(() => vi.fn(() => ({ data: [] as unknown[] })));
const openDMMock = vi.hoisted(() => vi.fn());
const useSearchUsersMock = vi.hoisted(() =>
  vi.fn(() => ({ data: { hits: [] as unknown[] }, isLoading: false })),
);
const useSearchChannelsMock = vi.hoisted(() =>
  vi.fn(() => ({ data: { hits: [] as unknown[] }, isLoading: false })),
);
const useUsersBatchMock = vi.hoisted(() =>
  vi.fn(() => ({ map: new Map<string, { avatarURL?: string }>(), isLoading: false })),
);

vi.mock('@/hooks/useChannels', () => ({
  useChannelBySlug: (slug?: string) => useChannelBySlugMock(slug as never),
}));
vi.mock('@/hooks/useConversations', () => ({
  useUserConversations: () => useUserConversationsMock(),
  useOpenDM: () => ({ openDM: openDMMock, isPending: false }),
}));
vi.mock('@/hooks/useSearch', () => ({
  useSearchUsers: (...args: unknown[]) => useSearchUsersMock(...(args as [])),
  useSearchChannels: (...args: unknown[]) => useSearchChannelsMock(...(args as [])),
}));
vi.mock('@/hooks/useUsersBatch', () => ({
  useUsersBatch: (...args: unknown[]) => useUsersBatchMock(...(args as [])),
}));
// NOTE: no mock for '@/hooks/useDebouncedValue' — the real 150ms timer runs.

let lastLocation: { pathname: string; search: string } = { pathname: '/', search: '' };
function LocationProbe() {
  const loc = useLocation();
  useEffect(() => {
    lastLocation = { pathname: loc.pathname, search: loc.search };
  }, [loc.pathname, loc.search]);
  return null;
}

function renderBar() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <SearchBar />
      <LocationProbe />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  useChannelBySlugMock.mockReturnValue({ data: undefined });
  useUserConversationsMock.mockReturnValue({ data: [] });
  useSearchUsersMock.mockReturnValue({ data: { hits: [] }, isLoading: false });
  useSearchChannelsMock.mockReturnValue({ data: { hits: [] }, isLoading: false });
  useUsersBatchMock.mockReturnValue({ map: new Map(), isLoading: false });
  lastLocation = { pathname: '/', search: '' };
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SearchBar debounce wiring (real useDebouncedValue)', () => {
  it('entity lookups lag the keystrokes by 150ms of stillness; rapid typing coalesces to one enabled query', () => {
    renderBar();
    const input = screen.getByTestId('searchbar-input');

    fireEvent.change(input, { target: { value: 'al' } });
    // Immediately after typing the debounced value is still the initial '' —
    // the hooks must be called DISABLED, not with the live keystroke.
    expect(useSearchUsersMock).toHaveBeenLastCalledWith('', false, 5);

    // A second keystroke inside the window resets the timer.
    act(() => {
      vi.advanceTimersByTime(100);
    });
    fireEvent.change(input, { target: { value: 'ali' } });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    // 200ms elapsed but never 150ms of stillness → still the initial value.
    expect(useSearchUsersMock).toHaveBeenLastCalledWith('', false, 5);

    // Stillness completes the debounce: exactly the final query, enabled.
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(useSearchUsersMock).toHaveBeenLastCalledWith('ali', true, 5);
    expect(useSearchChannelsMock).toHaveBeenLastCalledWith('ali', true, 5);
  });

  it('Enter before the debounce fires searches the LIVE query, not the stale debounced one', () => {
    renderBar();
    const input = screen.getByTestId('searchbar-input');

    fireEvent.change(input, { target: { value: 'al' } });
    act(() => {
      vi.advanceTimersByTime(200); // 'al' settles into the debounced value
    });
    fireEvent.change(input, { target: { value: 'alice' } });
    // Enter lands inside the 150ms window: the message action must carry
    // the text the user actually typed.
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(lastLocation.pathname).toBe('/search');
    expect(lastLocation.search).toContain('q=alice');
  });
});
