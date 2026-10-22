import { afterEach, describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { AppTopBar } from './AppTopBar';

vi.mock('@/components/SearchBar', () => ({
  SearchBar: () => <div aria-label="Search">search</div>,
}));
const mobile = vi.hoisted(() => ({ value: false }));
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => mobile.value }));

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

// jsdom has no Navigation API; a stand-in reports what the browser would.
class FakeNavigation extends EventTarget {
  canGoBack = false;
  canGoForward = false;
  move(back: boolean, forward: boolean) {
    this.canGoBack = back;
    this.canGoForward = forward;
    this.dispatchEvent(new Event('currententrychange'));
  }
}

describe('AppTopBar Back and Forward', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'navigation');
    vi.restoreAllMocks();
  });

  function installNavigation(): FakeNavigation {
    const nav = new FakeNavigation();
    Object.defineProperty(window, 'navigation', { value: nav, configurable: true });
    return nav;
  }

  it('goes back and forward through the history, each only when there is somewhere to go', () => {
    const nav = installNavigation();
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    const forward = vi.spyOn(window.history, 'forward').mockImplementation(() => {});
    render(<AppTopBar />);
    const backButton = screen.getByRole('button', { name: 'Back' });
    const forwardButton = screen.getByRole('button', { name: 'Forward' });
    expect(backButton).toBeDisabled();
    expect(forwardButton).toBeDisabled();

    act(() => nav.move(true, false));
    expect(backButton).toBeEnabled();
    expect(forwardButton).toBeDisabled();
    fireEvent.click(backButton);
    expect(back).toHaveBeenCalledTimes(1);

    act(() => nav.move(false, true));
    expect(backButton).toBeDisabled();
    expect(forwardButton).toBeEnabled();
    fireEvent.click(forwardButton);
    expect(forward).toHaveBeenCalledTimes(1);
  });

  // They come before the sidebar toggle, which stays against the search.
  it('puts them first in the left column', () => {
    installNavigation();
    render(<AppTopBar />);
    const left = screen.getByTestId('app-shell-header').querySelector('[data-topbar-left="true"]')!;
    const names = [...left.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'));
    expect(names).toEqual(['Back', 'Forward', 'Open channels']);
  });

  it('shows none where the browser cannot say where history goes', () => {
    render(<AppTopBar />);
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Forward' })).toBeNull();
  });

  // A phone has its own back button in that corner.
  it('shows none on a phone', () => {
    installNavigation();
    mobile.value = true;
    render(<AppTopBar onOpenChannels={vi.fn()} />);
    expect(screen.queryByTestId('history-back')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Forward' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument();
    mobile.value = false;
  });
});
