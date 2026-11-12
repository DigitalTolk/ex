import { useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronDown, Webhook } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { renderMarkdown } from '@/lib/markdown';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { CopyButton } from '@/components/ui/copy-button';
import { BlockList } from '@/components/chat/blocks/MessageBlocks';
import { MessageRichAttachments } from '@/components/chat/MessageRichAttachments';
import { ViewField } from '@/components/apps/AppViewDialog';
import { initialOf, segments, type FormValue } from '@/lib/app-view-form';
import { cn } from '@/lib/utils';
import type { AppView, Message } from '@/types';
import { FORM_TEMPLATES, MESSAGE_TEMPLATES, pretty, type BuilderTemplate } from './builderTemplates';

type Mode = 'message' | 'form';
type Preview = { message: Message } | { view: AppView } | { error: string };

const MODES: Record<Mode, { label: string; templates: BuilderTemplate[]; endpoint: string; blurb: string }> = {
  message: {
    label: 'Message',
    templates: MESSAGE_TEMPLATES,
    endpoint: '/api/v1/admin/webhooks/preview',
    blurb: 'A rich webhook payload: text, blocks and cards. (A classic webhook posts the text and cards and ignores blocks.)',
  },
  form: {
    label: 'Form',
    templates: FORM_TEMPLATES,
    endpoint: '/api/v1/admin/webhooks/preview-view',
    blurb: 'A view your app opens with views.open after a click.',
  },
};

// curlFor is the command that sends the payload for real: a webhook post,
// or a views.open (whose trigger_id comes with a click). The body is the
// payload re-serialized, never the text as typed, so nothing pasted into
// the editor can end the heredoc early and run in the reader's shell; no
// command is offered for text that isn't JSON.
function curlFor(mode: Mode, payload: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  const body = JSON.stringify(mode === 'form' ? { trigger_id: 'TRIGGER_ID_FROM_THE_CLICK', view: parsed } : parsed, null, 2);
  const url = mode === 'form' ? `'${window.location.origin}/api/v1/apps/views.open'` : '"$EX_WEBHOOK_URL"';
  return `curl -X POST ${url} \\\n  -H 'Content-Type: application/json' \\\n  -H "Authorization: Bearer $EX_BOT_TOKEN" \\\n  --data-binary @- <<'JSON'\n${body}\nJSON`;
}

