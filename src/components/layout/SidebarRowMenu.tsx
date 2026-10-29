import { useState, type ReactNode } from 'react';
import { MoreVertical } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

// Desktop: revealed on row hover. Touch: NOT a tap target (a long-press on the
// row opens the menu), but kept in place so the open menu anchors to it.
const TRIGGER_CLASS =
  'absolute right-1 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-gray-400 opacity-0 hover:bg-white/20 hover:text-white group-hover/row:opacity-100 touch:pointer-events-none touch:opacity-0';

// SidebarRowMenu is a sidebar row's kebab menu. The menu mounts the first time
// it opens and the trigger is a plain button until then: a menu per row held
// about 58 KB, and an account in a few thousand channels ran a phone out of
// memory on start.
export function SidebarRowMenu({
  open,
  onOpenChange,
  label,
  testID,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: string;
  testID: string;
  children: ReactNode;
}) {
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);

  const icon = <MoreVertical className="h-3.5 w-3.5" />;
  if (!mounted) {
    return (
      <button
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={false}
        data-testid={testID}
        className={TRIGGER_CLASS}
        onClick={() => onOpenChange(true)}
      >
        {icon}
      </button>
    );
  }
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger aria-label={label} data-testid={testID} className={TRIGGER_CLASS}>
        {icon}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
