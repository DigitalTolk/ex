import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { User as UserIcon, Users, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { MessageInput, type MessageInputValue } from '@/components/chat/MessageInput';
import { MessageList } from '@/components/chat/MessageList';
import type { DraftChangeHandler } from '@/components/chat/useComposerDraft';
import { useCreateConversation, useUserLookup, useUserConversations } from '@/hooks/useConversations';
import { useConversationUserMap } from '@/hooks/useConversationUserMap';
import {
  appendMessageToCache,
  CLIENT_NONCE_HEADER,
  newClientNonce,
  useConversationMessages,
} from '@/hooks/useMessages';
import {
  condemnDraftForSend,
  removeDraftScopeFromCache,
  useDraftAttachmentChips,
  useDraftForScope,
  useSaveDraft,
} from '@/hooks/useDrafts';
import { useFrequentEmojis } from '@/hooks/useEmoji';
import { useEventCallback } from '@/hooks/useEventCallback';
import { conversationsWith } from '@/lib/conversation-match';
import { shortName } from '@/lib/format';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { usePresence } from '@/context/PresenceContext';
import { UserPickerRow } from '@/components/UserPickerRow';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { useAutoFocusTextInput } from '@/hooks/useHardwareKeyboard';
import type { Message } from '@/types';

interface PickedUser {
  id: string;
  displayName: string;
}

const draftScope = (parentID: string) => ({ parentID, parentType: 'conversation' as const });

export default function NewConversationPage() {
  useDocumentTitle('New message');
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<PickedUser[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const { user } = useAuth();
  const autoFocusTextInput = useAutoFocusTextInput();
  const { data: searchResults } = useUserLookup(query);
  const { online } = usePresence();
  // The DMs and group messages you already have with everyone picked, the
  // one with exactly them first.
  const { data: conversations } = useUserConversations();
  const matches = useMemo(
    () => conversationsWith(conversations ?? [], picked.map((p) => p.id), user?.id),
    [conversations, picked, user?.id],
  );
  const exact = matches.find((m) => m.exact)?.conversation;
  // One without a message yet is only a draft's home (see below).
  const started = matches.filter((m) => m.conversation.activated !== false);
  const composer = useNewConversationComposer(picked, exact?.conversationID);

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
    // Dedup inside the updater, not against the render-scope `picked`: the
    // option row fires onSelect on BOTH mousedown and click (touch fallback,
    // see UserPickerRow), and when the two land in one batch the second call
    // still sees the stale pre-pick `picked` — only the chained updater sees
    // the first pick.
    setPicked((prev) => (prev.some((p) => p.id === u.id) ? prev : [...prev, u]));
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
      // Defensive: activeIndex is reset by an effect whenever the suggestion
      // list length changes, and React flushes passive effects before the
      // next discrete event, so `u` can only be undefined in a render→effect
      // gap that user events cannot land in.
      /* istanbul ignore else -- see v8 note */
      /* v8 ignore next -- unreachable defensive guard, see comment above */
      if (u) pick({ id: u.id, displayName: u.displayName });
    }
  }

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
      await composer.send(value);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send');
    }
  }

  return (
    // Chat-window shell, laid out like an open conversation: the To: row
    // where its header goes, then the messages you already have with these
    // people, then the composer.
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
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
              // Desktop-only autofocus (the InviteDialog convention): on mobile
              // an autofocused input pops the keyboard mid page-transition and
              // forces focus-scroll inside the overflow-hidden app shell.
              autoFocus={autoFocusTextInput}
              className="min-w-[8rem] flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground mobile:text-base"
            />
          </div>
        </div>

        {/* Autocomplete dropdown — overlays the message area
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
                  {/* Canonical people-row (avatar + presence + status),
                      shared with global search and add-member. mousedown pick
                      beats the input blur; the click stays as the touch
                      fallback (pick() is idempotent). */}
                  <UserPickerRow
                    displayName={u.displayName}
                    email={u.email}
                    avatarURL={u.avatarURL}
                    online={online.has(u.id)}
                    userStatus={u.userStatus}
                    you={u.id === user?.id}
                    highlighted={isActive}
                    pickOnMouseDown
                    onHover={() => setActiveIndex(i)}
                    onSelect={() => pick({ id: u.id, displayName: u.displayName })}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* The conversation with exactly these people, once it has messages;
          otherwise the ones that take in everyone picked and more. */}
      {exact && exact.activated !== false ? (
        <ConversationHistory key={exact.conversationID} id={exact.conversationID} participantIDs={exact.participantIDs} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {started.length > 0 && (
            <section className="space-y-1 p-4" aria-labelledby="existing-conversations">
              <h2 id="existing-conversations" className="px-2 pb-1 text-xs font-semibold text-muted-foreground">
                Existing conversations
              </h2>
              <ul>
                {started.map(({ conversation }) => {
                  const Icon = conversation.type === 'group' ? Users : UserIcon;
                  return (
                    <li key={conversation.conversationID}>
                      <button
                        type="button"
                        data-testid={`existing-conversation-${conversation.conversationID}`}
                        onClick={() => navigate(`/conversation/${conversation.conversationID}`)}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-muted mobile:py-3 mobile:text-base"
                      >
                        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                        <span className="min-w-0 flex-1 truncate font-medium">{conversation.displayName}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </div>
      )}

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
          disabled={picked.length === 0}
          placeholder={
            picked.length === 0
              ? 'Pick at least one recipient first…'
              : `Write to ${picked.length === 1 ? picked[0].displayName : picked.map((p) => shortName(p.displayName)).join(', ')}`
          }
          initialBody={composer.draft?.body ?? ''}
          initialDrafts={composer.draftAttachments}
          onDraftChange={composer.onDraftChange}
        />
      </div>
    </div>
  );
}

// useNewConversationComposer keeps what is written to the people picked as
// the draft of their conversation, as an open conversation's composer does,
// and sends it there.
//
// That conversation is made the first time there is something to keep in it
// (the server finds the one these people already have instead). Made, not
// started: nobody else sees it, in their sidebar or anywhere, until its first
// message — and yours shows it only while it holds your draft
// (useSidebarSections).
//
// The text belongs to the page, not to the people: it stays in the box while
// they change, and goes to the next save's conversation, leaving no draft
// where it was before.
function useNewConversationComposer(picked: PickedUser[], existingID: string | undefined) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const createAsync = useCreateConversation().mutateAsync;
  const saveDraft = useSaveDraft().mutate;
  const ids = picked.map((p) => p.id);
  const key = [...ids].sort().join(',');
  // Conversations made here, by the people they are with (key).
  const [made, setMade] = useState<Record<string, string>>({});
  const making = useRef(new Map<string, Promise<string>>());
  const id = existingID ?? made[key];
  const { data: draft } = useDraftForScope(useMemo(() => ({ parentID: id, parentType: 'conversation' as const }), [id]));
  const draftAttachments = useDraftAttachmentChips(draft?.attachmentIDs);
  // Where this page last saved text of its own (not a draft it only showed).
  const savedIn = useRef<string | undefined>(undefined);

  const ensure = useEventCallback((): Promise<string> => {
    if (id) return Promise.resolve(id);
    let pending = making.current.get(key);
    if (!pending) {
      const forKey = key;
      pending = createAsync({ type: ids.length > 1 ? 'group' : 'dm', participantIDs: ids }).then(
        (conv) => {
          setMade((prev) => ({ ...prev, [forKey]: conv.id }));
          return conv.id;
        },
        (err: unknown) => {
          // The next save or send asks again.
          making.current.delete(forKey);
          throw err;
        },
      );
      making.current.set(forKey, pending);
    }
    return pending;
  });

  const clear = (parentID: string) =>
    saveDraft({ ...draftScope(parentID), body: '', attachmentIDs: [], silent: true });

  const onDraftChange: DraftChangeHandler = useEventCallback((value, options) => {
    if (ids.length === 0) return;
    const hasContent = value.body !== '' || value.attachmentIDs.length > 0;
    const was = savedIn.current;
    if (!id && !hasContent) {
      // Emptied before these people had a conversation: nothing to keep,
      // and what was saved before went with the text.
      if (was) clear(was);
      savedIn.current = undefined;
      return;
    }
    const shown = draft;
    const makes = !id;
    void ensure().then(
      (to) => {
        saveDraft({
          ...draftScope(to),
          body: value.body,
          attachmentIDs: value.attachmentIDs,
          // Keystroke saves persist silently; the focus-loss flush (notify)
          // is what surfaces the draft in the sidebar. Except the one that
          // makes the conversation: the page then reads that conversation's
          // draft from the local list, which a silent save never reaches
          // (useSaveDraft), and would take it to have none.
          silent: !options?.notify && !makes,
          keepalive: options?.keepalive,
        });
        if (was && was !== to) clear(was);
        // Only text this page wrote moves with the recipients: a draft the
        // conversation already had, merely shown, stays where it is.
        const own = !shown || shown.body !== value.body || !sameIDs(shown.attachmentIDs ?? [], value.attachmentIDs);
        savedIn.current = own && hasContent ? to : undefined;
      },
      () => {
        // Not made: the next save tries again.
      },
    );
  });

  const send = useEventCallback(async (value: MessageInputValue) => {
    const to = await ensure();
    const scope = draftScope(to);
    // As an open conversation's send does (useSendMessage): the server
    // clears the draft with the send, so no save racing it may bring it back.
    const rollback = condemnDraftForSend(scope);
    const clientNonce = newClientNonce();
    let sent: Message;
    try {
      sent = await apiFetch<Message>(`/api/v1/conversations/${to}/messages`, {
        method: 'POST',
        headers: { [CLIENT_NONCE_HEADER]: clientNonce },
        body: JSON.stringify({
          body: value.body,
          parentMessageID: '',
          attachmentIDs: value.attachmentIDs,
        }),
      });
    } catch (err) {
      rollback();
      throw err;
    }
    removeDraftScopeFromCache(queryClient, scope);
    appendMessageToCache(queryClient, to, { ...sent, clientNonce: sent.clientNonce ?? clientNonce });
    const was = savedIn.current;
    if (was && was !== to) clear(was);
    savedIn.current = undefined;
    navigate(`/conversation/${to}`, { replace: true });
  });

  return { draft, draftAttachments, onDraftChange, send };
}

function sameIDs(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// ConversationHistory shows the messages of the conversation the people
// picked already have, as the conversation itself does. Replying in a thread
// opens it there.
function ConversationHistory({ id, participantIDs }: { id: string; participantIDs: string[] | undefined }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const quickReactions = useFrequentEmojis(6);
  const {
    data,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
    fetchNextPage,
    hasPreviousPage,
    isFetchingPreviousPage,
    fetchPreviousPage,
  } = useConversationMessages(id);
  const { userMap } = useConversationUserMap(data?.pages, participantIDs);
  const openThread = useEventCallback((rootID: string) => navigate(`/conversation/${id}?thread=${rootID}`));
  return (
    <MessageList
      pages={data?.pages ?? []}
      hasNextPage={hasNextPage}
      isFetchingNextPage={isFetchingNextPage}
      isLoading={isLoading}
      fetchNextPage={fetchNextPage}
      hasPreviousPage={hasPreviousPage}
      isFetchingPreviousPage={isFetchingPreviousPage}
      fetchPreviousPage={fetchPreviousPage}
      currentUserId={user?.id}
      conversationId={id}
      userMap={userMap}
      quickReactions={quickReactions}
      onReplyInThread={openThread}
    />
  );
}
