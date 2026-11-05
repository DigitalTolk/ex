import { useMemo, useState } from 'react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { SearchInput } from '@/components/ui/search-input';
import { useAllUsers } from '@/hooks/useConversations';
import { rankedMatches } from '@/lib/fuzzy';
import { getInitials } from '@/lib/format';
import { MAX_USER_GROUP_MEMBERS } from '@/lib/limits';
import { canBeGroupMember } from '@/lib/user-groups';

interface Props {
  selected: string[];
  onChange: (ids: string[]) => void;
}

// MemberPicker is a searchable checklist of the people who can join a user
// group, capped at MAX_USER_GROUP_MEMBERS.
export function MemberPicker({ selected, onChange }: Props) {
  const [query, setQuery] = useState('');
  const { data: users = [] } = useAllUsers();
  const eligible = useMemo(() => users.filter(canBeGroupMember), [users]);
  const visible = rankedMatches(eligible, query, (u) => [u.displayName, u.email]).slice(0, 50);
  const chosen = new Set(selected);
  const full = selected.length >= MAX_USER_GROUP_MEMBERS;

  const toggle = (id: string) => {
    onChange(chosen.has(id) ? selected.filter((s) => s !== id) : [...selected, id]);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <SearchInput
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search people"
          aria-label="Search people to add"
          containerClassName="flex-1"
        />
        <span className="shrink-0 text-xs text-muted-foreground" data-testid="member-count">
          {selected.length} / {MAX_USER_GROUP_MEMBERS}
        </span>
      </div>
      <ul className="max-h-64 space-y-1 overflow-y-auto" aria-label="People">
        {visible.map((u) => {
          const checked = chosen.has(u.id);
          return (
            <li key={u.id}>
              <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!checked && full}
                  onChange={() => toggle(u.id)}
                  aria-label={u.displayName}
                />
                <Avatar className="h-6 w-6">
                  {u.avatarURL && <AvatarImage src={u.avatarURL} alt="" />}
                  <AvatarFallback className="bg-primary/10 text-xs">{getInitials(u.displayName)}</AvatarFallback>
                </Avatar>
                <span className="min-w-0 truncate text-sm">{u.displayName}</span>
              </label>
            </li>
          );
        })}
        {visible.length === 0 && <li className="px-2 py-1.5 text-sm text-muted-foreground">No one matches.</li>}
      </ul>
      {full && <p className="text-xs text-muted-foreground">A user group holds at most {MAX_USER_GROUP_MEMBERS} people.</p>}
    </div>
  );
}