// MessagePreview is the webhooks panel's builder: start from a template, or
// paste a payload, and see it as ex draws it — checked by the server with
// the same rules a real post or views.open goes through, so mistakes show
// here first. Closed until asked for: nothing is sent for a page that's only
// being looked at.
export function MessagePreview() {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>('message');
  const [template, setTemplate] = useState(MESSAGE_TEMPLATES[0].key);
  const [payload, setPayload] = useState(pretty(MESSAGE_TEMPLATES[0].payload));
  // Mode and payload settle together, so a switch never sends one mode's
  // payload to the other's endpoint.
  const settled = useDebouncedValue(JSON.stringify([mode, payload]), 400);
  const [settledMode, debounced] = JSON.parse(settled) as [Mode, string];
  const cfg = MODES[mode];
  const curl = curlFor(mode, payload);

  const choose = (nextMode: Mode, t: BuilderTemplate) => {
    setMode(nextMode);
    setTemplate(t.key);
    setPayload(pretty(t.payload));
  };

  // Bad JSON is caught here; anything else is the server's to judge.
  const parsed = useMemo((): { ok: true } | { ok: false; error: string } => {
    try {
      JSON.parse(debounced);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `Not valid JSON: ${(err as Error).message}` };
    }
  }, [debounced]);

  const preview = useQuery<Preview>({
    queryKey: ['webhook-preview', settledMode, debounced],
    queryFn: async () => {
      try {
        const out = await apiFetch<Message | AppView>(MODES[settledMode].endpoint, { method: 'POST', body: debounced });
        return settledMode === 'form' ? { view: out as AppView } : { message: out as Message };
      } catch (err) {
        return { error: err instanceof Error ? err.message : 'Preview failed' };
      }
    },
    enabled: open && parsed.ok,
    staleTime: Infinity,
    retry: false,
    // The last good preview stays up while the next one loads: no flicker
    // between keystrokes.
    placeholderData: keepPreviousData,
  });

  const data = preview.data;
  const error = !parsed.ok ? parsed.error : data && 'error' in data ? data.error : undefined;

  return (
    <section className="rounded-lg border bg-card text-sm" data-testid="message-preview">
      <button
        type="button"
        className="flex w-full items-center gap-2 p-5 text-left font-medium mobile:min-h-12"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        data-testid="message-preview-toggle"
      >
        <ChevronDown className={cn('h-4 w-4 shrink-0 transition-transform', !open && '-rotate-90')} aria-hidden />
        Build a message or form
        <span className="font-normal text-muted-foreground mobile:hidden">— start from a template, see it as ex draws it</span>
      </button>
      {open && (
        <div className="flex flex-col gap-4 px-5 pb-5">
          <div className="flex flex-wrap items-center gap-3">
            <div role="tablist" aria-label="What to build" className="inline-flex rounded-lg bg-muted p-0.5">
              {(Object.keys(MODES) as Mode[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="tab"
                  aria-selected={mode === m}
                  onClick={() => choose(m, MODES[m].templates[0])}
                  className={cn('rounded-md px-3 py-1 text-sm font-medium transition-colors mobile:min-h-9', mode === m ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground')}
                  data-testid={`builder-mode-${m}`}
                >
                  {MODES[m].label}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Templates">
              {cfg.templates.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  aria-pressed={template === t.key}
                  onClick={() => choose(mode, t)}
                  className={cn(
                    'rounded-full border px-2.5 py-1 text-xs transition-colors hover:bg-muted mobile:py-1.5 mobile:text-sm',
                    template === t.key ? 'border-foreground/40 bg-muted font-medium' : 'border-border',
                  )}
                  data-testid={`builder-template-${t.key}`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <label htmlFor="message-preview-payload" className="font-medium">
                  {mode === 'form' ? 'View' : 'Payload'}
                  <span className="ml-2 text-xs font-normal text-muted-foreground mobile:hidden">{cfg.blurb}</span>
                </label>
                <div className="flex items-center gap-1">
                  {curl && <CopyButton value={curl} label="Copy as cURL" data-testid="builder-copy-curl" />}
                  <CopyButton value={payload} label="Copy JSON" />
                </div>
              </div>
              <textarea
                id="message-preview-payload"
                value={payload}
                onChange={(e) => setPayload(e.target.value)}
                spellCheck={false}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? 'message-preview-error' : undefined}
                className="min-h-96 w-full resize-y rounded-lg border border-input bg-transparent p-3 font-mono text-xs leading-relaxed outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive dark:bg-input/30"
                data-testid="message-preview-payload"
              />
              {error && (
                <p id="message-preview-error" className="text-sm text-destructive" role="alert" data-testid="message-preview-error">
                  {error}
                </p>
              )}
            </div>
            <div className="flex min-w-0 flex-col gap-2">
              <span className="font-medium">How it shows</span>
              <div
                className={cn('min-h-96 rounded-lg border bg-background p-4 transition-opacity', preview.isFetching && 'opacity-70')}
                aria-busy={preview.isFetching || undefined}
                data-testid="message-preview-result"
              >
                {data && 'message' in data && <PreviewMessage message={data.message} />}
                {data && 'view' in data && <PreviewForm key={data.view.hash + debounced.length} view={data.view} />}
                {(!data || 'error' in data) && <p className="text-muted-foreground">{mode === 'form' ? 'The form' : 'The message'} shows here.</p>}
              </div>
              <p className="text-xs text-muted-foreground">
                {mode === 'form'
                  ? 'Fields work here so you can try them; Submit goes to your app once it opens the form for real.'
                  : 'Buttons and pickers are shown, not live. Acknowledge and vote work in chat without an app server.'}
              </p>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function PreviewMessage({ message }: { message: Message }) {
  return (
    <div className="flex gap-3">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground" aria-hidden>
        <Webhook className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-semibold">{message.webhookUsername}</span>
          <Badge variant="secondary">App</Badge>
        </div>
        {message.blocks?.length ? (
          <BlockList blocks={message.blocks} className="mt-1" />
        ) : (
          message.body && <div className="prose-message mt-0.5 text-sm">{renderMarkdown(message.body)}</div>
        )}
        <MessageRichAttachments attachments={message.messageAttachments} />
      </div>
    </div>
  );
}

// PreviewForm draws a form as its dialog would, fields and all, on the page.
function PreviewForm({ view }: { view: AppView }) {
  const [values, setValues] = useState<Record<string, FormValue>>({});
  return (
    <div className="mx-auto flex max-w-lg flex-col gap-5 rounded-xl bg-popover p-4 ring-1 ring-foreground/10" data-testid="builder-form-preview">
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">Your app</span>
        <span className="text-lg leading-snug font-semibold">{view.title.text}</span>
      </div>
      {segments(view.blocks).map((segment) =>
        Array.isArray(segment) ? (
          <BlockList key={segment[0].block_id} blocks={segment} />
        ) : (
          <ViewField
            key={segment.block_id}
            id={`builder-${segment.block_id}`}
            block={segment}
            value={values[segment.block_id] ?? initialOf(segment.element)}
            onChange={(v) => setValues((cur) => ({ ...cur, [segment.block_id]: v }))}
            onSubmitShortcut={() => {}}
          />
        ),
      )}
      <div className="-mx-4 -mb-4 flex justify-end gap-2 rounded-b-xl border-t bg-muted/50 p-4">
        <Button variant="ghost" type="button" disabled>
          {view.close?.text ?? 'Cancel'}
        </Button>
        {view.submit && (
          <Button type="button" disabled title="Submit goes to your app">
            {view.submit.text}
          </Button>
        )}
      </div>
    </div>
  );
}
