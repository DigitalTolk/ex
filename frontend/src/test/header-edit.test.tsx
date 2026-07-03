import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Header } from '@/components/layout/Header';
import type { Channel } from '@/types';

// Minimal stub for Radix DropdownMenu in jsdom
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <button data-testid="dropdown-trigger" className={className}>{children}</button>
  ),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div data-testid="dropdown-content">{children}</div>,
  DropdownMenuItem: ({ children, onClick, className }: { children: React.ReactNode; onClick?: () => void; className?: string }) => (
    <button data-testid="dropdown-item" onClick={onClick} className={className}>{children}</button>
  ),
}));

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open: boolean }) => open ? <div data-testid="dialog">{children}</div> : null,
  // Renders the mobile top-header action like the real DialogContent (the
  // description editor's Save lives there now); mobileCloseLabel/mobileAction
  // must NOT be spread onto the div (unknown-prop warnings).
  DialogContent: ({
    children,
    className,
    mobileAction,
    mobileCloseLabel: _mobileCloseLabel,
    finalFocus: _finalFocus,
    ...props
  }: {
    children: React.ReactNode;
    className?: string;
    mobileAction?: { label: string; onClick: () => void; disabled?: boolean };
    mobileCloseLabel?: string;
    finalFocus?: unknown;
    [key: string]: unknown;
  }) => (
    <div className={className} {...props}>
      {children}
      {mobileAction && (
        <button data-slot="dialog-mobile-action" onClick={mobileAction.onClick} disabled={mobileAction.disabled}>
          {mobileAction.label}
        </button>
      )}
    </div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/components/ui/badge', () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick, variant, className, type }: { children: React.ReactNode; onClick?: () => void; variant?: string; className?: string; type?: 'button' | 'submit' | 'reset' }) => (
    <button type={type} onClick={onClick} data-variant={variant} className={className}>{children}</button>
  ),
}));

const baseChannel: Channel = {
  id: 'ch1',
  name: 'general',
  slug: 'general',
  type: 'public',
  createdBy: 'u1',
  archived: false,
  createdAt: '2024-01-01',
  description: 'Test description',
};

