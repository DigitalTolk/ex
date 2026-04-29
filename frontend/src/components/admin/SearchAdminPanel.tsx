import { Button } from '@/components/ui/button';
import {
  useSearchAdminStatus,
  useStartSearchReindex,
} from '@/hooks/useSearchAdmin';

// Distilled cluster fields the panel shows. OpenSearch returns more,
// but we only render the ones an operator usually checks at a glance.
function clusterField(record: Record<string, unknown> | undefined, key: string): string {
  if (!record) return '—';
  const v = record[key];
  if (v === undefined || v === null || v === '') return '—';
  return String(v);
}

function formatTime(unix?: number): string {
  if (!unix || unix <= 0) return '—';
  return new Date(unix * 1000).toLocaleString();
}

export function SearchAdminPanel() {
  const { data, isLoading, isError, error } = useSearchAdminStatus();
  const start = useStartSearchReindex();

  if (isLoading) {
    return (
      <section className="space-y-4 rounded-lg border bg-card p-5">
        <h2 className="text-base font-semibold">Search</h2>
        <p className="text-sm text-muted-foreground">Loading…</p>
      </section>
    );
  }

  if (isError) {
    return (
      <section className="space-y-4 rounded-lg border bg-card p-5">
        <h2 className="text-base font-semibold">Search</h2>
        <p className="text-sm text-destructive" role="alert">
          {error instanceof Error ? error.message : 'Could not load search status'}
        </p>
      </section>
    );
  }

  if (!data?.configured) {
    return (
      <section className="space-y-2 rounded-lg border bg-card p-5">
        <h2 className="text-base font-semibold">Search</h2>
        <p className="text-sm text-muted-foreground">
          Search isn't configured for this deployment. Set{' '}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">OPENSEARCH_URL</code>{' '}
          and restart the server to enable it.
        </p>
      </section>
    );
  }

  const reindex = data.reindex;
  const running = reindex?.running ?? false;

  return (
    <section className="space-y-4 rounded-lg border bg-card p-5" data-testid="admin-search-panel">
      <div>
        <h2 className="text-base font-semibold">Search</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          OpenSearch backs the global search box. Use <em>Rebuild index</em>{' '}
          after restoring a backup or wiring up a fresh cluster.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-md border p-3">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            Cluster
          </p>
          <dl className="mt-2 space-y-1 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Status</dt>
              <dd className="font-medium" data-testid="cluster-status">
                {clusterField(data.cluster, 'status')}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Nodes</dt>
              <dd>{clusterField(data.cluster, 'number_of_nodes')}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Active shards</dt>
              <dd>{clusterField(data.cluster, 'active_shards')}</dd>
            </div>
          </dl>
          {data.clusterError && (
            <p className="mt-2 text-xs text-destructive" role="alert">
              {data.clusterError}
            </p>
          )}
        </div>

        <div className="rounded-md border p-3">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            Indices
          </p>
          <table className="mt-2 w-full text-sm" data-testid="indices-table">
            <thead className="text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="pb-1 text-left font-normal">Index</th>
                <th className="pb-1 text-right font-normal">Docs</th>
                <th className="pb-1 text-right font-normal">Size</th>
              </tr>
            </thead>
            <tbody>
              {(data.indices ?? []).map((idx) => (
                <tr key={idx.name}>
                  <td className="py-1">
                    <span className="font-medium">{idx.name}</span>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {idx.health}
                    </span>
                  </td>
                  <td className="py-1 text-right tabular-nums">{idx.docs}</td>
                  <td className="py-1 text-right tabular-nums">
                    {idx.storeSize || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.indicesError && (
            <p className="mt-2 text-xs text-destructive" role="alert">
              {data.indicesError}
            </p>
          )}
        </div>
      </div>

      <div className="rounded-md border p-3" data-testid="reindex-card">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">
          Reindex
        </p>
        <div className="mt-2 flex items-start gap-3">
          <Button
            onClick={() => start.mutate()}
            disabled={running || start.isPending}
            data-testid="reindex-start"
          >
            {running ? 'Reindexing…' : start.isPending ? 'Starting…' : 'Rebuild index'}
          </Button>
          <div className="flex-1 space-y-1 text-sm">
            <p>
              Status:{' '}
              <span className="font-medium" data-testid="reindex-status">
                {running ? 'running' : 'idle'}
              </span>
            </p>
            {reindex && (reindex.users || reindex.channels || reindex.messages || reindex.files) ? (
              <p className="text-xs text-muted-foreground">
                Last run indexed {reindex.users} users, {reindex.channels} channels,{' '}
                {reindex.messages} messages, {reindex.files} files.
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              Started: {formatTime(reindex?.startedAt)} · Finished:{' '}
              {formatTime(reindex?.completedAt)}
            </p>
            {reindex?.lastError && (
              <p className="text-xs text-destructive" role="alert">
                {reindex.lastError}
              </p>
            )}
          </div>
        </div>
        {start.isError && (
          <p className="mt-2 text-sm text-destructive" role="alert">
            {start.error instanceof Error ? start.error.message : 'Could not start reindex'}
          </p>
        )}
      </div>
    </section>
  );
}
