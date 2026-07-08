import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Dialog, DialogContent, DialogTitle, useDialogMobileAction } from './dialog';

describe('DialogContent', () => {
  it('uses a full-screen mobile layout', async () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Settings</DialogTitle>
        </DialogContent>
      </Dialog>,
    );

    const content = await screen.findByRole('dialog');
    expect(content).toHaveClass(
      'mobile:inset-0',
      'mobile:max-h-none',
      'mobile:rounded-none',
      'mobile:overflow-y-auto',
    );
  });

  it('can replace the mobile icon close control with a text cancel button', async () => {
    render(
      <Dialog open>
        <DialogContent mobileCloseLabel="Cancel">
          <DialogTitle>Settings</DialogTitle>
        </DialogContent>
      </Dialog>,
    );

    const mobileClose = await screen.findByRole('button', { name: 'Cancel' });
    expect(mobileClose).toHaveAttribute('data-slot', 'dialog-mobile-close');
    expect(mobileClose).toHaveClass('after:content-[var(--mobile-close-label)]');
    expect(screen.getByRole('dialog')).toHaveClass('mobile:[&_[data-slot=dialog-header]]:pr-20');
    expect(screen.getByRole('button', { name: 'Close' })).toHaveClass('mobile:hidden');
  });

  it('renders a top-right mobile action button from the mobileAction prop and fires it', () => {
    const onClick = vi.fn();
    render(
      <Dialog open>
        <DialogContent mobileCloseLabel="Cancel" mobileAction={{ label: 'Save', onClick }}>
          <DialogTitle>Settings</DialogTitle>
        </DialogContent>
      </Dialog>,
    );

    const action = screen.getByRole('button', { name: 'Save' });
    expect(action).toHaveAttribute('data-slot', 'dialog-mobile-action');
    // Both controls share the top-right cluster; with both present the header
    // reserves extra right padding.
    expect(screen.getByRole('dialog')).toHaveClass('mobile:[&_[data-slot=dialog-header]]:pr-40');
    fireEvent.click(action);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('honours a disabled mobileAction', () => {
    render(
      <Dialog open>
        <DialogContent mobileAction={{ label: 'Save', onClick: vi.fn(), disabled: true }}>
          <DialogTitle>Settings</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('lets a child body register the mobile action via useDialogMobileAction', () => {
    const onClick = vi.fn();
    function Body() {
      useDialogMobileAction({ label: 'Apply', onClick });
      return <p>body</p>;
    }
    render(
      <Dialog open>
        <DialogContent mobileCloseLabel="Cancel">
          <DialogTitle>Settings</DialogTitle>
          <Body />
        </DialogContent>
      </Dialog>,
    );

    const action = screen.getByRole('button', { name: 'Apply' });
    fireEvent.click(action);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('clears a registered mobile action when the body passes null', () => {
    function Body({ register }: { register: boolean }) {
      useDialogMobileAction(register ? { label: 'Apply', onClick: vi.fn() } : null);
      return <p>body</p>;
    }
    const { rerender } = render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Settings</DialogTitle>
          <Body register />
        </DialogContent>
      </Dialog>,
    );
    expect(screen.getByRole('button', { name: 'Apply' })).toBeInTheDocument();

    rerender(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Settings</DialogTitle>
          <Body register={false} />
        </DialogContent>
      </Dialog>,
    );
    expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument();
  });

  it('useDialogMobileAction is a no-op outside a DialogContent provider', () => {
    function Body() {
      useDialogMobileAction({ label: 'X', onClick: vi.fn() });
      return <p>standalone</p>;
    }
    expect(() => render(<Body />)).not.toThrow();
  });
});
