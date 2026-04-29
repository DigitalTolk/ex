import { useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { File as FileIcon, Hash, MessageSquare, User as UserIcon, X } from 'lucide-react';
import { PageContainer } from '@/components/layout/PageContainer';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  useSearchUsers,
  useSearchChannels,
  useSearchMessages,
  useSearchFiles,
  type SearchHit,
} from '@/hooks/useSearch';
import { useUsersBatch } from '@/hooks/useUsersBatch';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { useUserChannels } from '@/hooks/useChannels';
import { useUserConversations, useCreateConversation } from '@/hooks/useConversations';
import { useMessageParent } from '@/hooks/useMessageParent';
import { formatLongDateTime, getInitials } from '@/lib/format';
import { highlight } from '@/lib/highlight';
import { MessageHitCard } from '@/components/search/MessageHitCard';
import { BucketPicker } from '@/components/search/BucketPicker';

type Tab = 'all' | 'messages' | 'files' | 'channels' | 'people' | 'dms';
type Sort = '' | 'newest' | 'oldest';

const SORT_LABELS: Record<Sort, string> = {
  '': 'Most relevant',
  newest: 'Newest first',
  oldest: 'Oldest first',
};

// SearchResultsPage drives every filter from the URL so back/forward
// and external deep-links are first-class.
export default function SearchResultsPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const tab = (params.get('type') as Tab) || 'all';
  const sort = (params.get('sort') as Sort) || '';
  const from = params.get('from') ?? '';
  const inParent = params.get('in') ?? '';

  useDocumentTitle(q ? `Search: ${q}` : 'Search');

  function updateParams(patch: Record<string, string | null>) {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '') next.delete(k);
      else next.set(k, v);
    }
    setParams(next, { replace: true });
  }

  // Users and Channels indices have no from/in filter, so a text
  // query is required for those. Messages and Files accept a filter-
  // only search ("all from user X", "all in ~channel"), gated by the
  // backend's empty-q check.
  const hasQuery = q.trim().length >= 2;
  const hasFilter = !!(from || inParent);
  const enabled = hasQuery || hasFilter;
  const wantUsers = hasQuery && (tab === 'all' || tab === 'people');
  const wantChannels = hasQuery && (tab === 'all' || tab === 'channels');
  const wantMessages = enabled && (tab === 'all' || tab === 'messages' || tab === 'dms');
  const wantFiles = enabled && (tab === 'all' || tab === 'files');

  const users = useSearchUsers(q, wantUsers, 25);
  const channels = useSearchChannels(q, wantChannels, 25);
  const messages = useSearchMessages(q, wantMessages, 50, { from, in: inParent, sort });
  const files = useSearchFiles(q, wantFiles, 30, { from, in: inParent, sort });

  const userHits = useMemo(() => users.data?.hits ?? [], [users.data]);
  const channelHits = useMemo(() => channels.data?.hits ?? [], [channels.data]);
  const rawMsgHits = useMemo(() => messages.data?.hits ?? [], [messages.data]);
  const fileHits = useMemo(() => files.data?.hits ?? [], [files.data]);

  const msgHits = useMemo(
    () =>
      tab === 'dms'
        ? rawMsgHits.filter((h) => h._source.parentType === 'conversation')
        : rawMsgHits,
    [rawMsgHits, tab],
  );

  const totalHits = userHits.length + channelHits.length + msgHits.length + fileHits.length;
  const isLoading = users.isLoading || channels.isLoading || messages.isLoading || files.isLoading;

  const { data: fromUserList = [] } = useUsersBatch(from ? [from] : []);
  const fromUser = fromUserList[0];
  const { data: userChannels = [] } = useUserChannels();
  const { data: userConversations = [] } = useUserConversations();
  const inParentLabel = useMemo(() => {
    if (!inParent) return '';
    const ch = userChannels.find((c) => c.channelID === inParent);
    if (ch) return `~${ch.channelName}`;
    const conv = userConversations.find((c) => c.conversationID === inParent);
    return conv?.displayName ?? '';
  }, [inParent, userChannels, userConversations]);

  if (!enabled) {
    return (
      <PageContainer title="Search">
        <p className="text-sm text-muted-foreground">Type a query in the top bar to search.</p>
      </PageContainer>
    );
  }

  // Pull filter buckets from whichever search the current tab is on.
  // Messages/Files both expose `byUser` / `byParent` aggregations.
  const aggSource = tab === 'files' ? files.data?.aggs : messages.data?.aggs;
  const userBuckets = aggSource?.byUser ?? [];
  const parentBuckets = aggSource?.byParent ?? [];

  return (
    <PageContainer title={`Search: ${q}`}>
      <div role="tablist" className="flex flex-wrap gap-1 border-b">
        {(
          [
            { id: 'all', label: 'All', count: totalHits },
            { id: 'messages', label: 'Messages', count: rawMsgHits.length },
            { id: 'dms', label: 'DMs', count: rawMsgHits.filter((h) => h._source.parentType === 'conversation').length },
            { id: 'files', label: 'Files', count: fileHits.length },
            { id: 'people', label: 'People', count: userHits.length },
            { id: 'channels', label: 'Channels', count: channelHits.length },
          ] as const
        ).map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => updateParams({ type: t.id === 'all' ? null : t.id })}
            className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px ${
              tab === t.id
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {t.label} <span className="text-xs text-muted-foreground">{t.count}</span>
          </button>
        ))}
      </div>

      <div className="my-3 flex flex-wrap items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger
            data-testid="results-sort"
            className="inline-flex items-center gap-1 rounded-md border bg-background px-2 py-1 text-xs hover:bg-muted"
          >
            Sort: {SORT_LABELS[sort]}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {(Object.keys(SORT_LABELS) as Sort[]).map((s) => (
              <DropdownMenuItem key={s} onClick={() => updateParams({ sort: s || null })}>
                {SORT_LABELS[s]}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {fromUser ? (
          <FilterChip
            label={`From: ${fromUser.displayName}`}
            onClear={() => updateParams({ from: null })}
          />
        ) : (
          <BucketPicker
            kind="users"
            buttonLabel="From: anyone ▾"
            buckets={userBuckets}
            onPick={(id) => updateParams({ from: id })}
          />
        )}
        {inParentLabel ? (
          <FilterChip
            label={`In: ${inParentLabel}`}
            onClear={() => updateParams({ in: null })}
          />
        ) : (
          <BucketPicker
            kind="channels"
            buttonLabel="In: any channel ▾"
            buckets={parentBuckets}
            onPick={(id) => updateParams({ in: id })}
          />
        )}
      </div>

      {isLoading && (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      )}

      {!isLoading && totalHits === 0 && (
        <p className="py-12 text-center text-muted-foreground">
          No results for <span className="font-semibold">{q}</span>.
        </p>
      )}

      {!isLoading && (
        <div className="space-y-6">
          {(tab === 'all' || tab === 'messages' || tab === 'dms') && msgHits.length > 0 && (
            <Section title={tab === 'dms' ? 'DMs' : 'Messages'} icon={<MessageSquare className="h-4 w-4" />}>
              <ul className="space-y-2">
                {msgHits.map((h) => (
                  <li key={h.id}>
                    <MessageHitCard
                      hit={h}
                      onAuthorClick={(id) => id && updateParams({ from: id })}
                    />
                  </li>
                ))}
              </ul>
            </Section>
          )}
          {(tab === 'all' || tab === 'files') && fileHits.length > 0 && (
            <Section title="Files" icon={<FileIcon className="h-4 w-4" />}>
              <ul className="space-y-2">
                {fileHits.map((h) => (
                  <FileHitRow key={h.id} hit={h} query={q} />
                ))}
              </ul>
            </Section>
          )}
          {(tab === 'all' || tab === 'channels') && channelHits.length > 0 && (
            <Section title="Channels" icon={<Hash className="h-4 w-4" />}>
              <ul className="space-y-2">
                {channelHits.map((h) => (
                  <ChannelHitRow key={h.id} hit={h} />
                ))}
              </ul>
            </Section>
          )}
          {(tab === 'all' || tab === 'people') && userHits.length > 0 && (
            <Section title="People" icon={<UserIcon className="h-4 w-4" />}>
              <ul className="space-y-2">
                {userHits.map((h) => (
                  <UserHitRow key={h.id} hit={h} />
                ))}
              </ul>
            </Section>
          )}
        </div>
      )}
    </PageContainer>
  );
}

function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-muted-foreground">
        {icon}
        {title}
      </h2>
      {children}
    </section>
  );
}

function FilterChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs">
      {label}
      <button
        type="button"
        onClick={onClear}
        aria-label={`Clear ${label}`}
        className="rounded text-muted-foreground hover:text-foreground"
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}

function FileHitRow({ hit, query }: { hit: SearchHit; query: string }) {
  // ex_files docs carry parallel parentIds / messageIds /
  // parentMessageIds slices — pick the first allowed parent and use
  // the matching slice entries so the click deep-links into the
  // right context (top-level message vs. thread reply).
  const filename = String(hit._source.filename ?? '');
  const parentIds = (hit._source.parentIds as string[] | undefined) ?? [];
  const messageIds = (hit._source.messageIds as string[] | undefined) ?? [];
  const parentMessageIds = (hit._source.parentMessageIds as string[] | undefined) ?? [];
  const created = hit._source.createdAt ? formatLongDateTime(String(hit._source.createdAt)) : '';
  const targetMsgId = messageIds[0];
  const targetThreadRoot = parentMessageIds[0] || undefined;
  const parent = useMessageParent(parentIds[0] ?? '', targetMsgId, targetThreadRoot);

  const inner = (
    <div className="flex items-start gap-3 rounded-lg border bg-card p-3 transition-colors hover:bg-muted/40">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted">
        <FileIcon className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-semibold truncate">
            {filename ? highlight(filename, query) : '(unnamed)'}
          </span>
          {created && (
            <span className="ml-auto text-xs text-muted-foreground">{created}</span>
          )}
        </div>
        {parent && (
          <p className="mt-1 truncate text-xs text-muted-foreground">in {parent.label}</p>
        )}
      </div>
    </div>
  );
  return (
    <li>
      {parent ? (
        <Link to={parent.href} className="block">
          {inner}
        </Link>
      ) : (
        inner
      )}
    </li>
  );
}

