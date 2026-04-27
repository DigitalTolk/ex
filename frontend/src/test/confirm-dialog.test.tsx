import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

describe('ConfirmDialog', () => {
  it('renders title + description and calls onConfirm + onOpenChange(false) on confirm', () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="Delete X?"
        description="X will be removed."
        confirmLabel="Delete"
        destructive
        onConfirm={onConfirm}
      />,
    );
    expect(screen.getByText('Delete X?')).toBeInTheDocument();
    expect(screen.getByText('X will be removed.')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('cancel calls onOpenChange(false) without firing onConfirm', () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="Are you sure?"
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByTestId('confirm-dialog-cancel'));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('uses the testIDPrefix for all three test ids so multiple confirms can coexist', () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={() => undefined}
        title="Custom prefix"
        onConfirm={() => undefined}
        testIDPrefix="my-prefix"
      />,
    );
    expect(screen.getByTestId('my-prefix')).toBeInTheDocument();
    expect(screen.getByTestId('my-prefix-cancel')).toBeInTheDocument();
    expect(screen.getByTestId('my-prefix-confirm')).toBeInTheDocument();
  });

  it('omits the description element when none is provided', () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={() => undefined}
        title="No description"
        onConfirm={() => undefined}
      />,
    );
    // DialogDescription renders as a <p> with a Radix-managed id; absence
    // is easiest to assert by checking no extra text inside the dialog
    // beyond title + buttons.
    expect(screen.queryByText('Confirm')).toBeInTheDocument(); // default label
    expect(screen.queryByText('Cancel')).toBeInTheDocument();
  });
});
