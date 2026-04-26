import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NotificationPrompt } from '@/components/NotificationPrompt';

let mockPermission: 'default' | 'granted' | 'denied' | 'unsupported' = 'default';
const mockRequestPermission = vi.fn().mockResolvedValue('granted');

vi.mock('@/context/NotificationContext', () => ({
  useNotifications: () => ({
    permission: mockPermission,
    requestPermission: mockRequestPermission,
    prefs: { soundEnabled: true, browserEnabled: true },
    setSoundEnabled: vi.fn(),
    setBrowserEnabled: vi.fn(),
    dispatch: vi.fn(),
    setActiveParent: vi.fn(),
  }),
}));

describe('NotificationPrompt', () => {
  beforeEach(() => {
    mockPermission = 'default';
    mockRequestPermission.mockClear();
    sessionStorage.clear();
  });

  it('renders when permission is default', () => {
    render(<NotificationPrompt />);
    expect(screen.getByLabelText('Enable browser notifications')).toBeInTheDocument();
  });

  it('hides when permission is granted', () => {
    mockPermission = 'granted';
    render(<NotificationPrompt />);
    expect(screen.queryByLabelText('Enable browser notifications')).toBeNull();
  });

  it('hides when permission is denied', () => {
    mockPermission = 'denied';
    render(<NotificationPrompt />);
    expect(screen.queryByLabelText('Enable browser notifications')).toBeNull();
  });

  it('hides when notifications are unsupported', () => {
    mockPermission = 'unsupported';
    render(<NotificationPrompt />);
    expect(screen.queryByLabelText('Enable browser notifications')).toBeNull();
  });

  it('calls requestPermission on Enable click', () => {
    render(<NotificationPrompt />);
    fireEvent.click(screen.getByLabelText('Enable browser notifications'));
    expect(mockRequestPermission).toHaveBeenCalledTimes(1);
  });

  it('dismisses on X click and stays dismissed for the session', () => {
    const { rerender } = render(<NotificationPrompt />);
    fireEvent.click(screen.getByLabelText('Dismiss notification prompt'));
    expect(screen.queryByLabelText('Enable browser notifications')).toBeNull();
    // Re-mounting in the same session should NOT bring the prompt back.
    rerender(<NotificationPrompt key="2" />);
    expect(screen.queryByLabelText('Enable browser notifications')).toBeNull();
  });
});
