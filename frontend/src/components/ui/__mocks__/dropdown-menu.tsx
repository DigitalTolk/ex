import React from 'react';

// Shared manual mock for the shadcn dropdown-menu, used by the many MessageItem-
// rendering suites that just need the menu/sub-menu to render their children as
// plain clickable buttons (no real popover/portal/animation). Auto-resolved by a
// bare `vi.mock('@/components/ui/dropdown-menu')` so a new menu part is added
// here once instead of pasted into every suite. Suites that need open/modal-aware
// behaviour (e.g. message-item-actions) keep their own inline factory.
//
// It is a superset: items expose `data-testid="dropdown-item"`, pass through
// `aria-label`/`className`, and the content exposes `data-testid="dropdown-content"`,
// covering every consumer. Non-DOM props (e.g. `variant`) are intentionally
// dropped so the rendered <button> never gets unknown attributes (which would
// trip the zero-warnings gate).

type Kids = { children: React.ReactNode };
type AnyProps = Record<string, unknown>;

export const DropdownMenu = ({ children }: Kids) => <div>{children}</div>;

export const DropdownMenuTrigger = ({ children, ...props }: Kids & AnyProps) => (
  <button {...props}>{children}</button>
);

export const DropdownMenuContent = ({ children }: Kids) => (
  <div data-testid="dropdown-content">{children}</div>
);

export const DropdownMenuItem = ({
  children,
  onClick,
  className,
  ...rest
}: Kids & { onClick?: () => void; className?: string } & AnyProps) => (
  <button
    data-testid="dropdown-item"
    onClick={onClick}
    className={className}
    aria-label={rest['aria-label'] as string | undefined}
  >
    {children}
  </button>
);

export const DropdownMenuSub = ({ children }: Kids) => <div>{children}</div>;

export const DropdownMenuSubTrigger = ({ children, ...rest }: Kids & AnyProps) => (
  <button {...rest}>{children}</button>
);

export const DropdownMenuSubContent = ({ children }: Kids) => <div>{children}</div>;
