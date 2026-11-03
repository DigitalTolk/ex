import { memo } from 'react';
import type { MessageAttachment } from '@/types';
import { renderMarkdown } from '@/lib/markdown';
import { externalHref, isSafeUrl } from '@/lib/url-safety';
import { BlockList } from '@/components/chat/blocks/MessageBlocks';
import { BlockIcon } from '@/components/chat/blocks/BlockIcon';
import { cardClass } from '@/lib/card-tint';
import { cn } from '@/lib/utils';

// Image src must be a real fetchable URL — http(s) only. isSafeUrl also admits
// mailto (fine for links, not images), so narrow it here. The backend already
// proxies these through the SSRF-guarded image proxy; this is defense-in-depth
// so a javascript:/data:/file: URL never reaches an <img src>.
function safeImg(url?: string): string | undefined {
  if (!url || !isSafeUrl(url) || /^\s*mailto:/i.test(url)) return undefined;
  return url;
}

// One markdown field of a webhook card. Memoized on its text: the message row
// re-renders for hover, reactions and presence, and re-parsing every field of
// every card on each of those was pure waste — the text did not change.
const MarkdownField = memo(function MarkdownField({ text, className }: { text: string; className: string }) {
  return <div className={className}>{renderMarkdown(text)}</div>;
});

export function MessageRichAttachments({ attachments, onContentHeightChange }: { attachments?: MessageAttachment[]; onContentHeightChange?: () => void }) {
  if (!attachments?.length) return null;
  return (
    // Capped so a card reads as one card on a wide screen, not a banner.
    <div className="mt-2 max-w-2xl space-y-2">
      {attachments.map((att, index) => (
        <div key={index} className="space-y-1.5">
          {/* Pretext is the line above the card, as in Slack. */}
          {att.pretext && <MarkdownField className="text-sm prose-message" text={att.pretext} />}
          <div
            data-testid="message-rich-attachment"
            // Notion-style: a colour tints the whole card; none is the theme's
            // plain card. Secondary text is the foreground, faded, so it keeps
            // its contrast on every tint.
            className={cn('relative overflow-hidden rounded-lg border px-4 py-3', cardClass(att.color))}
          >
            {safeImg(att.thumb_url) && (
              <img
                src={safeImg(att.thumb_url)}
                alt=""
                className="float-right ml-3 h-[75px] w-[75px] rounded-md object-cover"
                onLoad={onContentHeightChange}
              />
            )}
            {att.author_name && (
              <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-foreground/70">
                {safeImg(att.author_icon) && <img src={safeImg(att.author_icon)} alt="" className="h-4 w-4 rounded-sm" onLoad={onContentHeightChange} />}
                {externalHref(att.author_link) ? <a href={att.author_link} target="_blank" rel="noreferrer" className={LINK}>{att.author_name}</a> : att.author_name}
              </div>
            )}
            {(att.title || att.icon) && (
              <div className="mb-1 flex items-center gap-2 text-sm font-semibold">
                {att.icon && <BlockIcon icon={att.icon} size="lg" className="shrink-0" />}
                {externalHref(att.title_link) ? <a href={att.title_link} target="_blank" rel="noreferrer" className={LINK}>{att.title}</a> : att.title}
              </div>
            )}
            {att.text && <MarkdownField className="text-sm prose-message" text={att.text} />}
            {att.fields?.length ? (
              <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-2.5 sm:grid-cols-2">
                {att.fields.map((field, fieldIndex) => (
                  <div key={fieldIndex} className={field.short ? 'min-w-0' : 'min-w-0 sm:col-span-2'}>
                    {field.title && <dt className="text-xs font-medium text-foreground/70">{field.title}</dt>}
                    {field.value && (
                      <dd>
                        <MarkdownField className="text-sm prose-message" text={field.value} />
                      </dd>
                    )}
                  </div>
                ))}
              </dl>
            ) : null}
            {/* Blocks inside a card sit on its tint; their buttons answer
                through the message's block scope (MessageItem). */}
            {att.blocks?.length ? <BlockList blocks={att.blocks} className="mt-3" /> : null}
            {safeImg(att.image_url) && (
              <img
                src={safeImg(att.image_url)}
                alt=""
                width={att.image_width || undefined}
                height={att.image_height || undefined}
                // Responsive: never exceed the container width (so it reflows in
                // the narrow thread sidebar) while keeping aspect ratio and the
                // Mattermost 300px height cap. width/height attrs reserve space.
                className="mt-3 h-auto max-h-[300px] w-auto max-w-full rounded-md object-contain"
                onLoad={onContentHeightChange}
              />
            )}
            {(att.footer || att.footer_icon) && (
              <div className="clear-both mt-3 flex items-center gap-1.5 border-t border-foreground/10 pt-2 text-xs text-foreground/70">
                {safeImg(att.footer_icon) && <img src={safeImg(att.footer_icon)} alt="" className="h-4 w-4 rounded-sm" onLoad={onContentHeightChange} />}
                {att.footer}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// Links in a card's header read as text with a quiet underline, Notion-style,
// rather than the blue of links in a message body.
const LINK = 'underline decoration-foreground/30 underline-offset-2 hover:decoration-foreground';
