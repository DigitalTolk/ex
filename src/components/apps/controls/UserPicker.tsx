import { useRef, useState } from 'react';
import { Popover } from '@base-ui/react/popover';
import { Search, X } from 'lucide-react';
import { UserAvatar } from '@/components/UserAvatar';
import { FIELD_CLASS } from '@/components/ui/field-class';
import { useUserLookup } from '@/hooks/useConversations';
import { useUsersBatch } from '@/hooks/useUsersBatch';
import { cn } from '@/lib/utils';

interface UserPickerProps {
  id: string;
  label: string;
  value: string[];
  // name is the person just added, when one was.
  onChange: (value: string[], name?: string) => void;
  multiple?: boolean;
  max?: number;
  placeholder?: string;
  size?: 'default' | 'sm';
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
}

// UserPicker picks ex people by name or email — ex's own people search, which
// leaves deactivated accounts out. The server checks every ID it is sent
// again; this only makes picking pleasant: chips for who is chosen, arrow
// keys and Enter in the list, Backspace to drop the last chip.
export function UserPicker({ id, label, value, onChange, multiple, max, placeholder, size = 'default', disabled, invalid, describedBy }: UserPickerProps) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const { data: found = [] } = useUserLookup(query.trim(), { keepPrevious: true });
  const { map: chosen } = useUsersBatch(value);
  const results = found.filter((u) => !value.includes(u.id)).slice(0, 8);
  const open = query.trim().length >= 2;
  const full = multiple && !!max && value.length >= max;
  const listID = `${id}-list`;

  const pick = (userID: string, name: string) => {
    onChange(multiple ? [...value, userID] : [userID], name);
    setQuery('');
    setActive(0);
    inputRef.current?.focus();
  };

  return (
    <Popover.Root open={open && !full} onOpenChange={(next) => !next && setQuery('')}>
      <Popover.Trigger
        nativeButton={false}
        render={<div />}
        className={cn(
          FIELD_CLASS,
          'flex h-auto min-h-8 cursor-text flex-wrap items-center gap-1 py-1 mobile:min-h-11',
          size === 'sm' && 'min-h-7 w-64 max-w-full mobile:min-h-9',
          invalid && 'border-destructive',
          disabled && 'pointer-events-none opacity-50',
        )}
        onClick={() => inputRef.current?.focus()}
      >
        {value.map((userID) => {
          const user = chosen.get(userID);
          const name = user?.displayName ?? 'Someone';
          return (
            <span key={userID} className="inline-flex max-w-full items-center gap-1 rounded-md bg-muted py-0.5 pr-1 pl-0.5 text-xs" data-testid={`${id}-chip`}>
              <UserAvatar displayName={name} avatarURL={user?.avatarURL} className="size-4" initialsClassName="text-xs" />
              <span className="truncate">{name}</span>
              <button
                type="button"
                aria-label={`Remove ${name}`}
                className="rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
                onClick={(e) => {
                  e.stopPropagation();
                  onChange(value.filter((v) => v !== userID));
                }}
              >
                <X className="size-3" aria-hidden />
              </button>
            </span>
          );
        })}
        {(multiple ? !full : value.length === 0) && (
          <span className="flex min-w-24 flex-1 items-center gap-1.5">
            {value.length === 0 && <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
            <input
              ref={inputRef}
              id={id}
              role="combobox"
              aria-label={label}
              aria-expanded={open}
              aria-controls={listID}
              aria-activedescendant={open && results[active] ? `${listID}-${results[active].id}` : undefined}
              aria-invalid={invalid || undefined}
              aria-describedby={describedBy}
              disabled={disabled}
              value={query}
              placeholder={value.length === 0 ? (placeholder ?? 'Search people') : ''}
              autoComplete="off"
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setActive((i) => Math.min(i + 1, Math.max(results.length - 1, 0)));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setActive((i) => Math.max(i - 1, 0));
                } else if (e.key === 'Enter' && open && results[active]) {
                  e.preventDefault();
                  pick(results[active].id, results[active].displayName);
                } else if (e.key === 'Backspace' && query === '' && value.length > 0) {
                  onChange(value.slice(0, -1));
                }
              }}
              className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
              data-testid={id}
            />
          </span>
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={6} className="isolate z-50">
          <Popover.Popup
            initialFocus={false}
            finalFocus={false}
            className="w-(--anchor-width) min-w-56 origin-(--transform-origin) rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none"
          >
            <div id={listID} role="listbox" aria-label={label} className="max-h-64 overflow-y-auto">
              {results.map((u, i) => (
                <button
                  key={u.id}
                  id={`${listID}-${u.id}`}
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(u.id, u.displayName)}
                  className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm mobile:min-h-11', i === active && 'bg-muted')}
                  data-testid={`${id}-option`}
                >
                  <UserAvatar displayName={u.displayName} avatarURL={u.avatarURL} className="size-6" initialsClassName="text-xs" />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{u.displayName}</span>
                    <span className="truncate text-xs text-muted-foreground">{u.email}</span>
                  </span>
                </button>
              ))}
              {results.length === 0 && <p className="px-2 py-1.5 text-sm text-muted-foreground">No one matches</p>}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
