import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { MessageInput, type MessageInputValue } from '@/components/chat/MessageInput';
import { useCreateConversation, useSearchUsers } from '@/hooks/useConversations';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import type { Message } from '@/types';

interface PickedUser {
  id: string;
  displayName: string;
}

export default function NewConversationPage() {
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<PickedUser[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const { user } = useAuth();
  const { data: searchResults } = useSearchUsers(query);
  const createConversation = useCreateConversation();

  // Filter out already-picked users from the suggestion list.
  const suggestions = (searchResults ?? []).filter(
    (u) => !picked.some((p) => p.id === u.id),
  );

  // Reset the active row whenever the suggestion list changes — the
  // previously highlighted row may no longer exist after the query
  // refines or a user is picked.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActiveIndex(0);
  }, [suggestions.length]);

  function pick(u: PickedUser) {
    if (picked.some((p) => p.id === u.id)) return;
    setPicked((prev) => [...prev, u]);
    setQuery('');
    inputRef.current?.focus();
  }

  function unpick(id: string) {
    setPicked((prev) => prev.filter((p) => p.id !== id));
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Backspace' && query === '' && picked.length > 0) {
      // Slack-style: an empty input + Backspace pops the last pill so the
      // user doesn't have to reach for the X to undo a mis-pick.
      e.preventDefault();
      setPicked((prev) => prev.slice(0, -1));
      return;
    }
    if (suggestions.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % suggestions.length);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const u = suggestions[activeIndex];
      if (u) pick({ id: u.id, displayName: u.displayName });
    }
  }

  // Posting a message is the gesture that creates (or forwards into) the
  // conversation. Until the user actually sends something, no DM/group
  // exists on the server — so opening "New conversation" idly leaves no
  // empty rows in the recipients' sidebars.
  async function handleSend(value: MessageInputValue) {
    if (picked.length === 0) {
      setError('Pick at least one recipient.');
      return;
    }
    if (!value.body.trim() && value.attachmentIDs.length === 0) {
      return;
    }
    setError('');
    try {
      const conv = await createConversation.mutateAsync({
        type: picked.length > 1 ? 'group' : 'dm',
        participantIDs: picked.map((p) => p.id),
      });
      // The standard useSendMessage hook is bound to a conversation id
      // at construction time, but we only know the id once create
      // resolves. apiFetch directly here keeps the page from carrying a
      // pending hook for a conversation that may not exist yet.
      await apiFetch<Message>(`/api/v1/conversations/${conv.id}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          body: value.body,
          parentMessageID: '',
          attachmentIDs: value.attachmentIDs ?? [],
        }),
      });
      navigate(`/conversation/${conv.id}`, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send');
    }
  }

  return (
    // Chat-window shell: same flex-col / overflow layout the channel and
    // conversation views use, so this page slots into the main content
    // area without visual jolt. The To: row replaces the channel header
    // at the top; the composer pins to the bottom; the middle is empty
    // until the user sends the first message.
    <div
      className="flex flex-1 flex-col overflow-hidden"
      data-testid="new-conversation-form"
    >
      {/* Header / "To:" row */}
      <div className="border-b bg-background relative">
        <div className="flex items-center gap-2 px-4 py-2">
          <label
            htmlFor="recipients-input"
            className="text-sm font-medium text-muted-foreground shrink-0"
          >
            To:
          </label>
          <div
            className="flex flex-1 flex-wrap items-center gap-1 rounded-md border bg-background px-2 py-1"
            onClick={() => inputRef.current?.focus()}
          >
            {picked.map((p) => (
              <Badge
                key={p.id}
                variant="secondary"
                data-testid={`recipient-pill-${p.id}`}
                className="gap-1 text-sm h-auto py-0.5 pl-2 pr-1"
              >
                {p.displayName}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    unpick(p.id);
                  }}
                  className="ml-0.5 rounded-full hover:bg-muted/50"
                  aria-label={`Remove ${p.displayName}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
            <input
              ref={inputRef}
              id="recipients-input"
              type="text"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={suggestions.length > 0}
              aria-controls="recipients-suggestions"
              data-testid="recipients-input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={picked.length === 0 ? 'Type a name…' : ''}
              autoFocus
              className="flex-1 min-w-[8rem] bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
        </div>

        {/* Autocomplete dropdown — overlays the empty message area
            below so it doesn't push the composer down when it opens. */}
        {suggestions.length > 0 && (
          <ul
            id="recipients-suggestions"
            role="listbox"
            data-testid="recipients-suggestions"
            className="absolute left-4 right-4 top-full z-10 mt-1 max-h-64 overflow-y-auto rounded-md border bg-popover shadow-lg"
          >
            {suggestions.map((u, i) => {
              const isActive = i === activeIndex;
              return (
                <li
                  key={u.id}
                  role="option"
                  aria-selected={isActive}
                  data-testid={`recipient-option-${u.id}`}
                >
                  <button
                    type="button"
                    onMouseDown={(e) => {
                      // mousedown so we beat the input blur — picking
                      // shouldn't depend on whether the user clicks
                      // before or after the input loses focus.
                      e.preventDefault();
                      pick({ id: u.id, displayName: u.displayName });
                    }}
                    onMouseEnter={() => setActiveIndex(i)}
                    className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm ${
                      isActive ? 'bg-muted' : 'hover:bg-muted/50'
                    }`}
                  >
                    <span className="font-medium">{u.displayName}</span>
                    {u.id === user?.id && (
                      <span className="text-xs text-muted-foreground">(you)</span>
                    )}
                    <span className="text-muted-foreground">{u.email}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Empty message area — fills the gap between the To: row and the
          composer the same way an empty chat would. We don't render
          fake messages; just a neutral hint. */}
      <div className="flex-1 overflow-y-auto">
        <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
          {picked.length === 0
            ? 'Type a name above to find someone, then send a message to start the chat.'
            : 'No messages yet. Send the first one below to start the conversation.'}
        </div>
      </div>

      {/* Footer / composer area — error sits inline above the composer
          like a chat-input validation message would. */}
      <div className="border-t bg-background">
        {error && (
          <p
            role="alert"
            data-testid="new-conversation-error"
            className="px-4 pt-2 text-sm text-destructive"
          >
            {error}
          </p>
        )}
        <MessageInput
          onSend={handleSend}
          disabled={createConversation.isPending || picked.length === 0}
          placeholder={
            picked.length === 0
              ? 'Pick at least one recipient first…'
              : picked.length === 1
                ? `Message ${picked[0].displayName}…`
                : `Message ${picked.length} people…`
          }
        />
      </div>
    </div>
  );
}

