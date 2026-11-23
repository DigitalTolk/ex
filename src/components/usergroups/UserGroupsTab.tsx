import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { SearchInput } from '@/components/ui/search-input';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { useUserGroupPermissions, useUserGroups } from '@/hooks/useUserGroups';
import { rankedMatches } from '@/lib/fuzzy';
import { UserGroupDetailDialog } from './UserGroupDetailDialog';
import { UserGroupSyncReport } from './UserGroupSyncReport';

// UserGroupsTab is Directory › Groups: every user group by handle (one per
// Microsoft 365 group ex is connected to), a search, and — for admins — the
// sync report and disabling. "?group=<id>" opens one group (the mention
// card links here).
export function UserGroupsTab() {
  const [query, setQuery] = useState('');
  const [showDisabled, setShowDisabled] = useState(false);
  const [params, setParams] = useSearchParams();
  const openId = params.get('group') ?? '';
  const { canManage } = useUserGroupPermissions();
  const { data: groups, isLoading } = useUserGroups(showDisabled);

  const visible = rankedMatches(groups ?? [], query, (g) => [g.handle, g.name, g.description]);
  const open = (id: string) => setParams((p) => { p.set('group', id); return p; });
  const close = () => setParams((p) => { p.delete('group'); return p; });

  return (
    <div className="space-y-4 py-4">
      <div className="flex flex-wrap items-center gap-3">
        <SearchInput
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search user groups"
          aria-label="Search user groups"
          containerClassName="min-w-0 flex-1"
        />
        <div className="flex items-center gap-2">
          <Switch id="usergroups-show-disabled" checked={showDisabled} onCheckedChange={setShowDisabled} />
          <Label htmlFor="usergroups-show-disabled" className="text-sm">
            Show disabled
          </Label>
        </div>
      </div>
      {canManage && <UserGroupSyncReport />}

      {isLoading ? (
        <div className="space-y-1">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : visible.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {query ? 'No user groups match.' : "No user groups yet. They come from Microsoft 365."}
        </p>
      ) : (
        <ul className="space-y-1" aria-label="User groups">
          {visible.map((g) => (
            <li key={g.id}>
              <button
                type="button"
                onClick={() => open(g.id)}
                className="flex w-full items-center gap-3 rounded-md px-3 py-1.5 text-left hover:bg-muted"
              >
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold">@{g.handle}</span>
                    <span className="truncate text-sm text-muted-foreground">{g.name}</span>
                    {g.disabled && <Badge variant="secondary">Disabled</Badge>}
                  </span>
                  {g.description && <span className="block truncate text-xs text-muted-foreground">{g.description}</span>}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {g.memberCount} {g.memberCount === 1 ? 'member' : 'members'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {openId && <UserGroupDetailDialog key={openId} groupId={openId} canManage={canManage} onClose={close} />}
    </div>
  );
}
