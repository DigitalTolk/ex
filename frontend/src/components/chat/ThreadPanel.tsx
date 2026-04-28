import { useRef } from 'react';
import { MessageItem } from './MessageItem';
import { MessageInput, type MessageInputHandle } from './MessageInput';
import { MessageDropZone } from './MessageDropZone';
import { Button } from '@/components/ui/button';
import { X } from 'lucide-react';
import { useSendMessage, type SendMessageInput } from '@/hooks/useMessages';
import { useThreadMessages } from '@/hooks/useThreads';
import type { UserMapEntry } from './MessageList';

interface ThreadPanelProps {
  channelId?: string;
  conversationId?: string;
  threadRootID: string;
  onClose: () => void;
  userMap: Record<string, UserMapEntry>;
  currentUserId?: string;
}

export function ThreadPanel({
  channelId,
  conversationId,
  threadRootID,
  onClose,
  userMap,
  currentUserId,
}: ThreadPanelProps) {
  const { data, isLoading } = useThreadMessages({ channelId, conversationId, threadRootID });

  const send = useSendMessage({ channelId, conversationId });
  const inputRef = useRef<MessageInputHandle>(null);

  function handleReply(input: SendMessageInput) {
    send.mutate({ ...input, parentMessageID: threadRootID });
  }

  return (
    <aside className="w-[28rem] border-l flex flex-col" aria-label="Thread">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="text-sm font-semibold">Thread</h2>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={onClose}
          aria-label="Close thread"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
      <MessageDropZone onFiles={(files) => void inputRef.current?.uploadFiles(files)}>
        <div className="flex-1 overflow-y-auto p-2 space-y-2">
          {isLoading && (
            <p className="text-xs text-muted-foreground p-2">Loading replies...</p>
          )}
          {data?.length === 0 && (
            <p className="text-xs text-muted-foreground p-2">No replies yet. Start the thread!</p>
          )}
          {data?.map((msg) => {
            const u = userMap[msg.authorID];
            return (
              <MessageItem
                key={msg.id}
                message={msg}
                authorName={u?.displayName ?? 'Unknown'}
                authorAvatarURL={u?.avatarURL}
                authorOnline={u?.online}
                isOwn={msg.authorID === currentUserId}
                channelId={channelId}
                conversationId={conversationId}
                currentUserId={currentUserId}
                inThread
              />
            );
          })}
        </div>
        <MessageInput
          ref={inputRef}
          onSend={handleReply}
          disabled={send.isPending}
          placeholder="Reply..."
          focusKey={threadRootID}
        />
      </MessageDropZone>
    </aside>
  );
}
