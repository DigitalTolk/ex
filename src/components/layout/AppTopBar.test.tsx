import { afterEach, describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { AppTopBar } from './AppTopBar';
import { historyKeysWillStep } from '@/lib/history-shortcut';
import { installNavigation, uninstallNavigation } from '@/test/fake-navigation';

vi.mock('@/components/SearchBar', () => ({
  SearchBar: () => <div aria-label="Search">search</div>,
}));
const mobile = vi.hoisted(() => ({ value: false }));
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => mobile.value }));

afterEach(() => {
  mobile.value = false;
});

describe('AppTopBar', () => {
  it('renders only the channels button and the search — the account menu lives in the sidebar', () => {
    render(<AppTopBar />);
    expect(screen.getByLabelText('Search')).toBeInTheDocument();
    expect(screen.getByLabelText('Open channels')).toBeInTheDocument();
    expect(screen.queryByLabelText('Account menu')).not.toBeInTheDocument();
    expect(screen.queryByTestId('account-menu-trigger')).not.toBeInTheDocument();
  });

  it('calls onOpenChannels from the channels button', () => {
    const onOpen = vi.fn();
    render(<AppTopBar onOpenChannels={onOpen} />);
    fireEvent.click(screen.getByLabelText('Open channels'));
    expect(onOpen).toHaveBeenCalled();
  });

  it('keeps the channels button mounted but invisible (space reserved) when channelsButtonHidden is true', () => {
    render(<AppTopBar channelsButtonHidden />);
    const button = screen.getByLabelText('Open channels');
    // Still in the DOM so the grid column keeps its width and the search
    // bar doesn't shift; just visually hidden and out of the tab order.
    expect(button).toHaveClass('invisible');
    expect(button).toHaveAttribute('aria-hidden', 'true');
    expect(button).toHaveAttribute('tabindex', '-1');
  });

  it('shows the channels button (visible, focusable) when channelsButtonHidden is false', () => {
    render(<AppTopBar channelsButtonHidden={false} />);
    const button = screen.getByLabelText('Open channels');
    expect(button).not.toHaveClass('invisible');
    expect(button).toHaveAttribute('tabindex', '0');
    expect(button).not.toHaveAttribute('aria-hidden');
  });

  // On a phone the button goes back to the list (it shows a back chevron), so
  // that's what it's called.
  it('is named Back on a phone', () => {
    mobile.value = true;
    render(<AppTopBar onOpenChannels={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Open channels')).toBeNull();
    mobile.value = false;
  });
});

// On a phone the page's name shares the back button's row instead of taking
// a row of its own below it.
describe('AppTopBar page title (phone)', () => {
  it('shows the page title beside Back on a phone, and nothing without one or on desktop', async () => {
    const { usePageTitleStore } = await import('@/stores/page-title');
    mobile.value = true;
    usePageTitleStore.setState({ title: 'Directory' });
    const { unmount } = render(<AppTopBar onOpenChannels={vi.fn()} />);
    expect(screen.getByTestId('mobile-page-title')).toHaveTextContent('Directory');
    unmount();
    usePageTitleStore.setState({ title: null });
    const second = render(<AppTopBar onOpenChannels={vi.fn()} />);
    expect(screen.queryByTestId('mobile-page-title')).toBeNull();
    second.unmount();
    mobile.value = false;
    usePageTitleStore.setState({ title: 'Directory' });
    const third = render(<AppTopBar onOpenChannels={vi.fn()} />);
    expect(screen.queryByTestId('mobile-page-title')).toBeNull();
    third.unmount();
    usePageTitleStore.setState({ title: null });
  });
});

describe('AppTopBar Back and Forward', () => {
  afterEach(() => {
    uninstallNavigation();
    mobile.value = false;
    vi.restoreAllMocks();
  });

  it('goes back and forward through the history, each only when there is somewhere to go', () => {
    const nav = installNavigation();
    const historyBack = vi.spyOn(window.history, 'back');
    render(<AppTopBar />);
    const backButton = screen.getByRole('button', { name: 'Back' });
    const forwardButton = screen.getByRole('button', { name: 'Forward' });
    expect(backButton).toBeDisabled();
    expect(forwardButton).toBeDisabled();

    act(() => nav.move(true, false));
    expect(backButton).toBeEnabled();
    expect(forwardButton).toBeDisabled();
    fireEvent.click(backButton);
    expect(nav.back).toHaveBeenCalledTimes(1);

    act(() => nav.move(false, true));
    expect(backButton).toBeDisabled();
    expect(forwardButton).toBeEnabled();
    fireEvent.click(forwardButton);
    expect(nav.forward).toHaveBeenCalledTimes(1);
    // The Navigation API's own history, never the tab's joint session
    // history (which also walks frames on the page).
    expect(historyBack).not.toHaveBeenCalled();
  });

  it('shrugs off a traversal that is refused or overtaken', async () => {
    const nav = installNavigation();
    nav.outcome = 'reject';
    render(<AppTopBar />);
    act(() => nav.move(true, true));
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(screen.getByRole('button', { name: 'Forward' }));
    // Both promises of each traversal are handled (an unhandled rejection
    // would fail the run).
    for (const call of [...nav.back.mock.results, ...nav.forward.mock.results]) {
      await expect(call.value.committed).rejects.toThrow('aborted');
      await expect(call.value.finished).rejects.toThrow('aborted');
    }
  });

  // They come before the sidebar toggle, which stays against the search.
  it('puts them first in the left column, sized and rounded like the toggle', () => {
    installNavigation();
    render(<AppTopBar />);
    const left = screen.getByTestId('app-shell-header').querySelector('[data-topbar-left="true"]')!;
    const names = [...left.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'));
    expect(names).toEqual(['Back', 'Forward', 'Open channels']);
    for (const name of ['Back', 'Forward']) {
      expect(screen.getByRole('button', { name })).toHaveClass('size-7', 'rounded-lg');
    }
  });

  it('shows none where the browser cannot say where history goes', () => {
    render(<AppTopBar />);
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Forward' })).toBeNull();
  });

  // jsdom is not a Mac: Alt+← and Alt+→.
  const press = (key: string, init: KeyboardEventInit = {}) => {
    const e = new KeyboardEvent('keydown', { key, code: key, altKey: true, bubbles: true, cancelable: true, ...init });
    act(() => {
      document.body.dispatchEvent(e);
    });
    return e;
  };

  it('goes back and forward from the keyboard, each only when there is somewhere to go', () => {
    const nav = installNavigation();
    render(<AppTopBar />);
    expect(screen.getByRole('button', { name: 'Back' })).toHaveAttribute('aria-keyshortcuts', 'Alt+ArrowLeft');
    expect(screen.getByRole('button', { name: 'Forward' })).toHaveAttribute('aria-keyshortcuts', 'Alt+ArrowRight');

    // Nowhere to go: the browser's own shortcut is left to run.
    expect(press('ArrowLeft').defaultPrevented).toBe(false);
    expect(press('ArrowRight').defaultPrevented).toBe(false);
    expect(nav.back).not.toHaveBeenCalled();
    expect(nav.forward).not.toHaveBeenCalled();

    act(() => nav.move(true, true));
    expect(press('ArrowLeft').defaultPrevented).toBe(true);
    expect(nav.back).toHaveBeenCalledTimes(1);
    expect(press('ArrowRight').defaultPrevented).toBe(true);
    expect(nav.forward).toHaveBeenCalledTimes(1);
    // Other keys are not theirs.
    expect(press('ArrowUp').defaultPrevented).toBe(false);
    expect(press('ArrowLeft', { altKey: false }).defaultPrevented).toBe(false);
    expect(nav.back).toHaveBeenCalledTimes(1);
  });

  it('steps once for a held chord, swallowing its repeats', () => {
    const nav = installNavigation();
    render(<AppTopBar />);
    act(() => nav.move(true, false));
    expect(press('ArrowLeft').defaultPrevented).toBe(true);
    // The step landed on the first page: nowhere further back. The repeats
    // still belong to the held chord — none may reach the browser's Back.
    act(() => nav.move(false, true));
    for (let i = 0; i < 5; i++) expect(press('ArrowLeft', { repeat: true }).defaultPrevented).toBe(true);
    expect(press('ArrowRight', { repeat: true }).defaultPrevented).toBe(true);
    expect(nav.back).toHaveBeenCalledTimes(1);
    expect(nav.forward).not.toHaveBeenCalled();
    // Other keys' repeats are not theirs.
    expect(press('ArrowUp', { repeat: true }).defaultPrevented).toBe(false);
  });

  it('listens once, reading where history can go at the moment of the press', () => {
    const nav = installNavigation();
    const listen = vi.spyOn(document, 'addEventListener');
    render(<AppTopBar />);
    act(() => nav.move(true, false));
    act(() => nav.move(false, true));
    act(() => nav.move(true, true));
    expect(listen.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(1);
    // A change the page has not re-rendered for yet still counts.
    nav.canGoBack = false;
    expect(press('ArrowLeft').defaultPrevented).toBe(false);
    expect(nav.back).not.toHaveBeenCalled();
  });

  it('tells the message box when the keys will step, and stops once the bar is gone', () => {
    const nav = installNavigation();
    const view = render(<AppTopBar />);
    expect(historyKeysWillStep('back')).toBe(false);
    act(() => nav.move(true, false));
    expect(historyKeysWillStep('back')).toBe(true);
    expect(historyKeysWillStep('forward')).toBe(false);
    view.unmount();
    expect(historyKeysWillStep('back')).toBe(false);
  });

  it('leaves a key press something else took, or one composing text', () => {
    const nav = installNavigation();
    render(<AppTopBar />);
    act(() => nav.move(true, false));
    const taken = (e: KeyboardEvent) => e.preventDefault();
    document.body.addEventListener('keydown', taken);
    press('ArrowLeft');
    document.body.removeEventListener('keydown', taken);
    press('ArrowLeft', { isComposing: true });
    expect(nav.back).not.toHaveBeenCalled();
  });

  it('stops listening to the keyboard when the bar goes away, and never listens without the buttons', () => {
    const nav = installNavigation();
    const view = render(<AppTopBar />);
    act(() => nav.move(true, false));
    view.unmount();
    press('ArrowLeft');
    expect(nav.back).not.toHaveBeenCalled();
    uninstallNavigation();
    render(<AppTopBar />);
    expect(press('ArrowLeft').defaultPrevented).toBe(false);
  });

  // A phone has its own back button in that corner.
  it('shows none on a phone', () => {
    installNavigation();
    mobile.value = true;
    render(<AppTopBar onOpenChannels={vi.fn()} />);
    expect(screen.queryByTestId('history-back')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Forward' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument();
    expect(historyKeysWillStep('back')).toBe(false);
  });
});
