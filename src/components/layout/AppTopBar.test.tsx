import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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
