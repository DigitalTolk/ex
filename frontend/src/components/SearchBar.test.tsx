import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SearchBar } from './SearchBar';

vi.mock('@/hooks/useChannels', () => ({
  useChannelBySlug: () => ({ data: undefined }),
}));
vi.mock('@/hooks/useConversations', () => ({
  useUserConversations: () => ({ data: [] }),
}));

function renderBar() {
  return render(
    <MemoryRouter>
      <SearchBar />
    </MemoryRouter>,
  );
}

describe('SearchBar', () => {
  it('opens the dropdown on input and closes it on an outside mousedown', () => {
    renderBar();
    const input = screen.getByTestId('searchbar-input');
    fireEvent.change(input, { target: { value: 'hello' } });
    expect(screen.getByTestId('searchbar-dropdown')).toBeInTheDocument();

    // Mousedown outside the container closes the dropdown.
    act(() => {
      fireEvent.mouseDown(document.body);
    });
    expect(screen.queryByTestId('searchbar-dropdown')).toBeNull();
  });

  it('keeps the dropdown open on a mousedown inside the container', () => {
    renderBar();
    const input = screen.getByTestId('searchbar-input');
    fireEvent.change(input, { target: { value: 'hello' } });
    expect(screen.getByTestId('searchbar-dropdown')).toBeInTheDocument();
    // Mousedown on the input (inside the container) must NOT close it.
    act(() => {
      fireEvent.mouseDown(input);
    });
    expect(screen.getByTestId('searchbar-dropdown')).toBeInTheDocument();
  });

  it('ignores ArrowUp/ArrowDown when there are no suggestions', () => {
    renderBar();
    const input = screen.getByTestId('searchbar-input');
    fireEvent.focus(input); // open, but empty query → no suggestions
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    // No suggestions to navigate → dropdown stays empty, no crash.
    expect(screen.queryByTestId('searchbar-dropdown')).toBeNull();
  });

  it('cycles the highlight with ArrowDown/ArrowUp when suggestions exist', () => {
    renderBar();
    const input = screen.getByTestId('searchbar-input');
    fireEvent.change(input, { target: { value: 'hello' } });
    // Single 'all' suggestion → arrow keys wrap around to it without error.
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(screen.getByTestId('searchbar-show-results').getAttribute('aria-selected')).toBe('true');
  });

  it('ignores a neutral keydown that matches none of the navigation keys', () => {
    renderBar();
    const input = screen.getByTestId('searchbar-input');
    fireEvent.change(input, { target: { value: 'hello' } });
    // A plain character key falls through Enter/Escape/ArrowDown/ArrowUp
    // without preventing default or moving the highlight.
    fireEvent.keyDown(input, { key: 'a' });
    expect(screen.getByTestId('searchbar-dropdown')).toBeInTheDocument();
    expect(screen.getByTestId('searchbar-show-results').getAttribute('aria-selected')).toBe('true');
  });

  it('highlights a suggestion on hover and submits it on click', () => {
    renderBar();
    const input = screen.getByTestId('searchbar-input');
    fireEvent.change(input, { target: { value: 'meeting notes' } });
    const suggestion = screen.getByTestId('searchbar-show-results');
    // Hover sets the highlighted index.
    fireEvent.mouseEnter(suggestion);
    expect(suggestion.getAttribute('aria-selected')).toBe('true');
    // Clicking submits → the dropdown closes.
    fireEvent.click(suggestion);
    expect(screen.queryByTestId('searchbar-dropdown')).toBeNull();
  });

  it('closes on Escape', () => {
    renderBar();
    const input = screen.getByTestId('searchbar-input');
    fireEvent.change(input, { target: { value: 'x' } });
    expect(screen.getByTestId('searchbar-dropdown')).toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByTestId('searchbar-dropdown')).toBeNull();
  });
});
