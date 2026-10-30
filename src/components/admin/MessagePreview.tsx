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
import { cn } from '@/lib/utils';
import type { Message } from '@/types';

// A payload that shows what blocks can do: a header, a section with a link
// button, built-in acknowledge and vote buttons, and a context line with a
// time in each viewer's own zone.
const SAMPLE_PAYLOAD = JSON.stringify(
  {
    text: 'Deploy of api 1.42 finished',
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'Deploy finished' } },
      {
        type: 'section',
        text: { type: 'markdown', text: '**api 1.42** is live on production.' },
        accessory: { type: 'button', text: { type: 'plain_text', text: 'Open release notes' }, url: 'https://example.com/releases/1.42' },
      },
      {
        type: 'actions',
        elements: [
          { type: 'button', style: 'primary', ex_action: 'ack', text: { type: 'plain_text', text: 'Acknowledge' } },
          { type: 'button', ex_action: 'vote', text: { type: 'plain_text', text: 'Looks good' } },
        ],
      },
      { type: 'context', elements: [{ type: 'markdown', text: 'Finished <!date^1761058323^{time}|14:52 UTC> by the release bot' }] },
    ],
  },
  null,
  2,
);

type Preview = { message: Message } | { error: string };

// MessagePreview checks a webhook payload with the server — the same checks
// a post goes through — and draws the message as ex would, so a payload can
// be got right before any app sends it. Closed until asked for: nothing is
// sent for a page that's only being looked at.
export function MessagePreview() {
  const [open, setOpen] = useState(false);
  const [payload, setPayload] = useState(SAMPLE_PAYLOAD);
  const debounced = useDebouncedValue(payload, 400);

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
    queryKey: ['webhook-preview', debounced],
    queryFn: async () => {
      try {
        const message = await apiFetch<Message>('/api/v1/admin/webhooks/preview', { method: 'POST', body: debounced });
        return { message };
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

  const error = !parsed.ok ? parsed.error : preview.data && 'error' in preview.data ? preview.data.error : undefined;
  const message = preview.data && 'message' in preview.data ? preview.data.message : undefined;

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
        Preview a message
        <span className="font-normal text-muted-foreground">— paste a payload to see how ex draws it</span>
      </button>
      {open && (
        <div className="grid gap-4 px-5 pb-5 lg:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor="message-preview-payload" className="font-medium">
                Payload
              </label>
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="sm" onClick={() => setPayload(SAMPLE_PAYLOAD)} data-testid="message-preview-reset">
                  Example
                </Button>
                <CopyButton value={payload} label="Copy payload" />
              </div>
            </div>
            <textarea
              id="message-preview-payload"
              value={payload}
              onChange={(e) => setPayload(e.target.value)}
              spellCheck={false}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'message-preview-error' : undefined}
              className="min-h-72 w-full resize-y rounded-lg border border-input bg-transparent p-3 font-mono text-xs leading-relaxed outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive dark:bg-input/30"
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
              className={cn('min-h-72 rounded-lg border bg-background p-4 transition-opacity', preview.isFetching && 'opacity-70')}
              aria-busy={preview.isFetching || undefined}
              data-testid="message-preview-result"
            >
              {message ? <PreviewMessage message={message} /> : <p className="text-muted-foreground">The message shows here.</p>}
            </div>
            <p className="text-xs text-muted-foreground">
              Buttons are shown, not live. Acknowledge and vote work in chat without an app server.
            </p>
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
