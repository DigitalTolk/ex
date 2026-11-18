import { memo } from 'react';
import type { MessageAttachment } from '@/types';
import { renderMarkdown } from '@/lib/markdown';
import { externalHref, isSafeUrl } from '@/lib/url-safety';
import { BlockList } from '@/components/chat/blocks/MessageBlocks';
import { BlockIcon } from '@/components/chat/blocks/BlockIcon';
import { CircleCheck, CircleDot, CircleX, Info, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { RichColor } from '@/types';
import { cardClass, cardTint, HUE_TEXT } from '@/lib/card-tint';
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

// The meaning of a card's colour as a shape, so it never rests on colour
// alone (some people can't tell the hues apart): done, failed, warning, for
// your information, or simply marked.
const STATUS_ICON: Record<RichColor, LucideIcon> = {
  green: CircleCheck,
  red: CircleX,
  orange: TriangleAlert,
  yellow: TriangleAlert,
  blue: Info,
  purple: CircleDot,
  brown: CircleDot,
  gray: CircleDot,
};
const STATUS_LABEL: Record<RichColor, string> = {
  green: 'Success',
  red: 'Error',
  orange: 'Warning',
  yellow: 'Warning',
  blue: 'Information',
  purple: 'Note',
  brown: 'Note',
  gray: 'Note',
};

// What leads a card: its own emoji when the sender chose one, else the status
// icon its colour stands for, else nothing.
function hasLead(att: MessageAttachment): boolean {
  return !!att.icon || cardTint(att.color) !== null;
}

function CardLead({ att }: { att: MessageAttachment }) {
  if (att.icon) return <BlockIcon icon={att.icon} size="lg" className="shrink-0" />;
  const tint = cardTint(att.color);
  if (!tint) return null;
  const Icon = STATUS_ICON[tint];
  return <Icon className={`h-[18px] w-[18px] shrink-0 ${HUE_TEXT[tint]}`} role="img" aria-label={STATUS_LABEL[tint]} data-testid="card-status-icon" />;
}

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
            // One card for every webhook, classic or rich: the page's surface,
            // an outline that starts in the card's hue, and a status icon.
            className={cn('relative overflow-hidden rounded-lg px-4 py-3', !att.title && hasLead(att) && 'flex gap-2.5', cardClass(att.color))}
          >
            {/* No title: the icon leads the card, beside its content, as in a callout. */}
            {!att.title && <CardLead att={att} />}
            {/* The first part sits at the card's top edge, whatever it is. */}
            <div className="min-w-0 flex-1 [&>*:first-child]:mt-0">
              {safeImg(att.thumb_url) && (
                <img
                  src={safeImg(att.thumb_url)}
                  alt=""
                  className="float-right ml-3 h-[75px] w-[75px] rounded-md object-cover"
                  onLoad={onContentHeightChange}
                />
              )}
              {att.author_name && (
                <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  {safeImg(att.author_icon) && <img src={safeImg(att.author_icon)} alt="" className="h-4 w-4 rounded-sm" onLoad={onContentHeightChange} />}
                  {externalHref(att.author_link) ? <a href={att.author_link} target="_blank" rel="noreferrer" className={LINK}>{att.author_name}</a> : att.author_name}
                </div>
              )}
              {att.title && (
                <div className="mb-1 flex items-center gap-2 text-sm font-semibold">
                  <CardLead att={att} />
                  {externalHref(att.title_link) ? <a href={att.title_link} target="_blank" rel="noreferrer" className={LINK}>{att.title}</a> : att.title}
                </div>
              )}
              {att.text && <MarkdownField className="text-sm prose-message" text={att.text} />}
              {att.fields?.length ? (
                <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-2.5 sm:grid-cols-2">
                  {att.fields.map((field, fieldIndex) => (
                    <div key={fieldIndex} className={field.short ? 'min-w-0' : 'min-w-0 sm:col-span-2'}>
                      {field.title && <dt className="text-xs font-medium text-muted-foreground">{field.title}</dt>}
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
                <div className="clear-both mt-3 flex items-center gap-1.5 border-t border-border pt-2 text-xs text-muted-foreground">
                  {safeImg(att.footer_icon) && <img src={safeImg(att.footer_icon)} alt="" className="h-4 w-4 rounded-sm" onLoad={onContentHeightChange} />}
                  {att.footer}
                </div>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// Links in a card's header read as text with a quiet underline, Notion-style,
// rather than the blue of links in a message body.
const LINK = 'underline decoration-foreground/30 underline-offset-2 hover:decoration-foreground';