describe('Header - description editing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens channel description editing as a full-page mobile dialog', () => {
    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({
        matches: true,
        media: '(max-width: 767px)',
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    const onDescriptionSave = vi.fn();
    render(<Header channel={baseChannel} canEdit onDescriptionSave={onDescriptionSave} />);

    const items = screen.getAllByTestId('dropdown-item');
    const editItem = items.find(item => item.textContent?.includes('Edit description'));
    fireEvent.click(editItem!);

    const editor = screen.getByTestId('mobile-description-editor');
    expect(editor).toHaveClass('max-w-none');
    const textarea = screen.getByLabelText('Description');
    fireEvent.change(textarea, { target: { value: 'Mobile desc' } });
    fireEvent.click(screen.getByText('Save'));

    expect(onDescriptionSave).toHaveBeenCalledWith('Mobile desc');
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: originalMatchMedia });
  });

  it('clicking edit description opens inline input', () => {
    render(<Header channel={baseChannel} canEdit />);
    const items = screen.getAllByTestId('dropdown-item');
    const editItem = items.find(item => item.textContent?.includes('Edit description'));
    fireEvent.click(editItem!);

    const input = screen.getByRole('textbox') || screen.getByDisplayValue('Test description');
    expect(input).toBeInTheDocument();
  });

  it('opens inline editor via dropdown when description is empty and canEdit', () => {
    render(<Header channel={{ ...baseChannel, description: '' }} canEdit />);
    // No "Add a description..." button should render anymore
    expect(screen.queryByText('Add a description...')).not.toBeInTheDocument();
    // Click the dropdown's "Edit description" item to open the inline editor
    const items = screen.getAllByTestId('dropdown-item');
    const editItem = items.find(item => item.textContent?.includes('Edit description'));
    fireEvent.click(editItem!);
    // Inline input should now render with the placeholder
    const input = screen.getByPlaceholderText('Add a description...');
    expect(input).toBeInTheDocument();
  });

  it('opens inline editor via dropdown when description is undefined and canEdit', () => {
    // baseChannel has description set; build one without it
    const channelNoDesc: Channel = {
      id: 'ch1',
      name: 'general',
      slug: 'general',
      type: 'public',
      createdBy: 'u1',
      archived: false,
      createdAt: '2024-01-01',
    };
    const onDescriptionSave = vi.fn();
    render(<Header channel={channelNoDesc} canEdit onDescriptionSave={onDescriptionSave} />);

    // Click "Edit description" in dropdown
    const items = screen.getAllByTestId('dropdown-item');
    const editItem = items.find(item => item.textContent?.includes('Edit description'));
    fireEvent.click(editItem!);

    // Inline input must render even though description is undefined
    const input = screen.getByPlaceholderText('Add a description...');
    expect(input).toBeInTheDocument();

    // Typing and pressing Enter saves
    fireEvent.change(input, { target: { value: 'Brand new description' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onDescriptionSave).toHaveBeenCalledWith('Brand new description');
  });

  it('clicking description text opens edit mode', () => {
    render(<Header channel={baseChannel} canEdit />);
    const descButton = screen.getByTitle('Click to edit description');
    fireEvent.click(descButton);

    const input = screen.getByDisplayValue('Test description');
    expect(input).toBeInTheDocument();
  });

  it('pressing Enter saves the description', () => {
    const onDescriptionSave = vi.fn();
    render(<Header channel={baseChannel} canEdit onDescriptionSave={onDescriptionSave} />);

    // Open edit mode via description button
    const descButton = screen.getByTitle('Click to edit description');
    fireEvent.click(descButton);

    const input = screen.getByDisplayValue('Test description');
    fireEvent.change(input, { target: { value: 'New desc' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onDescriptionSave).toHaveBeenCalledWith('New desc');
  });

  it('pressing Escape cancels editing', () => {
    const onDescriptionSave = vi.fn();
    render(<Header channel={baseChannel} canEdit onDescriptionSave={onDescriptionSave} />);

    const descButton = screen.getByTitle('Click to edit description');
    fireEvent.click(descButton);

    const input = screen.getByDisplayValue('Test description');
    fireEvent.keyDown(input, { key: 'Escape' });

    // Should no longer show input, back to button
    expect(onDescriptionSave).not.toHaveBeenCalled();
    expect(screen.getByTitle('Click to edit description')).toBeInTheDocument();
  });

  it('blur saves the description', () => {
    const onDescriptionSave = vi.fn();
    render(<Header channel={baseChannel} canEdit onDescriptionSave={onDescriptionSave} />);

    const descButton = screen.getByTitle('Click to edit description');
    fireEvent.click(descButton);

    const input = screen.getByDisplayValue('Test description');
    fireEvent.change(input, { target: { value: 'Blurred desc' } });
    fireEvent.blur(input);

    expect(onDescriptionSave).toHaveBeenCalledWith('Blurred desc');
  });

  it('cancel button in archive dialog closes it', () => {
    const onArchive = vi.fn();
    render(<Header channel={baseChannel} canArchive onArchive={onArchive} />);

    // Open dialog
    const items = screen.getAllByTestId('dropdown-item');
    const archiveItem = items.find(item => item.textContent?.includes('Archive channel'));
    fireEvent.click(archiveItem!);
    expect(screen.getByTestId('dialog')).toBeInTheDocument();

    // Click Cancel
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByTestId('dialog')).not.toBeInTheDocument();
    expect(onArchive).not.toHaveBeenCalled();
  });

  it('shows description as read-only text when canEdit is false', () => {
    render(<Header channel={baseChannel} canEdit={false} />);
    expect(screen.getByText('Test description')).toBeInTheDocument();
    expect(screen.queryByTitle('Click to edit description')).not.toBeInTheDocument();
  });
});
