import { useRef, useState, type ReactNode } from 'react';

interface MessageDropZoneProps {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
  // Layout classes for the wrapper. Defaults to the chat-column shape
  // (flex-1 + min-h-0) used by ChannelView / ConversationView; thread
  // contexts that aren't growing flex children pass `relative` only.
  className?: string;
  children: ReactNode;
}

const DEFAULT_CLASSNAME = 'relative flex flex-1 flex-col min-h-0';

// Wraps a chat surface (channel/dm/group) so files dropped anywhere
// inside route through the active MessageInput's upload pipeline.
// Tracks drag depth via a counter — onDragLeave fires whenever the
// pointer crosses any descendant boundary, so a single boolean would
// flicker the overlay constantly while moving over child elements.
export function MessageDropZone({ onFiles, disabled, className, children }: MessageDropZoneProps) {
  const depth = useRef(0);
  const [over, setOver] = useState(false);

  function reset() {
    depth.current = 0;
    setOver(false);
  }

  function hasFiles(e: React.DragEvent<HTMLDivElement>): boolean {
    const types = e.dataTransfer?.types;
    if (!types) return false;
    for (let i = 0; i < types.length; i++) {
      if (types[i] === 'Files') return true;
    }
    return false;
  }

  return (
    <div
      className={className ?? DEFAULT_CLASSNAME}
      onDragEnter={(e) => {
        if (disabled || !hasFiles(e)) return;
        depth.current += 1;
        if (!over) setOver(true);
      }}
      onDragOver={(e) => {
        if (disabled || !hasFiles(e)) return;
        // Without preventDefault the browser opens the file in the tab.
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={() => {
        if (disabled) return;
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setOver(false);
      }}
      onDrop={(e) => {
        if (disabled || !hasFiles(e)) return;
        e.preventDefault();
        const files = Array.from(e.dataTransfer.files ?? []);
        reset();
        if (files.length > 0) onFiles(files);
      }}
    >
      {children}
      {over && (
        <div
          data-testid="message-drop-overlay"
          className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center rounded-md border-2 border-dashed border-primary bg-primary/10"
        >
          <span className="rounded-md bg-background px-3 py-1.5 text-sm font-medium text-foreground shadow">
            Drop to attach
          </span>
        </div>
      )}
    </div>
  );
}
