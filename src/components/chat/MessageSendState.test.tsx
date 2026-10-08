import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NotSentMark } from './MessageSendState';
import type { Message } from '@/types';

const actions = vi.hoisted(() => ({ retry: vi.fn(), discard: vi.fn() }));
vi.mock('@/hooks/useMessages', () => ({ usePendingMessageActions: () => actions }));
vi.mock('@/components/ui/dropdown-menu');

const failed: Message = {
  id: 'pending-n1',
  parentID: 'ch-1',
  authorID: 'u-1',
  body: 'hello',
  createdAt: '2026-10-07T10:00:00Z',
  clientNonce: 'n1',
  pendingState: 'failed',
};

describe('NotSentMark', () => {
  it('offers Try again and Delete', () => {
    render(<NotSentMark message={failed} showLabel />);
    expect(screen.getByTestId('message-failed')).toHaveTextContent('Not sent');
    fireEvent.click(screen.getByLabelText('Try sending again'));
    expect(actions.retry).toHaveBeenCalledWith(failed);
    fireEvent.click(screen.getByLabelText('Delete unsent message'));
    expect(actions.discard).toHaveBeenCalledWith(failed);
  });

  it('where there is no room for words (a grouped row) it is just the mark', () => {
    render(<NotSentMark message={failed} />);
    expect(screen.getByTestId('message-failed').textContent).toBe('');
    expect(screen.getByLabelText('Not sent — retry or delete')).toBeInTheDocument();
  });
});