function ChannelHitRow({ hit }: { hit: SearchHit }) {
  const name = String(hit._source.name ?? hit.id);
  const slug = String(hit._source.slug ?? '');
  const description = String(hit._source.description ?? '');
  return (
    <li>
      <Link
        to={`/channel/${slug || hit.id}`}
        className="flex items-start gap-3 rounded-lg border bg-card p-3 transition-colors hover:bg-muted/40"
      >
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted">
          <Hash className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">~{name}</p>
          {description && (
            <p className="truncate text-sm text-muted-foreground">{description}</p>
          )}
        </div>
      </Link>
    </li>
  );
}

function UserHitRow({ hit }: { hit: SearchHit }) {
  const name = String(hit._source.displayName ?? hit.id);
  const email = String(hit._source.email ?? '');
  const role = String(hit._source.systemRole ?? '');
  const navigate = useNavigate();
  const createConv = useCreateConversation();

  function openDM() {
    createConv.mutate(
      { type: 'dm', participantIDs: [hit.id] },
      { onSuccess: (conv) => navigate(`/conversation/${conv.id}`) },
    );
  }

  return (
    <li>
      <button
        type="button"
        onClick={openDM}
        className="flex w-full items-start gap-3 rounded-lg border bg-card p-3 text-left transition-colors hover:bg-muted/40"
      >
        <Avatar className="h-9 w-9">
          <AvatarFallback className="text-xs">{getInitials(name || '??')}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold">{name}</p>
            {role && (
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                {role}
              </span>
            )}
          </div>
          {email && <p className="truncate text-sm text-muted-foreground">{email}</p>}
        </div>
      </button>
    </li>
  );
}
