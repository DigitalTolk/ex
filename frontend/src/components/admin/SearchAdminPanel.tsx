import { Button } from '@/components/ui/button';
import {
  useSearchAdminStatus,
  useStartSearchReindex,
  useStartSearchMappingRebuild,
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
  const rebuildMapping = useStartSearchMappingRebuild();

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
  const mappingRebuild = data.mappingRebuild;
  const mappingRunning = mappingRebuild?.running ?? false;
  const schemaVersions = data.schemaVersions ?? [];

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
          <div className="overflow-x-auto">
            <table className="mt-2 w-full min-w-[18rem] text-sm" data-testid="indices-table">
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
          </div>
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
        <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-start">
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

      <div className="rounded-md border p-3" data-testid="mapping-rebuild-card">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">
          Users &amp; channels mapping
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Rebuilds the users &amp; channels indices with the current analyzer.
          Runs automatically on deploy when the schema changes; use this to force
          a rebuild.
        </p>
        {schemaVersions.length > 0 && (
          <ul className="mt-2 space-y-0.5 text-xs" data-testid="schema-versions">
            {schemaVersions.map((v) => (
              <li key={v.index} className="flex items-center gap-2">
                <span className="font-mono text-muted-foreground">{v.index}</span>
                <span>
                  v{v.current ?? '—'} / v{v.expected}
                </span>
                {v.stale ? (
                  <span className="text-pinned" data-testid={`schema-stale-${v.index}`}>
                    rebuilding
                  </span>
                ) : (
                  <span className="text-online">up to date</span>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-start">
          <Button
            onClick={() => rebuildMapping.mutate()}
            disabled={mappingRunning || rebuildMapping.isPending}
            data-testid="mapping-rebuild-start"
          >
            {mappingRunning
              ? 'Rebuilding…'
              : rebuildMapping.isPending
                ? 'Starting…'
                : 'Rebuild users & channels'}
          </Button>
          <div className="flex-1 space-y-1 text-sm">
            <p>
              Status:{' '}
              <span className="font-medium" data-testid="mapping-rebuild-status">
                {mappingRunning ? 'running' : 'idle'}
              </span>
            </p>
            {mappingRebuild && (mappingRebuild.users || mappingRebuild.channels) ? (
              <p className="text-xs text-muted-foreground">
                Last run rebuilt {mappingRebuild.users} users, {mappingRebuild.channels}{' '}
                channels.
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              Started: {formatTime(mappingRebuild?.startedAt)} · Finished:{' '}
              {formatTime(mappingRebuild?.completedAt)}
            </p>
            {mappingRebuild?.lastError && (
              <p className="text-xs text-destructive" role="alert">
                {mappingRebuild.lastError}
              </p>
            )}
          </div>
        </div>
        {rebuildMapping.isError && (
          <p className="mt-2 text-sm text-destructive" role="alert">
            {rebuildMapping.error instanceof Error
              ? rebuildMapping.error.message
              : 'Could not start mapping rebuild'}
          </p>
        )}
        {data.mappingRebuildError && (
          <p className="mt-2 text-xs text-destructive" role="alert">
            {data.mappingRebuildError}
          </p>
        )}
      </div>
    </section>
  );
}
