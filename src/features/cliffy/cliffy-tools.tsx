/* eslint-disable react-refresh/only-export-components -- assistant-ui tool
   renderers (makeAssistantToolUI) are not plain components; fast-refresh
   boundaries don't apply to this leaf module of tool UIs. */
import { memo, useState, type AnchorHTMLAttributes } from 'react';
import { makeAssistantToolUI } from '@assistant-ui/react';
import { MarkdownTextPrimitive } from '@assistant-ui/react-markdown';
import remarkGfm from 'remark-gfm';
import { getAccessToken } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useCliffyStore, type CliffyScope } from './cliffy-store';

/**
 * Cliffy's assistant-ui tool renderers, ex flavour.
 *
 * Reads (executeApi/search/…) run server-side inside the agent turn, so they
 * need no UI here — the ToolFallback shows a subtle "working" chip. writeApi is
 * the one human-in-the-loop tool: it has no server execute, so its approval card
 * runs the approved call through ex's write passthrough (/api/v1/cliffy/api,
 * which injects the bridged CliffHub token) and feeds the outcome back to the
 * agent via addResult.
 */

// Cliffy emits relative CliffHub app links (e.g. /tasks/<id>). In ex those must
// become absolute CliffHub URLs opened in a new tab — ex isn't CliffHub.
function CliffhubAnchor({ href, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  const base = useCliffyStore((s) => s.cliffhubBase);
  let finalHref = href;
  let external = false;
  if (href && href.startsWith('/') && !href.startsWith('//') && base) {
    finalHref = base + href;
    external = true;
  } else if (href && /^https?:\/\//i.test(href)) {
    external = true;
  }
  return (
    <a
      href={finalHref}
      {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      className="font-medium text-brand underline underline-offset-2 hover:text-brand/80"
      {...props}
    >
      {children}
    </a>
  );
}

export const MarkdownText = memo(function MarkdownText() {
  return (
    <MarkdownTextPrimitive
      components={{ a: CliffhubAnchor }}
      remarkPlugins={[remarkGfm]}
      className={cn(
        'text-sm leading-relaxed',
        '[&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0',
        '[&_ul]:my-2 [&_ul]:ml-4 [&_ul]:list-disc [&_ol]:my-2 [&_ol]:ml-4 [&_ol]:list-decimal [&_li]:mt-1',
        '[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2',
        '[&_h1]:mb-2 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:mt-3 [&_h2]:mb-1.5 [&_h2]:text-sm [&_h2]:font-semibold',
        '[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em]',
        '[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:bg-muted/40 [&_pre]:p-3 [&_pre]:text-xs',
        '[&_table]:my-2 [&_table]:w-full [&_table]:border-collapse [&_table]:text-xs',
        '[&_th]:border [&_th]:bg-muted/60 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_td]:border [&_td]:px-2 [&_td]:py-1',
        '[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground',
      )}
    />
  );
});

/** Subtle chip for any read/lookup tool that renders no card of its own. */
export function ToolFallback({ toolName }: { toolName: string }) {
  const label = READ_TOOL_LABELS[toolName] ?? 'Working…';
  return (
    <div className="my-1.5 flex items-center gap-2 text-xs text-muted-foreground">
      <span className="inline-block size-1.5 animate-pulse rounded-full bg-primary/70" />
      {label}
    </div>
  );
}

const READ_TOOL_LABELS: Record<string, string> = {
  executeApi: 'Looking that up…',
  queryKnowledgeBase: 'Finding the right action…',
  search: 'Searching…',
  searchDocs: 'Searching the docs…',
  readDocSection: 'Reading the docs…',
};

type WriteApiArgs = {
  method: string;
  path: string;
  query?: Record<string, string> | null;
  body?: Record<string, unknown> | null;
  summary?: string;
};

type WriteResult = {
  approved: boolean;
  executed: boolean;
  ok?: boolean;
  status?: number;
  message?: string;
  data?: unknown;
  rejected?: boolean;
  error?: string;
};

const MAX_RESULT_CHARS = 4000;

function boundedData(data: unknown): unknown {
  const serialized = JSON.stringify(data ?? null);
  return serialized.length > MAX_RESULT_CHARS ? serialized.slice(0, MAX_RESULT_CHARS) + '…[truncated]' : data;
}

function extractMessage(data: unknown): string | undefined {
  if (data && typeof data === 'object' && 'message' in data) {
    const m = (data as { message?: unknown }).message;
    if (typeof m === 'string' && m.trim()) return m;
  }
  return undefined;
}

// Run an APPROVED write through ex's passthrough, which injects the bridged
// CliffHub token server-side. Raw fetch (not apiFetch) so a 4xx still yields the
// body — the agent needs to see validation errors, not just a thrown exception.
async function runWrite(args: WriteApiArgs): Promise<{ status: number; ok: boolean; data: unknown }> {
  const res = await fetch('/api/v1/cliffy/api', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${getAccessToken() ?? ''}`,
    },
    body: JSON.stringify({
      method: args.method,
      path: args.path,
      query: args.query ?? undefined,
      body: args.body ?? undefined,
    }),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, ok: res.ok, data };
}

// Post a Cliffy card into the conversation the panel was opened from, so both
// participants see the result (the "visible to both" mode). ex-side endpoint;
// no CliffHub token involved.
async function runShare(scope: CliffyScope, text: string): Promise<void> {
  const res = await fetch('/api/v1/cliffy/share', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${getAccessToken() ?? ''}`,
    },
    body: JSON.stringify({ scope_type: scope.type, scope_id: scope.id, text }),
  });
  if (!res.ok) throw new Error(`share failed (${res.status})`);
}

