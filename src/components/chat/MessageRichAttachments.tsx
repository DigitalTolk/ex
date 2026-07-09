import type { MessageAttachment } from '@/types';
import { renderMarkdown } from '@/lib/markdown';
import { isSafeUrl } from '@/lib/url-safety';

// Image src must be a real fetchable URL — http(s) only. isSafeUrl also admits
// mailto (fine for links, not images), so narrow it here. The backend already
// proxies these through the SSRF-guarded image proxy; this is defense-in-depth
// so a javascript:/data:/file: URL never reaches an <img src>.
function safeImg(url?: string): string | undefined {
  if (!url || !isSafeUrl(url) || /^\s*mailto:/i.test(url)) return undefined;
  return url;
}

export function MessageRichAttachments({ attachments, onContentHeightChange }: { attachments?: MessageAttachment[]; onContentHeightChange?: () => void }) {
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
        </div>
      ))}
    </div>
  );
}

function validColor(value?: string) {
  if (!value) return null;
  return /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(value) ? value : null;
}
