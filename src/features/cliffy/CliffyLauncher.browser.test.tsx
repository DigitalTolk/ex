import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CliffyLauncher } from './CliffyLauncher';
import { MessageInput } from '@/components/chat/MessageInput';
import { useCliffyStore } from './cliffy-store';
import { swipe } from '@/test/gestures';

// The panel is a whole feature of its own (transcript, streaming, bridge auth)
// and is covered by its own suites — stub it so these tests observe only what
// the launcher does: show/hide, open/close, drag, and stay out of the way.
vi.mock('./CliffyPanel', () => ({
  CliffyPanel: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="cliffy-panel">
      <button type="button" data-testid="panel-close" onClick={onClose}>
        close
      </button>
    </div>
  ),
}));

// MessageInput is rendered for real in the geometry test — the whole point is to
// measure the ACTUAL docked composer, not a stand-in whose height I chose. Its
// data dependencies are stubbed the same way its own browser suite stubs them.
vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn().mockResolvedValue([]),
  setAccessToken: vi.fn(),
  getAccessToken: vi.fn(() => null),
  clearAccessToken: vi.fn(),
  refreshAccessToken: vi.fn().mockResolvedValue(null),
  ApiError: class ApiError extends Error {
    status: number;

    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

vi.mock('@/hooks/useSettings', () => ({
  useWorkspaceSettings: () => ({
    data: { maxUploadBytes: 0, allowedExtensions: [] as string[], giphyEnabled: false, giphyAPIKey: '' },
  }),
  useUpdateWorkspaceSettings: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/useConversations', () => ({
  useOpenDM: () => ({ openDM: vi.fn(), isPending: false }),
  useAllUsers: () => ({ data: [] }),
}));

vi.mock('@/hooks/useAttachments', () => ({
  uploadAttachment: vi.fn(),
  useDeleteDraftAttachment: () => ({ mutateAsync: vi.fn(), mutate: vi.fn(), isPending: false }),
  useAttachment: () => ({ data: undefined, isLoading: false }),
  useAttachmentsBatch: () => ({ map: new Map(), isLoading: false }),
}));

const WIDGET_LS_KEY = 'cliffy.widget.v1';

beforeEach(() => {
  window.localStorage.removeItem(WIDGET_LS_KEY);
});

function launcher() {
  return document.querySelector('[data-testid="cliffy-launcher"]') as HTMLElement | null;
}

/** True when two boxes share any pixel — the launcher must never do this with
 *  the composer, or it eats clicks meant for Send or for the editor. */
function intersects(a: DOMRect, b: DOMRect) {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

describe('CliffyLauncher', () => {
  it('keeps its whole hit area clear of the docked composer, which stays clickable', async () => {
    const onSend = vi.fn();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // A full-viewport shell, as the app shell is: the composer docks at the
    // real bottom of the real window, so the measured gap is the one users get.
    const screen = await render(
      <QueryClientProvider client={qc}>
        <div style={{ position: 'fixed', inset: 0, height: '100dvh', display: 'flex', flexDirection: 'column' }}>
          <div style={{ flex: 1 }} />
          <MessageInput onSend={onSend} />
        </div>
        <CliffyLauncher />
      </QueryClientProvider>,
    );

    const composer = document.querySelector('[data-message-composer]') as HTMLElement;
    expect(composer).not.toBeNull();
    const el = launcher();
    expect(el).not.toBeNull();
    await expect.element(el!).toBeVisible();

    // The invariant that the ANCHOR_BOTTOM constant exists to hold.
    expect(intersects(el!.getBoundingClientRect(), composer.getBoundingClientRect())).toBe(false);

    // And prove it end to end: type, then hit the real Send button. If the
    // launcher overlapped it, this click would land on the mascot instead.
    const editor = screen.getByLabelText('Message input');
    await editor.click();
    await editor.fill('hello from the composer');
    await screen.getByLabelText('Send message').click();
    await vi.waitFor(() => {
      expect(onSend).toHaveBeenCalledTimes(1);
    });
    expect(onSend.mock.calls[0][0].body).toBe('hello from the composer');
    // Still closed — nothing about sending touches Cliffy.
    expect(document.querySelector('[data-testid="cliffy-panel"]')).toBeNull();
  });

  it('opens the panel on click and closes it again', async () => {
    const screen = await render(<CliffyLauncher />);
    await screen.getByLabelText('Open Cliffy (Cmd/Ctrl+Shift+C)').click();
    await expect.element(screen.getByTestId('cliffy-panel')).toBeVisible();
    // The mascot yields to the panel rather than floating over it.
    expect(launcher()).toBeNull();

    await screen.getByTestId('panel-close').click();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="cliffy-panel"]')).toBeNull();
    });
    expect(launcher()).not.toBeNull();
  });

  it('Cmd/Ctrl+Shift+C toggles the panel open and closed', async () => {
    await render(<CliffyLauncher />);

    const press = () =>
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'C', metaKey: true, shiftKey: true, bubbles: true, cancelable: true }),
      );

    press();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="cliffy-panel"]')).not.toBeNull();
    });
    press();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="cliffy-panel"]')).toBeNull();
    });
    // The shortcut is also the way back from a dismissal, so it must survive it.
    useCliffyStore.getState().hide();
    press();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="cliffy-panel"]')).not.toBeNull();
    });
  });

  it('the × dismisses the widget, persists that, and renders nothing on the next visit', async () => {
    const screen = await render(<CliffyLauncher />);
    // The × is hover-revealed on desktop, so it must be hovered before it can be
    // clicked — a plain click would time out on `display: none`.
    await screen.getByTestId('cliffy-launcher').hover();
    await screen
      .getByLabelText('Hide Cliffy (type /cliffy or press Cmd/Ctrl+Shift+C to bring it back)')
      .click();

    await vi.waitFor(() => {
      expect(launcher()).toBeNull();
    });
    expect(JSON.parse(window.localStorage.getItem(WIDGET_LS_KEY) ?? '{}').hidden).toBe(true);

    // A fresh mount while hidden takes the early-return path — no mascot, but
    // the shortcut listener is still registered, which is what makes it
    // recoverable.
    await render(<CliffyLauncher />);
    expect(launcher()).toBeNull();
    useCliffyStore.getState().showWidget();
    await vi.waitFor(() => {
      expect(launcher()).not.toBeNull();
    });
    expect(JSON.parse(window.localStorage.getItem(WIDGET_LS_KEY) ?? '{}').hidden).toBe(false);
  });

  it('a drag moves and persists the mascot, and its trailing click does not open the panel', async () => {
    await render(<CliffyLauncher />);
    const el = launcher()!;
    const before = el.getBoundingClientRect();
    const button = document.querySelector(
      '[aria-label="Open Cliffy (Cmd/Ctrl+Shift+C)"]',
    ) as HTMLElement;

    // A real Motion drag: pointerdown on the element, moves/up on window, spread
    // across frames. `settle` keeps the release velocity near zero so the icon
    // stops where it was dropped instead of being flung into a constraint.
    await swipe(button, { dx: -100, dy: -100, steps: 8, settle: true });
    // The browser follows a drag with a click on the element it started on.
    button.click();

    await vi.waitFor(() => {
      const after = launcher()!.getBoundingClientRect();
      expect(after.left).toBeLessThan(before.left);
      expect(after.top).toBeLessThan(before.top);
    });
    // The trailing click was swallowed as the end of the drag.
    expect(document.querySelector('[data-testid="cliffy-panel"]')).toBeNull();
    expect(useCliffyStore.getState().launcherPos).not.toBeNull();
    const saved = JSON.parse(window.localStorage.getItem(WIDGET_LS_KEY) ?? '{}');
    expect(saved.pos.x).toBeLessThan(0);
    expect(saved.pos.y).toBeLessThan(0);

    // A plain click after the drag settles still opens — the guard is one-shot,
    // not a latch that leaves the mascot permanently dead.
    button.click();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="cliffy-panel"]')).not.toBeNull();
    });
  });

  it('restores a persisted drag offset on mount', async () => {
    window.localStorage.setItem(
      WIDGET_LS_KEY,
      JSON.stringify({ hidden: false, pos: { x: -120, y: -90 } }),
    );
    // The store reads localStorage once at module load, so seed the state the
    // way a reload would have produced it.
    useCliffyStore.setState({ launcherPos: { x: -120, y: -90 }, hidden: false });

    await render(<CliffyLauncher />);
    const el = launcher()!;
    // Rendered 120px left and 90px up of the anchor, not at it.
    expect(el.getBoundingClientRect().right).toBeLessThan(window.innerWidth - 120);
    expect(getComputedStyle(el).transform).not.toBe('none');
  });
});
