import { describe, it, expect, vi } from 'vitest';
import { render as rtlRender, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MessageInput } from './MessageInput';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn().mockResolvedValue([]) }));

function render(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return rtlRender(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe('MessageInput', () => {
  it('renders textarea and send button', () => {
    render(<MessageInput onSend={vi.fn()} />);

    expect(screen.getByLabelText('Message input')).toBeInTheDocument();
    expect(screen.getByLabelText('Send message')).toBeInTheDocument();
  });

  it('send button is disabled when input is empty', () => {
    render(<MessageInput onSend={vi.fn()} />);

    expect(screen.getByLabelText('Send message')).toBeDisabled();
  });

  it('send button is enabled when input has text', async () => {
    const user = userEvent.setup();
    render(<MessageInput onSend={vi.fn()} />);

    await user.type(screen.getByLabelText('Message input'), 'Hello');

    expect(screen.getByLabelText('Send message')).not.toBeDisabled();
  });

  it('calls onSend when pressing Enter', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<MessageInput onSend={onSend} />);

    const textarea = screen.getByLabelText('Message input');
    await user.type(textarea, 'Hello{Enter}');

    expect(onSend).toHaveBeenCalledWith({ body: 'Hello', attachmentIDs: [] });
  });

  it('does not call onSend on Shift+Enter', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<MessageInput onSend={onSend} />);

    const textarea = screen.getByLabelText('Message input');
    await user.type(textarea, 'Hello{Shift>}{Enter}{/Shift}');

    expect(onSend).not.toHaveBeenCalled();
  });

  it('clears input after sending', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<MessageInput onSend={onSend} />);

    const textarea = screen.getByLabelText('Message input');
    await user.type(textarea, 'Hello{Enter}');

    expect(textarea).toHaveValue('');
  });

  it('uses custom placeholder', () => {
    render(<MessageInput onSend={vi.fn()} placeholder="Write here..." />);

    expect(screen.getByPlaceholderText('Write here...')).toBeInTheDocument();
  });

  it('only disables send button (not textarea) when disabled prop is true', () => {
    render(<MessageInput onSend={vi.fn()} disabled />);

    // Textarea must remain enabled so user can keep typing
    expect(screen.getByLabelText('Message input')).not.toBeDisabled();
    expect(screen.getByLabelText('Send message')).toBeDisabled();
  });

  it('refocuses textarea after sending via Enter', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<MessageInput onSend={onSend} />);

    const textarea = screen.getByLabelText('Message input');
    await user.type(textarea, 'hello');
    await user.keyboard('{Enter}');

    await vi.waitFor(() => {
      expect(document.activeElement).toBe(textarea);
    });
  });

  it('refocuses textarea after sending via button click', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<MessageInput onSend={onSend} />);

    const textarea = screen.getByLabelText('Message input');
    await user.type(textarea, 'hello');
    await user.click(screen.getByLabelText('Send message'));

    expect(onSend).toHaveBeenCalledWith({ body: 'hello', attachmentIDs: [] });
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(textarea);
    });
  });
});
