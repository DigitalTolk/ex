import { useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { UserPickerRow } from '@/components/UserPickerRow';
import { useOptionalAuth } from '@/context/AuthContext';
import { useChannelMembers } from '@/hooks/useChannels';
import { useConversation } from '@/hooks/useConversations';
import { useUsersBatch } from '@/hooks/useUsersBatch';
import type { User } from '@/types';

// How many matches the list offers at once.
const MAX_MATCHES = 8;

const NO_IDS: string[] = [];

interface ReminderPeoplePickerProps {
  parentID: string;
  parentType: 'channel' | 'conversation';
  value: string[];
  onChange: (ids: string[]) => void;
}

// ReminderPeoplePicker adds people to a reminder: when it comes due the
// reminder bot replies to the message tagging them and you. It offers the
// chat's own people — the channel's members or the conversation's
// participants — since a tag elsewhere would point at a message they can't
// open, and never bots or agents (a tag would set an agent to work).
export function ReminderPeoplePicker({ parentID, parentType, value, onChange }: ReminderPeoplePickerProps) {
  const me = useOptionalAuth()?.user;
  const [query, setQuery] = useState('');
  const { data: members } = useChannelMembers(parentType === 'channel' ? parentID : undefined);
  const { data: conversation } = useConversation(parentType === 'conversation' ? parentID : undefined);

  // The chat's people as id → name, without you.
  const candidates = useMemo(() => {
    const names = new Map<string, string>();
    for (const m of members ?? []) names.set(m.userID, m.displayName);
    for (const id of conversation?.participantIDs ?? []) names.set(id, '');
    names.delete(me?.id ?? '');
    return names;
  }, [members, conversation, me?.id]);

  const term = query.trim().toLowerCase();
  // A conversation's participants have no names until their records load, so
  // its matches come from those; a channel's from its member list.
  const participantIDs = conversation?.participantIDs ?? NO_IDS;
  const matchIDs = useMemo(() => {
    if (!term) return NO_IDS;
    const out: string[] = [];
    for (const [id, name] of candidates) {
      if (!value.includes(id) && (name === '' || name.toLowerCase().includes(term))) out.push(id);
    }
    return out;
  }, [term, candidates, value]);

  const { data: users } = useUsersBatch(useMemo(() => [...value, ...matchIDs.slice(0, 50), ...participantIDs], [value, matchIDs, participantIDs]));
  const byID = useMemo(() => new Map((users ?? []).map((u) => [u.id, u])), [users]);
  const nameOf = (id: string) => byID.get(id)?.displayName || candidates.get(id) || 'Someone';
  // Only someone whose record has loaded, so a bot or agent never flashes in
  // the list before its record says what it is.
  const taggable = (u: User | undefined) => !!u && !u.isBot && u.kind !== 'agent';

  const matches = matchIDs
    .filter((id) => taggable(byID.get(id)) && nameOf(id).toLowerCase().includes(term))
    .slice(0, MAX_MATCHES);

  const add = (id: string) => {
    onChange([...value, id]);
    setQuery('');
  };

  return (
    <div className="space-y-2" data-testid="reminder-people">
      <label htmlFor="reminder-people-input" className="text-sm font-medium">
        Also remind
      </label>
      {value.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="People to remind">
          {value.map((id) => (
            <li
              key={id}
              className="flex items-center gap-1 rounded-full border border-border py-0.5 pl-2.5 pr-1 text-sm"
              data-testid={`reminder-person-${id}`}
            >
              {nameOf(id)}
              <button
                type="button"
                onClick={() => onChange(value.filter((v) => v !== id))}
                aria-label={`Remove ${nameOf(id)}`}
                className="flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <input
        id="reminder-people-input"
        type="text"
        autoComplete="off"
        placeholder="Add people from this conversation"
        data-testid="reminder-people-input"
        className="w-full rounded-md border border-border bg-background px-3 py-2 text-base md:text-sm mobile:h-11"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && matches.length > 0) {
            // Enter picks the top match rather than setting the reminder.
            e.preventDefault();
            e.stopPropagation();
            add(matches[0]);
          }
        }}
      />
      {term && (
        <div className="max-h-48 overflow-y-auto rounded-md border border-border" role="listbox" aria-label="Matching people">
          {matches.length === 0 ? (
            <p className="px-3 py-2 text-sm text-muted-foreground" data-testid="reminder-people-empty">
              No one in this conversation matches.
            </p>
          ) : (
            matches.map((id) => (
              <UserPickerRow
                key={id}
                displayName={nameOf(id)}
                avatarURL={byID.get(id)?.avatarURL}
                userStatus={byID.get(id)?.userStatus}
                testID={`reminder-people-option-${id}`}
                onSelect={() => add(id)}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}
