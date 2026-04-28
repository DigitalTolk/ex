import { type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { X } from 'lucide-react';

interface SidePanelProps {
  title: string;
  ariaLabel: string;
  closeLabel: string;
  onClose: () => void;
  children: ReactNode;
}

// Common shell for the right-rail panels (pinned, files, members, etc.).
// Centralises the title bar + close button + scroll body so each panel
// stays focused on its own content.
export function SidePanel({ title, ariaLabel, closeLabel, onClose, children }: SidePanelProps) {
  return (
    <aside className="flex w-[28rem] flex-col border-l" aria-label={ariaLabel}>
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={onClose}
          aria-label={closeLabel}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto p-2">{children}</div>
    </aside>
  );
}
