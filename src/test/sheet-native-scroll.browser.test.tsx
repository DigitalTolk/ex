import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EmojiPicker } from '@/components/EmojiPicker';
import { nativeTouchScroll, touchScrollWorks } from '@/test/native-scroll';

// The mobile bottom sheets, proven against REAL touch input.
//
// Every other test of these sheets asserts that a gesture does not DISMISS
// them. That is only half the contract, and it is the half that was already
// working: the reported bug was that a finger dragged upward over the picker
// moved nothing at all — the sheet stayed put (correct) and the emoji list
// underneath it never scrolled (the bug). A synthetic pointer sequence cannot
// tell those two apart, because dispatched events never scroll a browser.
// These tests drive genuine compositor-level touch gestures instead, so
// "nothing happened" is a failure rather than a pass.

vi.mock('@/hooks/useEmoji', () => ({
  useEmojis: () => ({ data: [] }),
  useEmojiMap: () => ({ data: {} }),
}));
vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn().mockResolvedValue({}),
  getAccessToken: () => null,
}));
vi.mock('@/lib/emoji-frequency', () => ({
  EMOJI_FREQUENCY_CHANGED_EVENT: 'emoji-frequency-changed',
  getFrequentEmojis: vi.fn(async () => [
    ':smile:', ':joy:', ':heart:', ':thumbsup:', ':fire:', ':tada:', ':eyes:',
  ]),
  recordEmojiUse: vi.fn(),
}));
vi.mock('@/context/AuthContext', () => {
  const state = () => ({ user: null, isAuthenticated: false, isLoading: false, setAuth: vi.fn() });
  return {
    useAuth: state,
    useOptionalAuth: state,
    AuthContext: { Provider: ({ children }: { children: React.ReactNode }) => <>{children}</> },
  };
});

function Wrap({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function openPicker() {
  const screen = await render(
    <Wrap>
      <EmojiPicker onSelect={() => {}} />
    </Wrap>,
  );
  await screen.getByLabelText('Open emoji picker').click();
  // The sheet springs in from off-screen; measure only once it is at rest.
  await settle(700);
  return document.querySelector('[data-testid="emoji-scroll-body"]') as HTMLElement;
}

describe('emoji picker sheet — native touch scrolling', () => {
  it('scrolls when the gesture starts inside the emoji grid', async () => {
    // Probe the harness BEFORE the picker opens (the probe's synthesized
    // input must never land on the surface under test). Gesture assertions
    // run only where the harness can genuinely scroll: webkit has no CDP,
    // and some CI chromium builds synthesize gestures that move nothing.
    const gesturesWork = await touchScrollWorks();
    const body = await openPicker();
    expect(body.scrollHeight).toBeGreaterThan(body.clientHeight);
    if (!gesturesWork) return;

    const rect = body.getBoundingClientRect();
    await nativeTouchScroll(body, {
      dy: -120,
      from: { x: rect.left + rect.width / 2, y: rect.top + rect.height * 0.7 },
    });

    expect(body.scrollTop).toBeGreaterThan(0);
  });

  // The regression. The frequently-used shelf used to sit OUTSIDE the scroll
  // body, so a drag starting on it was claimed by the sheet's dismiss gesture
  // — which is pinned in the up direction and therefore did nothing, while the
  // browser, having handed the gesture to JS, also did nothing. The picker
  // read as frozen.
  it('scrolls when the gesture starts on the frequently-used shelf', async () => {
    const gesturesWork = await touchScrollWorks();
    const body = await openPicker();
    const shelf = document.querySelector('[data-testid="emoji-frequent-grid"]') as HTMLElement;
    expect(shelf).not.toBeNull();
    // The shelf must live inside the one scroll region, not above it.
    expect(body.contains(shelf)).toBe(true);
    if (!gesturesWork) return;

    await nativeTouchScroll(shelf, { dy: -120 });

    expect(body.scrollTop).toBeGreaterThan(0);
  });

  it('keeps the grab handle out of the scroll region so it can still dismiss', async () => {
    await openPicker();
    const handle = document.querySelector('[data-testid="sheet-grab-handle"]') as HTMLElement | null;
    const body = document.querySelector('[data-testid="emoji-scroll-body"]') as HTMLElement;
    if (window.innerWidth > 767) {
      // Desktop renders a popover, not a sheet — no handle to check.
      expect(handle).toBeNull();
      return;
    }
    expect(handle).not.toBeNull();
    expect(body.contains(handle)).toBe(false);
    expect(handle!.getAttribute('data-sheet-drag')).toBe('true');
  });
});
