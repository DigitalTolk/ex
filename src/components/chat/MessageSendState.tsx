import { AlertCircle, RotateCw, Trash2 } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { usePendingMessageActions } from '@/hooks/useMessages';
import type { Message } from '@/types';

// NotSentMark is the red mark of a failed send, shown in space the row
// already has (beside the time, or over a grouped row's hidden time) so it
// never changes the row's height. It opens Try again / Delete — the text is
// kept, never silently lost.
export function NotSentMark({ message, showLabel = false }: { message: Message; showLabel?: boolean }) {
  const { retry, discard } = usePendingMessageActions();
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        aria-label="Not sent — retry or delete"
        title="Not sent — click to try again or delete"
        data-testid="message-failed"
        className="inline-flex shrink-0 items-center gap-1 self-center rounded-full text-xs font-medium text-destructive hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/40"
      >
        <AlertCircle className="h-4 w-4" aria-hidden="true" />
        {showLabel && 'Not sent'}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-44">
        <DropdownMenuItem onClick={() => retry(message)} aria-label="Try sending again">
          <RotateCw className="mr-2 h-4 w-4" />
          Try again
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => discard(message)} aria-label="Delete unsent message" className="text-destructive">
          <Trash2 className="mr-2 h-4 w-4" />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
