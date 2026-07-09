import { type ReactNode } from 'react';
import { motion } from 'motion/react';
import { Button } from '@/components/ui/button';
import { ArrowRight } from 'lucide-react';
import { useSwipeDismiss } from '@/hooks/useSwipeDismiss';
import { usePanelWidth } from '@/hooks/usePanelWidth';
import { SIDE_PANEL_WIDTH } from '@/lib/panel-width';
import { PanelResizeHandle } from '@/components/layout/PanelResizeHandle';
import { useMobileBackClose } from '@/hooks/useMobileBackClose';

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
  const { dismissing, settled, motionProps } = useSwipeDismiss('right', onClose);
  // Mounted-while-open panel: Back on mobile closes it instead of navigating.
  useMobileBackClose(true, onClose);
  // Desktop rail is resizable from its left edge; the width is shared with
  // the thread panel (one persisted "right panel" width) and resettable from
  // profile settings.
  const { width: panelWidth, handleProps: panelHandleProps } = usePanelWidth(
    SIDE_PANEL_WIDTH,
    'left',
    'Resize side panel',
  );
  return (
    <motion.aside
      className={`relative flex w-[var(--side-panel-width,28rem)] flex-col bg-background not-mobile:border-l mobile:fixed mobile:inset-x-0 mobile:bottom-0 mobile:top-[var(--mobile-right-panel-top,6rem)] mobile:z-40 mobile:w-auto mobile:touch-pan-y ${settled ? '' : 'border-l'}`}
      style={{ '--side-panel-width': `${panelWidth}px` } as React.CSSProperties}
      aria-label={ariaLabel}
      data-mobile-right-sidebar="true"
      data-swipe-dismissing={String(dismissing)}
      {...motionProps}
    >
      <PanelResizeHandle edge="left" testID="side-panel-resize-handle" {...panelHandleProps} />
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
      {/* Bottom inset: on mobile the panel is fixed to the screen bottom, so
          the last row must clear the home indicator. */}
      <div className="flex-1 overflow-y-auto p-2 mobile:pb-[calc(env(safe-area-inset-bottom)+0.5rem)]">{children}</div>
    </motion.aside>
  );
}
