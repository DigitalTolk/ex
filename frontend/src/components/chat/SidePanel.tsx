import { type ReactNode } from 'react';
import { motion } from 'motion/react';
import { Button } from '@/components/ui/button';
import { ArrowRight } from 'lucide-react';
import { useSwipeDismiss } from '@/hooks/useSwipeDismiss';

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
  const { dismissing, motionProps } = useSwipeDismiss('right', onClose);
  return (
    <motion.aside
      className="flex w-[28rem] flex-col bg-background md:border-l max-md:fixed max-md:inset-x-0 max-md:bottom-0 max-md:top-[var(--mobile-right-panel-top,6rem)] max-md:z-40 max-md:w-auto max-md:touch-pan-y"
      aria-label={ariaLabel}
      data-mobile-right-sidebar="true"
      data-swipe-dismissing={String(dismissing)}
      {...motionProps}
    >
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={onClose}
          aria-label={closeLabel}
        >
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto p-2">{children}</div>
    </motion.aside>
  );
}