export const WriteApiToolUI = makeAssistantToolUI<WriteApiArgs, WriteResult>({
  toolName: 'writeApi',
  render: ({ args, result, addResult }) => <ApprovalCard args={args} result={result} addResult={addResult} />,
});

function ApprovalCard({
  args,
  result,
  addResult,
}: {
  args?: Partial<WriteApiArgs>;
  result?: WriteResult;
  addResult: (result: WriteResult) => void;
}) {
  const [busy, setBusy] = useState(false);
  const scope = useCliffyStore((s) => s.scope);
  const [shareState, setShareState] = useState<'idle' | 'sharing' | 'shared' | 'error'>('idle');
  const summary = args?.summary || `${args?.method ?? ''} ${args?.path ?? ''}`.trim() || 'this action';

  const approve = async () => {
    if (!args?.method || !args?.path) return;
    setBusy(true);
    try {
      const res = await runWrite(args as WriteApiArgs);
      addResult({
        approved: true,
        executed: true,
        ok: res.ok,
        status: res.status,
        message: extractMessage(res.data),
        data: boundedData(res.data),
      });
    } catch (err) {
      addResult({ approved: true, executed: false, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  };

  const reject = () => addResult({ approved: false, executed: false, rejected: true });

  const settled = result != null;
  const done = settled && result.executed === true && result.ok === true;
  const rejected = settled && result.rejected === true;
  const failed = settled && !done && !rejected;

  const header = done
    ? 'Action completed'
    : rejected
      ? 'Action cancelled'
      : failed
        ? 'Action failed'
        : 'Approve this action?';

  return (
    <div
      className={cn(
        'my-2 overflow-hidden rounded-xl border',
        rejected || failed ? 'border-border bg-muted/30' : done ? 'border-border bg-muted/20' : 'border-amber-500/40 bg-amber-500/5',
      )}
    >
      <div
        className={cn(
          'px-3 py-2 text-xs font-semibold',
          done ? 'text-foreground' : failed ? 'text-destructive' : rejected ? 'text-muted-foreground' : 'text-amber-600 dark:text-amber-400',
        )}
      >
        {header}
      </div>
      <div className="px-3 pb-2 text-sm">{summary}</div>
      {failed && result?.message && <div className="px-3 pb-2 text-xs text-destructive">{result.message}</div>}
      {!settled && (
        <div className="flex gap-2 px-3 pb-3">
          <Button size="sm" onClick={approve} disabled={busy}>
            {busy ? 'Working…' : 'Approve'}
          </Button>
          <Button size="sm" variant="outline" onClick={reject} disabled={busy}>
            Reject
          </Button>
        </div>
      )}
      {done && scope && (
        <div className="flex items-center gap-2 px-3 pb-3">
          {shareState === 'shared' ? (
            <span className="text-xs text-muted-foreground">
              Shared to {scope.name ?? 'the conversation'}
            </span>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={shareState === 'sharing'}
              onClick={async () => {
                setShareState('sharing');
                try {
                  await runShare(scope, `✅ ${summary}`);
                  setShareState('shared');
                } catch {
                  setShareState('error');
                }
              }}
            >
              {shareState === 'sharing' ? 'Sharing…' : `Share to ${scope.name ?? 'conversation'}`}
            </Button>
          )}
          {shareState === 'error' && <span className="text-xs text-destructive">Couldn't share</span>}
        </div>
      )}
    </div>
  );
}

type OpenPageArgs = { path: string; label?: string };

// openPage navigates within CliffHub, not ex. Without CliffHub's web origin in
// the SPA we can't build a working link, so we surface it as an informational
// chip. (Refinement: inject CliffHub's web base and make this a real link.)
export const OpenPageToolUI = makeAssistantToolUI<OpenPageArgs, { ok: boolean; path: string; label?: string }>({
  toolName: 'openPage',
  render: ({ args, result }) => {
    const path = result?.path ?? args?.path;
    if (!path) return null;
    const label = result?.label ?? args?.label ?? path;
    return (
      <div className="my-1.5 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        Cliffy suggests opening <span className="font-medium text-foreground">{label}</span> in CliffHub
        <span className="ml-1 font-mono opacity-70">({path})</span>
      </div>
    );
  },
});
