import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TagSearchPanel } from './TagSearchPanel';

vi.mock('@/context/TagSearchContext', () => ({
  useTagState: () => ({ activeTag: 'urgent', tagNonce: 0, closeTag: vi.fn() }),
}));

type MessagesState = {
  isError: boolean;
  isLoading: boolean;
  error: unknown;
  data: { hits: unknown[] } | undefined;
};
let mockMessages: MessagesState;
vi.mock('@/hooks/useSearch', () => ({
  useSearchMessages: () => mockMessages,
}));

describe('TagSearchPanel error rendering', () => {
  beforeEach(() => {
    mockMessages = { isError: false, isLoading: false, error: null, data: { hits: [] } };
  });

  it('shows the Error message when the search rejects with an Error', () => {
    mockMessages = { isError: true, isLoading: false, error: new Error('index offline'), data: undefined };
    render(<TagSearchPanel />);
    expect(screen.getByRole('alert')).toHaveTextContent('index offline');
  });

  it('shows a generic fallback when the search rejects with a non-Error value', () => {
    mockMessages = { isError: true, isLoading: false, error: 'weird', data: undefined };
    render(<TagSearchPanel />);
    expect(screen.getByRole('alert')).toHaveTextContent('Search failed');
  });
});
