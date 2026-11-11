import { useState } from 'react';
import { SearchInput } from '@/components/ui/search-input';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useEntraGroupSearch } from '@/hooks/useUserGroups';
import type { EntraGroup } from '@/types/generated';

const KIND_LABEL: Record<string, string> = { m365: 'Microsoft 365', security: 'Security', dynamic: 'Dynamic' };

interface PickerProps {
  value: EntraGroup | null;
  onChange: (group: EntraGroup) => void;
}

// EntraGroupPicker searches the workspace's Microsoft 365 (Entra) groups by
// name and picks one to link a user group to.
export function EntraGroupPicker({ value, onChange }: PickerProps) {
  const [query, setQuery] = useState('');
  const debounced = useDebouncedValue(query, 300);
  const { data: groups, isFetching } = useEntraGroupSearch(debounced);
  return (
    <div className="space-y-2">
      <SearchInput
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search Microsoft 365 groups"
        aria-label="Search Microsoft 365 groups"
      />
      {debounced.trim() !== '' && (
        <ul className="max-h-48 space-y-1 overflow-y-auto" aria-label="Microsoft 365 groups">
          {(groups ?? []).map((g) => (
            <li key={g.id}>
              <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted">
                <input type="radio" name="entra-group" checked={value?.id === g.id} onChange={() => onChange(g)} aria-label={g.displayName} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{g.displayName}</span>
                  {g.mail && <span className="block truncate text-xs text-muted-foreground">{g.mail}</span>}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">{KIND_LABEL[g.kind] ?? g.kind}</span>
              </label>
            </li>
          ))}
          {!isFetching && groups?.length === 0 && <li className="px-2 py-1.5 text-sm text-muted-foreground">No groups match.</li>}
        </ul>
      )}
    </div>
  );
}
