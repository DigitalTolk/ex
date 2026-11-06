import { useMemo, useState } from 'react';
import { Popover } from '@base-ui/react/popover';
import { ChevronDown, Users } from 'lucide-react';
import { UserAvatar } from '@/components/UserAvatar';
import { useOptionalAuth } from '@/context/AuthContext';
import { useChannelMembers } from '@/hooks/useChannels';
import { useConversation } from '@/hooks/useConversations';
import { useUsersBatch } from '@/hooks/useUsersBatch';
import type { ReminderAudience } from '@/lib/reminder-audience';
import type { User } from '@/types';

// How many people a reminder adds or leaves out, as the server caps it
// (service.maxReminderPeople).
export const MAX_REMINDER_PEOPLE = 20;

const NO_IDS: string[] = [];

interface ReminderPeoplePickerProps {
  parentID: string;
  parentType: 'channel' | 'conversation';
  value: ReminderAudience;
  onChange: (audience: ReminderAudience) => void;
}

// "Bob", "Bob and Carol", "Bob, Carol and 3 others".
function listNames(names: string[]): string {
  if (names.length <= 2) return names.join(' and ');
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} others`;
}

// ReminderPeoplePicker says who a reminder is for: one line under the
// dialog's title ("Just you", "Everyone except Bob") that opens a list of the
// chat's people to tick. Its first box is "Everyone here": ticked, the
// reminder tags @all and unticking someone leaves them out; unticked, it
// reminds you and whoever is ticked. No names to type — the search only
// narrows a long list. It offers the chat's own people (a tag elsewhere would
// point at a message they can't open), never bots or agents (a tag would set
// an agent to work), and the list only loads while it is open.
export function ReminderPeoplePicker({ parentID, parentType, value, onChange }: ReminderPeoplePickerProps) {
  const me = useOptionalAuth()?.user;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const { data: members } = useChannelMembers(parentType === 'channel' ? parentID : undefined);
  const { data: conversation } = useConversation(parentType === 'conversation' ? parentID : undefined);

  // The chat's people as id → name, without you. A conversation's
  // participants have no names until their records load.
  const candidates = useMemo(() => {
    const names = new Map<string, string>();
    for (const m of members ?? []) names.set(m.userID, m.displayName);
    for (const id of conversation?.participantIDs ?? []) names.set(id, '');
    names.delete(me?.id ?? '');
    return names;
  }, [members, conversation, me?.id]);
  // The list in hand: the people added, or the people left out of everyone.
  const picked = value.everyone ? value.excludedUserIDs : value.userIDs;
  const { data: users } = useUsersBatch(useMemo(() => (open ? [...picked, ...candidates.keys()] : picked), [open, picked, candidates]));
  const byID = useMemo(() => new Map((users ?? []).map((u) => [u.id, u])), [users]);
  const nameOf = (id: string) => byID.get(id)?.displayName || candidates.get(id) || 'Someone';
  // Only someone whose record has loaded, so a bot or agent never flashes in
  // the list before its record says what it is.
  const taggable = (u: User | undefined) => !!u && !u.isBot && u.kind !== 'agent';

  const term = query.trim().toLowerCase();
  const roster = open
    ? [...candidates.keys()]
        .filter((id) => taggable(byID.get(id)) && (!term || nameOf(id).toLowerCase().includes(term)))
        .sort((a, b) => nameOf(a).localeCompare(nameOf(b)))
    : NO_IDS;

  // How many the chat has, you included, once its people are known.
  const headcount = parentType === 'channel' ? members?.length : conversation?.participantIDs?.length;
  const full = picked.length >= MAX_REMINDER_PEOPLE;
  const reminded = (id: string) => (value.everyone ? !picked.includes(id) : picked.includes(id));
  const toggle = (id: string) => {
    const next = picked.includes(id) ? picked.filter((v) => v !== id) : [...picked, id];
    onChange(value.everyone ? { ...value, excludedUserIDs: next } : { ...value, userIDs: next });
  };
  // "Everyone here" starts from everyone ticked, and back off from nobody.
  const setEveryone = (everyone: boolean) =>
    onChange(everyone ? { ...value, everyone, excludedUserIDs: [] } : { ...value, everyone, userIDs: [] });

  const names = picked.map(nameOf);
  const summary = value.everyone
    ? picked.length
      ? `Everyone except ${listNames(names)}`
      : `Everyone here${headcount ? ` · ${headcount} people` : ''}`
    : picked.length
      ? `You, ${listNames(names)}`
      : 'Just you';

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery('');
      }}
    >
      <Popover.Trigger
        nativeButton
        data-testid="reminder-who"
        aria-label={`Who to remind: ${summary}`}
        className="flex w-full items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-left text-sm transition-colors hover:bg-muted mobile:h-11"
      >
        <Users className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate" data-testid="reminder-who-summary">
          {summary}
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={4} className="isolate z-50">
          <Popover.Popup
            data-testid="reminder-people"
            aria-label="Who to remind"
            className="flex w-(--anchor-width) max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none"
          >
            <div className="border-b border-border p-2">
              <input
                type="text"
                autoComplete="off"
                aria-label="Find someone"
                placeholder="Find someone"
                data-testid="reminder-people-input"
                className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-base md:text-sm mobile:h-10"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <label className="flex cursor-pointer items-center gap-2.5 border-b border-border px-3 py-2 text-sm font-medium hover:bg-muted mobile:py-3">
              <input
                type="checkbox"
                checked={value.everyone}
                onChange={(e) => setEveryone(e.target.checked)}
                data-testid="reminder-everyone"
                className="h-4 w-4 accent-foreground"
              />
              <span className="flex-1">Everyone here</span>
              {headcount ? <span className="text-xs font-normal text-muted-foreground">{headcount} people</span> : null}
            </label>
            <div className="max-h-60 overflow-y-auto py-1" data-testid="reminder-roster">
              {roster.length === 0 ? (
                <p className="px-3 py-2 text-sm text-muted-foreground" data-testid="reminder-people-empty">
                  {term ? 'No one here matches.' : 'Loading people…'}
                </p>
              ) : (
                roster.map((id) => {
                  const on = reminded(id);
                  // At the cap, only what's already picked can change.
                  const locked = full && !picked.includes(id);
                  return (
                    <label
                      key={id}
                      className="flex cursor-pointer items-center gap-2.5 px-3 py-1.5 text-sm hover:bg-muted has-disabled:cursor-default has-disabled:opacity-50 mobile:py-2.5"
                      data-testid={`reminder-person-${id}`}
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={locked}
                        onChange={() => toggle(id)}
                        aria-label={`Remind ${nameOf(id)}`}
                        className="h-4 w-4 accent-foreground"
                      />
                      <UserAvatar displayName={nameOf(id)} avatarURL={byID.get(id)?.avatarURL} className="h-6 w-6" maxInitials={1} />
                      <span className="truncate">{nameOf(id)}</span>
                    </label>
                  );
                })
              )}
            </div>
            {full && (
              <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground" data-testid="reminder-people-full">
                {value.everyone ? `Up to ${MAX_REMINDER_PEOPLE} people can be left out.` : `Up to ${MAX_REMINDER_PEOPLE} people can be added.`}
              </p>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
