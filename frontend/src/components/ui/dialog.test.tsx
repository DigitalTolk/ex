import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Dialog, DialogContent, DialogTitle } from './dialog';

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
      'max-md:inset-0',
      'max-md:max-h-none',
      'max-md:rounded-none',
      'max-md:overflow-y-auto',
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
    expect(screen.getByRole('dialog')).toHaveClass('max-md:[&_[data-slot=dialog-header]]:pr-20');
    expect(screen.getByRole('button', { name: 'Close' })).toHaveClass('max-md:hidden');
  });
});
