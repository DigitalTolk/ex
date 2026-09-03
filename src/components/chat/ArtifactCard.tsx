import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Download, FileText, Loader2 } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import type { ArtifactMarker } from '@/lib/artifact-marker';

// ArtifactCard: the inline chat rendering of a published artifact marker
// (see lib/artifact-marker.ts) — title + size at a glance, content fetched
// only when expanded or downloaded, so a 60KB doc costs the thread nothing
// until someone asks for it.

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function fileExtension(kind: string): string {
  switch (kind.toLowerCase()) {
    case 'markdown':
    case 'md':
      return 'md';
    case 'diff':
    case 'patch':
      return 'patch';
    case 'json':
      return 'json';
    case 'html':
      return 'html';
    default:
      return 'txt';
  }
}

export function ArtifactCard({ marker }: { marker: ArtifactMarker }) {
  const [open, setOpen] = useState(false);
  const [wantContent, setWantContent] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ['artifact', marker.runID, marker.artifactID],
    queryFn: () =>
      apiFetch<{ artifact: { title: string; kind: string; content?: string } }>(
        `/api/v1/runs/${marker.runID}/artifacts/${marker.artifactID}`,
      ),
    enabled: wantContent,
    staleTime: Infinity, // artifacts are immutable once published
  });

  const download = () => {
    setWantContent(true);
    const save = (content: string) => {
      const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${marker.title.replace(/[^\w\- ]+/g, '').trim() || 'artifact'}.${fileExtension(marker.kind)}`;
      a.click();
      URL.revokeObjectURL(url);
    };
    if (data?.artifact.content != null) {
      save(data.artifact.content);
    } else {
      void apiFetch<{ artifact: { content?: string } }>(
        `/api/v1/runs/${marker.runID}/artifacts/${marker.artifactID}`,
      ).then((res) => save(res.artifact.content ?? ''));
    }
  };

  return (
    <div
      data-testid="artifact-card"
      className="my-0.5 w-fit max-w-full overflow-hidden rounded-lg border bg-muted/30"
    >
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <button
          type="button"
          onClick={() => {
            setOpen((v) => !v);
            if (!open) setWantContent(true);
          }}
          className="flex min-w-0 items-center gap-2 text-left text-sm hover:text-foreground"
          aria-expanded={open}
          title={open ? 'Collapse' : 'Expand'}
        >
          {open ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          )}
          <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 truncate font-medium">{marker.title}</span>
        </button>
        <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {marker.kind} · {formatBytes(marker.bytes)}
        </span>
        <button
          type="button"
          onClick={download}
          title="Download"
          aria-label={`Download ${marker.title}`}
          className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Download className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
      {open && (
        <div className="border-t">
          {isLoading && (
            <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              Loading…
            </div>
          )}
          {error != null && (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              Couldn’t load this artifact — it may belong to a channel you don’t have access to.
            </div>
          )}
          {data && (
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words bg-background/60 p-3 font-mono text-xs leading-relaxed">
              {data.artifact.content ?? ''}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
