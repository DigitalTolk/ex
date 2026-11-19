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

  // "Edit description" in the channel menu.
  function openEditorFromMenu() {
    const items = screen.getAllByTestId('dropdown-item');
    fireEvent.click(items.find((item) => item.textContent?.includes('Edit description'))!);
    return screen.getByLabelText('Description') as HTMLTextAreaElement;
  }
  // The editor's own Save (the first of two: a phone gets a second one in the
  // dialog's top bar).
  const save = () => fireEvent.click(screen.getAllByText('Save')[0]);

  it('opens channel description editing as a full-page dialog on a phone, saved from its top bar', () => {
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

    const textarea = openEditorFromMenu();
    expect(screen.getByTestId('channel-description-editor')).toHaveClass('mobile:grid-rows-[auto_1fr]');
    fireEvent.change(textarea, { target: { value: 'Mobile desc' } });
    fireEvent.click(document.querySelector('[data-slot="dialog-mobile-action"]')!);

    expect(onDescriptionSave).toHaveBeenCalledWith('Mobile desc');
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: originalMatchMedia });
  });

  it('opens the editor from the menu with the current description in it', () => {
    render(<Header channel={baseChannel} canEdit />);
    const textarea = openEditorFromMenu();
    expect(textarea.value).toBe('Test description');
    expect(textarea).toHaveAttribute('maxLength', '1000');
    expect(screen.getByTestId('channel-description-count')).toHaveTextContent('16/1000');
  });

  it('opens an empty editor from the menu when there is no description yet', () => {
    render(<Header channel={{ ...baseChannel, description: '' }} canEdit />);
    // Nothing in the header invites a description; the menu does.
    expect(screen.queryByTestId('channel-description-teaser')).not.toBeInTheDocument();
    const textarea = openEditorFromMenu();
    expect(textarea.value).toBe('');
    expect(textarea).toHaveAttribute('placeholder', 'What is this channel for?');
  });

  it.each([{ ctrlKey: true }, { metaKey: true }])('saves a first description with %o + Enter, and keeps plain Enter for a new line', (modifier) => {
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

    const textarea = openEditorFromMenu();
    fireEvent.change(textarea, { target: { value: 'Brand new description' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onDescriptionSave).not.toHaveBeenCalled();
    fireEvent.keyDown(textarea, { key: 'Enter', ...modifier });
    expect(onDescriptionSave).toHaveBeenCalledWith('Brand new description');
    expect(screen.queryByTestId('channel-description-editor')).not.toBeInTheDocument();
  });

  it('shows the whole description from the header, and edits it from there', () => {
    render(<Header channel={baseChannel} canEdit />);
    fireEvent.click(screen.getByTestId('channel-description-teaser'));

    const view = screen.getByTestId('channel-description-view');
    expect(view).toHaveTextContent('About ~general');
    expect(view).toHaveTextContent('Test description');

    fireEvent.click(screen.getByText('Edit'));
    expect(screen.queryByTestId('channel-description-view')).not.toBeInTheDocument();
    expect(screen.getByDisplayValue('Test description')).toBeInTheDocument();
  });

  it('shows the first line in the header, a link as its words, and the rest in the dialog', () => {
    const description = '\n\nRunbooks live in [the wiki](https://example.com/wiki)\nAsk in the thread before paging.';
    render(<Header channel={{ ...baseChannel, description }} />);
    const teaser = screen.getByTestId('channel-description-teaser');
    expect(teaser).toHaveTextContent('Runbooks live in the wiki');
    expect(teaser).not.toHaveTextContent('Ask in the thread');

    fireEvent.click(teaser);
    const view = screen.getByTestId('channel-description-view');
    expect(view).toHaveTextContent('Ask in the thread before paging.');
    expect(screen.getByRole('link', { name: 'the wiki' })).toHaveAttribute('href', 'https://example.com/wiki');
  });

  it('shows nothing in the header for a description that is only white space', () => {
    render(<Header channel={{ ...baseChannel, description: '  \n  ' }} canEdit />);
    expect(screen.queryByTestId('channel-description-teaser')).not.toBeInTheDocument();
  });

  it('keeps the open description dialog standing when the description is removed meanwhile', () => {
    const { rerender } = render(<Header channel={baseChannel} />);
    fireEvent.click(screen.getByTestId('channel-description-teaser'));
    expect(screen.getByTestId('channel-description-view')).toHaveTextContent('Test description');
    // Someone else clears it while it is open here.
    rerender(<Header channel={{ ...baseChannel, description: undefined }} />);
    const view = screen.getByTestId('channel-description-view');
    expect(view).toHaveTextContent('About ~general');
    expect(view).not.toHaveTextContent('Test description');
    expect(screen.queryByTestId('channel-description-teaser')).not.toBeInTheDocument();
  });

  it('saves the edited description, trimmed, with the Save button', () => {
    const onDescriptionSave = vi.fn();
    render(<Header channel={baseChannel} canEdit onDescriptionSave={onDescriptionSave} />);

    const textarea = openEditorFromMenu();
    fireEvent.change(textarea, { target: { value: '  New desc\nsecond line  ' } });
    expect(screen.getByTestId('channel-description-count')).toHaveTextContent('24/1000');
    save();

    expect(onDescriptionSave).toHaveBeenCalledWith('New desc\nsecond line');
    expect(screen.queryByTestId('channel-description-editor')).not.toBeInTheDocument();
  });

  it('cancels editing without saving', () => {
    const onDescriptionSave = vi.fn();
    render(<Header channel={baseChannel} canEdit onDescriptionSave={onDescriptionSave} />);

    const textarea = openEditorFromMenu();
    fireEvent.change(textarea, { target: { value: 'Thrown away' } });
    fireEvent.click(screen.getByText('Cancel'));

    expect(onDescriptionSave).not.toHaveBeenCalled();
    expect(screen.queryByTestId('channel-description-editor')).not.toBeInTheDocument();
    // The header still shows the description as it was.
    expect(screen.getByTestId('channel-description-teaser')).toHaveTextContent('Test description');
  });

  it('does not save when the field merely loses focus', () => {
    const onDescriptionSave = vi.fn();
    render(<Header channel={baseChannel} canEdit onDescriptionSave={onDescriptionSave} />);

    const textarea = openEditorFromMenu();
    fireEvent.change(textarea, { target: { value: 'Blurred desc' } });
    fireEvent.blur(textarea);

    expect(onDescriptionSave).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue('Blurred desc')).toBeInTheDocument();
  });

  it('saves without a handler wired (nothing to call) and still closes', () => {
    render(<Header channel={baseChannel} canEdit />);
    openEditorFromMenu();
    save();
    expect(screen.queryByTestId('channel-description-editor')).not.toBeInTheDocument();
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

  it('lets someone who cannot edit read the description in full, with no way to edit it', () => {
    render(<Header channel={baseChannel} canEdit={false} />);
    fireEvent.click(screen.getByTestId('channel-description-teaser'));
    expect(screen.getByTestId('channel-description-view')).toHaveTextContent('Test description');
    expect(screen.queryByText('Edit')).not.toBeInTheDocument();
    const items = screen.queryAllByTestId('dropdown-item');
    expect(items.some((item) => item.textContent?.includes('Edit description'))).toBe(false);
  });
});
