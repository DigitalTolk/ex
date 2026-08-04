import { useState } from 'react';
import type { MessageAction, MessageAttachment } from '@/types';
import { renderMarkdown } from '@/lib/markdown';
import { isSafeUrl } from '@/lib/url-safety';
import { Button } from '@/components/ui/button';
import { useInvokeMessageAction } from '@/hooks/useMessageActions';

// Image src must be a real fetchable URL — http(s) only. isSafeUrl also admits
// mailto (fine for links, not images), so narrow it here. The backend already
// proxies these through the SSRF-guarded image proxy; this is defense-in-depth
// so a javascript:/data:/file: URL never reaches an <img src>.
function safeImg(url?: string): string | undefined {
  if (!url || !isSafeUrl(url) || /^\s*mailto:/i.test(url)) return undefined;
  return url;
}

// The chat an attachment lives in, needed to invoke its interactive actions.
// Absent (e.g. in a preview or a search result) renders the actions disabled
// rather than hiding them, so the message still reads the way its author meant.
export interface AttachmentActionTarget {
  parentType: 'channel' | 'conversation';
  parentID: string;
  messageID: string;
}

export function MessageRichAttachments({
  attachments,
  onContentHeightChange,
  actionTarget,
}: {
  attachments?: MessageAttachment[];
  onContentHeightChange?: () => void;
  actionTarget?: AttachmentActionTarget;
}) {
  if (!attachments?.length) return null;
  return (
    <div className="mt-2 space-y-2">
      {attachments.map((att, index) => (
        <div
          key={index}
          data-testid="message-rich-attachment"
          className="relative overflow-hidden rounded-md border bg-background p-3"
          style={{ borderLeftWidth: 4, borderLeftColor: validColor(att.color) ?? 'var(--border)' }}
        >
          {safeImg(att.thumb_url) && (
            <img
              src={safeImg(att.thumb_url)}
              alt=""
              className="float-right ml-3 h-[75px] w-[75px] rounded object-cover"
              onLoad={onContentHeightChange}
            />
          )}
          {att.pretext && <div className="mb-2 text-sm prose-message">{renderMarkdown(att.pretext)}</div>}
          {att.author_name && (
            <div className="mb-1 flex items-center gap-1.5 text-sm font-medium">
              {safeImg(att.author_icon) && <img src={safeImg(att.author_icon)} alt="" className="h-4 w-4 rounded-sm" onLoad={onContentHeightChange} />}
              {att.author_link && isSafeUrl(att.author_link) ? <a href={att.author_link} target="_blank" rel="noreferrer" className="text-link">{att.author_name}</a> : att.author_name}
            </div>
          )}
          {att.title && (
            <div className="mb-1 text-sm font-semibold">
              {att.title_link && isSafeUrl(att.title_link) ? <a href={att.title_link} target="_blank" rel="noreferrer" className="text-link">{att.title}</a> : att.title}
            </div>
          )}
          {att.text && <div className="text-sm prose-message">{renderMarkdown(att.text)}</div>}
          {att.fields?.length ? (
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {att.fields.map((field, fieldIndex) => (
                <div key={fieldIndex} className={field.short ? '' : 'sm:col-span-2'}>
                  {field.title && <div className="text-sm font-semibold">{field.title}</div>}
                  {field.value && <div className="text-sm prose-message">{renderMarkdown(field.value)}</div>}
                </div>
              ))}
            </div>
          ) : null}
          {safeImg(att.image_url) && (
            <img
              src={safeImg(att.image_url)}
              alt=""
              width={att.image_width || undefined}
              height={att.image_height || undefined}
              // Responsive: never exceed the container width (so it reflows in
              // the narrow thread sidebar) while keeping aspect ratio and the
              // Mattermost 300px height cap. width/height attrs reserve space.
              className="mt-2 h-auto max-h-[300px] w-auto max-w-full rounded object-contain"
              onLoad={onContentHeightChange}
            />
          )}
          {(att.footer || att.footer_icon) && (
            <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
              {safeImg(att.footer_icon) && <img src={safeImg(att.footer_icon)} alt="" className="h-4 w-4 rounded-sm" onLoad={onContentHeightChange} />}
              {att.footer}
            </div>
          )}
          {att.actions?.length ? (
            <AttachmentActions actions={att.actions} target={actionTarget} onContentHeightChange={onContentHeightChange} />
          ) : null}
        </div>
      ))}
    </div>
  );
}

// AttachmentActions renders an attachment's interactive controls and invokes them.
//
// One request is in flight at a time per attachment: an action commonly rewrites
// the message it lives on, so letting a second fire while the first is still
// running would race two updates against the same post.
function AttachmentActions({
  actions,
  target,
  onContentHeightChange,
}: {
  actions: MessageAction[];
  target?: AttachmentActionTarget;
  onContentHeightChange?: () => void;
}) {
  const invoke = useInvokeMessageAction();
  const [note, setNote] = useState('');

  const run = (action: MessageAction, selectedOption?: string) => {
    /* istanbul ignore next -- defensive: every control below is `disabled`
       without a target, so React never fires a handler in that state. */
    if (!target) return;
    setNote('');
    invoke.mutate(
      { ...target, actionID: action.id, selectedOption },
      {
        onSuccess: (res) => {
          // The updated post arrives over the WebSocket; only the ephemeral text
          // is ours to show, and only to the person who clicked.
          setNote(res.ephemeral_text ?? '');
          onContentHeightChange?.();
        },
        onError: (err) => {
          setNote(err instanceof Error ? err.message : "That didn't work — please try again.");
          onContentHeightChange?.();
        },
      },
    );
  };

  return (
    <div className="mt-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {actions.map((action) =>
          action.type === 'select' ? (
            <select
              key={action.id}
              aria-label={action.name}
              defaultValue=""
              disabled={action.disabled || !target || invoke.isPending}
              onChange={(e) => run(action, e.target.value)}
              className="h-8 max-w-full rounded-md border bg-background px-2 text-sm disabled:opacity-50"
            >
              <option value="" disabled>
                {action.name}
              </option>
              {action.options?.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.text}
                </option>
              ))}
            </select>
          ) : (
            <Button
              key={action.id}
              size="sm"
              variant={buttonVariantFor(action.style)}
              disabled={action.disabled || !target || invoke.isPending}
              onClick={() => run(action, undefined)}
            >
              {action.name}
            </Button>
          ),
        )}
      </div>
      {note && (
        <p className="text-xs text-muted-foreground" role="status">
          {note}
        </p>
      )}
    </div>
  );
}

// buttonVariantFor maps Mattermost's action styles onto ex's button variants.
// MM also allows an arbitrary hex colour there; those fall back to the default
// rather than injecting an inline colour that would ignore the theme.
function buttonVariantFor(style?: string) {
  switch (style) {
    case 'primary':
      return 'default' as const;
    case 'danger':
      return 'destructive' as const;
    default:
      return 'outline' as const;
  }
}

function validColor(value?: string) {
  if (!value) return null;
  return /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(value) ? value : null;
}
